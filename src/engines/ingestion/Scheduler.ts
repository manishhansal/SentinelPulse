/**
 * Scheduler — per-source poll loop manager for the IngestionEngine.
 *
 * Responsibilities:
 *   - Maintain a `setInterval` per enabled source, driven by each source's
 *     `NEWS_SOURCE_{NAME}_POLL_INTERVAL_MS` environment variable.
 *   - Within every cycle, poll ALL enabled Tier-1 sources sequentially
 *     (Reuters → Moneycontrol → EconomicTimes) BEFORE any Tier-2 source
 *     (Req 1.3).
 *   - Gate every fetch through the source's CircuitBreaker; if OPEN, attempt
 *     tryHalfOpen() — allow only if it transitions to HALF_OPEN (Req 2.2).
 *   - On healthCheck failure: log failure with source name + timestamp,
 *     increment failure counter, continue cycle without interruption (Req 1.6).
 *   - On fetchLatest exception: catch, log with source name + stack trace,
 *     return empty array, never propagate (Req 1.10).
 *   - Skip sources whose enabled env var is false (Req 1.8).
 *   - Publish every fetched RawArticle as a job on the `news.raw` BullMQ
 *     queue (Req 2.6).
 *   - Apply RateLimiter.throttle() before each fetchLatest call.
 *   - After each per-source fetch cycle, insert a `news_ingestion_runs`
 *     record via prisma (Req 2.8).
 *
 * Requirements: Req 1.3, Req 1.6, Req 1.8, Req 1.10, Req 2.6, Req 2.8
 */

import type { Queue } from 'bullmq';
import { pino } from 'pino';
import type {
  NewsSourceAdapter,
  RawArticle,
} from '../../adapters/base/NewsSourceAdapter.js';
import { CircuitBreaker } from './CircuitBreaker.js';
import { RateLimiter } from './RateLimiter.js';
import { prisma } from '../../db/prisma.js';

// ---------------------------------------------------------------------------
// Queue name constant
// ---------------------------------------------------------------------------

// TODO: replace with `import { QUEUE_NAMES } from '../../queue/queues.js'` once
//       that module is created in task 4-queue-setup.
const RAW_QUEUE_NAME = 'news.raw' as const;

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger = pino({ name: 'scheduler' });

// ---------------------------------------------------------------------------
// Source → env-var name mapping (Req 1.9)
// ---------------------------------------------------------------------------

/**
 * Maps a `sourceId` (as returned by adapters) to the upper-case source key
 * used in environment variable names, e.g. `reuters` → `REUTERS`.
 *
 * The mapping must be exhaustive for the six built-in sources; any unknown
 * sourceId falls back to the uppercase version of the string itself.
 */
const SOURCE_ID_TO_ENV_KEY: Record<string, string> = {
  reuters: 'REUTERS',
  moneycontrol: 'MONEYCONTROL',
  'economic-times': 'ECONOMICTIMES',
  bloomberg: 'BLOOMBERG',
  'financial-times': 'FINANCIALTIMES',
  coindesk: 'COINDESK',
};

/**
 * Default polling interval when the env var is absent.
 * A reasonably conservative fallback: 5 minutes.
 */
const DEFAULT_POLL_INTERVAL_MS = 300_000;

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface SchedulerConfig {
  /** All adapters (enabled + disabled); Scheduler filters by enabled state. */
  adapters: NewsSourceAdapter[];
  /** The `news.raw` BullMQ queue instance (Req 2.6). */
  rawQueue: Queue;
}

/** Observable state returned by getSourceStatus(). */
export interface SourceStatus {
  /** Current CircuitBreaker state for this source. */
  cbState: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  /**
   * Cumulative count of healthCheck failures seen in this process lifetime.
   * Note: this tracks only health-check failures recorded by the Scheduler,
   * not the CircuitBreaker's internal consecutiveFailures counter.
   */
  healthFailureCount: number;
  /** UTC timestamp of the most recent fetch cycle completion, or null. */
  lastRunAt: Date | null;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export class Scheduler {
  // Map of sourceId → CircuitBreaker instance.
  private readonly circuitBreakers = new Map<string, CircuitBreaker>();

  // Map of sourceId → RateLimiter instance.
  private readonly rateLimiters = new Map<string, RateLimiter>();

  // Map of sourceId → setInterval handle (only for currently running sources).
  private readonly intervals = new Map<string, ReturnType<typeof setInterval>>();

  // Scheduler lifecycle state.
  private isRunning = false;

  // Accumulated health-check failure counters per source (Req 1.6).
  private readonly healthFailureCounts = new Map<string, number>();

  // Timestamp of the last completed fetch cycle per source.
  private readonly lastRunAt = new Map<string, Date>();

  constructor(private readonly config: SchedulerConfig) {
    for (const adapter of config.adapters) {
      this.circuitBreakers.set(
        adapter.sourceId,
        new CircuitBreaker(adapter.sourceId),
      );
      this.rateLimiters.set(
        adapter.sourceId,
        new RateLimiter(
          adapter.sourceId,
          adapter.getRateLimit().requestsPerMinute,
        ),
      );
      this.healthFailureCounts.set(adapter.sourceId, 0);
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start per-source poll intervals for every enabled adapter.
   *
   * Adapters are considered "enabled" when their
   * `NEWS_SOURCE_{NAME}_ENABLED` env var resolves to the string `"true"`
   * (case-insensitive) via the parsed env config (Req 1.7, Req 1.8).
   *
   * Each source gets its own independent `setInterval` so that a slow source
   * does not stall a fast source's poll loop.
   *
   * `start()` is idempotent — calling it while already running is a no-op.
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('Scheduler.start() called while already running — ignoring.');
      return;
    }
    this.isRunning = true;

    for (const adapter of this.config.adapters) {
      if (!this.isSourceEnabled(adapter.sourceId)) {
        logger.info(
          { sourceId: adapter.sourceId },
          'Source is disabled — skipping poll interval setup.',
        );
        continue;
      }

      const intervalMs = this.getPollIntervalMs(adapter.sourceId);

      logger.info(
        { sourceId: adapter.sourceId, intervalMs },
        'Starting poll interval for source.',
      );

      // Kick off an immediate first cycle, then set the recurring interval.
      void this.runCycleForSource(adapter);

      const handle = setInterval(() => {
        void this.runCycleForSource(adapter);
      }, intervalMs);

      this.intervals.set(adapter.sourceId, handle);
    }
  }

  /**
   * Stop all poll intervals and mark the scheduler as stopped.
   * Idempotent — safe to call multiple times.
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    for (const [sourceId, handle] of this.intervals) {
      clearInterval(handle);
      logger.info({ sourceId }, 'Stopped poll interval for source.');
    }

    this.intervals.clear();
    this.isRunning = false;
    logger.info('Scheduler stopped.');
  }

  // ---------------------------------------------------------------------------
  // Core cycle
  // ---------------------------------------------------------------------------

  /**
   * Runs one full poll cycle across ALL enabled adapters, enforcing Tier-1
   * priority ordering (Req 1.3):
   *
   *   1. Poll all enabled Tier-1 sources sequentially.
   *   2. Only after all Tier-1 sources have been processed, poll Tier-2
   *      sources sequentially.
   *
   * This method is intentionally public to support direct invocation in tests.
   */
  async runCycle(): Promise<void> {
    const enabledAdapters = this.config.adapters.filter((a) =>
      this.isSourceEnabled(a.sourceId),
    );

    // Separate by tier — preserve declaration order within each tier (Req 1.3).
    const tier1 = enabledAdapters.filter((a) => a.tier === 1);
    const tier2 = enabledAdapters.filter((a) => a.tier === 2);

    // Poll Tier-1 sources first, then Tier-2 (Req 1.3).
    for (const adapter of tier1) {
      await this.runCycleForSource(adapter);
    }
    for (const adapter of tier2) {
      await this.runCycleForSource(adapter);
    }
  }

  // ---------------------------------------------------------------------------
  // Per-source cycle
  // ---------------------------------------------------------------------------

  /**
   * Executes one fetch cycle for a single source:
   *   1. CircuitBreaker gate (Req 2.2).
   *   2. healthCheck — on failure: log, increment counter, skip fetch (Req 1.6).
   *   3. Rate-limit throttle before fetchLatest (Req 2.4).
   *   4. fetchLatest — on exception: log + return [] (Req 1.10).
   *   5. Publish each article to `news.raw` queue (Req 2.6).
   *   6. Record ingestion run in DB (Req 2.8).
   */
  private async runCycleForSource(adapter: NewsSourceAdapter): Promise<void> {
    const { sourceId, sourceName } = adapter;
    const cb = this.circuitBreakers.get(sourceId)!;
    const rl = this.rateLimiters.get(sourceId)!;

    const startedAt = new Date();

    // ── 1. CircuitBreaker gate ─────────────────────────────────────────────
    if (!cb.isAllowed()) {
      // Circuit is OPEN — see if the recovery timeout has elapsed.
      const probeAllowed = cb.tryHalfOpen();
      if (!probeAllowed) {
        logger.debug(
          { sourceId, cbState: cb.getState() },
          'CircuitBreaker is OPEN and recovery timeout has not elapsed — skipping source.',
        );
        return;
      }
      logger.info(
        { sourceId },
        'CircuitBreaker transitioning to HALF_OPEN — executing probe fetch.',
      );
    }

    // ── 2. healthCheck (Req 1.6) ──────────────────────────────────────────
    let healthOk = false;
    try {
      const health = await adapter.healthCheck();
      healthOk = health.healthy;

      if (!healthOk) {
        const failCount = this.incrementHealthFailureCount(sourceId);
        logger.warn(
          {
            sourceId,
            sourceName,
            checkedAt: health.checkedAt.toISOString(),
            statusCode: health.statusCode,
            message: health.message,
            cumulativeFailureCount: failCount,
          },
          `[Scheduler] healthCheck failed for source "${sourceName}" at ${health.checkedAt.toISOString()}.`,
        );
        cb.recordFailure();
        // Skip fetch for this source but continue the rest of the cycle.
        return;
      }
    } catch (err: unknown) {
      const failCount = this.incrementHealthFailureCount(sourceId);
      logger.warn(
        {
          sourceId,
          sourceName,
          cumulativeFailureCount: failCount,
          err,
        },
        `[Scheduler] healthCheck threw for source "${sourceName}".`,
      );
      cb.recordFailure();
      return;
    }

    // ── 3. Rate limiting (Req 2.4) ────────────────────────────────────────
    await rl.throttle();

    // ── 4. fetchLatest (Req 1.10) ─────────────────────────────────────────
    let articles: RawArticle[] = [];
    let fetchFailed = false;

    try {
      articles = await adapter.fetchLatest();
      cb.recordSuccess();

      logger.info(
        { sourceId, sourceName, articleCount: articles.length },
        `Fetched ${articles.length} article(s) from "${sourceName}".`,
      );
    } catch (err: unknown) {
      fetchFailed = true;
      cb.recordFailure();

      const stack =
        err instanceof Error ? err.stack : String(err);

      logger.error(
        {
          sourceId,
          sourceName,
          stack,
          err,
        },
        `[Scheduler] fetchLatest threw for source "${sourceName}". Returning empty article list.`,
      );
      // Do NOT propagate — Req 1.10. articles stays [].
    }

    // ── 5. Publish to news.raw queue (Req 2.6) ───────────────────────────
    let articlesPublished = 0;
    let articlesFailed = 0;

    for (const article of articles) {
      try {
        await this.config.rawQueue.add(
          RAW_QUEUE_NAME,
          {
            ...article,
            source_id: article.sourceId,
            source_name: article.sourceName,
            fetched_at: new Date().toISOString(),
            adapter_version: article.adapterVersion,
          },
          {
            // Use externalId as job deduplication key to avoid double-publishing
            // on overlapping poll windows.
            jobId: `${article.sourceId}:${article.externalId}`,
            removeOnComplete: { age: 86_400 }, // keep completed jobs for 24 h
            removeOnFail: { age: 7 * 86_400 }, // keep failed jobs for 7 days
          },
        );
        articlesPublished += 1;
      } catch (publishErr: unknown) {
        articlesFailed += 1;
        logger.error(
          { sourceId, articleId: article.externalId, err: publishErr },
          'Failed to publish article to news.raw queue.',
        );
      }
    }

    // ── 6. Record ingestion run (Req 2.8) ─────────────────────────────────
    const completedAt = new Date();
    this.lastRunAt.set(sourceId, completedAt);

    const runStatus = determineRunStatus({
      fetchFailed,
      articlesPublished,
      articlesFailed,
    });

    await this.recordIngestionRun({
      sourceId,
      startedAt,
      completedAt,
      articlesFetched: articlesPublished,
      articlesFailed,
      status: runStatus,
    });
  }

  // ---------------------------------------------------------------------------
  // Public observability
  // ---------------------------------------------------------------------------

  /**
   * Returns the current observable state for a source.
   * Returns `null` when no adapter with the given `sourceId` is registered.
   */
  getSourceStatus(sourceId: string): SourceStatus | null {
    const cb = this.circuitBreakers.get(sourceId);
    if (!cb) return null;

    return {
      cbState: cb.getState(),
      healthFailureCount: this.healthFailureCounts.get(sourceId) ?? 0,
      lastRunAt: this.lastRunAt.get(sourceId) ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Returns `true` when the source's enabled env var is set to `"true"`
   * (case-insensitive).  Any other value (including absent) → disabled
   * (Req 1.7, Req 1.8).
   */
  private isSourceEnabled(sourceId: string): boolean {
    const envKey = SOURCE_ID_TO_ENV_KEY[sourceId] ?? sourceId.toUpperCase();
    const varName = `NEWS_SOURCE_${envKey}_ENABLED`;
    const val = process.env[varName] ?? '';
    return val.toLowerCase() === 'true';
  }

  /**
   * Returns the polling interval in milliseconds for a source.
   * Reads from `NEWS_SOURCE_{NAME}_POLL_INTERVAL_MS`; falls back to
   * `DEFAULT_POLL_INTERVAL_MS` when absent or invalid (Req 1.9).
   */
  private getPollIntervalMs(sourceId: string): number {
    const envKey = SOURCE_ID_TO_ENV_KEY[sourceId] ?? sourceId.toUpperCase();
    const varName = `NEWS_SOURCE_${envKey}_POLL_INTERVAL_MS`;
    const raw = process.env[varName];

    if (raw === undefined || raw === '') {
      logger.warn(
        { sourceId, varName },
        `[Scheduler] ${varName} is absent — using default poll interval of ${DEFAULT_POLL_INTERVAL_MS}ms.`,
      );
      return DEFAULT_POLL_INTERVAL_MS;
    }

    const parsed = parseInt(raw, 10);
    if (isNaN(parsed) || parsed < 1000) {
      logger.warn(
        { sourceId, varName, raw, parsed },
        `[Scheduler] ${varName} is invalid (${raw}) — using default poll interval of ${DEFAULT_POLL_INTERVAL_MS}ms.`,
      );
      return DEFAULT_POLL_INTERVAL_MS;
    }

    return parsed;
  }

  /**
   * Increments the health-failure counter for a source and returns the new
   * cumulative count.
   */
  private incrementHealthFailureCount(sourceId: string): number {
    const current = this.healthFailureCounts.get(sourceId) ?? 0;
    const next = current + 1;
    this.healthFailureCounts.set(sourceId, next);
    return next;
  }

  /**
   * Inserts a `news_ingestion_runs` record.  Wrapped in try/catch so that
   * a missing DB connection (e.g. in unit tests) does not crash the scheduler.
   *
   * Req 2.8: record source_id, started_at, completed_at, articles_fetched,
   * articles_failed, status.
   */
  private async recordIngestionRun(data: {
    sourceId: string;
    startedAt: Date;
    completedAt: Date;
    articlesFetched: number;
    articlesFailed: number;
    status: string;
  }): Promise<void> {
    try {
      await prisma.newsIngestionRun.create({
        data: {
          sourceId: data.sourceId,
          startedAt: data.startedAt,
          completedAt: data.completedAt,
          articlesFetched: data.articlesFetched,
          articlesFailed: data.articlesFailed,
          status: data.status,
        },
      });
    } catch (err: unknown) {
      // Non-fatal — log and continue.  The scheduler must not crash due to
      // a DB connectivity issue when recording the run (Req 2.8 best-effort).
      logger.error(
        { sourceId: data.sourceId, err },
        'Failed to record ingestion run in DB — continuing.',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Pure helper — determines run status from outcome counters (Req 2.8)
// ---------------------------------------------------------------------------

/**
 * Derives the `status` value for a `news_ingestion_runs` record.
 *
 * Rules (Req 2.8):
 *   - "success"          — fetch succeeded AND all published without error
 *   - "partial_failure"  — at least one article published AND at least one failed
 *   - "failed"           — fetch itself failed, OR zero articles were fetched/published
 *                          with at least one failure
 */
export function determineRunStatus(outcome: {
  fetchFailed: boolean;
  articlesPublished: number;
  articlesFailed: number;
}): 'success' | 'partial_failure' | 'failed' {
  const { fetchFailed, articlesPublished, articlesFailed } = outcome;

  if (fetchFailed) return 'failed';
  if (articlesFailed > 0 && articlesPublished > 0) return 'partial_failure';
  if (articlesFailed > 0 && articlesPublished === 0) return 'failed';
  return 'success';
}
