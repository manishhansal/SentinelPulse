/**
 * News API route handlers for SentinelPulse.
 *
 * Implements the full /api/v1/news/* route group (Req 25.1):
 *   GET /api/v1/news/latest              — paginated articles with filters
 *   GET /api/v1/news/assets/:assetId     — news and impact for a specific asset
 *   GET /api/v1/news/market/india        — India market news with breadth/regime context
 *   GET /api/v1/news/events/:eventId     — event with cluster context
 *   GET /api/v1/news/events/similar      — delegates to semantic search endpoint
 *   GET /api/v1/news/impact/:assetId     — market impact scores for an asset
 *   GET /api/v1/news/regime              — current market regime
 *   GET /api/v1/news/signal/:assetId     — composite news signal for an asset
 *
 * All responses follow the standard envelope:
 *   { success: true, data: ..., meta: { timestamp, ... } }
 *
 * Pagination uses a cursor-based approach with `cursor` (last article ID) and
 * `limit` (default 20, max 50) per Req 25.1.
 *
 * Requirements: Req 25.1
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../db/prisma.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function meta(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { timestamp: new Date().toISOString(), ...extra };
}

function successEnvelope(
  data: unknown,
  metaExtra: Record<string, unknown> = {},
): { success: true; data: unknown; meta: Record<string, unknown> } {
  return { success: true, data, meta: meta(metaExtra) };
}

function errorEnvelope(
  message: string,
): { success: false; error: string; meta: Record<string, unknown> } {
  return { success: false, error: message, meta: meta() };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Registers all /api/v1/news/* route handlers on the provided Fastify
 * instance.  Called from buildApp() instead of the inline stubs.
 *
 * Requirements: Req 25.1
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function registerNewsRoutes(app: FastifyInstance): Promise<void> {
  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/v1/news/latest
  //
  // Returns paginated articles sorted by publishedAt desc.
  // Query parameters:
  //   - limit   (integer, 1–50, default 20)
  //   - cursor  (UUID, opaque pagination cursor — last article id from prev page)
  //   - source  (string, filter by sourceId)
  //   - category (string, filter by category)
  //   - lang    (string, filter by ISO 639-1 language code)
  //   - from    (ISO 8601 date, filter publishedAt >= from)
  //   - to      (ISO 8601 date, filter publishedAt <= to)
  // ─────────────────────────────────────────────────────────────────────────
  app.get('/api/v1/news/latest', async (
    request: FastifyRequest<{
      Querystring: {
        limit?: number;
        cursor?: string;
        source?: string;
        category?: string;
        lang?: string;
        from?: string;
        to?: string;
      };
    }>,
    reply: FastifyReply,
  ) => {
    const { limit: rawLimit, cursor, source, category, lang, from, to } = request.query;

    const limit = Math.min(Math.max(Number(rawLimit) || 20, 1), 50);

    // Build where clause
    type WhereClause = {
      publishedAt?: { gte?: Date; lte?: Date };
      sourceId?: string;
      category?: string;
      language?: string;
      id?: { lt: string };
    };
    const where: WhereClause = {};
    if (source) where.sourceId = source;
    if (category) where.category = category;
    if (lang) where.language = lang;

    // Date range
    const dateFilter: { gte?: Date; lte?: Date } = {};
    if (from) {
      const d = new Date(from);
      if (!isNaN(d.getTime())) dateFilter.gte = d;
    }
    if (to) {
      const d = new Date(to);
      if (!isNaN(d.getTime())) dateFilter.lte = d;
    }
    if (Object.keys(dateFilter).length > 0) {
      where.publishedAt = dateFilter;
    }

    // Cursor pagination: articles published before cursor's publishedAt
    // We use the cursor as the article id for simplicity (stable ordering by id desc)
    if (cursor) {
      where.id = { lt: cursor };
    }

    try {
      const articles = await prisma.newsArticle.findMany({
        where,
        orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        select: {
          id: true,
          sourceId: true,
          title: true,
          summary: true,
          canonicalUrl: true,
          language: true,
          publishedAt: true,
          scrapedAt: true,
          category: true,
          contentTruncated: true,
          timestampInferred: true,
          duplicateCount: true,
          clusterId: true,
          author: true,
          source: {
            select: { name: true, tier: true },
          },
        },
      });

      const hasMore = articles.length > limit;
      const items = hasMore ? articles.slice(0, limit) : articles;
      const nextCursor = hasMore ? items[items.length - 1]?.id ?? null : null;

      return reply.send(successEnvelope(items, {
        total_count: items.length,
        next_cursor: nextCursor,
        has_more: hasMore,
      }));
    } catch (err) {
      request.log.error({ err }, 'Failed to fetch latest articles');
      return reply.status(500).send(errorEnvelope('Failed to fetch articles'));
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/v1/news/assets/:assetId
  //
  // Returns recent articles and market impact scores for the given asset.
  // Query parameters:
  //   - limit  (integer, 1–50, default 20)
  //   - from   (ISO 8601)
  //   - to     (ISO 8601)
  // ─────────────────────────────────────────────────────────────────────────
  app.get('/api/v1/news/assets/:assetId', async (
    request: FastifyRequest<{
      Params: { assetId: string };
      Querystring: { limit?: number; from?: string; to?: string };
    }>,
    reply: FastifyReply,
  ) => {
    const { assetId } = request.params;
    const { limit: rawLimit, from, to } = request.query;
    const limit = Math.min(Math.max(Number(rawLimit) || 20, 1), 50);

    const dateFilter: { gte?: Date; lte?: Date } = {};
    if (from) {
      const d = new Date(from);
      if (!isNaN(d.getTime())) dateFilter.gte = d;
    }
    if (to) {
      const d = new Date(to);
      if (!isNaN(d.getTime())) dateFilter.lte = d;
    }

    try {
      const [assetLinks, impacts] = await Promise.all([
        // Articles linked to this asset through news_asset_links
        prisma.newsAssetLink.findMany({
          where: {
            assetId,
            ...(Object.keys(dateFilter).length > 0 ? { publishedAt: dateFilter } : {}),
          },
          orderBy: { publishedAt: 'desc' },
          take: limit,
          include: {
            article: {
              select: {
                id: true,
                title: true,
                summary: true,
                canonicalUrl: true,
                publishedAt: true,
                category: true,
                language: true,
                source: { select: { name: true, tier: true } },
              },
            },
          },
        }),
        // Most recent market impact scores for this asset
        prisma.newsMarketImpact.findMany({
          where: { assetId },
          orderBy: { computedAt: 'desc' },
          take: limit,
          select: {
            id: true,
            eventId: true,
            direction: true,
            strength: true,
            confidence: true,
            expectedHorizon: true,
            evidenceType: true,
            newsImpactScore: true,
            computedAt: true,
          },
        }),
      ]);

      return reply.send(successEnvelope(
        {
          assetId,
          articles: assetLinks.map((al) => ({
            ...al.article,
            assetConfidence: Number(al.confidence),
          })),
          impacts,
        },
        { total_count: assetLinks.length },
      ));
    } catch (err) {
      request.log.error({ err, assetId }, 'Failed to fetch asset news');
      return reply.status(500).send(errorEnvelope('Failed to fetch asset news'));
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/v1/news/market/india
  //
  // Returns India market news with breadth and regime context.
  // Query parameters:
  //   - limit  (integer, 1–50, default 20)
  // ─────────────────────────────────────────────────────────────────────────
  app.get('/api/v1/news/market/india', async (
    request: FastifyRequest<{ Querystring: { limit?: number } }>,
    reply: FastifyReply,
  ) => {
    const { limit: rawLimit } = request.query;
    const limit = Math.min(Math.max(Number(rawLimit) || 20, 1), 50);

    // India-market relevant taxonomy categories
    const indiaCategories = [
      'NIFTY50', 'SENSEX', 'BANKNIFTY', 'NIFTY_MIDCAP', 'NIFTY_SMALLCAP',
      'SEBI', 'FII_DII_FLOWS', 'INDIA_MACRO', 'RBI',
    ];

    try {
      const [articles, regime, breadthFeature] = await Promise.all([
        // Recent India-focused articles
        prisma.newsArticle.findMany({
          where: { category: { in: indiaCategories } },
          orderBy: { publishedAt: 'desc' },
          take: limit,
          select: {
            id: true,
            title: true,
            summary: true,
            canonicalUrl: true,
            publishedAt: true,
            category: true,
            language: true,
            source: { select: { name: true, tier: true } },
          },
        }),
        // Current India market regime
        prisma.newsMarketRegime.findFirst({
          where: { marketId: 'india', validTo: null },
          orderBy: { validFrom: 'desc' },
          select: {
            id: true,
            regime: true,
            confidence: true,
            validFrom: true,
          },
        }),
        // Latest breadth feature for NIFTY50 (if available)
        prisma.newsFeature.findFirst({
          where: { featureType: 'BREADTH', assetId: 'NIFTY50' },
          orderBy: { computedAt: 'desc' },
          select: { featureVector: true, computedAt: true },
        }),
      ]);

      return reply.send(successEnvelope({
        articles,
        regime: regime ?? null,
        breadth: breadthFeature
          ? {
              featureVector: breadthFeature.featureVector,
              computedAt: breadthFeature.computedAt,
            }
          : null,
      }));
    } catch (err) {
      request.log.error({ err }, 'Failed to fetch India market news');
      return reply.status(500).send(errorEnvelope('Failed to fetch India market news'));
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // NOTE: /api/v1/news/events/similar must be registered BEFORE
  // /api/v1/news/events/:eventId to prevent Fastify matching "similar" as
  // a dynamic :eventId segment.
  // ─────────────────────────────────────────────────────────────────────────

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/v1/news/events/similar
  //
  // Delegates to the semantic search endpoint (GET /api/v1/news/search).
  // Query parameters:
  //   - q      (required, query string)
  //   - topK   (integer, default 20, max 100)
  //   - type   (article|event|entity, default event)
  // ─────────────────────────────────────────────────────────────────────────
  app.get('/api/v1/news/events/similar', async (
    request: FastifyRequest<{
      Querystring: { q?: string; topK?: number; type?: string };
    }>,
    reply: FastifyReply,
  ) => {
    const { q } = request.query;
    if (!q || q.trim().length === 0) {
      return reply.status(400).send(errorEnvelope('Query parameter "q" is required'));
    }

    // Build redirect URL to semantic search endpoint
    const params = new URLSearchParams({
      q: q.trim(),
      topK: String(Math.min(Math.max(Number(request.query.topK) || 20, 1), 100)),
      type: (request.query.type as string) || 'event',
    });

    // Perform an internal forward by replying with a redirect
    return reply.redirect(302, `/api/v1/news/search?${params.toString()}`);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/v1/news/events/:eventId
  //
  // Returns an event with its associated article and cluster context.
  // ─────────────────────────────────────────────────────────────────────────
  app.get('/api/v1/news/events/:eventId', async (
    request: FastifyRequest<{ Params: { eventId: string } }>,
    reply: FastifyReply,
  ) => {
    const { eventId } = request.params;

    try {
      const event = await prisma.newsEvent.findUnique({
        where: { id: eventId },
        include: {
          article: {
            select: {
              id: true,
              title: true,
              summary: true,
              canonicalUrl: true,
              publishedAt: true,
              category: true,
              language: true,
              clusterId: true,
              source: { select: { name: true, tier: true } },
              cluster: {
                select: {
                  id: true,
                  headline: true,
                  sourceCount: true,
                  sourceDiversity: true,
                  consensusScore: true,
                  firstSeenAt: true,
                },
              },
            },
          },
          importance_: {
            select: {
              importanceScore: true,
              subScores: true,
              modelVersion: true,
            },
          },
          sentiment: {
            orderBy: { computedAt: 'desc' },
            take: 1,
            select: {
              sentimentScore: true,
              marketSentiment: true,
              qualitativeSignals: true,
              confidence: true,
            },
          },
        },
      });

      if (!event) {
        return reply.status(404).send(errorEnvelope(`Event ${eventId} not found`));
      }

      return reply.send(successEnvelope(event));
    } catch (err) {
      request.log.error({ err, eventId }, 'Failed to fetch event');
      return reply.status(500).send(errorEnvelope('Failed to fetch event'));
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/v1/news/impact/:assetId
  //
  // Returns paginated market impact scores for the given asset, most recent
  // first.
  // Query parameters:
  //   - limit  (integer, 1–50, default 20)
  //   - from   (ISO 8601)
  //   - to     (ISO 8601)
  // ─────────────────────────────────────────────────────────────────────────
  app.get('/api/v1/news/impact/:assetId', async (
    request: FastifyRequest<{
      Params: { assetId: string };
      Querystring: { limit?: number; from?: string; to?: string };
    }>,
    reply: FastifyReply,
  ) => {
    const { assetId } = request.params;
    const { limit: rawLimit, from, to } = request.query;
    const limit = Math.min(Math.max(Number(rawLimit) || 20, 1), 50);

    const dateFilter: { gte?: Date; lte?: Date } = {};
    if (from) {
      const d = new Date(from);
      if (!isNaN(d.getTime())) dateFilter.gte = d;
    }
    if (to) {
      const d = new Date(to);
      if (!isNaN(d.getTime())) dateFilter.lte = d;
    }

    try {
      const impacts = await prisma.newsMarketImpact.findMany({
        where: {
          assetId,
          ...(Object.keys(dateFilter).length > 0 ? { computedAt: dateFilter } : {}),
        },
        orderBy: { computedAt: 'desc' },
        take: limit,
        select: {
          id: true,
          eventId: true,
          direction: true,
          strength: true,
          confidence: true,
          expectedHorizon: true,
          evidenceType: true,
          newsImpactScore: true,
          impactComponents: true,
          impactComputationVersion: true,
          computedAt: true,
          event: {
            select: {
              eventType: true,
              actor: true,
              eventTimestamp: true,
            },
          },
        },
      });

      return reply.send(successEnvelope(impacts, { total_count: impacts.length }));
    } catch (err) {
      request.log.error({ err, assetId }, 'Failed to fetch impact scores');
      return reply.status(500).send(errorEnvelope('Failed to fetch impact scores'));
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/v1/news/regime
  //
  // Returns the current active market regime for the requested market
  // (default: india).
  // Query parameters:
  //   - market  (string, default "india")
  // ─────────────────────────────────────────────────────────────────────────
  app.get('/api/v1/news/regime', async (
    request: FastifyRequest<{ Querystring: { market?: string } }>,
    reply: FastifyReply,
  ) => {
    const { market = 'india' } = request.query;

    try {
      const regime = await prisma.newsMarketRegime.findFirst({
        where: { marketId: market, validTo: null },
        orderBy: { validFrom: 'desc' },
      });

      if (!regime) {
        return reply.send(successEnvelope(null, {
          message: `No active regime found for market "${market}"`,
        }));
      }

      return reply.send(successEnvelope(regime));
    } catch (err) {
      request.log.error({ err, market }, 'Failed to fetch market regime');
      return reply.status(500).send(errorEnvelope('Failed to fetch market regime'));
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/v1/news/signal/:assetId
  //
  // Returns a composite news signal for the given asset, aggregating the
  // most recent market impact scores and sentiment.
  // ─────────────────────────────────────────────────────────────────────────
  app.get('/api/v1/news/signal/:assetId', async (
    request: FastifyRequest<{ Params: { assetId: string } }>,
    reply: FastifyReply,
  ) => {
    const { assetId } = request.params;

    try {
      // Aggregate the five most recent impact records for this asset
      const recentImpacts = await prisma.newsMarketImpact.findMany({
        where: { assetId },
        orderBy: { computedAt: 'desc' },
        take: 5,
        select: {
          newsImpactScore: true,
          direction: true,
          strength: true,
          confidence: true,
          computedAt: true,
        },
      });

      if (recentImpacts.length === 0) {
        return reply.send(successEnvelope(null, {
          message: `No impact data found for asset "${assetId}"`,
        }));
      }

      // Compute composite signal: weighted average of newsImpactScore by confidence
      let weightedScoreSum = 0;
      let weightSum = 0;
      let bullishCount = 0;
      let bearishCount = 0;

      for (const impact of recentImpacts) {
        if (impact.newsImpactScore !== null) {
          weightedScoreSum += impact.newsImpactScore * impact.confidence;
          weightSum += impact.confidence;
        }
        if (impact.direction === 'POSITIVE') bullishCount++;
        else if (impact.direction === 'NEGATIVE') bearishCount++;
      }

      const compositeScore = weightSum > 0 ? weightedScoreSum / weightSum : 0;
      const dominantDirection =
        bullishCount > bearishCount
          ? 'BULLISH'
          : bearishCount > bullishCount
            ? 'BEARISH'
            : 'NEUTRAL';

      // Also pull the latest sentiment for this asset's articles
      const latestSentiment = await prisma.newsSentiment.findFirst({
        where: {
          article: {
            assetLinks: { some: { assetId } },
          },
        },
        orderBy: { computedAt: 'desc' },
        select: {
          sentimentScore: true,
          marketSentiment: true,
          qualitativeSignals: true,
          confidence: true,
          computedAt: true,
        },
      });

      return reply.send(successEnvelope({
        assetId,
        compositeScore: Math.round(compositeScore * 100) / 100,
        dominantDirection,
        recentImpacts,
        latestSentiment: latestSentiment ?? null,
        signalComputedAt: new Date().toISOString(),
      }));
    } catch (err) {
      request.log.error({ err, assetId }, 'Failed to compute news signal');
      return reply.status(500).send(errorEnvelope('Failed to compute news signal'));
    }
  });
}
