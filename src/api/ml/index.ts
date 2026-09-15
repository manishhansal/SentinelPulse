/**
 * ML / Data API route handlers.
 *
 * Endpoints:
 *   GET /api/v1/ml/features/market
 *   GET /api/v1/ml/features/asset/:assetId
 *   GET /api/v1/ml/features/sector/:sector
 *     - Feature vectors scoped to market, asset, or sector (Req 25.3)
 *
 *   GET /api/v1/ml/training/events
 *     - Paginated list of NewsEvents with importance data
 *       (max 1,000/page, Req 25.3)
 *
 *   GET /api/v1/ml/training/samples
 *     - Paginated list of TrainingSamples with labels
 *       (max 1,000/page, Req 25.3)
 *
 *   GET /api/v1/ml/historical-reactions
 *     - NewsMarketReaction records with optional filters
 *
 *   GET /api/v1/ml/training/samples/:sampleId/lineage
 *     - Full provenance chain:
 *       TrainingSample → FeatureVector → NewsEvent → NormalizedArticle → RawArticle metadata
 *     - HTTP 404 if sampleId not found (Req 33.3)
 *
 * Requirements: Req 25.3, Req 22.5, Req 33.3
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma, MAX_QUERY_RESULTS } from '../../db/prisma.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard cap on page size for paginated ML endpoints (Req 25.3). */
const ML_PAGE_MAX = 1_000;

/** Default page size when caller does not specify. */
const ML_PAGE_DEFAULT = 100;

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerMlRoutes(app: FastifyInstance): Promise<void> {
  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/v1/ml/features/market
  //
  // Most recent market-scoped feature vectors (VELOCITY, BREADTH, etc.).
  // Requirements: Req 25.3
  // ─────────────────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/ml/features/market',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            feature_type: { type: 'string' },
            limit: { type: 'number', minimum: 1, maximum: ML_PAGE_MAX, default: ML_PAGE_DEFAULT },
            cursor: { type: 'string' },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as {
        feature_type?: string;
        limit?: number;
        cursor?: string;
      };

      const limit = Math.min(query.limit ?? ML_PAGE_DEFAULT, ML_PAGE_MAX);
      const cursorDate = query.cursor ? new Date(query.cursor) : undefined;

      const where: Record<string, unknown> = {
        assetId: null,
        entityType: { not: null },
      };

      if (query.feature_type) {
        where['featureType'] = query.feature_type;
      }

      if (cursorDate) {
        where['computedAt'] = { lt: cursorDate };
      }

      const features = await prisma.newsFeature.findMany({
        where,
        orderBy: { computedAt: 'desc' },
        take: limit + 1,
        select: {
          id: true,
          featureType: true,
          entityType: true,
          entityId: true,
          featureVector: true,
          window: true,
          value: true,
          baseline: true,
          momentum: true,
          featureVersion: true,
          pipelineVersion: true,
          computedAt: true,
        },
      });

      const hasNextPage = features.length > limit;
      const rows = hasNextPage ? features.slice(0, limit) : features;
      const nextCursor =
        hasNextPage && rows.length > 0
          ? rows[rows.length - 1]!.computedAt.toISOString()
          : null;

      return reply.send({
        success: true,
        data: rows,
        meta: {
          timestamp: new Date().toISOString(),
          total_count: rows.length,
          next_cursor: nextCursor,
          has_next_page: hasNextPage,
          truncated: rows.length >= MAX_QUERY_RESULTS,
        },
      });
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/v1/ml/features/asset/:assetId
  //
  // Feature vectors for a specific asset, ordered by most recent first.
  // Requirements: Req 25.3
  // ─────────────────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/ml/features/asset/:assetId',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            feature_type: { type: 'string' },
            feature_version: { type: 'string' },
            limit: { type: 'number', minimum: 1, maximum: ML_PAGE_MAX, default: ML_PAGE_DEFAULT },
            cursor: { type: 'string' },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { assetId } = request.params as { assetId: string };
      const query = request.query as {
        feature_type?: string;
        feature_version?: string;
        limit?: number;
        cursor?: string;
      };

      const limit = Math.min(query.limit ?? ML_PAGE_DEFAULT, ML_PAGE_MAX);
      const cursorDate = query.cursor ? new Date(query.cursor) : undefined;

      const where: Record<string, unknown> = { assetId };

      if (query.feature_type) {
        where['featureType'] = query.feature_type;
      }
      if (query.feature_version) {
        where['featureVersion'] = query.feature_version;
      }
      if (cursorDate) {
        where['computedAt'] = { lt: cursorDate };
      }

      const features = await prisma.newsFeature.findMany({
        where,
        orderBy: { computedAt: 'desc' },
        take: limit + 1,
        select: {
          id: true,
          eventId: true,
          featureType: true,
          featureVector: true,
          window: true,
          value: true,
          baseline: true,
          momentum: true,
          featureVersion: true,
          pipelineVersion: true,
          computedAt: true,
        },
      });

      const hasNextPage = features.length > limit;
      const rows = hasNextPage ? features.slice(0, limit) : features;
      const nextCursor =
        hasNextPage && rows.length > 0
          ? rows[rows.length - 1]!.computedAt.toISOString()
          : null;

      return reply.send({
        success: true,
        data: rows,
        meta: {
          timestamp: new Date().toISOString(),
          asset_id: assetId,
          total_count: rows.length,
          next_cursor: nextCursor,
          has_next_page: hasNextPage,
        },
      });
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/v1/ml/features/sector/:sector
  //
  // Feature vectors for a specific sector.
  // Requirements: Req 25.3
  // ─────────────────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/ml/features/sector/:sector',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            feature_type: { type: 'string' },
            limit: { type: 'number', minimum: 1, maximum: ML_PAGE_MAX, default: ML_PAGE_DEFAULT },
            cursor: { type: 'string' },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { sector } = request.params as { sector: string };
      const query = request.query as {
        feature_type?: string;
        limit?: number;
        cursor?: string;
      };

      const limit = Math.min(query.limit ?? ML_PAGE_DEFAULT, ML_PAGE_MAX);
      const cursorDate = query.cursor ? new Date(query.cursor) : undefined;

      // Sector-scoped features: entity_type = sector-related type or
      // features linked to sector via news_sector_links join.
      // We query features where entity_id matches the sector id,
      // using entity_type to scope.
      const where: Record<string, unknown> = {
        entityId: sector,
      };

      if (query.feature_type) {
        where['featureType'] = query.feature_type;
      }
      if (cursorDate) {
        where['computedAt'] = { lt: cursorDate };
      }

      const features = await prisma.newsFeature.findMany({
        where,
        orderBy: { computedAt: 'desc' },
        take: limit + 1,
        select: {
          id: true,
          eventId: true,
          featureType: true,
          entityType: true,
          featureVector: true,
          value: true,
          baseline: true,
          momentum: true,
          featureVersion: true,
          pipelineVersion: true,
          computedAt: true,
        },
      });

      const hasNextPage = features.length > limit;
      const rows = hasNextPage ? features.slice(0, limit) : features;
      const nextCursor =
        hasNextPage && rows.length > 0
          ? rows[rows.length - 1]!.computedAt.toISOString()
          : null;

      return reply.send({
        success: true,
        data: rows,
        meta: {
          timestamp: new Date().toISOString(),
          sector,
          total_count: rows.length,
          next_cursor: nextCursor,
          has_next_page: hasNextPage,
        },
      });
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/v1/ml/training/events
  //
  // Paginated list of NewsEvents with importance data, suitable for ML
  // training dataset assembly.
  // Filters: event_type, min_importance, date_from, date_to.
  // Max 1,000 records per page (Req 25.3).
  // Requirements: Req 25.3, Req 22.5
  // ─────────────────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/ml/training/events',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            event_type: { type: 'string' },
            min_importance: { type: 'number', minimum: 0, maximum: 1 },
            date_from: { type: 'string' },
            date_to: { type: 'string' },
            asset_id: { type: 'string' },
            limit: { type: 'number', minimum: 1, maximum: ML_PAGE_MAX, default: ML_PAGE_DEFAULT },
            cursor: { type: 'string' },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as {
        event_type?: string;
        min_importance?: number;
        date_from?: string;
        date_to?: string;
        asset_id?: string;
        limit?: number;
        cursor?: string;
      };

      const limit = Math.min(query.limit ?? ML_PAGE_DEFAULT, ML_PAGE_MAX);
      const cursorDate = query.cursor ? new Date(query.cursor) : undefined;

      // Build event filter
      const eventWhere: Record<string, unknown> = {};

      if (query.event_type) {
        eventWhere['eventType'] = query.event_type;
      }

      // Timestamp window filter
      const tsFilter: Record<string, unknown> = {};
      if (query.date_from) tsFilter['gte'] = new Date(query.date_from);
      if (query.date_to) tsFilter['lte'] = new Date(query.date_to);
      if (Object.keys(tsFilter).length > 0) {
        eventWhere['eventTimestamp'] = tsFilter;
      }

      if (cursorDate) {
        // Cursor pagination on eventTimestamp desc
        eventWhere['eventTimestamp'] = {
          ...(typeof eventWhere['eventTimestamp'] === 'object' &&
          eventWhere['eventTimestamp'] !== null
            ? (eventWhere['eventTimestamp'] as Record<string, unknown>)
            : {}),
          lt: cursorDate,
        };
      }

      // importance_ relation filter
      const importanceFilter: Record<string, unknown> = {};
      if (query.min_importance !== undefined) {
        importanceFilter['importanceScore'] = { gte: query.min_importance };
      }

      // asset_id scope via marketImpacts relation
      if (query.asset_id) {
        eventWhere['marketImpacts'] = {
          some: { assetId: query.asset_id },
        };
      }

      const events = await prisma.newsEvent.findMany({
        where: {
          ...eventWhere,
          ...(Object.keys(importanceFilter).length > 0
            ? { importance_: { is: importanceFilter } }
            : {}),
        },
        orderBy: { eventTimestamp: 'desc' },
        take: limit + 1,
        select: {
          id: true,
          eventType: true,
          actor: true,
          action: true,
          targetEntities: true,
          quantitativeValue: true,
          surpriseDirection: true,
          surpriseScore: true,
          confidence: true,
          eventTimestamp: true,
          createdAt: true,
          importance_: {
            select: {
              importanceScore: true,
              historicalDataAvailable: true,
              modelVersion: true,
              computedAt: true,
            },
          },
          article: {
            select: {
              sourceId: true,
              publishedAt: true,
              language: true,
            },
          },
        },
      });

      const hasNextPage = events.length > limit;
      const rows = hasNextPage ? events.slice(0, limit) : events;
      const nextCursor =
        hasNextPage && rows.length > 0
          ? rows[rows.length - 1]!.eventTimestamp.toISOString()
          : null;

      return reply.send({
        success: true,
        data: rows.map((e) => ({
          eventId: e.id,
          eventType: e.eventType,
          actor: e.actor,
          action: e.action,
          targetEntities: e.targetEntities,
          quantitativeValue: e.quantitativeValue,
          surpriseDirection: e.surpriseDirection,
          surpriseScore: e.surpriseScore,
          confidence: e.confidence,
          eventTimestamp: e.eventTimestamp,
          createdAt: e.createdAt,
          importanceScore: e.importance_?.importanceScore ?? null,
          importanceModelVersion: e.importance_?.modelVersion ?? null,
          historicalDataAvailable: e.importance_?.historicalDataAvailable ?? null,
          sourceId: e.article?.sourceId ?? null,
          publishedAt: e.article?.publishedAt ?? null,
          language: e.article?.language ?? null,
        })),
        meta: {
          timestamp: new Date().toISOString(),
          total_count: rows.length,
          next_cursor: nextCursor,
          has_next_page: hasNextPage,
          page_limit: limit,
        },
      });
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/v1/ml/training/samples
  //
  // Paginated list of TrainingSamples with labels.
  // Max 1,000 records per page (Req 25.3).
  // Filters: asset_id, feature_version, model_version, date_from, date_to.
  // Requirements: Req 25.3, Req 22.5
  // ─────────────────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/ml/training/samples',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            asset_id: { type: 'string' },
            feature_version: { type: 'string' },
            model_version: { type: 'string' },
            pipeline_version: { type: 'string' },
            date_from: { type: 'string' },
            date_to: { type: 'string' },
            limit: { type: 'number', minimum: 1, maximum: ML_PAGE_MAX, default: ML_PAGE_DEFAULT },
            cursor: { type: 'string' },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as {
        asset_id?: string;
        feature_version?: string;
        model_version?: string;
        pipeline_version?: string;
        date_from?: string;
        date_to?: string;
        limit?: number;
        cursor?: string;
      };

      const limit = Math.min(query.limit ?? ML_PAGE_DEFAULT, ML_PAGE_MAX);
      const cursorDate = query.cursor ? new Date(query.cursor) : undefined;

      const where: Record<string, unknown> = {};

      if (query.asset_id) where['assetId'] = query.asset_id;
      if (query.feature_version) where['featureVersion'] = query.feature_version;
      if (query.model_version) where['modelVersion'] = query.model_version;
      if (query.pipeline_version) where['pipelineVersion'] = query.pipeline_version;

      const createdAtFilter: Record<string, unknown> = {};
      if (query.date_from) createdAtFilter['gte'] = new Date(query.date_from);
      if (query.date_to) createdAtFilter['lte'] = new Date(query.date_to);
      if (cursorDate) createdAtFilter['lt'] = cursorDate;
      if (Object.keys(createdAtFilter).length > 0) {
        where['createdAt'] = createdAtFilter;
      }

      const samples = await prisma.newsTrainingSample.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit + 1,
        select: {
          id: true,
          eventId: true,
          assetId: true,
          articleIds: true,
          featureVectorId: true,
          futureReturn5m: true,
          futureReturn15m: true,
          futureReturn30m: true,
          futureReturn1h: true,
          futureReturn4h: true,
          futureReturn1d: true,
          label5m: true,
          label15m: true,
          label30m: true,
          label1h: true,
          label4h: true,
          label1d: true,
          featureVersion: true,
          pipelineVersion: true,
          marketDataSnapshotVersion: true,
          modelVersion: true,
          createdAt: true,
        },
      });

      const hasNextPage = samples.length > limit;
      const rows = hasNextPage ? samples.slice(0, limit) : samples;
      const nextCursor =
        hasNextPage && rows.length > 0
          ? rows[rows.length - 1]!.createdAt.toISOString()
          : null;

      return reply.send({
        success: true,
        data: rows,
        meta: {
          timestamp: new Date().toISOString(),
          total_count: rows.length,
          next_cursor: nextCursor,
          has_next_page: hasNextPage,
          page_limit: limit,
        },
      });
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/v1/ml/historical-reactions
  //
  // Observed price/volume/volatility reactions for past events.
  // Filters: event_id, asset_id, min_return, date_from, date_to.
  // Requirements: Req 25.3
  // ─────────────────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/ml/historical-reactions',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            event_id: { type: 'string' },
            asset_id: { type: 'string' },
            high_impact_only: { type: 'boolean' },
            date_from: { type: 'string' },
            date_to: { type: 'string' },
            limit: { type: 'number', minimum: 1, maximum: ML_PAGE_MAX, default: ML_PAGE_DEFAULT },
            cursor: { type: 'string' },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as {
        event_id?: string;
        asset_id?: string;
        high_impact_only?: boolean;
        date_from?: string;
        date_to?: string;
        limit?: number;
        cursor?: string;
      };

      const limit = Math.min(query.limit ?? ML_PAGE_DEFAULT, ML_PAGE_MAX);
      const cursorDate = query.cursor ? new Date(query.cursor) : undefined;

      const where: Record<string, unknown> = {};

      if (query.event_id) where['eventId'] = query.event_id;
      if (query.asset_id) where['assetId'] = query.asset_id;
      if (query.high_impact_only === true) where['highImpactFlag'] = true;

      const computedAtFilter: Record<string, unknown> = {};
      if (query.date_from) computedAtFilter['gte'] = new Date(query.date_from);
      if (query.date_to) computedAtFilter['lte'] = new Date(query.date_to);
      if (cursorDate) computedAtFilter['lt'] = cursorDate;
      if (Object.keys(computedAtFilter).length > 0) {
        where['computedAt'] = computedAtFilter;
      }

      const reactions = await prisma.newsMarketReaction.findMany({
        where,
        orderBy: { computedAt: 'desc' },
        take: limit + 1,
        select: {
          id: true,
          eventId: true,
          assetId: true,
          return1m: true,
          return5m: true,
          return15m: true,
          return30m: true,
          return1h: true,
          return4h: true,
          return1d: true,
          volumeChangeRatio: true,
          volatilityChangeRatio: true,
          highImpactFlag: true,
          marketOpen: true,
          dataServiceSnapshotVersion: true,
          computedAt: true,
        },
      });

      const hasNextPage = reactions.length > limit;
      const rows = hasNextPage ? reactions.slice(0, limit) : reactions;
      const nextCursor =
        hasNextPage && rows.length > 0
          ? rows[rows.length - 1]!.computedAt.toISOString()
          : null;

      return reply.send({
        success: true,
        data: rows,
        meta: {
          timestamp: new Date().toISOString(),
          total_count: rows.length,
          next_cursor: nextCursor,
          has_next_page: hasNextPage,
        },
      });
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/v1/ml/training/samples/:sampleId/lineage
  //
  // Full provenance chain from TrainingSample back to raw article metadata.
  //
  // Chain (Req 33.3):
  //   TrainingSample → FeatureVector → NewsEvent → NormalizedArticle → RawArticle metadata
  //
  // HTTP 404 if sampleId not found (Req 33.3).
  // Requirements: Req 25.3, Req 33.3
  // ─────────────────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/ml/training/samples/:sampleId/lineage',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { sampleId } = request.params as { sampleId: string };

      // --- Fetch TrainingSample ---
      const sample = await prisma.newsTrainingSample.findUnique({
        where: { id: sampleId },
        select: {
          id: true,
          eventId: true,
          assetId: true,
          articleIds: true,
          featureVectorId: true,
          futureReturn5m: true,
          futureReturn15m: true,
          futureReturn30m: true,
          futureReturn1h: true,
          futureReturn4h: true,
          futureReturn1d: true,
          label5m: true,
          label15m: true,
          label30m: true,
          label1h: true,
          label4h: true,
          label1d: true,
          featureVersion: true,
          pipelineVersion: true,
          marketDataSnapshotVersion: true,
          modelVersion: true,
          createdAt: true,
        },
      });

      if (!sample) {
        return reply.status(404).send({
          success: false,
          error: `Training sample not found: ${sampleId}`,
          meta: { timestamp: new Date().toISOString() },
        });
      }

      // --- Fetch FeatureVector ---
      const featureVector = await prisma.newsFeature.findUnique({
        where: { id: sample.featureVectorId },
        select: {
          id: true,
          featureType: true,
          featureVector: true,
          featureVersion: true,
          pipelineVersion: true,
          computedAt: true,
          eventId: true,
          assetId: true,
        },
      });

      // --- Fetch NewsEvent ---
      const newsEvent = await prisma.newsEvent.findUnique({
        where: { id: sample.eventId },
        select: {
          id: true,
          eventType: true,
          actor: true,
          action: true,
          targetEntities: true,
          quantitativeValue: true,
          surpriseDirection: true,
          surpriseScore: true,
          confidence: true,
          eventTimestamp: true,
          articleId: true,
          createdAt: true,
        },
      });

      // --- Fetch NormalizedArticle ---
      let normalizedArticle: Record<string, unknown> | null = null;
      let rawArticleMetadata: Record<string, unknown> | null = null;

      if (newsEvent?.articleId) {
        const article = await prisma.newsArticle.findUnique({
          where: { id: newsEvent.articleId },
          select: {
            id: true,
            sourceId: true,
            externalId: true,
            canonicalUrl: true,
            title: true,
            summary: true,
            language: true,
            languageConfidence: true,
            publishedAt: true,
            scrapedAt: true,
            category: true,
            contentHash: true,
            titleHash: true,
            contentTruncated: true,
            timestampInferred: true,
            createdAt: true,
            // Include source metadata as the "raw article metadata" layer
            source: {
              select: {
                id: true,
                name: true,
                tier: true,
                baseUrl: true,
                adapterVersion: true,
              },
            },
            // Include content-version history as raw article provenance
            versions: {
              orderBy: { version: 'asc' },
              select: {
                version: true,
                contentHash: true,
                titleHash: true,
                capturedAt: true,
              },
            },
          },
        });

        if (article) {
          const { source, versions, ...articleFields } = article;

          normalizedArticle = articleFields as Record<string, unknown>;

          // RawArticle metadata: source adapter details + version history
          rawArticleMetadata = {
            source: source ?? null,
            externalId: article.externalId,
            fetchedAt: article.scrapedAt,
            adapterVersion: source?.adapterVersion ?? null,
            contentVersionHistory: versions,
          };
        }
      }

      // Additional article IDs from the sample's articleIds array
      // (articles that contributed to this sample beyond the primary event article)
      let additionalArticles: Array<Record<string, unknown>> = [];

      if (sample.articleIds.length > 1) {
        const secondaryArticleIds = sample.articleIds.filter(
          (id) => id !== newsEvent?.articleId,
        );

        if (secondaryArticleIds.length > 0) {
          const secondaryArticles = await prisma.newsArticle.findMany({
            where: { id: { in: secondaryArticleIds } },
            select: {
              id: true,
              sourceId: true,
              externalId: true,
              canonicalUrl: true,
              title: true,
              publishedAt: true,
              scrapedAt: true,
              source: {
                select: { id: true, name: true, tier: true, adapterVersion: true },
              },
            },
          });

          additionalArticles = secondaryArticles.map((a) => ({
            ...a,
          })) as Array<Record<string, unknown>>;
        }
      }

      // Assemble provenance chain (Req 33.3)
      const lineage = {
        training_sample: sample,
        feature_vector: featureVector ?? null,
        news_event: newsEvent ?? null,
        normalized_article: normalizedArticle,
        raw_article_metadata: rawArticleMetadata,
        additional_contributing_articles: additionalArticles,
      };

      return reply.send({
        success: true,
        data: lineage,
        meta: {
          timestamp: new Date().toISOString(),
          sample_id: sampleId,
          provenance_depth: [
            'training_sample',
            featureVector ? 'feature_vector' : null,
            newsEvent ? 'news_event' : null,
            normalizedArticle ? 'normalized_article' : null,
            rawArticleMetadata ? 'raw_article_metadata' : null,
          ].filter(Boolean),
        },
      });
    },
  );
}
