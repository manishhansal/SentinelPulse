/**
 * sentiment.worker.ts — BullMQ worker for the sentiment analysis pipeline stage.
 *
 * Consumes `news.events` jobs, delegates to SentimentEngine, which computes
 * five sentiment dimensions, persists to `news_sentiment`, and publishes to
 * `news.sentiment`.
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
import { SentimentEngine } from '../engines/sentiment/SentimentEngine.js';
import { QUEUE_NAMES } from '../queue/queues.js';
import { prisma } from '../db/prisma.js';

const logger = pino({ name: 'sentiment-worker' });
const CONCURRENCY = parseInt(process.env['WORKER_SENTIMENT_CONCURRENCY'] ?? '1', 10);

const connection = new Redis(process.env['REDIS_URL'] ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

const sentimentQueue = new Queue(QUEUE_NAMES.SENTIMENT, { connection });
const engine = new SentimentEngine(sentimentQueue);

const worker = new Worker(
  QUEUE_NAMES.EVENTS,
  async (job: Job) => {
    const { articleId, eventIds } = job.data as { articleId: string; eventIds?: string[] };
    try {
      // Fetch article from DB — SentimentEngine needs title + content
      const article = await prisma.newsArticle.findUnique({ where: { id: articleId } });
      if (!article) {
        logger.warn({ articleId, jobId: job.id }, 'Article not found — skipping sentiment');
        return;
      }
      // Run once per article; link to the primary event if available
      const primaryEventId = eventIds?.[0];
      await engine.process({
        id: article.id,
        title: article.title,
        content: article.content,
        eventId: primaryEventId,
      });
    } catch (err) {
      if (err instanceof LookAheadBiasError) {
        logger.error({ err, jobId: job.id }, 'LookAheadBiasError — aborting without retry');
        return;
      }
      throw err;
    }
  },
  { connection, concurrency: CONCURRENCY },
);

worker.on('completed', (job) => logger.info({ jobId: job.id }, 'Job completed'));
worker.on('failed', (job, err) => logger.error({ jobId: job?.id, err }, 'Job failed'));
worker.on('error', (err) => logger.error({ err }, 'Worker error'));

export { worker };
