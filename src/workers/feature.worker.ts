/**
 * feature.worker.ts — BullMQ worker for historical reaction + feature engineering stages.
 *
 * Consumes `news.impact` jobs ({ eventId }) published by ImportanceEngine.
 * For each event:
 *   1. Calls HistoricalReactionEngine.process() — fetches OHLCV data at nine
 *      time offsets and upserts news_market_reactions (Req 12.1–12.5).
 *   2. Calls FeatureEngineeringEngine.process() — assembles and persists the
 *      FeatureVector, then publishes to `news.features` (Req 20.1–20.6).
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
import { HistoricalReactionEngine } from '../engines/historical-reaction/HistoricalReactionEngine.js';
import { FeatureEngineeringEngine } from '../engines/feature-engineering/FeatureEngineeringEngine.js';
import { DataServiceClient } from '../integrations/data-service/DataServiceClient.js';
import { QUEUE_NAMES } from '../queue/queues.js';
import { prisma } from '../db/prisma.js';

const logger = pino({ name: 'feature-worker' });
const CONCURRENCY = parseInt(process.env['WORKER_FEATURE_CONCURRENCY'] ?? '1', 10);

const connection = new Redis(process.env['REDIS_URL'] ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

const featuresQueue = new Queue(QUEUE_NAMES.FEATURES, { connection });
const dataServiceClient = new DataServiceClient();

const historicalReactionEngine = new HistoricalReactionEngine(dataServiceClient);
const featureEngineeringEngine = new FeatureEngineeringEngine(featuresQueue);

const worker = new Worker(
  QUEUE_NAMES.IMPACT,
  async (job: Job<{ eventId: string }>) => {
    const { eventId } = job.data;

    // Look up the full event record needed by both engines
    const event = await prisma.newsEvent.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        articleId: true,
        eventType: true,
        actor: true,
        surpriseScore: true,
        importance: true,
        eventTimestamp: true,
        article: {
          select: {
            publishedAt: true,
            sourceId: true,
            title: true,
          },
        },
      },
    });

    if (!event) {
      logger.warn({ eventId, jobId: job.id }, 'Event not found — skipping feature pipeline');
      return;
    }

    // Resolve linked asset IDs for HistoricalReactionEngine
    const assetLinks = await prisma.newsAssetLink.findMany({
      where: { articleId: event.articleId },
      select: { assetId: true },
    });
    const assetIds = assetLinks.map((l) => l.assetId);

    try {
      // Step 1: HistoricalReactionEngine — fetch OHLCV at nine offsets (Req 12.1)
      await historicalReactionEngine.process({
        id: event.id,
        assetIds,
        eventTimestamp: event.eventTimestamp,
      });

      // Step 2: FeatureEngineeringEngine — assemble and persist FeatureVector (Req 20.1)
      await featureEngineeringEngine.process({
        id: event.id,
        articleId: event.articleId,
        eventType: event.eventType,
        assetId: assetIds[0] ?? undefined, // primary asset (first linked)
        eventTimestamp: event.eventTimestamp,
      });
    } catch (err) {
      if (err instanceof LookAheadBiasError) {
        logger.error(
          { err, jobId: job.id, eventId },
          'LookAheadBiasError — aborting without retry',
        );
        return; // complete without downstream publish
      }
      throw err; // BullMQ will retry
    }
  },
  { connection, concurrency: CONCURRENCY },
);

worker.on('completed', (job) => logger.info({ jobId: job.id }, 'Job completed'));
worker.on('failed', (job, err) => logger.error({ jobId: job?.id, err }, 'Job failed'));
worker.on('error', (err) => logger.error({ err }, 'Worker error'));

export { worker };
