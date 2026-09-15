/**
 * Admin API route handlers.
 *
 * Endpoints:
 *   GET /api/v1/admin/sources
 *   GET /api/v1/admin/ingestion
 *   GET /api/v1/admin/queues
 *   GET /api/v1/admin/data-quality
 *
 *   POST /api/v1/admin/test/pipeline   (Phase 3A)
 *     - Controlled smoke test: drives a single article through all 12 pipeline
 *       stages inline (bypasses BullMQ for the test), returns complete lineage.
 *
 *   GET /api/v1/admin/lineage/:articleId   (Phase 3A)
 *     - Returns the complete pipeline lineage for a processed article.
 *
 * Requirements: Req 25.4, Req 26.5, Req 29.4
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import { prisma } from '../../db/prisma.js';
import { NormalizationEngine } from '../../engines/normalization/NormalizationEngine.js';
import { DeduplicationEngine } from '../../engines/deduplication/DeduplicationEngine.js';
import { EntityResolutionEngine } from '../../engines/entity/EntityResolutionEngine.js';
import { EventDetectionEngine } from '../../engines/event-detection/EventDetectionEngine.js';
import { SentimentEngine } from '../../engines/sentiment/SentimentEngine.js';
import { ImportanceEngine } from '../../engines/importance/ImportanceEngine.js';
import { IndianMarketImpactEngine } from '../../engines/market-impact/IndianMarketImpactEngine.js';
import { HistoricalReactionEngine } from '../../engines/historical-reaction/HistoricalReactionEngine.js';
import { DataServiceClient } from '../../integrations/data-service/DataServiceClient.js';
import { FeatureEngineeringEngine } from '../../engines/feature-engineering/FeatureEngineeringEngine.js';
import { upsertMarketImpact } from '../../db/prisma.js';

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

// eslint-disable-next-line @typescript-eslint/require-await
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

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/v1/admin/test/pipeline
  //
  // Controlled smoke test: drives a single article through all 12 pipeline
  // stages inline (no BullMQ queue dispatch) and returns the complete
  // lineage with per-stage results.
  //
  // Body (optional):
  //   {
  //     source_id?: string  — defaults to "reuters"
  //     title?:    string   — defaults to a canned test headline
  //     content?:  string   — defaults to a canned test body
  //   }
  //
  // Phase 3A smoke test endpoint.
  // ─────────────────────────────────────────────────────────────────────────
  app.post(
    '/api/v1/admin/test/pipeline',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            source_id: { type: 'string' },
            title: { type: 'string' },
            content: { type: 'string' },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const startedAt = new Date();
      const body = (request.body ?? {}) as {
        source_id?: string;
        title?: string;
        content?: string;
      };

      const sourceId = body.source_id ?? 'reuters';
      const testTitle =
        body.title ??
        'RBI keeps repo rate unchanged at 6.5%, raises inflation forecast';
      const testContent =
        body.content ??
        'The Reserve Bank of India Monetary Policy Committee voted 4-2 to hold the repo ' +
        'rate at 6.50% for the eighth consecutive meeting. Governor Shaktikanta Das cited ' +
        'elevated core inflation (5.1%) and resilient growth (GDP 7.2%) as reasons to ' +
        'maintain the current stance. NIFTY 50 fell 0.3% on the decision. Markets had ' +
        'priced a 30% probability of a 25bp cut. The next MPC meeting is scheduled for ' +
        'October 2026. FII net flows were negative at ₹850 crore on the day.';

      // Verify the source exists in the DB before proceeding
      const source = await prisma.newsSource.findUnique({ where: { id: sourceId } });
      if (!source) {
        return reply.status(400).send({
          success: false,
          error: `Source '${sourceId}' not found in news_sources. Run seed-sources first.`,
          meta: { timestamp: startedAt.toISOString() },
        });
      }

      const stageResults: Record<string, unknown> = {};
      const errors: string[] = [];

      // ── STAGE 1: Synthetic RawArticle ─────────────────────────────────────
      const externalId = `test-pipeline-${randomUUID().slice(0, 8)}`;
      const rawArticle = {
        sourceId,
        sourceName: source.name,
        externalId,
        url: `https://test.sentinelpulse.internal/articles/${externalId}`,
        title: testTitle,
        summary: testContent.slice(0, 200),
        content: testContent,
        author: 'SentinelPulse Test',
        // Use 1 hour in the FUTURE as publishedAt so all downstream computedAt
        // timestamps (computed in milliseconds) fall before eventTimestamp.
        // This is intentionally synthetic — the smoke test validates pipeline
        // wiring, not temporal correctness. Real articles have publishedAt in
        // the past so the LookAheadGuard protects them correctly.
        publishedAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        adapterVersion: '1.0.0',
      };
      stageResults['stage_1_source'] = {
        status: 'OK',
        source_id: sourceId,
        external_id: externalId,
        title: testTitle,
        content_length: testContent.length,
      };

      // ── STAGE 2: NORMALIZATION ─────────────────────────────────────────────
      let articleId: string;
      try {
        // Create a stub normalizedQueue that records the published job payload
        // but doesn't need a real Redis connection for the test.
        const stubNormalizedQueue = {
          add: () => Promise.resolve({ id: 'test-job' }),
        } as unknown as Queue;

        const normEngine = new NormalizationEngine(stubNormalizedQueue);
        const normalized = await normEngine.process(rawArticle as Parameters<typeof normEngine.process>[0]);
        articleId = normalized.id;
        stageResults['stage_2_normalization'] = {
          status: 'OK',
          article_id: articleId,
          language: normalized.language,
          category: normalized.category,
          content_depth: normalized.contentDepth,
          content_quality_score: normalized.contentQualityScore,
          content_truncated: normalized.contentTruncated,
          timestamp_inferred: normalized.timestampInferred,
        };
      } catch (err) {
        const msg = `Normalization failed: ${err instanceof Error ? err.message : String(err)}`;
        errors.push(msg);
        return reply.status(500).send({
          success: false,
          error: msg,
          stage_results: stageResults,
          meta: { timestamp: startedAt.toISOString() },
        });
      }

      // ── STAGE 3: DEDUPLICATION ────────────────────────────────────────────
      let clusterId: string | undefined;
      try {
        const stubDedupQueue = { add: () => Promise.resolve({ id: 'test-job' }) } as unknown as Queue;

        // Fetch the article we just normalized
        const article = await prisma.newsArticle.findUnique({ where: { id: articleId } });
        if (article) {
          const dedupEngine = new DeduplicationEngine(stubDedupQueue);
          const dedupResult = await dedupEngine.process({
            id: article.id,
            sourceId: article.sourceId,
            sourceName: source.name,
            externalId: article.externalId,
            canonicalUrl: article.canonicalUrl,
            title: article.title,
            contentHash: article.contentHash,
            titleHash: article.titleHash,
            publishedAt: article.publishedAt,
            tier: source.tier as 1 | 2,
          });
          clusterId = dedupResult.clusterId ?? undefined;
          stageResults['stage_3_deduplication'] = {
            status: 'OK',
            is_duplicate: dedupResult.isDuplicate,
            cluster_id: clusterId ?? null,
            cluster_action: dedupResult.clusterAction,
          };
        }
      } catch (err) {
        const msg = `Deduplication failed: ${err instanceof Error ? err.message : String(err)}`;
        errors.push(msg);
        stageResults['stage_3_deduplication'] = { status: 'ERROR', error: msg };
      }

      // ── STAGE 4: ENTITY RESOLUTION ────────────────────────────────────────
      try {
        const stubEntitiesQueue = { add: () => Promise.resolve({ id: 'test-job' }) } as unknown as Queue;
        const article = await prisma.newsArticle.findUnique({ where: { id: articleId } });
        if (article) {
          const entityEngine = new EntityResolutionEngine(stubEntitiesQueue);
          await entityEngine.process({
            id: article.id,
            sourceId: article.sourceId,
            externalId: article.externalId,
            title: article.title,
            summary: article.summary,
            content: article.content,
            publishedAt: article.publishedAt,
          });
          const mentionCount = await prisma.newsEntityMention.count({ where: { articleId } });
          const assetLinkCount = await prisma.newsAssetLink.count({ where: { articleId } });
          stageResults['stage_4_entity'] = {
            status: 'OK',
            entity_mentions: mentionCount,
            asset_links: assetLinkCount,
          };
        }
      } catch (err) {
        const msg = `Entity resolution failed: ${err instanceof Error ? err.message : String(err)}`;
        errors.push(msg);
        stageResults['stage_4_entity'] = { status: 'ERROR', error: msg };
      }

      // ── STAGE 5: EVENT DETECTION ──────────────────────────────────────────
      let eventId: string | undefined;
      try {
        const stubEventsQueue = { add: () => Promise.resolve({ id: 'test-job' }) } as unknown as Queue;
        const article = await prisma.newsArticle.findUnique({ where: { id: articleId } });
        if (article) {
          const eventEngine = new EventDetectionEngine(stubEventsQueue);
          await eventEngine.process({
            id: article.id,
            sourceId: article.sourceId,
            title: article.title,
            summary: article.summary,
            content: article.content,
            publishedAt: article.publishedAt,
          });
          const events = await prisma.newsEvent.findMany({
            where: { articleId },
            select: { id: true, eventType: true, actor: true },
          });
          eventId = events[0]?.id;
          stageResults['stage_5_event'] = {
            status: 'OK',
            events_detected: events.length,
            event_id: eventId ?? null,
            event_types: events.map((e) => e.eventType),
          };
        }
      } catch (err) {
        const msg = `Event detection failed: ${err instanceof Error ? err.message : String(err)}`;
        errors.push(msg);
        stageResults['stage_5_event'] = { status: 'ERROR', error: msg };
      }

      // ── STAGE 6: SENTIMENT ────────────────────────────────────────────────
      try {
        const stubSentimentQueue = { add: () => Promise.resolve({ id: 'test-job' }) } as unknown as Queue;
        const sentimentEngine = new SentimentEngine(stubSentimentQueue);
        const result = await sentimentEngine.process({
          id: articleId,
          title: testTitle,
          content: testContent,
          eventId,
        });
        stageResults['stage_6_sentiment'] = {
          status: 'OK',
          sentiment_score: Number(result.sentimentScore),
          market_sentiment: Number(result.marketSentiment),
          qualitative_signals: result.qualitativeSignals,
          model_version: result.modelVersion,
        };
      } catch (err) {
        const msg = `Sentiment failed: ${err instanceof Error ? err.message : String(err)}`;
        errors.push(msg);
        stageResults['stage_6_sentiment'] = { status: 'ERROR', error: msg };
      }

      // ── STAGE 7: IMPORTANCE ───────────────────────────────────────────────
      let importanceScore: number | undefined;
      try {
        if (eventId) {
          const stubImpactQueue = { add: () => Promise.resolve({ id: 'test-job' }) } as unknown as Queue;
          const event = await prisma.newsEvent.findUnique({ where: { id: eventId } });
          if (event) {
            const importanceEngine = new ImportanceEngine(stubImpactQueue);
            const result = await importanceEngine.process({
              id: event.id,
              articleId: event.articleId,
              eventType: event.eventType,
              sourceId: sourceId,
              surpriseScore: event.surpriseScore,
              publishedAt: event.eventTimestamp,
            });
            importanceScore = result.importanceScore;
            stageResults['stage_7_importance'] = {
              status: 'OK',
              importance_score: result.importanceScore,
              historical_data_available: result.historicalDataAvailable,
              sub_scores: result.subScores,
            };
          }
        } else {
          stageResults['stage_7_importance'] = { status: 'SKIPPED', reason: 'no event detected' };
        }
      } catch (err) {
        const msg = `Importance failed: ${err instanceof Error ? err.message : String(err)}`;
        errors.push(msg);
        stageResults['stage_7_importance'] = { status: 'ERROR', error: msg };
      }

      // ── STAGE 8: MARKET IMPACT ────────────────────────────────────────────
      let impactAssets: string[] = [];
      try {
        if (eventId) {
          const event = await prisma.newsEvent.findUnique({ where: { id: eventId } });
          if (event) {
            const impactEngine = new IndianMarketImpactEngine();
            const impacts = impactEngine.getAffectedAssets(
              event.eventType,
              event.actor ?? null,
              event.action ?? testTitle,
            );
            impactAssets = impacts.map((i) => i.assetId).filter(Boolean);

            for (const impact of impacts) {
              await upsertMarketImpact({
                articleId,
                eventId: event.id,
                assetId: impact.assetId ?? undefined,
                sectorId: impact.sectorId ?? undefined,
                direction: impact.direction,
                strength: impact.strength,
                confidence: impact.confidence,
                expectedHorizon: impact.expectedHorizon,
                evidenceType: impact.evidenceType,
                impactComputationVersion: '1.0.0',
                newsImpactScore: impact.direction === 'POSITIVE'
                  ? impact.strength * 50
                  : impact.direction === 'NEGATIVE'
                    ? -impact.strength * 50
                    : 0,
              });
            }
            stageResults['stage_8_market_impact'] = {
              status: 'OK',
              impacts_created: impacts.length,
              affected_assets: impactAssets,
            };
          }
        } else {
          stageResults['stage_8_market_impact'] = { status: 'SKIPPED', reason: 'no event detected' };
        }
      } catch (err) {
        const msg = `Market impact failed: ${err instanceof Error ? err.message : String(err)}`;
        errors.push(msg);
        stageResults['stage_8_market_impact'] = { status: 'ERROR', error: msg };
      }

      // ── STAGE 9: HISTORICAL REACTION ──────────────────────────────────────
      try {
        if (eventId && impactAssets.length > 0) {
          const event = await prisma.newsEvent.findUnique({ where: { id: eventId } });
          if (event) {
            const reactionEngine = new HistoricalReactionEngine(new DataServiceClient());
            await reactionEngine.process({
              id: event.id,
              eventTimestamp: event.eventTimestamp,
              assetIds: impactAssets.slice(0, 3), // cap at 3 for test
            });
            const reactionCount = await prisma.newsMarketReaction.count({ where: { eventId } });
            stageResults['stage_9_historical_reaction'] = {
              status: 'OK',
              reactions_created: reactionCount,
            };
          }
        } else {
          stageResults['stage_9_historical_reaction'] = {
            status: 'SKIPPED',
            reason: eventId ? 'no affected assets' : 'no event detected',
          };
        }
      } catch (err) {
        const msg = `Historical reaction failed: ${err instanceof Error ? err.message : String(err)}`;
        errors.push(msg);
        stageResults['stage_9_historical_reaction'] = { status: 'ERROR', error: msg };
      }

      // ── STAGE 10–12: FEATURES, TRAINING SAMPLE, EMBEDDING ────────────────
      // Features are only computed for importance_score > 0.3
      if (eventId && importanceScore !== undefined && importanceScore > 0.3) {
        // STAGE 10: FEATURES
        try {
          const stubFeaturesQueue = { add: () => Promise.resolve({ id: 'test-job' }) } as unknown as Queue;
          const event = await prisma.newsEvent.findUnique({ where: { id: eventId } });
          if (event) {
            const featureEngine = new FeatureEngineeringEngine(stubFeaturesQueue);
            await featureEngine.process({
              id: event.id,
              articleId: event.articleId,
              eventType: event.eventType,
              eventTimestamp: event.eventTimestamp,
              assetId: impactAssets[0],
            });
            const featureCount = await prisma.newsFeature.count({ where: { eventId } });
            stageResults['stage_10_features'] = {
              status: 'OK',
              features_created: featureCount,
            };
          }
        } catch (err) {
          const msg = `Feature engineering failed: ${err instanceof Error ? err.message : String(err)}`;
          errors.push(msg);
          stageResults['stage_10_features'] = { status: 'ERROR', error: msg };
        }
      } else {
        stageResults['stage_10_features'] = {
          status: 'SKIPPED',
          reason: eventId
            ? `importance_score=${importanceScore?.toFixed(3) ?? 'unknown'} <= 0.3 threshold`
            : 'no event detected',
        };
      }

      stageResults['stage_11_training_sample'] = {
        status: 'SKIPPED',
        reason: 'Training samples require labeled future returns — cannot be created synchronously in smoke test',
      };

      stageResults['stage_12_embedding'] = {
        status: 'SKIPPED',
        reason: 'Embedding stage is non-blocking and async — EMBEDDING_API_KEY not configured in this environment',
      };

      // ── COLLECT LINEAGE ───────────────────────────────────────────────────
      const lineage = await buildLineage(articleId);

      const completedAt = new Date();
      const durationMs = completedAt.getTime() - startedAt.getTime();
      const stagesCompleted = Object.values(stageResults).filter(
        (s) => (s as { status: string }).status === 'OK',
      ).length;

      return reply.send({
        success: errors.length === 0,
        data: {
          article_id: articleId,
          external_id: externalId,
          source_id: sourceId,
          stages_completed: stagesCompleted,
          stages_total: 12,
          errors,
          stage_results: stageResults,
          lineage,
        },
        meta: {
          timestamp: startedAt.toISOString(),
          completed_at: completedAt.toISOString(),
          duration_ms: durationMs,
        },
      });
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/v1/admin/lineage/:articleId
  //
  // Returns the complete pipeline lineage for an already-processed article.
  //
  // Lineage chain:
  //   article → cluster → entity_mentions → asset_links → sector_links
  //           → events → sentiment → importance → market_impacts
  //           → market_reactions → features → training_samples
  //
  // If any stage is missing, that key will be null/empty with a note.
  //
  // Phase 3A lineage validation endpoint.
  // ─────────────────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/admin/lineage/:articleId',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { articleId } = request.params as { articleId: string };

      if (!articleId || articleId.trim() === '') {
        return reply.status(400).send({
          success: false,
          error: 'articleId is required',
          meta: { timestamp: new Date().toISOString() },
        });
      }

      const article = await prisma.newsArticle.findUnique({ where: { id: articleId } });
      if (!article) {
        return reply.status(404).send({
          success: false,
          error: `Article not found: ${articleId}`,
          meta: { timestamp: new Date().toISOString() },
        });
      }

      const lineage = await buildLineage(articleId);

      // Derive missing-stage summary
      const missing: string[] = [];
      if (!lineage.cluster_id) missing.push('cluster (dedup not run or article is unique head)');
      if (lineage.entity_mention_count === 0) missing.push('entity_mentions');
      if (lineage.asset_links.length === 0) missing.push('asset_links');
      if (lineage.events.length === 0) missing.push('events');
      if (lineage.sentiment_count === 0) missing.push('sentiment');

      // Type-narrow events to access nested arrays
      const typedEvents = lineage.events as Array<{
        importance: Record<string, unknown> | null;
        market_impacts: unknown[];
        market_reactions: unknown[];
        features: unknown[];
        training_samples: unknown[];
      }>;
      if (typedEvents.some((e) => !e.importance)) missing.push('importance (for some events)');
      if (typedEvents.some((e) => e.market_impacts.length === 0)) missing.push('market_impacts (for some events)');
      if (typedEvents.some((e) => e.market_reactions.length === 0)) missing.push('market_reactions (for some events)');
      if (typedEvents.some((e) => e.features.length === 0)) missing.push('features (for some events)');
      if (typedEvents.some((e) => e.training_samples.length === 0)) missing.push('training_samples (for some events)');

      return reply.send({
        success: true,
        data: {
          article_id: articleId,
          is_complete: missing.length === 0,
          missing_stages: missing,
          lineage,
        },
        meta: { timestamp: new Date().toISOString() },
      });
    },
  );
}

// ---------------------------------------------------------------------------
// buildLineage() — assembles the full pipeline lineage for one article
// ---------------------------------------------------------------------------

async function buildLineage(articleId: string): Promise<ArticleLineage> {
  const [
    article,
    entityMentions,
    assetLinks,
    sectorLinks,
    sentimentRows,
    events,
  ] = await Promise.all([
    prisma.newsArticle.findUnique({
      where: { id: articleId },
      select: {
        id: true,
        sourceId: true,
        externalId: true,
        canonicalUrl: true,
        title: true,
        language: true,
        publishedAt: true,
        scrapedAt: true,
        category: true,
        contentDepth: true,
        contentQualityScore: true,
        contentTruncated: true,
        timestampInferred: true,
        clusterId: true,
        createdAt: true,
        source: { select: { name: true, tier: true } },
        cluster: { select: { id: true, headline: true, sourceCount: true, consensusScore: true } },
      },
    }),
    prisma.newsEntityMention.count({ where: { articleId } }),
    prisma.newsAssetLink.findMany({
      where: { articleId },
      select: { assetId: true, confidence: true },
    }),
    prisma.newsSectorLink.findMany({
      where: { articleId },
      select: { sectorId: true, confidence: true },
    }),
    prisma.newsSentiment.findMany({
      where: { articleId },
      select: {
        id: true,
        sentimentScore: true,
        marketSentiment: true,
        companySentiment: true,
        macroSentiment: true,
        riskSentiment: true,
        qualitativeSignals: true,
        confidence: true,
        modelVersion: true,
        computedAt: true,
      },
    }),
    prisma.newsEvent.findMany({
      where: { articleId },
      include: {
        importance_: {
          select: {
            id: true,
            importanceScore: true,
            subScores: true,
            historicalDataAvailable: true,
            modelVersion: true,
            computedAt: true,
          },
        },
        marketImpacts: {
          select: {
            id: true,
            assetId: true,
            sectorId: true,
            direction: true,
            strength: true,
            confidence: true,
            newsImpactScore: true,
            expectedHorizon: true,
            evidenceType: true,
            computedAt: true,
          },
        },
        marketReactions: {
          select: {
            id: true,
            assetId: true,
            return5m: true,
            return15m: true,
            return1h: true,
            return1d: true,
            highImpactFlag: true,
            computedAt: true,
          },
        },
        features: {
          select: {
            id: true,
            assetId: true,
            featureType: true,
            featureVersion: true,
            computedAt: true,
          },
        },
        trainingSamples: {
          select: {
            id: true,
            assetId: true,
            featureVersion: true,
            label5m: true,
            label1d: true,
            createdAt: true,
          },
        },
      },
    }),
  ]);

  return {
    article_id: articleId,
    source_id: article?.sourceId ?? null,
    source_name: article?.source.name ?? null,
    source_tier: article?.source.tier ?? null,
    title: article?.title ?? null,
    language: article?.language ?? null,
    published_at: article?.publishedAt ?? null,
    scraped_at: article?.scrapedAt ?? null,
    category: article?.category ?? null,
    content_depth: article?.contentDepth ?? null,
    content_quality_score: article?.contentQualityScore ?? null,
    content_truncated: article?.contentTruncated ?? null,
    timestamp_inferred: article?.timestampInferred ?? null,
    cluster_id: article?.clusterId ?? null,
    cluster: article?.cluster
      ? {
          id: article.cluster.id,
          headline: article.cluster.headline,
          source_count: article.cluster.sourceCount,
          consensus_score: Number(article.cluster.consensusScore),
        }
      : null,
    entity_mention_count: entityMentions,
    asset_links: assetLinks.map((l) => ({
      asset_id: l.assetId,
      confidence: Number(l.confidence),
    })),
    sector_links: sectorLinks.map((l) => ({
      sector_id: l.sectorId,
      confidence: Number(l.confidence),
    })),
    sentiment_count: sentimentRows.length,
    sentiment: sentimentRows.map((s) => ({
      id: s.id,
      sentiment_score: Number(s.sentimentScore),
      market_sentiment: Number(s.marketSentiment),
      company_sentiment: Number(s.companySentiment),
      macro_sentiment: Number(s.macroSentiment),
      risk_sentiment: Number(s.riskSentiment),
      qualitative_signals: s.qualitativeSignals,
      confidence: Number(s.confidence),
      model_version: s.modelVersion,
      computed_at: s.computedAt,
    })),
    events: events.map((e) => ({
      event_id: e.id,
      event_type: e.eventType,
      actor: e.actor ?? null,
      action: e.action ?? null,
      event_timestamp: e.eventTimestamp,
      confidence: e.confidence,
      surprise_direction: e.surpriseDirection ?? null,
      surprise_score: e.surpriseScore ?? null,
      importance: e.importance_ ? {
        id: e.importance_.id,
        importance_score: e.importance_.importanceScore,
        historical_data_available: e.importance_.historicalDataAvailable,
        model_version: e.importance_.modelVersion,
        computed_at: e.importance_.computedAt,
      } : null,
      market_impacts: e.marketImpacts.map((i) => ({
        id: i.id,
        asset_id: i.assetId ?? null,
        sector_id: i.sectorId ?? null,
        direction: i.direction,
        strength: i.strength,
        confidence: i.confidence,
        news_impact_score: i.newsImpactScore ?? null,
        expected_horizon: i.expectedHorizon,
        evidence_type: i.evidenceType,
        computed_at: i.computedAt,
      })),
      market_reactions: e.marketReactions.map((r) => ({
        id: r.id,
        asset_id: r.assetId,
        return_5m: r.return5m ?? null,
        return_15m: r.return15m ?? null,
        return_1h: r.return1h ?? null,
        return_1d: r.return1d ?? null,
        high_impact_flag: r.highImpactFlag,
        computed_at: r.computedAt,
      })),
      features: e.features.map((f) => ({
        id: f.id,
        asset_id: f.assetId ?? null,
        feature_type: f.featureType,
        feature_version: f.featureVersion,
        computed_at: f.computedAt,
      })),
      training_samples: e.trainingSamples.map((t) => ({
        id: t.id,
        asset_id: t.assetId,
        feature_version: t.featureVersion,
        label_5m: t.label5m ?? null,
        label_1d: t.label1d ?? null,
        created_at: t.createdAt,
      })),
    })),
  };
}

// Type for the buildLineage return value
interface ArticleLineage {
  article_id: string;
  source_id: string | null;
  source_name: string | null;
  source_tier: number | null;
  title: string | null;
  language: string | null;
  published_at: Date | null;
  scraped_at: Date | null;
  category: string | null;
  content_depth: string | null;
  content_quality_score: number | null;
  content_truncated: boolean | null;
  timestamp_inferred: boolean | null;
  cluster_id: string | null;
  cluster: { id: string; headline: string; source_count: number; consensus_score: number } | null;
  entity_mention_count: number;
  asset_links: Array<{ asset_id: string; confidence: number }>;
  sector_links: Array<{ sector_id: string; confidence: number }>;
  sentiment_count: number;
  sentiment: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
}
