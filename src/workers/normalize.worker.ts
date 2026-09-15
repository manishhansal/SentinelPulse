/**
 * normalize.worker.ts — BullMQ worker for the normalization pipeline stage.
 *
 * Consumes `news.raw` jobs (RawArticle payloads), delegates to
 * NormalizationEngine, which persists to `news_articles` and publishes to
 * `news.normalized`.
 *
 * Error handling (Req 26.2):
 *   - LookAheadBiasError → log ERROR, complete without downstream publish (no retry)
 *   - All other errors   → re-throw so BullMQ retries per queue policy
 *   - Exhausted retries  → BullMQ moves job to DLQ automatically (Req 26.4)
 *
 * Idle behaviour (Req 26.6):
 *   BullMQ's Worker keeps the process alive when the queue is empty and
 *   resumes within 2 s when a new job arrives — no extra logic needed.
 *
 * Requirements: Req 26.1, Req 26.2, Req 26.3, Req 26.4, Req 26.6
 */

import { Worker, Queue, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { LookAheadBiasError } from '../engines/feature-engineering/LookAheadGuard.js';
import { NormalizationEngine } from '../engines/normalization/NormalizationEngine.js';
import type { RawArticle } from '../adapters/base/NewsSourceAdapter.js';
import { QUEUE_NAMES } from '../queue/queues.js';

const logger = pino({ name: 'normalize-worker' });
const CONCURRENCY = parseInt(process.env['WORKER_NORMALIZE_CONCURRENCY'] ?? '1', 10);

const connection = new Redis(process.env['REDIS_URL'] ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

const normalizedQueue = new Queue(QUEUE_NAMES.NORMALIZED, { connection });
const engine = new NormalizationEngine(normalizedQueue);

const worker = new Worker(
  QUEUE_NAMES.RAW,
  async (job: Job) => {
    try {
      await engine.process(job.data as RawArticle);
    } catch (err) {
      if (err instanceof LookAheadBiasError) {
        logger.error({ err, jobId: job.id }, 'LookAheadBiasError — aborting without retry');
        return; // complete without downstream publish
      }
      throw err; // BullMQ will retry per queue policy
    }
  },
  { connection, concurrency: CONCURRENCY },
);

worker.on('completed', (job) => logger.info({ jobId: job.id }, 'Job completed'));
worker.on('failed', (job, err) => logger.error({ jobId: job?.id, err }, 'Job failed'));
worker.on('error', (err) => logger.error({ err }, 'Worker error'));

export { worker };
