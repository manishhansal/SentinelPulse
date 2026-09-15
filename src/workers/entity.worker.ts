/**
 * entity.worker.ts — BullMQ worker for the entity resolution pipeline stage.
 *
 * Consumes `news.deduplicated` jobs, delegates to EntityResolutionEngine,
 * which extracts entities, resolves them against InstrumentMaster, persists
 * records, and publishes to `news.entities`.
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
import { EntityResolutionEngine } from '../engines/entity/EntityResolutionEngine.js';
import { QUEUE_NAMES } from '../queue/queues.js';
import { prisma } from '../db/prisma.js';

const logger = pino({ name: 'entity-worker' });
const CONCURRENCY = parseInt(process.env['WORKER_ENTITY_CONCURRENCY'] ?? '1', 10);

const connection = new Redis(process.env['REDIS_URL'] ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

const entitiesQueue = new Queue(QUEUE_NAMES.ENTITIES, { connection });
const engine = new EntityResolutionEngine(entitiesQueue);

const worker = new Worker(
  QUEUE_NAMES.DEDUPLICATED,
  async (job: Job) => {
    const { articleId } = job.data as { articleId: string };
    try {
      // Fetch full article from DB (dedup publishes only articleId + dedup result)
      const article = await prisma.newsArticle.findUnique({ where: { id: articleId } });
      if (!article) {
        logger.warn({ articleId, jobId: job.id }, 'Article not found — skipping entity resolution');
        return;
      }
      await engine.process({
        id: article.id,
        sourceId: article.sourceId,
        externalId: article.externalId,
        title: article.title,
        summary: article.summary,
        content: article.content,
        publishedAt: article.publishedAt,
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
