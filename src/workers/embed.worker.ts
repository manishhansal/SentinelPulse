/**
 * embed.worker.ts — BullMQ worker for the embedding generation pipeline stage.
 *
 * Consumes `news.embeddings` jobs. Handles two job types:
 *   - `embedding.retry`  — initial or retry embedding generation.
 *     Payload: { text, entityType, entityId, modelVersion? }
 *
 * Delegates to EmbeddingEngine.generateAndStore(), which calls the OpenAI
 * Embeddings API and persists to `news_embeddings`.  On API failure the engine
 * self-enqueues a retry job, so the worker never retries directly for API
 * failures.
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
 * Requirements: Req 26.1, Req 26.2, Req 26.3, Req 26.4, Req 26.6, Req 18.1
 */

import { Worker, Queue, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { LookAheadBiasError } from '../engines/feature-engineering/LookAheadGuard.js';
import { EmbeddingEngine } from '../engines/embedding/EmbeddingEngine.js';
import { QUEUE_NAMES } from '../queue/queues.js';

const logger = pino({ name: 'embed-worker' });
const CONCURRENCY = parseInt(process.env['WORKER_EMBED_CONCURRENCY'] ?? '1', 10);

const connection = new Redis(process.env['REDIS_URL'] ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

// The embeddings queue is passed to the engine so it can self-enqueue retries
// on OpenAI API failures (Req 18.1).
const embeddingsQueue = new Queue(QUEUE_NAMES.EMBEDDINGS, { connection });
const engine = new EmbeddingEngine(embeddingsQueue);

const worker = new Worker(
  QUEUE_NAMES.EMBEDDINGS,
  async (job: Job<{ text: string; entityType: string; entityId: string; modelVersion?: string }>) => {
    try {
      await engine.generateAndStore(job.data.text, job.data.entityType as any, job.data.entityId);
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
