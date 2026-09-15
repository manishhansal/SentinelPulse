/**
 * AlphaForge API route handlers.
 *
 * Endpoints:
 *   GET /api/v1/alphaforge/news-context/:instrument
 *     - Redis-cached (TTL 30s) under news:signal:{instrument} (Req 25.8, Req 27.1)
 *     - Returns full news_context bundle (Req 32.1) with explainability block (Req 32.2)
 *     - HTTP 404 when instrument has no data (Req 32.5)
 *     - NEVER exposes BUY/SELL/HOLD (Req 32.4)
 *     - Target p95 < 100ms under cache-hit (Req 25.2, Req 28.3)
 *
 *   GET /api/v1/alphaforge/context/market
 *   GET /api/v1/alphaforge/context/index/:index
 *   GET /api/v1/alphaforge/context/sector/:sector
 *   GET /api/v1/alphaforge/context/asset/:asset
 *     - Contextual intelligence aggregates for each scope
 *
 *   GET /api/v1/alphaforge/high-impact-events
 *     - Events with importance_score > 0.7, sorted by recency (Req 25.2)
 *
 * Requirements: Req 25.2, Req 32.1–32.5
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pino } from 'pino';
import { prisma, MAX_QUERY_RESULTS } from '../../db/prisma.js';
import { HistoricalAnalogueEngine } from '../../engines/historical-analogue/HistoricalAnalogueEngine.js';

const logger = pino({ name: 'alphaforge-routes' });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Redis cache key prefix for instrument news-context (Req 27.1). */
const CACHE_KEY_PREFIX = 'news:signal:';

/** Cache TTL for news-context responses: 30 seconds (Req 25.8, Req 27.1). */
const CACHE_TTL_SECONDS = 30;

/** Importance threshold for high-impact events (Req 25.2). */
const HIGH_IMPACT_THRESHOLD = 0.7;

/** Maximum top contributing events returned in news-context bundle (Req 32.1). */
const MAX_CONTRIBUTING_EVENTS = 5;

/** Maximum top contributing events in the explainability block (Req 32.2). */
const MAX_EXPLAINABILITY_EVENTS = 3;

/** Maximum cross-market signals in the explainability block (Req 32.2). */
const MAX_EXPLAINABILITY_RELATIONSHIPS = 3;

// ---------------------------------------------------------------------------
// Redis injection (set by app bootstrap when Redis is available)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let redisClient: any = null;

/** Injects the ioredis client for cache operations. */
export function setAlphaForgeRedisClient(client: unknown): void {
  redisClient = client;
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
async function getCachedContext(instrument: string): Promise<unknown | null> {
  if (!redisClient) return null;
  try {
    const raw: string | null = await redisClient.get(`${CACHE_KEY_PREFIX}${instrument}`);
    if (!raw) return null;
    return JSON.parse(raw) as unknown;
  } catch (err) {
    logger.warn({ instrument, err }, 'Redis cache read failed — falling back to DB');
    return null;
  }
}

async function setCachedContext(instrument: string, data: unknown): Promise<void> {
  if (!redisClient) return;
  try {
    await redisClient.set(
      `${CACHE_KEY_PREFIX}${instrument}`,
      JSON.stringify(data),
      'EX',
      CACHE_TTL_SECONDS,
    );
  } catch (err) {
    logger.warn({ instrument, err }, 'Redis cache write failed — continuing without cache');
  }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/require-await
export async function registerAlphaForgeRoutes(app: FastifyInstance): Promise<void> {
  const analogueEngine = new HistoricalAnalogueEngine();

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/v1/alphaforge/news-context/:instrument
  //
  // Full news context bundle for an instrument, served from Redis when cached.
  // Assembles: impact score, sentiment summary, velocity, regime context,
  // top contributing events, cross-market signals, and historical analogue.
  //
  // Requirements: Req 25.2, Req 25.8, Req 32.1, Req 32.2, Req 32.4, Req 32.5
  // ─────────────────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/alphaforge/news-context/:instrument',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { instrument } = request.params as { instrument: string };

      if (!instrument || instrument.trim() === '') {
        return reply.status(400).send({
          success: false,
          error: 'instrument parameter is required',
          meta: { timestamp: new Date().toISOString() },
        });
      }

      const instrumentId = instrument.trim().toUpperCase();

      // --- 1. Redis cache hit fast path (Req 25.8) ---
      const cached = await getCachedContext(instrumentId);
      if (cached !== null) {
        return reply.send({
          success: true,
          data: cached,
          meta: {
            timestamp: new Date().toISOString(),
            cached: true,
            cacheKey: `${CACHE_KEY_PREFIX}${instrumentId}`,
          },
        });
      }

      // --- 2. Check instrument exists in news_market_impacts (Req 32.5) ---
      const impactCount = await prisma.newsMarketImpact.count({
        where: { assetId: instrumentId },
      });

      if (impactCount === 0) {
        return reply.status(404).send({
          success: false,
          error: `No news context available for instrument: ${instrumentId}`,
          meta: { timestamp: new Date().toISOString() },
        });
      }

      // --- 3. Fetch recent market impacts for the instrument ---
      const recentImpacts = await prisma.newsMarketImpact.findMany({
        where: { assetId: instrumentId },
        orderBy: { computedAt: 'desc' },
        take: 20,
        select: {
          eventId: true,
          direction: true,
          strength: true,
          confidence: true,
          newsImpactScore: true,
          evidenceType: true,
          computedAt: true,
          expectedHorizon: true,
        },
      });

      // Compute news_impact_score as mean of recent scores (normalised 0.0–1.0)
      const validScores = recentImpacts
        .map((i) => i.newsImpactScore)
        .filter((s): s is number => s !== null);

      const rawMean =
        validScores.length > 0
          ? validScores.reduce((sum, s) => sum + s, 0) / validScores.length
          : 0;

      // news_impact_score exposed as 0.0–1.0 (map [-100,+100] → [0,1])
      const newsImpactScore = Math.max(0, Math.min(1, (rawMean + 100) / 200));

      // --- 4. Fetch top contributing events by importance (Req 32.1) ---
      const eventIds = [...new Set(recentImpacts.map((i) => i.eventId))].slice(
        0,
        MAX_CONTRIBUTING_EVENTS * 2,
      );

      const importanceRows = await prisma.newsImportance.findMany({
        where: { eventId: { in: eventIds } },
        orderBy: { importanceScore: 'desc' },
        take: MAX_CONTRIBUTING_EVENTS,
        select: {
          eventId: true,
          importanceScore: true,
          computedAt: true,
          event: {
            select: {
              eventType: true,
              actor: true,
              action: true,
              eventTimestamp: true,
              article: {
                select: {
                  title: true,
                  sourceId: true,
                },
              },
            },
          },
        },
      });

      const topContributingEvents = importanceRows.map((row) => ({
        eventId: row.eventId,
        eventType: row.event.eventType,
        actor: row.event.actor,
        action: row.event.action,
        eventTimestamp: row.event.eventTimestamp,
        title: row.event.article?.title ?? null,
        sourceId: row.event.article?.sourceId ?? null,
        importanceScore: row.importanceScore,
        sentimentDirection: getSentimentDirection(row.eventId, recentImpacts),
      }));

      // --- 5. Fetch sentiment summary for the instrument's articles ---
      const assetLinks = await prisma.newsAssetLink.findMany({
        where: { assetId: instrumentId },
        orderBy: { publishedAt: 'desc' },
        take: 10,
        select: { articleId: true },
      });

      const articleIds = assetLinks.map((l) => l.articleId);

      const sentimentRows = await prisma.newsSentiment.findMany({
        where: { articleId: { in: articleIds } },
        orderBy: { computedAt: 'desc' },
        take: 10,
        select: {
          marketSentiment: true,
          companySentiment: true,
          macroSentiment: true,
          riskSentiment: true,
          sentimentScore: true,
        },
      });

      const sentimentSummary = computeSentimentSummary(sentimentRows);

      // --- 6. Fetch current market regime (Req 32.1) ---
      const currentRegime = await prisma.newsMarketRegime.findFirst({
        where: { marketId: 'india', validTo: null },
        orderBy: { validFrom: 'desc' },
        select: {
          regime: true,
          confidence: true,
          validFrom: true,
        },
      });

      const regimeContext = currentRegime
        ? {
            regime: currentRegime.regime,
            confidence: currentRegime.confidence,
            validFrom: currentRegime.validFrom,
          }
        : null;

      // --- 7. Fetch velocity metrics (article count over recent windows) ---
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      const [velocity1h, velocity24h] = await Promise.all([
        prisma.newsAssetLink.count({
          where: { assetId: instrumentId, publishedAt: { gte: oneHourAgo } },
        }),
        prisma.newsAssetLink.count({
          where: { assetId: instrumentId, publishedAt: { gte: oneDayAgo } },
        }),
      ]);

      const velocityMetrics = {
        articles_1h: velocity1h,
        articles_24h: velocity24h,
      };

      // --- 8. Fetch active cross-market signals (Req 32.1) ---
      const crossMarketSignals = await prisma.newsEventRelationship.findMany({
        where: {
          sourceEntityId: instrumentId,
          confidence: { gte: 0.2 },
          sampleSize: { gte: 30 },
          lowSample: false,
        },
        orderBy: { confidence: 'desc' },
        take: 10,
        select: {
          id: true,
          targetEntityId: true,
          relationshipType: true,
          historicalCorrelation: true,
          confidence: true,
          sampleSize: true,
        },
      });

      const activeCrossMarketSignals = crossMarketSignals.map((rel) => ({
        relationshipId: rel.id,
        targetEntityId: rel.targetEntityId,
        relationshipType: rel.relationshipType,
        historicalCorrelation: rel.historicalCorrelation,
        confidence: rel.confidence,
        sampleSize: rel.sampleSize,
      }));

      // --- 9. Fetch historical analogue summary (Req 32.1) ---
      let historicalAnalogueSummary: unknown = null;

      // Find the most recent high-importance event for this instrument to get analogues
      const anchorEvent = importanceRows[0];
      if (anchorEvent) {
        try {
          const analogueResult = await analogueEngine.findAnalogues(anchorEvent.eventId, {
            topN: 5,
            assetId: instrumentId,
          });

          if (analogueResult.analogues.length > 0) {
            historicalAnalogueSummary = {
              analogueCount: analogueResult.analogueCount,
              aggregateStats: analogueResult.aggregateStats,
              mostRelevantAnalogue: analogueResult.analogues[0]
                ? {
                    eventId: analogueResult.analogues[0].eventId,
                    similarityScore: analogueResult.analogues[0].similarityScore,
                    eventDate: analogueResult.analogues[0].eventDate,
                    eventDescription: analogueResult.analogues[0].eventDescription,
                    marketReaction: analogueResult.analogues[0].marketReaction,
                  }
                : null,
            };
          }
        } catch (err) {
          logger.warn(
            { instrumentId, eventId: anchorEvent.eventId, err },
            'Historical analogue lookup failed — omitting from response',
          );
        }
      }

      // --- 10. Assemble explainability block (Req 32.2) ---
      // NOTE: Never include BUY/SELL/HOLD (Req 32.4)
      const topExplainEvents = topContributingEvents
        .slice(0, MAX_EXPLAINABILITY_EVENTS)
        .map((e) => ({
          eventId: e.eventId,
          title: e.title,
          importanceScore: e.importanceScore,
          sentimentDirection: e.sentimentDirection,
        }));

      const topCrossMarket = activeCrossMarketSignals.slice(
        0,
        MAX_EXPLAINABILITY_RELATIONSHIPS,
      );

      const explainability = {
        top_events: topExplainEvents,
        top_cross_market_relationships: topCrossMarket,
        most_relevant_historical_analogue:
          historicalAnalogueSummary !== null &&
          typeof historicalAnalogueSummary === 'object' &&
          'mostRelevantAnalogue' in (historicalAnalogueSummary)
            ? (historicalAnalogueSummary as { mostRelevantAnalogue: unknown })
                .mostRelevantAnalogue
            : null,
        // Explicit disclaimer — SentinelPulse is an input factor only (Req 32.3, Req 32.4)
        disclaimer:
          'news_impact_score is an input factor to the AlphaForge multi-factor model ' +
          '(News + Technical + Smart Money + Volume + Open Interest + Market Regime + Macro → ML Probability → Final Signal). ' +
          'SentinelPulse does not generate autonomous trading signals.',
      };

      // --- 11. Assemble full bundle (Req 32.1) ---
      const bundle = {
        instrument: instrumentId,
        news_impact_score: newsImpactScore,
        sentiment_summary: sentimentSummary,
        velocity_metrics: velocityMetrics,
        regime_context: regimeContext,
        top_contributing_events: topContributingEvents,
        active_cross_market_signals: activeCrossMarketSignals,
        historical_analogue_summary: historicalAnalogueSummary,
        explainability,
        computed_at: new Date().toISOString(),
      };

      // --- 12. Populate cache (Req 25.8) ---
      await setCachedContext(instrumentId, bundle);

      return reply.send({
        success: true,
        data: bundle,
        meta: {
          timestamp: new Date().toISOString(),
          cached: false,
        },
      });
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/v1/alphaforge/context/market
  //
  // Broad market intelligence: regime, top events, sentiment aggregates.
  // Requirements: Req 25.2
  // ─────────────────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/alphaforge/context/market',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const [currentRegime, topEvents, recentSentiments] = await Promise.all([
        prisma.newsMarketRegime.findFirst({
          where: { marketId: 'india', validTo: null },
          orderBy: { validFrom: 'desc' },
          select: { regime: true, confidence: true, validFrom: true },
        }),
        prisma.newsImportance.findMany({
          where: { importanceScore: { gt: HIGH_IMPACT_THRESHOLD } },
          orderBy: { computedAt: 'desc' },
          take: 10,
          select: {
            importanceScore: true,
            computedAt: true,
            event: {
              select: {
                id: true,
                eventType: true,
                actor: true,
                action: true,
                eventTimestamp: true,
              },
            },
          },
        }),
        prisma.newsSentiment.findMany({
          orderBy: { computedAt: 'desc' },
          take: 50,
          select: {
            marketSentiment: true,
            macroSentiment: true,
            riskSentiment: true,
          },
        }),
      ]);

      const overallSentiment = computeSentimentSummary(recentSentiments);

      return reply.send({
        success: true,
        data: {
          market: 'india',
          regime: currentRegime ?? null,
          overall_sentiment: overallSentiment,
          top_events: topEvents.map((row) => ({
            eventId: row.event.id,
            eventType: row.event.eventType,
            actor: row.event.actor,
            action: row.event.action,
            eventTimestamp: row.event.eventTimestamp,
            importanceScore: row.importanceScore,
            computedAt: row.computedAt,
          })),
        },
        meta: { timestamp: new Date().toISOString() },
      });
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/v1/alphaforge/context/index/:index
  //
  // News context scoped to a market index (index ID as path param).
  // Requirements: Req 25.2
  // ─────────────────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/alphaforge/context/index/:index',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { index } = request.params as { index: string };
      const indexId = index.trim().toUpperCase();

      const [assetLinks, recentImpacts] = await Promise.all([
        prisma.newsAssetLink.findMany({
          where: { assetId: indexId },
          orderBy: { publishedAt: 'desc' },
          take: MAX_QUERY_RESULTS,
          select: { articleId: true, publishedAt: true, confidence: true },
        }),
        prisma.newsMarketImpact.findMany({
          where: { assetId: indexId },
          orderBy: { computedAt: 'desc' },
          take: 20,
          select: {
            eventId: true,
            direction: true,
            strength: true,
            newsImpactScore: true,
            computedAt: true,
          },
        }),
      ]);

      return reply.send({
        success: true,
        data: {
          index: indexId,
          article_count: assetLinks.length,
          recent_impacts: recentImpacts,
          latest_article_at: assetLinks[0]?.publishedAt ?? null,
        },
        meta: {
          timestamp: new Date().toISOString(),
          truncated: assetLinks.length >= MAX_QUERY_RESULTS,
        },
      });
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/v1/alphaforge/context/sector/:sector
  //
  // News context scoped to a market sector.
  // Requirements: Req 25.2
  // ─────────────────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/alphaforge/context/sector/:sector',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { sector } = request.params as { sector: string };
      const sectorId = sector.trim().toUpperCase();

      const [sectorLinks, recentImpacts, currentRegime] = await Promise.all([
        prisma.newsSectorLink.findMany({
          where: { sectorId },
          orderBy: { publishedAt: 'desc' },
          take: MAX_QUERY_RESULTS,
          select: { articleId: true, publishedAt: true, confidence: true },
        }),
        prisma.newsMarketImpact.findMany({
          where: { sectorId },
          orderBy: { computedAt: 'desc' },
          take: 20,
          select: {
            eventId: true,
            direction: true,
            strength: true,
            newsImpactScore: true,
            computedAt: true,
          },
        }),
        prisma.newsMarketRegime.findFirst({
          where: { marketId: 'india', validTo: null },
          orderBy: { validFrom: 'desc' },
          select: { regime: true, confidence: true },
        }),
      ]);

      return reply.send({
        success: true,
        data: {
          sector: sectorId,
          article_count: sectorLinks.length,
          recent_impacts: recentImpacts,
          latest_article_at: sectorLinks[0]?.publishedAt ?? null,
          current_regime: currentRegime ?? null,
        },
        meta: {
          timestamp: new Date().toISOString(),
          truncated: sectorLinks.length >= MAX_QUERY_RESULTS,
        },
      });
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/v1/alphaforge/context/asset/:asset
  //
  // News context scoped to a single asset (instrument).  Similar to
  // news-context but without the full bundle assembly and caching.
  // Requirements: Req 25.2
  // ─────────────────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/alphaforge/context/asset/:asset',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { asset } = request.params as { asset: string };
      const assetId = asset.trim().toUpperCase();

      const [assetLinks, recentImpacts, sentimentRows] = await Promise.all([
        prisma.newsAssetLink.findMany({
          where: { assetId },
          orderBy: { publishedAt: 'desc' },
          take: 20,
          select: { articleId: true, publishedAt: true, confidence: true },
        }),
        prisma.newsMarketImpact.findMany({
          where: { assetId },
          orderBy: { computedAt: 'desc' },
          take: 10,
          select: {
            eventId: true,
            direction: true,
            strength: true,
            confidence: true,
            newsImpactScore: true,
            evidenceType: true,
            computedAt: true,
          },
        }),
        prisma.newsSentiment.findMany({
          where: {
            articleId: {
              in: (
                await prisma.newsAssetLink.findMany({
                  where: { assetId },
                  orderBy: { publishedAt: 'desc' },
                  take: 10,
                  select: { articleId: true },
                })
              ).map((l) => l.articleId),
            },
          },
          orderBy: { computedAt: 'desc' },
          take: 10,
          select: {
            marketSentiment: true,
            companySentiment: true,
            macroSentiment: true,
            riskSentiment: true,
            sentimentScore: true,
          },
        }),
      ]);

      const sentimentSummary = computeSentimentSummary(sentimentRows);

      return reply.send({
        success: true,
        data: {
          asset: assetId,
          article_count: assetLinks.length,
          latest_article_at: assetLinks[0]?.publishedAt ?? null,
          sentiment_summary: sentimentSummary,
          recent_impacts: recentImpacts,
        },
        meta: { timestamp: new Date().toISOString() },
      });
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/v1/alphaforge/high-impact-events
  //
  // Events with importance_score > 0.7, sorted by recency (Req 25.2).
  // Supports optional query params: limit (default 20, max 100), cursor.
  // Requirements: Req 25.2
  // ─────────────────────────────────────────────────────────────────────────
  app.get(
    '/api/v1/alphaforge/high-impact-events',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'number', minimum: 1, maximum: 100, default: 20 },
            cursor: { type: 'string' },
            asset_id: { type: 'string' },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as {
        limit?: number;
        cursor?: string;
        asset_id?: string;
      };

      const limit = Math.min(query.limit ?? 20, 100);
      const cursorDate = query.cursor ? new Date(query.cursor) : undefined;

      const whereClause: Record<string, unknown> = {
        importanceScore: { gt: HIGH_IMPACT_THRESHOLD },
      };

      if (cursorDate) {
        whereClause['computedAt'] = { lt: cursorDate };
      }

      const importanceRows = await prisma.newsImportance.findMany({
        where: whereClause,
        orderBy: { computedAt: 'desc' },
        take: limit + 1, // fetch one extra to determine if there's a next page
        select: {
          importanceScore: true,
          computedAt: true,
          historicalDataAvailable: true,
          event: {
            select: {
              id: true,
              eventType: true,
              actor: true,
              action: true,
              eventTimestamp: true,
              confidence: true,
              article: {
                select: {
                  title: true,
                  sourceId: true,
                  publishedAt: true,
                },
              },
              marketImpacts: query.asset_id
                ? {
                    where: { assetId: query.asset_id },
                    take: 1,
                    select: {
                      assetId: true,
                      direction: true,
                      newsImpactScore: true,
                    },
                  }
                : {
                    take: 3,
                    orderBy: { confidence: 'desc' },
                    select: {
                      assetId: true,
                      direction: true,
                      newsImpactScore: true,
                    },
                  },
            },
          },
        },
      });

      const hasNextPage = importanceRows.length > limit;
      const rows = hasNextPage ? importanceRows.slice(0, limit) : importanceRows;

      const nextCursor =
        hasNextPage && rows.length > 0
          ? rows[rows.length - 1]!.computedAt.toISOString()
          : null;

      const events = rows.map((row) => ({
        eventId: row.event.id,
        eventType: row.event.eventType,
        actor: row.event.actor,
        action: row.event.action,
        eventTimestamp: row.event.eventTimestamp,
        title: row.event.article?.title ?? null,
        sourceId: row.event.article?.sourceId ?? null,
        publishedAt: row.event.article?.publishedAt ?? null,
        importanceScore: row.importanceScore,
        confidence: row.event.confidence,
        historicalDataAvailable: row.historicalDataAvailable,
        marketImpacts: row.event.marketImpacts,
        computedAt: row.computedAt,
      }));

      return reply.send({
        success: true,
        data: events,
        meta: {
          timestamp: new Date().toISOString(),
          total_count: events.length,
          next_cursor: nextCursor,
          has_next_page: hasNextPage,
          importance_threshold: HIGH_IMPACT_THRESHOLD,
        },
      });
    },
  );
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Computes a sentiment summary object from an array of sentiment rows.
 * Each dimension is averaged; returns nulls when no rows are present.
 */
function computeSentimentSummary(
  rows: Array<{
    marketSentiment?: unknown;
    companySentiment?: unknown;
    macroSentiment?: unknown;
    riskSentiment?: unknown;
    sentimentScore?: unknown;
  }>,
): {
  market: number | null;
  company: number | null;
  macro: number | null;
  risk: number | null;
  overall: number | null;
  direction: 'positive' | 'negative' | 'neutral';
} {
  if (rows.length === 0) {
    return { market: null, company: null, macro: null, risk: null, overall: null, direction: 'neutral' };
  }

  const avg = (field: string): number | null => {
    const values = rows
      .map((r) => {
        const v = (r as Record<string, unknown>)[field];
        return v !== null && v !== undefined ? Number(v) : null;
      })
      .filter((v): v is number => v !== null);
    if (values.length === 0) return null;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  };

  const market = avg('marketSentiment');
  const company = avg('companySentiment');
  const macro = avg('macroSentiment');
  const risk = avg('riskSentiment');
  const overall = avg('sentimentScore');

  const direction: 'positive' | 'negative' | 'neutral' =
    overall === null ? 'neutral' :
    overall > 0.05 ? 'positive' :
    overall < -0.05 ? 'negative' : 'neutral';

  return { market, company, macro, risk, overall, direction };
}

/**
 * Resolves the sentiment direction label for an event based on its impact
 * direction in the recent impacts list.
 */
function getSentimentDirection(
  eventId: string,
  impacts: Array<{ eventId: string; direction: string }>,
): 'positive' | 'negative' | 'neutral' {
  const impact = impacts.find((i) => i.eventId === eventId);
  if (!impact) return 'neutral';
  if (impact.direction === 'POSITIVE') return 'positive';
  if (impact.direction === 'NEGATIVE') return 'negative';
  return 'neutral';
}
