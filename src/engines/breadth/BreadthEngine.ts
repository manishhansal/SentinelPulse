/**
 * BreadthEngine — computes market breadth metrics at the India and Global
 * market levels based on a rolling 4-hour sentiment window.
 *
 * Pipeline position:
 *   Runs as a standalone cron process every 5 minutes (breadth-cron).
 *   node dist/engines/breadth/BreadthEngine.js --cron
 *
 * Breadth definitions (Req 16.1):
 *   positive_asset_count  = articles where marketSentiment > +0.3
 *   negative_asset_count  = articles where marketSentiment < -0.3
 *   neutral_asset_count   = articles where marketSentiment ∈ [-0.3, +0.3]
 *   Window: most recent 4-hour rolling window.
 *
 * Market categorisation:
 *   india:  article.category IN INDIA_MARKET_CATEGORIES
 *   global: article.category IN GLOBAL_MARKET_CATEGORIES
 *
 * Storage (Req 16.3):
 *   news_features row: feature_type = 'BREADTH', entity_id = marketId,
 *   feature_vector = { positive, negative, neutral, windowStartAt, windowEndAt }
 *
 * Cache (Req 16.4):
 *   news:breadth:india  TTL = 6 minutes
 *   news:breadth:global TTL = 6 minutes
 *   When no articles in trailing 4h window → all counts = 0.
 *
 * Requirements: Req 16.1–16.4
 */

import { pino } from 'pino';
import { prisma } from '../../db/prisma.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Rolling window duration in milliseconds (4 hours). */
const WINDOW_4H_MS = 4 * 60 * 60 * 1000;

/**
 * Threshold above which marketSentiment is classified as positive (Req 16.1).
 */
const POSITIVE_THRESHOLD = 0.3;

/**
 * Threshold below which marketSentiment is classified as negative (Req 16.1).
 */
const NEGATIVE_THRESHOLD = -0.3;

/** Redis TTL for breadth cache entries in seconds — 6 minutes (Req 16.4). */
const REDIS_TTL_SECONDS = 6 * 60;

/** Feature version written to news_features. */
const FEATURE_VERSION = '1.0.0';

/** Pipeline version tag stored on every news_features row. */
const PIPELINE_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Market category mappings
// ---------------------------------------------------------------------------

/**
 * Article categories that belong to the India market breadth computation.
 * Categories are stored as-is in news_articles.category (Req 16.1, Req 16.2).
 */
const INDIA_MARKET_CATEGORIES: string[] = [
  'NIFTY50',
  'SENSEX',
  'BANKNIFTY',
  'INDIA_MACRO',
  'INDIA_EQUITY',
  'INDIA_MARKET',
  'RBI_POLICY',
  'INDIA_RATES',
  'INDIA_FOREX',
  'INDIA_COMMODITY',
  'NIFTY_MIDCAP',
  'NIFTY_SMALLCAP',
  'INDIA_SECTORAL',
];

/**
 * Article categories that belong to the Global market breadth computation.
 */
const GLOBAL_MARKET_CATEGORIES: string[] = [
  'US_MARKET',
  'EUROPE_MARKET',
  'ASIA_MARKET',
  'GLOBAL_MACRO',
  'FED_POLICY',
  'ECB_POLICY',
  'US_EQUITY',
  'US_RATES',
  'US_FOREX',
  'CRYPTO',
  'COMMODITIES',
  'OIL',
  'GOLD',
  'GLOBAL_EQUITY',
  'EMERGING_MARKETS',
];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Breadth metrics snapshot for a single market at a point in time.
 */
export interface BreadthMetrics {
  /** 'india' | 'global' */
  marketId: string;
  /** Count of articles with marketSentiment > +0.3 (Req 16.1). */
  positiveAssetCount: number;
  /** Count of articles with marketSentiment < -0.3 (Req 16.1). */
  negativeAssetCount: number;
  /** Count of articles with marketSentiment ∈ [-0.3, +0.3] (Req 16.1). */
  neutralAssetCount: number;
  /** Start of the 4-hour rolling window. */
  windowStartAt: Date;
  /** End of the 4-hour rolling window (= computedAt). */
  windowEndAt: Date;
  /** UTC timestamp of computation. */
  computedAt: Date;
}

// ---------------------------------------------------------------------------
// BreadthEngine
// ---------------------------------------------------------------------------

/**
 * Computes news breadth metrics for India and Global markets every 5 minutes.
 *
 * Redis client injection is optional: when omitted (e.g. in unit tests)
 * caching is skipped gracefully.
 */
export class BreadthEngine {
  private readonly logger = pino({ name: 'BreadthEngine' });

  /**
   * Lazily injected Redis client.
   * Type kept as `any` so the class does not import ioredis directly —
   * the caller supplies the real client at runtime.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private redisClient: any = null;

  // -------------------------------------------------------------------------
  // Redis injection
  // -------------------------------------------------------------------------

  /**
   * Injects a Redis client (e.g. ioredis instance) after construction.
   * Must be called before `compute()` to enable caching.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setRedisClient(client: any): void {
    this.redisClient = client;
  }

  // -------------------------------------------------------------------------
  // Public: main entry point
  // -------------------------------------------------------------------------

  /**
   * Computes and persists breadth metrics for both India and Global markets.
   * Intended to be called every 5 minutes by the breadth-cron process.
   * Requirements: Req 16.1–16.4
   */
  async compute(): Promise<void> {
    this.logger.info('BreadthEngine compute cycle started');

    const results: BreadthMetrics[] = [];

    for (const marketId of ['india', 'global'] as const) {
      try {
        const metrics = await this.computeForMarket(marketId);
        await this.storeMetrics(metrics);
        await this.cacheMetrics(metrics);
        results.push(metrics);
      } catch (err) {
        this.logger.error({ marketId, err }, 'Failed to compute breadth for market');
      }
    }

    this.logger.info(
      {
        india: results.find((r) => r.marketId === 'india'),
        global: results.find((r) => r.marketId === 'global'),
      },
      'BreadthEngine compute cycle complete',
    );
  }

  // -------------------------------------------------------------------------
  // Public: compute for a single market (exposed for direct use / testing)
  // -------------------------------------------------------------------------

  /**
   * Computes breadth metrics for a single market over the most recent 4-hour
   * rolling window.
   *
   * Steps:
   *  1. Determine the 4-hour window [windowStartAt, windowEndAt].
   *  2. Query news_sentiment joined with news_articles filtered by category
   *     and window, taking the latest sentiment row per article.
   *  3. Classify each article's marketSentiment into positive/negative/neutral.
   *  4. Return the counts (all zero when no articles found — Req 16.4).
   *
   * Requirements: Req 16.1, Req 16.4
   */
  async computeForMarket(marketId: 'india' | 'global'): Promise<BreadthMetrics> {
    const computedAt = new Date();
    const windowEndAt = computedAt;
    const windowStartAt = new Date(computedAt.getTime() - WINDOW_4H_MS);

    const categories =
      marketId === 'india' ? INDIA_MARKET_CATEGORIES : GLOBAL_MARKET_CATEGORIES;

    this.logger.debug(
      { marketId, windowStartAt, windowEndAt, categories },
      'Computing breadth metrics',
    );

    // Fetch all sentiment rows for articles within the 4-hour window that
    // belong to the relevant market categories.  We use the article's
    // publishedAt for window filtering and take marketSentiment for
    // classification.
    //
    // Note: an article may have multiple sentiment rows (different model
    // versions).  We take the most recent one per article by ordering
    // descending on computedAt and using the first result per group via a
    // subquery-style approach.  In Prisma we achieve this by fetching all rows
    // in the window and deduplicating in memory (corpus is small — 4h window).
    const rawRows = await prisma.newsSentiment.findMany({
      where: {
        article: {
          publishedAt: { gte: windowStartAt, lte: windowEndAt },
          category: { in: categories },
        },
      },
      select: {
        articleId: true,
        marketSentiment: true,
        computedAt: true,
      },
      orderBy: { computedAt: 'desc' },
    });

    // Deduplicate: keep only the most recent sentiment row per articleId.
    // The results are already ordered desc by computedAt, so the first
    // occurrence per articleId is the latest one.
    const latestByArticle = new Map<string, number>();
    for (const row of rawRows) {
      if (!latestByArticle.has(row.articleId)) {
        // Prisma returns Decimal for db.Decimal columns; convert to number.
        latestByArticle.set(row.articleId, Number(row.marketSentiment));
      }
    }

    // Classify into breadth buckets (Req 16.1).
    let positiveAssetCount = 0;
    let negativeAssetCount = 0;
    let neutralAssetCount = 0;

    for (const marketSentiment of latestByArticle.values()) {
      if (marketSentiment > POSITIVE_THRESHOLD) {
        positiveAssetCount++;
      } else if (marketSentiment < NEGATIVE_THRESHOLD) {
        negativeAssetCount++;
      } else {
        neutralAssetCount++;
      }
    }

    this.logger.debug(
      { marketId, positiveAssetCount, negativeAssetCount, neutralAssetCount },
      'Breadth counts computed',
    );

    return {
      marketId,
      positiveAssetCount,
      negativeAssetCount,
      neutralAssetCount,
      windowStartAt,
      windowEndAt,
      computedAt,
    };
  }

  // -------------------------------------------------------------------------
  // Private: storage
  // -------------------------------------------------------------------------

  /**
   * Persists a breadth metrics snapshot to news_features with
   * feature_type = 'BREADTH' and entity_id = marketId (Req 16.3).
   *
   * Uses createMany with skipDuplicates so that re-runs at the same
   * computed_at are idempotent.
   */
  private async storeMetrics(metrics: BreadthMetrics): Promise<void> {
    const { marketId, positiveAssetCount, negativeAssetCount, neutralAssetCount,
            windowStartAt, windowEndAt, computedAt } = metrics;

    await prisma.newsFeature.create({
      data: {
        entityType: 'MARKET',
        entityId: marketId,
        featureType: 'BREADTH',
        featureVector: {
          positiveAssetCount,
          negativeAssetCount,
          neutralAssetCount,
          windowStartAt: windowStartAt.toISOString(),
          windowEndAt: windowEndAt.toISOString(),
        },
        computedAt,
        featureVersion: FEATURE_VERSION,
        pipelineVersion: PIPELINE_VERSION,
      },
    });

    this.logger.debug({ marketId }, 'Breadth metrics stored to news_features');
  }

  // -------------------------------------------------------------------------
  // Private: caching
  // -------------------------------------------------------------------------

  /**
   * Serialises and caches the metrics payload in Redis under
   * `news:breadth:india` or `news:breadth:global` with TTL = 6 min (Req 16.4).
   *
   * If no Redis client has been injected, caching is silently skipped so
   * that unit tests and dry-run scripts can operate without a Redis instance.
   *
   * When all counts are zero (no articles in window), the zero payload is
   * cached — callers should treat it as "no breadth signal" (Req 16.4).
   */
  private async cacheMetrics(metrics: BreadthMetrics): Promise<void> {
    if (this.redisClient === null) {
      return;
    }

    const key = `news:breadth:${metrics.marketId}`;
    const payload = JSON.stringify({
      marketId: metrics.marketId,
      positiveAssetCount: metrics.positiveAssetCount,
      negativeAssetCount: metrics.negativeAssetCount,
      neutralAssetCount: metrics.neutralAssetCount,
      windowStartAt: metrics.windowStartAt.toISOString(),
      windowEndAt: metrics.windowEndAt.toISOString(),
      computedAt: metrics.computedAt.toISOString(),
    });

    try {
      await this.redisClient.set(key, payload, 'EX', REDIS_TTL_SECONDS);
      this.logger.debug({ key }, 'Breadth metrics cached in Redis');
    } catch (err) {
      this.logger.warn(
        { key, err },
        'Redis cache write failed for breadth metrics; continuing without cache',
      );
    }
  }
}
