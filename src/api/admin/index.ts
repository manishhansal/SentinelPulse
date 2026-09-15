/**
 * Admin API route handlers.
 *
 * Endpoints:
 *   GET /api/v1/admin/sources
 *     - List all news sources with health status, failure counter, and
 *       circuit breaker state (Req 25.4)
 *
 *   GET /api/v1/admin/ingestion
 *     - Recent ingestion runs + processing errors (Req 25.4)
 *
 *   GET /api/v1/admin/queues
 *     - Queue depth, throughput RPM, error rate, and DLQ count (Req 26.5)
 *     - Returns stub metrics since BullMQ is not connected in the handler layer
 *
 *   GET /api/v1/admin/data-quality
 *     - Four quality percentages over the trailing 24h (Req 29.4):
 *         1. articles_with_resolved_entities_pct
 *         2. articles_with_sentiment_pct
 *         3. events_with_importance_pct
 *         4. high_importance_events_with_reactions_pct (importance > 0.7)
 *     - Each percentage rounded to 2 decimal places (Req 29.4)
 *
 * Requirements: Req 25.4, Req 26.5, Req 29.4
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../db/prisma.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Trailing window for data-quality calculations (Req 29.4). */
const DATA_QUALITY_WINDOW_HOURS = 24;

/** Importance threshold for "high-importance" classification (Req 29.4). */
const HIGH_IMPORTANCE_THRESHOLD = 0.7;

/** Maximum ingestion runs returned in admin view. */
const MAX_INGESTION_RUNS = 100;

/** Maximum processing error records returned. */
const MAX_PROCESSING_ERRORS = 100;

/**
 * Known BullMQ queue names.  These are the canonical queue definitions from
 * the worker architecture (Req 26.1).  Metrics are stubs since BullMQ is not
 * directly connected in the HTTP handler layer (Req 26.5).
 */
const QUEUE_NAMES = [
  'news.raw',
  'news.normalized',
  'news.deduplicated',
  'news.entities',
  'news.events',
  'news.sentiment',
  'news.impact',
  'news.features',
  'news.embeddings',
  'news.backfill',
  // DLQ entries
  'news.raw.deadletter',
  'news.normalized.deadletter',
  'news.deduplicated.deadletter',
  'news.entities.deadletter',
  'news.events.deadletter',
  'news.sentiment.deadletter',
  'news.impact.deadletter',
  'news.features.deadletter',
  'news.embeddings.deadletter',
  'news.backfill.deadletter',
] as const;

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/v1/admin/sources
  //
  // Returns all configured news sources with health, failure counter, CB state.
  // Requirements: Req 25.4
  // ─────────────────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/admin/sources',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const sources = await prisma.newsSource.findMany({
        orderBy: [{ tier: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          name: true,
          tier: true,
          enabled: true,
          baseUrl: true,
          sourceReliability: true,
          failureCounter: true,
          disabledUntil: true,
          adapterVersion: true,
          createdAt: true,
          updatedAt: true,
          // Latest source metric for current health indication
          sourceMetrics: {
            orderBy: { recordedAt: 'desc' },
            take: 1,
            select: {
              articlesFetched: true,
              articlesFailed: true,
              avgLatencyMs: true,
              windowStart: true,
              windowEnd: true,
              recordedAt: true,
            },
          },
        },
      });

      const now = new Date();

      const result = sources.map((source) => {
        const isDisabled =
          !source.enabled ||
          (source.disabledUntil !== null && source.disabledUntil > now);

        // Circuit breaker state inference:
        // - OPEN: source is disabled due to disabledUntil > now (back-off period, Req 1.12)
        // - CLOSED: enabled and failure_counter < threshold
        // - HALF_OPEN: disabledUntil is set but has already elapsed (probe window)
        const cbState: 'CLOSED' | 'OPEN' | 'HALF_OPEN' =
          source.disabledUntil !== null && source.disabledUntil > now
            ? 'OPEN'
            : source.disabledUntil !== null && source.disabledUntil <= now
              ? 'HALF_OPEN'
              : 'CLOSED';

        const latestMetric = source.sourceMetrics[0] ?? null;

        return {
          id: source.id,
          name: source.name,
          tier: source.tier,
          enabled: source.enabled,
          health: isDisabled ? 'DOWN' : source.failureCounter > 0 ? 'DEGRADED' : 'UP',
          failure_counter: source.failureCounter,
          cb_state: cbState,
          disabled_until: source.disabledUntil ?? null,
          source_reliability: source.sourceReliability,
          adapter_version: source.adapterVersion,
          latest_metric: latestMetric
            ? {
                articles_fetched: latestMetric.articlesFetched,
                articles_failed: latestMetric.articlesFailed,
                avg_latency_ms: latestMetric.avgLatencyMs,
                window_start: latestMetric.windowStart,
                window_end: latestMetric.windowEnd,
                recorded_at: latestMetric.recordedAt,
              }
            : null,
          created_at: source.createdAt,
          updated_at: source.updatedAt,
        };
      });

      return reply.send({
        success: true,
        data: result,
        meta: {
          timestamp: new Date().toISOString(),
          total_count: result.length,
        },
      });
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/v1/admin/ingestion
  //
  // Recent ingestion runs and processing errors across all sources.
  // Supports optional source_id and status filters.
  // Requirements: Req 25.4
  // ─────────────────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/admin/ingestion',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            source_id: { type: 'string' },
            status: {
              type: 'string',
              enum: ['success', 'partial_failure', 'failed'],
            },
            date_from: { type: 'string' },
            date_to: { type: 'string' },
            limit: { type: 'number', minimum: 1, maximum: MAX_INGESTION_RUNS, default: 50 },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as {
        source_id?: string;
        status?: string;
        date_from?: string;
        date_to?: string;
        limit?: number;
      };

      const limit = Math.min(query.limit ?? 50, MAX_INGESTION_RUNS);

      // Build run filter
      const runWhere: Record<string, unknown> = {};
      if (query.source_id) runWhere['sourceId'] = query.source_id;
      if (query.status) runWhere['status'] = query.status;

      const tsFilter: Record<string, unknown> = {};
      if (query.date_from) tsFilter['gte'] = new Date(query.date_from);
      if (query.date_to) tsFilter['lte'] = new Date(query.date_to);
      if (Object.keys(tsFilter).length > 0) runWhere['startedAt'] = tsFilter;

      // Build error filter
      const errorWhere: Record<string, unknown> = {};
      if (query.source_id) errorWhere['sourceId'] = query.source_id;
      if (Object.keys(tsFilter).length > 0) errorWhere['createdAt'] = tsFilter;

      const [runs, errors, summary] = await Promise.all([
        prisma.newsIngestionRun.findMany({
          where: runWhere,
          orderBy: { startedAt: 'desc' },
          take: limit,
          select: {
            id: true,
            sourceId: true,
            startedAt: true,
            completedAt: true,
            articlesFetched: true,
            articlesFailed: true,
            status: true,
            source: {
              select: { name: true, tier: true },
            },
          },
        }),
        prisma.newsProcessingError.findMany({
          where: errorWhere,
          orderBy: { createdAt: 'desc' },
          take: MAX_PROCESSING_ERRORS,
          select: {
            id: true,
            sourceId: true,
            externalId: true,
            stage: true,
            errorType: true,
            errorMessage: true,
            createdAt: true,
          },
        }),
        // Summary counts for rapid status assessment
        prisma.newsIngestionRun.groupBy({
          by: ['status'],
          where: runWhere,
          _count: { id: true },
        }),
      ]);

      const statusSummary = Object.fromEntries(
        summary.map((s) => [s.status, s._count.id]),
      );

      return reply.send({
        success: true,
        data: {
          runs: runs.map((run) => ({
            id: run.id,
            source_id: run.sourceId,
            source_name: run.source.name,
            source_tier: run.source.tier,
            started_at: run.startedAt,
            completed_at: run.completedAt,
            articles_fetched: run.articlesFetched,
            articles_failed: run.articlesFailed,
            status: run.status,
            duration_ms:
              run.completedAt
                ? run.completedAt.getTime() - run.startedAt.getTime()
                : null,
          })),
          errors: errors.map((err) => ({
            id: err.id,
            source_id: err.sourceId,
            external_id: err.externalId,
            stage: err.stage,
            error_type: err.errorType,
            error_message: err.errorMessage,
            created_at: err.createdAt,
          })),
          summary: {
            status_counts: statusSummary,
            total_runs: runs.length,
            total_errors: errors.length,
          },
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/v1/admin/queues
  //
  // Queue depth, throughput RPM, error rate, and DLQ count per queue.
  // Returns stub data since BullMQ is not directly connected in the handler
  // layer — real metrics require a BullMQ Board or direct queue access.
  //
  // Stub values are explicitly marked as estimated/unavailable so consumers
  // are not misled.
  //
  // Requirements: Req 25.4, Req 26.5
  // ─────────────────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/admin/queues',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      // Derive DLQ names from non-DLQ queues for cleaner metadata
      const mainQueues = QUEUE_NAMES.filter((q) => !q.endsWith('.deadletter'));
      const dlqQueues = QUEUE_NAMES.filter((q) => q.endsWith('.deadletter'));

      const queueMetrics = mainQueues.map((queueName) => {
        const dlqName = `${queueName}.deadletter`;
        const hasDlq = (dlqQueues as readonly string[]).includes(dlqName);

        return {
          queue_name: queueName,
          dlq_name: hasDlq ? dlqName : null,
          // Stub metrics — BullMQ metrics require direct Redis/BullMQ connection
          depth: null,
          throughput_rpm: null,
          error_rate: null,
          dlq_count: null,
          active_count: null,
          waiting_count: null,
          completed_last_minute: null,
          failed_last_minute: null,
          metrics_available: false,
          note:
            'Queue metrics require a direct BullMQ connection. ' +
            'Connect a BullMQ metrics exporter (e.g. bull-board, Prometheus BullMQ exporter) ' +
            'for live queue depth and throughput data.',
        };
      });

      return reply.send({
        success: true,
        data: {
          queues: queueMetrics,
          total_queues: mainQueues.length,
          total_dlqs: dlqQueues.length,
        },
        meta: {
          timestamp: new Date().toISOString(),
          note: 'Queue metrics are structural stubs. Live metrics require BullMQ integration.',
        },
      });
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/v1/admin/data-quality
  //
  // Four data quality percentages over the trailing 24-hour window (Req 29.4):
  //   1. articles_with_resolved_entities_pct
  //      — articles with >= 1 resolved entity mention / total articles
  //   2. articles_with_sentiment_pct
  //      — articles with >= 1 sentiment record / total articles
  //   3. events_with_importance_pct
  //      — events with an importance record / total events
  //   4. high_importance_events_with_reactions_pct
  //      — events with importance > 0.7 AND a market reaction / total
  //        events with importance > 0.7
  //
  // All percentages rounded to 2 decimal places (Req 29.4).
  // Requirements: Req 25.4, Req 29.4
  // ─────────────────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/admin/data-quality',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const now = new Date();
      const windowStart = new Date(
        now.getTime() - DATA_QUALITY_WINDOW_HOURS * 60 * 60 * 1000,
      );

      // Run all four quality computations in parallel
      const [
        totalArticles,
        articlesWithEntities,
        articlesWithSentiment,
        totalEvents,
        eventsWithImportance,
        highImportanceEvents,
        highImportanceWithReactions,
      ] = await Promise.all([
        // 1a. Total articles in the trailing window
        prisma.newsArticle.count({
          where: { createdAt: { gte: windowStart } },
        }),

        // 1b. Articles with at least one resolved entity mention
        // A resolved mention has entityId != null
        prisma.newsArticle.count({
          where: {
            createdAt: { gte: windowStart },
            entityMentions: {
              some: { entityId: { not: null } },
            },
          },
        }),

        // 2. Articles with at least one sentiment record
        prisma.newsArticle.count({
          where: {
            createdAt: { gte: windowStart },
            sentiment: { some: {} },
          },
        }),

        // 3a. Total events created in the trailing window
        prisma.newsEvent.count({
          where: { createdAt: { gte: windowStart } },
        }),

        // 3b. Events with an importance record
        prisma.newsEvent.count({
          where: {
            createdAt: { gte: windowStart },
            importance_: { isNot: null },
          },
        }),

        // 4a. High-importance events in the trailing window
        prisma.newsImportance.count({
          where: {
            importanceScore: { gt: HIGH_IMPORTANCE_THRESHOLD },
            computedAt: { gte: windowStart },
          },
        }),

        // 4b. High-importance events with at least one market reaction
        prisma.newsImportance.count({
          where: {
            importanceScore: { gt: HIGH_IMPORTANCE_THRESHOLD },
            computedAt: { gte: windowStart },
            event: {
              marketReactions: { some: {} },
            },
          },
        }),
      ]);

      /**
       * Computes a percentage rounded to 2 decimal places.
       * Returns null when the denominator is zero.
       */
      const pct = (numerator: number, denominator: number): number | null => {
        if (denominator === 0) return null;
        return Math.round((numerator / denominator) * 10_000) / 100;
      };

      const dataQuality = {
        window_start: windowStart.toISOString(),
        window_end: now.toISOString(),
        window_hours: DATA_QUALITY_WINDOW_HOURS,

        // 1. Entity resolution coverage
        articles_with_resolved_entities_pct: pct(articlesWithEntities, totalArticles),
        articles_with_resolved_entities_count: articlesWithEntities,
        total_articles: totalArticles,

        // 2. Sentiment coverage
        articles_with_sentiment_pct: pct(articlesWithSentiment, totalArticles),
        articles_with_sentiment_count: articlesWithSentiment,

        // 3. Importance score coverage
        events_with_importance_pct: pct(eventsWithImportance, totalEvents),
        events_with_importance_count: eventsWithImportance,
        total_events: totalEvents,

        // 4. High-importance events with reaction coverage
        high_importance_events_with_reactions_pct: pct(
          highImportanceWithReactions,
          highImportanceEvents,
        ),
        high_importance_events_with_reactions_count: highImportanceWithReactions,
        total_high_importance_events: highImportanceEvents,
        high_importance_threshold: HIGH_IMPORTANCE_THRESHOLD,
      };

      return reply.send({
        success: true,
        data: dataQuality,
        meta: {
          timestamp: now.toISOString(),
        },
      });
    },
  );
}
