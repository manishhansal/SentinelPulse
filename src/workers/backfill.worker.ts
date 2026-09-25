/**
 * backfill.worker.ts — BullMQ worker for historical news backfill.
 *
 * Consumes jobs from the `news.backfill` queue.  Two job types:
 *
 *   "backfill"        — initial batch: fetches the first batchSize articles
 *                       from the DB starting at config.startDate, calls
 *                       BackfillEngine.processBatch(), then re-enqueues itself
 *                       for the next batch if more articles remain.
 *
 *   "backfill-resume" — re-enqueues the active job after a resumeJob() call.
 *
 * Rate limiting (Req 23.6):
 *   Concurrency is capped at WORKER_BACKFILL_CONCURRENCY (default 1) so that
 *   backfill never starves the live pipeline.  The live impact worker uses
 *   WORKER_FEATURE_CONCURRENCY (default 1–4), so running this worker at
 *   concurrency=1 caps backfill at ≈20% of total pipeline throughput.
 *
 * Checkpoint / resume (Req 23.2, Req 23.3):
 *   BackfillEngine.processBatch() writes a checkpoint to the news_features
 *   table after every batch.  If the process crashes mid-batch, the next
 *   worker invocation restores state via BackfillEngine.getJobState().
 *
 * PIT safety (Req 23.5):
 *   BackfillEngine.processBatch() calls runPipelineForArticle() for each
 *   article.  Any article that triggers a LookAheadBiasError is skipped;
 *   the batch continues without retry for that article.
 *
 * Error handling:
 *   LookAheadBiasError   → handled inside BackfillEngine, never reaches here.
 *   Job-level errors     → re-throw; BullMQ retries up to DEFAULT_JOB_OPTIONS.attempts.
 *   Auth / rate-limit    → logged and re-thrown (BullMQ retries with backoff).
 *
 * Requirements: Req 23.1–23.6
 */

import { Worker, Queue, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { BackfillEngine, type BackfillConfig } from '../engines/backfill/BackfillEngine.js';
import { QUEUE_NAMES, DEFAULT_JOB_OPTIONS } from '../queue/queues.js';
import { prisma } from '../db/prisma.js';

const logger = pino({ name: 'backfill-worker' });

/** Max backfill concurrency (Req 23.6 — ≤20% of live pipeline capacity). */
const CONCURRENCY = parseInt(process.env['WORKER_BACKFILL_CONCURRENCY'] ?? '1', 10);

const connection = new Redis(process.env['REDIS_URL'] ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

const backfillQueue = new Queue(QUEUE_NAMES.BACKFILL, { connection });
const engine = new BackfillEngine(backfillQueue);

// ---------------------------------------------------------------------------
// Job handlers
// ---------------------------------------------------------------------------

/**
 * Payload for a "backfill" job (initial or continuation batch).
 */
interface BackfillJobPayload {
  jobId: string;
  config: Omit<BackfillConfig, 'startDate' | 'endDate'> & {
    /** ISO string from BackfillEngine.startJob() */
    startDate: string;
    /** ISO string from BackfillEngine.startJob() */
    endDate: string;
    batchSize: number;
  };
}

/**
 * Payload for a "backfill-resume" job (sent by BackfillEngine.resumeJob()).
 */
interface BackfillResumePayload {
  jobId: string;
}

const worker = new Worker(
  QUEUE_NAMES.BACKFILL,
  async (job: Job<BackfillJobPayload | BackfillResumePayload>) => {
    logger.info({ jobId: job.id, jobName: job.name }, 'Backfill job received');

    // ── "backfill-resume" — restore state then enqueue the next batch ───────
    if (job.name === 'backfill-resume') {
      const { jobId } = job.data as BackfillResumePayload;
      const state = await engine.getJobState(jobId);
      if (!state) {
        logger.warn({ jobId }, 'backfill-resume: job state not found — skipping');
        return;
      }
      if (state.status !== 'running') {
        logger.info({ jobId, status: state.status }, 'backfill-resume: job not running — skipping');
        return;
      }
      // Re-enqueue as a regular backfill job from the restored cursor.
      const config = {
        startDate: state.currentDateCursor.toISOString(),
        endDate: state.endDate.toISOString(),
        batchSize: 100,
      };
      await backfillQueue.add(
        'backfill',
        { jobId, config },
        { ...DEFAULT_JOB_OPTIONS, jobId: `backfill:${jobId}:${Date.now()}` },
      );
      logger.info({ jobId, cursor: state.currentDateCursor }, 'Backfill resumed — batch enqueued');
      return;
    }

    // ── "backfill" — process the next batch ──────────────────────────────────
    const { jobId, config } = job.data as BackfillJobPayload;
    const startDate = new Date(config.startDate);
    const endDate = new Date(config.endDate);
    const batchSize = config.batchSize ?? 100;

    // Restore or verify job state
    let state = await engine.getJobState(jobId);
    if (!state) {
      // State lost (e.g. process restart) — attempt to recreate from job payload.
      logger.warn({ jobId }, 'Job state not found in memory or DB — re-initialising from payload');
      await engine.startJob({
        startDate,
        endDate,
        batchSize,
        sources: config.sources,
        categories: config.categories,
        assets: config.assets,
      });
      state = await engine.getJobState(jobId);
      if (!state) {
        throw new Error(`Could not restore or create state for backfill job ${jobId}`);
      }
    }

    if (state.status === 'cancelled') {
      logger.info({ jobId }, 'Job is cancelled — stopping worker processing');
      return;
    }

    if (state.status === 'completed') {
      logger.info({ jobId }, 'Job already completed');
      return;
    }

    if (state.status === 'paused') {
      logger.info({ jobId }, 'Job is paused — stopping processing until resumed');
      return;
    }

    // Fetch the next batch of articles from the cursor position.
    const cursor = state.currentDateCursor;
    const articles = await prisma.newsArticle.findMany({
      where: {
        publishedAt: {
          gte: cursor,
          lt: endDate,
        },
        ...(config.sources?.length ? { sourceId: { in: config.sources } } : {}),
      },
      orderBy: { publishedAt: 'asc' },
      take: batchSize,
      select: {
        id: true,
        publishedAt: true,
      },
    });

    logger.info(
      { jobId, batchSize: articles.length, cursor: cursor.toISOString() },
      'Fetched batch for processing',
    );

    // processBatch accepts ArticleRef[] — map from DB rows.
    const articleRefs = articles.map((a) => ({
      id: a.id,
      eventTimestamp: a.publishedAt,
    }));

    await engine.processBatch(jobId, articleRefs);

    // Re-fetch state to get the updated cursor.
    state = await engine.getJobState(jobId);
    if (!state) {
      logger.warn({ jobId }, 'State lost after processBatch — not re-enqueueing');
      return;
    }

    const hasMore =
      articles.length === batchSize &&
      state.currentDateCursor < endDate &&
      state.status === 'running';

    if (hasMore) {
      // Enqueue the next batch with the advanced cursor.
      await backfillQueue.add(
        'backfill',
        {
          jobId,
          config: {
            ...config,
            startDate: state.currentDateCursor.toISOString(),
          },
        },
        {
          ...DEFAULT_JOB_OPTIONS,
          jobId: `backfill:${jobId}:${state.currentDateCursor.getTime()}`,
          // Small delay to avoid hammering DB — yields to live pipeline.
          delay: parseInt(process.env['BACKFILL_BATCH_DELAY_MS'] ?? '500', 10),
        },
      );
      logger.info(
        { jobId, nextCursor: state.currentDateCursor, articlesProcessed: state.articlesProcessed },
        'Next batch enqueued',
      );
    } else {
      logger.info(
        {
          jobId,
          status: state.status,
          articlesProcessed: state.articlesProcessed,
          articlesFailed: state.articlesFailed,
          reason: hasMore ? 'state_not_running' : 'no_more_articles',
        },
        'Backfill batch sequence complete',
      );
    }
  },
  { connection, concurrency: CONCURRENCY },
);

// ---------------------------------------------------------------------------
// Worker event handlers
// ---------------------------------------------------------------------------

worker.on('completed', (job) =>
  logger.info({ jobId: job.id, jobName: job.name }, 'Backfill job completed'),
);

worker.on('failed', (job, err) =>
  logger.error({ jobId: job?.id, jobName: job?.name, err }, 'Backfill job failed'),
);

worker.on('error', (err) =>
  logger.error({ err }, 'Backfill worker error'),
);

worker.on('stalled', (jobId) =>
  logger.warn({ jobId }, 'Backfill job stalled'),
);

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

const shutdown = async (): Promise<void> => {
  logger.info('Backfill worker shutting down...');
  await worker.close();
  await backfillQueue.close();
  connection.disconnect();
  process.exit(0);
};

process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });

export { worker };
