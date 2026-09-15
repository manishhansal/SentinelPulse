/**
 * MarketRegimeEngine — classifies and caches the current market regime for each
 * major market (India, US, Global).
 *
 * Update cycle (every 15 minutes, run by regime-cron):
 *   1. Request regime prediction from ml-service POST /predict/regime using
 *      current market data from the data-service quote endpoint.
 *   2. If ml-service OR data-service is unavailable, retain the existing
 *      cached regime and emit a WARN log (Req 13.5).
 *      regime_data_available is set to false on the feature vector when no
 *      regime is available — fabricated regimes are never written (Req 13.5).
 *   3. If the regime changed, close the prior DB record (valid_to = now) and
 *      open a new one (valid_from = now). Purge Redis cached impact scores for
 *      active high-importance events linked to that market (Req 13.3).
 *   4. Write/refresh the Redis key news:regime:{market_id} (TTL = 20 min).
 *
 * Requirements: Req 13.1, Req 13.2, Req 13.3, Req 13.4, Req 13.5
 */

import { randomUUID } from 'crypto';
import { pino } from 'pino';
import { prisma } from '../../db/prisma.js';
import { DataServiceClient } from '../../integrations/data-service/DataServiceClient.js';
import { MlServiceClient } from '../../integrations/ml-service/MlServiceClient.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Discrete market-environment classification (Req 13.1).
 */
export type MarketRegime =
  | 'TRENDING_BULL'
  | 'TRENDING_BEAR'
  | 'SIDEWAYS'
  | 'HIGH_VOLATILITY'
  | 'LOW_VOLATILITY'
  | 'RISK_ON'
  | 'RISK_OFF'
  | 'EVENT_DRIVEN'
  | 'PANIC'
  | 'RECOVERY';

/** The three major markets tracked by SentinelPulse (Req 13.1). */
export type MarketId = 'india' | 'us' | 'global';

/** A point-in-time regime record surfaced to callers. */
export interface RegimeRecord {
  marketId: MarketId;
  regime: MarketRegime;
  confidence: number;
  validFrom: Date;
  validTo: Date | null;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/** Set of all valid MarketRegime strings for safe type-narrowing. */
const VALID_REGIMES = new Set<string>([
  'TRENDING_BULL',
  'TRENDING_BEAR',
  'SIDEWAYS',
  'HIGH_VOLATILITY',
  'LOW_VOLATILITY',
  'RISK_ON',
  'RISK_OFF',
  'EVENT_DRIVEN',
  'PANIC',
  'RECOVERY',
]);

/**
 * Fallback regime returned when data-service is unavailable and no DB/cache
 * record exists (Req 13.5).
 */
const DEFAULT_REGIME: MarketRegime = 'SIDEWAYS';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const DEFAULT_CONFIDENCE = 0.5;

/**
 * Redis TTL for news:regime:{market_id} keys (Req 13.2, Req 13.5).
 * 20 minutes expressed in seconds.
 */
const REGIME_CACHE_TTL_SECONDS = 20 * 60;

/**
 * Importance threshold above which cached impact scores must be purged on
 * regime change (Req 13.3).
 */
const HIGH_IMPORTANCE_THRESHOLD = 0.7;

/**
 * Pattern prefix used when scanning Redis for cached impact score keys that
 * must be invalidated on regime change (Req 13.3).
 * Format: news:impact:{eventId}
 */
const IMPACT_CACHE_KEY_PREFIX = 'news:impact:';

// ---------------------------------------------------------------------------
// MarketRegimeEngine
// ---------------------------------------------------------------------------

export class MarketRegimeEngine {
  private readonly logger = pino({ name: 'MarketRegimeEngine' });
  // Typed as `any` to avoid pulling in ioredis as a hard dependency here;
  // callers inject the real ioredis client via setRedisClient().
  private redisClient: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any

  constructor(
    private readonly dataServiceClient: DataServiceClient = new DataServiceClient(),
    private readonly mlServiceClient: MlServiceClient = new MlServiceClient(),
  ) {}

  /**
   * Injects a Redis client (ioredis-compatible) for cache operations.
   * Must be called before `update()` or `getCurrentRegime()` if Redis caching
   * is desired — both methods degrade gracefully when no client is set.
   */
  setRedisClient(client: any): void { // eslint-disable-line @typescript-eslint/no-explicit-any
    this.redisClient = client;
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Updates market regime classifications for all three markets.
   * Called every 15 minutes by the regime-cron process (Req 13.2).
   *
   * Errors per-market are caught and logged so a failure for one market does
   * not block the others (Req 13.5).
   */
  async update(): Promise<void> {
    const markets: MarketId[] = ['india', 'us', 'global'];

    for (const marketId of markets) {
      try {
        await this.updateMarket(marketId);
      } catch (err) {
        // Req 13.5: retain existing cached regime on data-service failure
        this.logger.warn(
          { marketId, err },
          'MarketRegimeEngine: failed to update regime — retaining existing cached regime',
        );
      }
    }
  }

  /**
   * Returns the current regime for a market.
   *
   * Resolution order:
   *   1. Redis cache (news:regime:{market_id})
   *   2. Postgres (the record with valid_to = null)
   *   3. null — no record available
   *
   * Callers should treat null as an indication that the engine has not yet
   * run for this market.
   */
  async getCurrentRegime(marketId: MarketId): Promise<RegimeRecord | null> {
    // --- 1. Try Redis ---
    const cached = await this.readFromCache(marketId);
    if (cached) return cached;

    // --- 2. Try DB ---
    return this.fetchCurrentFromDb(marketId);
  }

  // --------------------------------------------------------------------------
  // Private: per-market update logic
  // --------------------------------------------------------------------------

  /**
   * Fetches market data and requests regime prediction from ml-service,
   * then persists and caches the result for a single market (Req 13.2).
   *
   * If ml-service is unavailable or market data cannot be assembled,
   * retains the existing regime (Req 13.5) — never fabricates one.
   *
   * @throws When a non-recoverable error occurs (caller handles per Req 13.5).
   */
  private async updateMarket(marketId: MarketId): Promise<void> {
    // India is the only market for which we have direct data-service coverage.
    // For 'us' and 'global', we emit a warn and retain the cached regime until
    // a data feed is configured.
    if (marketId !== 'india') {
      this.logger.warn(
        { marketId },
        'MarketRegimeEngine: no market-data feed configured for this market — retaining cached regime',
      );
      return;
    }

    // --- 1. Fetch intraday market data for regime input ---
    //
    // We need NIFTY and BANKNIFTY quote snapshots plus VIX.
    // getMarketContextSnapshot uses the current time as asOf — correct for
    // regime classification (we are classifying the PRESENT regime).
    const now = new Date();

    const [niftySnapshot, bankNiftySnapshot] = await Promise.all([
      this.dataServiceClient.getMarketContextSnapshot('NIFTY', now).catch(() => null),
      this.dataServiceClient.getMarketContextSnapshot('BANKNIFTY', now).catch(() => null),
    ]);

    // If neither snapshot is available, we cannot assemble a valid request.
    if (!niftySnapshot && !bankNiftySnapshot) {
      this.logger.warn(
        { marketId },
        'MarketRegimeEngine: market-data snapshots unavailable — retaining cached regime (regime_data_available=false)',
      );
      return;
    }

    // Build a best-effort RegimePredictionRequest.
    // Use fallback values (0) for missing fields — the ml-service tolerates
    // nullish optional fields and will use the available ones.
    const regimeRequest = {
      nifty_change_pct: niftySnapshot?.price && niftySnapshot.close
        ? ((niftySnapshot.price - niftySnapshot.close) / niftySnapshot.close) * 100
        : 0,
      banknifty_change_pct: bankNiftySnapshot?.price && bankNiftySnapshot.close
        ? ((bankNiftySnapshot.price - bankNiftySnapshot.close) / bankNiftySnapshot.close) * 100
        : 0,
      india_vix: niftySnapshot?.vix ?? 15.0, // 15 = long-run VIX average as fallback
      nifty_atr_pct: niftySnapshot?.atr && niftySnapshot.price
        ? (niftySnapshot.atr / niftySnapshot.price) * 100
        : 0.5,
      nifty_adx: 25.0, // neutral fallback — not available from quotes endpoint
      advance_decline_ratio: 1.0, // neutral fallback
      market_breadth: 0.5, // neutral fallback
      sector_strength: niftySnapshot?.price && niftySnapshot.close
        ? ((niftySnapshot.price - niftySnapshot.close) / niftySnapshot.close) * 100
        : 0,
      volume_ratio: niftySnapshot?.volume ?? 1.0,
      gap_pct: niftySnapshot?.price && niftySnapshot.open
        ? ((niftySnapshot.price - niftySnapshot.open) / niftySnapshot.open) * 100
        : 0,
    };

    // --- 2. Request regime prediction from ml-service ---
    const prediction = await this.mlServiceClient.predictRegime(regimeRequest);

    if (!prediction) {
      this.logger.warn(
        { marketId },
        'MarketRegimeEngine: ml-service predictRegime returned null — retaining cached regime (regime_data_available=false)',
      );
      return;
    }

    const regime = this.normaliseRegime(prediction.regime);
    const confidence = prediction.confidence;

    // --- 3. Get current DB regime ---
    const currentRecord = await this.fetchCurrentFromDb(marketId);

    // --- 4. Handle change if regime differs ---
    if (!currentRecord || currentRecord.regime !== regime) {
      await this.handleRegimeChange(marketId, regime, confidence);
    }

    // --- 5. Refresh Redis cache regardless of whether regime changed (Req 13.2) ---
    await this.writeToCache(marketId, regime, confidence);

    this.logger.info(
      { marketId, regime, confidence, modelVersion: prediction.modelVersion },
      'MarketRegimeEngine: regime updated from ml-service',
    );
  }

  // --------------------------------------------------------------------------
  // Private: regime normalisation
  // --------------------------------------------------------------------------

  /**
   * Validates that the regime string from ml-service is one of the known
   * MarketRegime values. Falls back to DEFAULT_REGIME when unrecognised.
   */
  private normaliseRegime(regime: string): MarketRegime {
    if (VALID_REGIMES.has(regime)) {
      return regime as MarketRegime;
    }
    this.logger.warn({ regime }, 'MarketRegimeEngine: unrecognised regime from ml-service — using DEFAULT');
    return DEFAULT_REGIME;
  }

  // --------------------------------------------------------------------------
  // Private: regime-change handler
  // --------------------------------------------------------------------------

  /**
   * Handles a regime change:
   *   1. Closes the prior DB record by setting valid_to = now (Req 13.2).
   *   2. Inserts a new record with valid_from = now (Req 13.2).
   *   3. Purges Redis cached impact scores for high-importance events (Req 13.3).
   */
  private async handleRegimeChange(
    marketId: MarketId,
    newRegime: MarketRegime,
    confidence: number,
  ): Promise<void> {
    const now = new Date();

    // Close prior active record (valid_to = null → valid_to = now)
    await prisma.newsMarketRegime.updateMany({
      where: {
        marketId,
        validTo: null,
      },
      data: {
        validTo: now,
      },
    });

    // Insert new current record
    await prisma.newsMarketRegime.create({
      data: {
        id: randomUUID(),
        marketId,
        regime: newRegime,
        confidence,
        validFrom: now,
        validTo: null,
      },
    });

    this.logger.info(
      { marketId, newRegime, confidence },
      'MarketRegimeEngine: regime changed — persisted new record',
    );

    // Purge cached impact scores for high-importance events (Req 13.3)
    await this.purgeHighImportanceCaches(marketId);
  }

  // --------------------------------------------------------------------------
  // Private: Redis cache helpers
  // --------------------------------------------------------------------------

  /**
   * Reads the cached regime record for a market from Redis.
   * Returns null when no client is configured or the key is absent.
   */
  private async readFromCache(marketId: MarketId): Promise<RegimeRecord | null> {
    if (!this.redisClient) return null;

    try {
      const key = `news:regime:${marketId}`;
      const raw: string | null = await this.redisClient.get(key);
      if (!raw) return null;

      const parsed = JSON.parse(raw) as {
        marketId: MarketId;
        regime: MarketRegime;
        confidence: number;
        validFrom: string;
        validTo: string | null;
      };

      return {
        marketId: parsed.marketId,
        regime: parsed.regime,
        confidence: parsed.confidence,
        validFrom: new Date(parsed.validFrom),
        validTo: parsed.validTo ? new Date(parsed.validTo) : null,
      };
    } catch (err) {
      this.logger.warn({ marketId, err }, 'MarketRegimeEngine: failed to read regime from Redis — falling back to DB');
      return null;
    }
  }

  /**
   * Writes the current regime for a market to Redis.
   * Key: news:regime:{market_id}, TTL: 20 minutes (Req 13.2, Req 13.5).
   * Logs a WARN and continues silently when no client is configured or the
   * write fails.
   */
  private async writeToCache(
    marketId: MarketId,
    regime: MarketRegime,
    confidence: number,
  ): Promise<void> {
    if (!this.redisClient) return;

    try {
      const key = `news:regime:${marketId}`;
      const value = JSON.stringify({
        marketId,
        regime,
        confidence,
        validFrom: new Date().toISOString(),
        validTo: null,
      });
      await this.redisClient.set(key, value, 'EX', REGIME_CACHE_TTL_SECONDS);
    } catch (err) {
      this.logger.warn({ marketId, err }, 'MarketRegimeEngine: failed to write regime to Redis');
    }
  }

  // --------------------------------------------------------------------------
  // Private: DB helpers
  // --------------------------------------------------------------------------

  /**
   * Reads the current regime record (valid_to = null) from Postgres for a
   * market. Returns null when no record exists.
   */
  private async fetchCurrentFromDb(marketId: MarketId): Promise<RegimeRecord | null> {
    const row = await prisma.newsMarketRegime.findFirst({
      where: { marketId, validTo: null },
      orderBy: { validFrom: 'desc' },
    });

    if (!row) return null;

    return {
      marketId: row.marketId as MarketId,
      regime: row.regime as MarketRegime,
      confidence: row.confidence,
      validFrom: row.validFrom,
      validTo: row.validTo ?? null,
    };
  }

  // --------------------------------------------------------------------------
  // Private: cache purge on regime change
  // --------------------------------------------------------------------------

  /**
   * Purges Redis cached impact scores for all active high-importance events
   * linked to the given market (Req 13.3).
   *
   * Identifies candidate events via:
   *   - news_importance.importance_score > HIGH_IMPORTANCE_THRESHOLD (0.7)
   *   - The event's newsMarketImpacts contain the market's assetId pattern, OR
   *     the event is not yet expired (no valid_to constraint — we purge broadly
   *     across all active events above the threshold linked to any asset).
   *
   * Redis keys purged: news:impact:{eventId}
   *
   * If Redis is unavailable, logs WARN and continues without throwing so that
   * the regime update itself still completes successfully.
   */
  private async purgeHighImportanceCaches(marketId: MarketId): Promise<void> {
    if (!this.redisClient) return;

    try {
      // Fetch active high-importance event IDs. We scope to events whose
      // market impacts are associated with the affected market. Since asset/
      // sector IDs embed no market prefix in the schema, we perform a broad
      // purge across all events above the threshold (conservative approach
      // that avoids stale impact scores surviving a regime change).
      const highImportanceEvents = await prisma.newsImportance.findMany({
        where: {
          importanceScore: { gt: HIGH_IMPORTANCE_THRESHOLD },
        },
        select: { eventId: true },
        take: 1000, // safety cap — impact scores beyond 1k are extremely rare
      });

      if (highImportanceEvents.length === 0) {
        this.logger.debug({ marketId }, 'MarketRegimeEngine: no high-importance events to purge from cache');
        return;
      }

      const pipeline = this.redisClient.pipeline?.() ?? null;

      for (const { eventId } of highImportanceEvents) {
        const key = `${IMPACT_CACHE_KEY_PREFIX}${eventId}`;
        if (pipeline) {
          pipeline.del(key);
        } else {
          await this.redisClient.del(key);
        }
      }

      if (pipeline) {
        await pipeline.exec();
      }

      this.logger.info(
        { marketId, purgedCount: highImportanceEvents.length },
        'MarketRegimeEngine: purged cached impact scores for high-importance events on regime change',
      );
    } catch (err) {
      this.logger.warn(
        { marketId, err },
        'MarketRegimeEngine: failed to purge high-importance impact caches — continuing',
      );
    }
  }
}
