/**
 * impact.worker.ts — BullMQ workers for the importance + market-impact pipeline stages.
 *
 * Two workers in a single module:
 *
 * 1. importanceWorker — consumes `news.sentiment` ({ articleId, modelVersion }).
 *    Fetches all NewsEvents for the article and calls ImportanceEngine.process()
 *    for each, which upserts news_importance and publishes { eventId } to
 *    `news.impact`.
 *
 * 2. marketImpactWorker — consumes `news.impact` ({ eventId }).
 *    Looks up the full event from the DB and calls MarketImpactEngine.process(),
 *    which upserts news_market_impacts for each affected asset.
 *
 * Note: ImportanceEngine publishes to news.impact; MarketImpactEngine reads from
 * there. Both stages are co-located in this file for pipeline cohesion.
 *
 * Error handling (Req 26.2):
 *   - LookAheadBiasError → log ERROR, complete without downstream publish (no retry)
 *   - All other errors   → re-throw so BullMQ retries per queue policy
 *   - Exhausted retries  → BullMQ moves job to DLQ automatically (Req 26.4)
 *
 * Idle behaviour (Req 26.6):
 *   BullMQ's Worker keeps the process alive when the queue is empty and
 *   resumes within 2 s when a new job arrives.
 *
 * Requirements: Req 26.1, Req 26.2, Req 26.3, Req 26.4, Req 26.6
 */

import { Worker, Queue, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { LookAheadBiasError } from '../engines/feature-engineering/LookAheadGuard.js';
import { ImportanceEngine } from '../engines/importance/ImportanceEngine.js';
import { MarketImpactEngine } from '../engines/market-impact/MarketImpactEngine.js';
import { QUEUE_NAMES } from '../queue/queues.js';
import { prisma } from '../db/prisma.js';

const logger = pino({ name: 'impact-worker' });
const CONCURRENCY = parseInt(process.env['WORKER_IMPACT_CONCURRENCY'] ?? '1', 10);

const connection = new Redis(process.env['REDIS_URL'] ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

// news.impact queue — written by ImportanceEngine, read by marketImpactWorker
const impactQueue = new Queue(QUEUE_NAMES.IMPACT, { connection });

const importanceEngine = new ImportanceEngine(impactQueue);
const marketImpactEngine = new MarketImpactEngine(impactQueue);

// ---------------------------------------------------------------------------
// Worker 1: news.sentiment → ImportanceEngine (for each event on the article)
// ---------------------------------------------------------------------------

const importanceWorker = new Worker(
  QUEUE_NAMES.SENTIMENT,
  async (job: Job<{ articleId: string; modelVersion: string }>) => {
    const { articleId } = job.data;

    // Fetch all events linked to this article
    const events = await prisma.newsEvent.findMany({
      where: { articleId },
      select: {
        id: true,
        articleId: true,
        eventType: true,
        surpriseScore: true,
        article: {
          select: {
            publishedAt: true,
            sourceId: true,
          },
        },
      },
    });

    if (events.length === 0) {
      logger.warn({ articleId, jobId: job.id }, 'No events found for article — skipping ImportanceEngine');
      return;
    }

    for (const event of events) {
      try {
        await importanceEngine.process({
          id: event.id,
          articleId: event.articleId,
          eventType: event.eventType,
          sourceId: event.article.sourceId,
          surpriseScore: event.surpriseScore !== null ? Number(event.surpriseScore) : null,
          publishedAt: event.article.publishedAt,
        });
      } catch (err) {
        if (err instanceof LookAheadBiasError) {
          logger.error(
            { err, jobId: job.id, eventId: event.id },
            'LookAheadBiasError in ImportanceEngine — aborting without retry',
          );
          continue; // skip this event, continue with next
        }
        throw err; // BullMQ will retry
      }
    }
  },
  { connection, concurrency: CONCURRENCY },
);

importanceWorker.on('completed', (job) => logger.info({ jobId: job.id }, 'Importance job completed'));
importanceWorker.on('failed', (job, err) => logger.error({ jobId: job?.id, err }, 'Importance job failed'));
importanceWorker.on('error', (err) => logger.error({ err }, 'Importance worker error'));

// ---------------------------------------------------------------------------
// Worker 2: news.impact → MarketImpactEngine
// ---------------------------------------------------------------------------

const marketImpactWorker = new Worker(
  QUEUE_NAMES.IMPACT,
  async (job: Job<{ eventId: string }>) => {
    const { eventId } = job.data;

    // Look up the full event record from the DB
    const event = await prisma.newsEvent.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        articleId: true,
        eventType: true,
        actor: true,
        surpriseScore: true,
        importance: true,
        article: {
          select: {
            title: true,
            publishedAt: true,
            sourceId: true,
          },
        },
      },
    });

    if (!event) {
      logger.warn({ eventId, jobId: job.id }, 'Event not found — skipping MarketImpactEngine');
      return;
    }

    // Fetch importance score from DB (upserted by ImportanceEngine in prior stage)
    const importanceRow = await prisma.newsImportance.findUnique({
      where: { eventId },
      select: { importanceScore: true },
    });

    try {
      await marketImpactEngine.process({
        id: event.id,
        articleId: event.articleId,
        eventType: event.eventType,
        actor: event.actor,
        importance: importanceRow ? Number(importanceRow.importanceScore) : Number(event.importance),
        surpriseScore: event.surpriseScore !== null ? Number(event.surpriseScore) : null,
        title: event.article.title,
        publishedAt: event.article.publishedAt,
        sourceId: event.article.sourceId,
      });
    } catch (err) {
      if (err instanceof LookAheadBiasError) {
        logger.error(
          { err, jobId: job.id, eventId },
          'LookAheadBiasError in MarketImpactEngine — aborting without retry',
        );
        return; // complete without downstream publish
      }
      throw err; // BullMQ will retry
    }
  },
  { connection, concurrency: CONCURRENCY },
);

marketImpactWorker.on('completed', (job) => logger.info({ jobId: job.id }, 'Market impact job completed'));
marketImpactWorker.on('failed', (job, err) => logger.error({ jobId: job?.id, err }, 'Market impact job failed'));
marketImpactWorker.on('error', (err) => logger.error({ err }, 'Market impact worker error'));

// Export both workers (importanceWorker is the "primary" entry for this stage)
export { importanceWorker as worker, marketImpactWorker };
