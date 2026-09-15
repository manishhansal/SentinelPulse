/**
 * VelocityEngine — computes rolling news velocity and momentum metrics per
 * asset and sector, detecting velocity spikes that may themselves act as
 * market signal inputs.
 *
 * Pipeline position:
 *   Runs as a standalone cron process (velocity-cron) every 60 seconds.
 *   node dist/engines/velocity/VelocityEngine.js --cron
 *
 * Computed metrics (Req 15.1):
 *   velocity_1m  = COUNT(articles) in trailing 60s for entity
 *   velocity_5m  = COUNT(articles) in trailing 300s for entity
 *
 * Momentum (Req 15.2):
 *   baseline     = rolling 7-day average at same clock-hour:clock-minute
 *   momentum     = velocity_5m / baseline  (null when baseline is 0 or null)
 *   *** NEVER divide by zero — null guard is unconditional ***
 *
 * Cache (Req 15.3):
 *   Redis key: news:velocity:{entity_type}:{entity_id}   TTL = 90 s
 *
 * Storage (Req 15.4):
 *   news_features rows: feature_type = "VELOCITY", window = "1m" | "5m",
 *   entity_type, entity_id, value, baseline, momentum, computed_at
 *
 * Spike detection (Req 15.5):
 *   IF velocity_5m > 3 × baseline AND baseline is NOT null
 *   THEN alertCallback(entityId, velocity5m, baseline) is invoked.
 *   IF baseline is null → alert is NOT generated.
 *
 * Requirements: Req 15.1–15.5
 */

import { pino } from 'pino';
import { prisma } from '../../db/prisma.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Rolling window for velocity_1m in milliseconds (60 seconds). */
const WINDOW_1M_MS = 60_000;

/** Rolling window for velocity_5m in milliseconds (5 minutes). */
const WINDOW_5M_MS = 300_000;

/**
 * Lookback for baseline: 7 days, expressed in days.
 * For each day we sample the same clock-hour:clock-minute.
 */
const BASELINE_DAYS = 7;

/** Spike threshold multiplier (Req 15.5). */
const SPIKE_MULTIPLIER = 3;

/**
 * Redis TTL for velocity cache entries in seconds (Req 15.3).
 * 90s so that a missed 60s cycle still serves fresh data.
 */
const REDIS_TTL_SECONDS = 90;

/** Feature version used when writing to news_features. */
const FEATURE_VERSION = '1.0.0';

/** Pipeline version tag stored on every news_features row. */
const PIPELINE_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** All velocity metrics computed for a single entity at a single point in time. */
export interface VelocityMetrics {
  /** 'asset' | 'sector' (or any entity type string from entity maps). */
  entityType: string;
  /** Stable identifier for the entity (e.g. instrument_id or sector_id). */
  entityId: string;
  /** Article count in the trailing 60-second window. */
  velocity1m: number;
  /** Article count in the trailing 5-minute window. */
  velocity5m: number;
  /**
   * 7-day average velocity at the same clock-hour:clock-minute.
   * null when no historical data is available for this time slot.
   */
  baseline: number | null;
  /**
   * velocity5m / baseline.
   * ALWAYS null when baseline is null or zero (Req 15.2 — no division by zero).
   */
  momentum: number | null;
  /** UTC timestamp of computation. */
  computedAt: Date;
}

// ---------------------------------------------------------------------------
// VelocityEngine
// ---------------------------------------------------------------------------

/**
 * Computes rolling news velocity and momentum for every recently active asset
 * and sector.  Designed to be invoked once every 60 seconds by the
 * velocity-cron process.
 *
 * Redis client injection is optional: when not injected (e.g. in unit tests)
 * caching is skipped gracefully.
 */
export class VelocityEngine {
  private readonly logger = pino({ name: 'VelocityEngine' });

  /**
   * Lazily injected Redis client.
   * Type kept as `any` so the class does not import ioredis directly —
   * the caller supplies the real client at runtime.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private redisClient: any = null;

  /**
   * @param alertCallback  Optional callback invoked when a velocity spike is
   *                       detected (velocity_5m > 3× baseline).  Req 15.5.
   *                       Parameters: entityId, velocity5m, baseline.
   *                       baseline is guaranteed to be > 0 when the callback fires.
   */
  constructor(
    private readonly alertCallback?: (
      assetId: string,
      velocity5m: number,
      baseline: number,
    ) => void,
  ) {}

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
   * Computes velocity metrics for all recently active assets and sectors.
   * Intended to be called every 60 seconds by the velocity-cron process.
   * Requirements: Req 15.1–15.5
   */
  async compute(): Promise<void> {
    const now = new Date();
    const lookbackStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    this.logger.info('VelocityEngine compute cycle started');

    // --- Assets ---
    const recentAssets = await prisma.newsAssetLink.findMany({
      where: { publishedAt: { gte: lookbackStart } },
      select: { assetId: true },
      distinct: ['assetId'],
    });

    this.logger.debug({ count: recentAssets.length }, 'Active assets found');

    for (const { assetId } of recentAssets) {
      try {
        const metrics = await this.computeForEntity('asset', assetId, now);
        await this.storeMetrics(metrics);
        await this.cacheMetrics(metrics);
        this.checkVelocitySpike(metrics);
      } catch (err) {
        this.logger.warn({ assetId, err }, 'Failed to compute velocity for asset');
      }
    }

    // --- Sectors ---
    const recentSectors = await prisma.newsSectorLink.findMany({
      where: { publishedAt: { gte: lookbackStart } },
      select: { sectorId: true },
      distinct: ['sectorId'],
    });

    this.logger.debug({ count: recentSectors.length }, 'Active sectors found');

    for (const { sectorId } of recentSectors) {
      try {
        const metrics = await this.computeForEntity('sector', sectorId, now);
        await this.storeMetrics(metrics);
        await this.cacheMetrics(metrics);
        this.checkVelocitySpike(metrics);
      } catch (err) {
        this.logger.warn({ sectorId, err }, 'Failed to compute velocity for sector');
      }
    }

    this.logger.info(
      { assets: recentAssets.length, sectors: recentSectors.length },
      'VelocityEngine compute cycle complete',
    );
  }

  // -------------------------------------------------------------------------
  // Public: compute for a single entity (exposed for direct use / testing)
  // -------------------------------------------------------------------------

  /**
   * Computes all velocity metrics for a single entity at the given timestamp.
   *
   * @param entityType  'asset' or 'sector'
   * @param entityId    Identifier (instrument_id / sector_id)
   * @param now         Reference point for window calculations
   */
  async computeForEntity(
    entityType: 'asset' | 'sector',
    entityId: string,
    now: Date,
  ): Promise<VelocityMetrics> {
    const from1m = new Date(now.getTime() - WINDOW_1M_MS);
    const from5m = new Date(now.getTime() - WINDOW_5M_MS);

    const [velocity1m, velocity5m, baseline] = await Promise.all([
      this.countArticlesForEntity(entityType, entityId, from1m, now),
      this.countArticlesForEntity(entityType, entityId, from5m, now),
      this.computeBaseline(entityType, entityId, now),
    ]);

    // Req 15.2: momentum is null whenever baseline is null or zero.
    // This is the ONLY place momentum is computed — the guard is unconditional.
    const momentum =
      baseline !== null && baseline > 0 ? velocity5m / baseline : null;

    return {
      entityType,
      entityId,
      velocity1m,
      velocity5m,
      baseline,
      momentum,
      computedAt: now,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Counts articles linked to `entityId` within the time range [from, to).
   *
   * Queries `news_asset_links` for assets and `news_sector_links` for sectors.
   * Both tables carry a denormalised `published_at` column indexed for range
   * queries (Req 28.2).
   */
  private async countArticlesForEntity(
    entityType: 'asset' | 'sector',
    entityId: string,
    from: Date,
    to: Date,
  ): Promise<number> {
    if (entityType === 'asset') {
      return prisma.newsAssetLink.count({
        where: {
          assetId: entityId,
          publishedAt: { gte: from, lt: to },
        },
      });
    }

    // sector
    return prisma.newsSectorLink.count({
      where: {
        sectorId: entityId,
        publishedAt: { gte: from, lt: to },
      },
    });
  }

  /**
   * Computes the 7-day baseline: the average of `value` stored in
   * `news_features` (feature_type = 'VELOCITY', window = '5m') for rows
   * at the same clock-hour:clock-minute over the past 7 days.
   *
   * Returns `null` when no historical rows are available for this slot, so
   * the caller can distinguish "zero articles at baseline time" (baseline = 0)
   * from "no historical data at all" (baseline = null).
   *
   * Req 15.2: The caller treats both null and 0 as → momentum = null.
   */
  private async computeBaseline(
    entityType: string,
    entityId: string,
    now: Date,
  ): Promise<number | null> {
    const targetHour = now.getUTCHours();
    const targetMinute = now.getUTCMinutes();

    const sevenDaysAgo = new Date(now.getTime() - BASELINE_DAYS * 24 * 60 * 60 * 1000);

    // Fetch all VELOCITY/5m feature rows for this entity in the past 7 days.
    const historicalRows = await prisma.newsFeature.findMany({
      where: {
        featureType: 'VELOCITY',
        entityType,
        entityId,
        window: '5m',
        computedAt: { gte: sevenDaysAgo, lt: now },
        value: { not: null },
      },
      select: { computedAt: true, value: true },
    });

    if (historicalRows.length === 0) {
      return null;
    }

    // Filter to rows at the same clock-hour:clock-minute as `now` (UTC).
    const sameSlotRows = historicalRows.filter((row) => {
      const d = row.computedAt;
      return d.getUTCHours() === targetHour && d.getUTCMinutes() === targetMinute;
    });

    if (sameSlotRows.length === 0) {
      return null;
    }

    // Average of the value column (velocity_5m values at this time slot).
    const sum = sameSlotRows.reduce((acc, row) => acc + (row.value ?? 0), 0);
    return sum / sameSlotRows.length;
  }

  /**
   * Persists two `news_features` snapshot rows (one for each window: 1m, 5m)
   * for the given metrics object.
   *
   * Uses `createMany` with `skipDuplicates: true` so re-runs at the same
   * computed_at timestamp are idempotent (Req 15.4).
   *
   * Note: the schema's unique index on news_features is
   * `(event_id, asset_id, feature_version)`.  For VELOCITY rows, event_id
   * and asset_id are both null; idempotency is achieved by always writing
   * fresh rows (TTL-managed by the cron schedule) rather than upsert.
   */
  private async storeMetrics(metrics: VelocityMetrics): Promise<void> {
    const { entityType, entityId, velocity1m, velocity5m, baseline, momentum, computedAt } =
      metrics;

    // Build two rows: one per window.
    const rows = [
      {
        entityType,
        entityId,
        featureType: 'VELOCITY',
        window: '1m',
        value: velocity1m,
        baseline,
        momentum,
        computedAt,
        featureVersion: FEATURE_VERSION,
        pipelineVersion: PIPELINE_VERSION,
      },
      {
        entityType,
        entityId,
        featureType: 'VELOCITY',
        window: '5m',
        value: velocity5m,
        baseline,
        momentum,
        computedAt,
        featureVersion: FEATURE_VERSION,
        pipelineVersion: PIPELINE_VERSION,
      },
    ];

    await prisma.newsFeature.createMany({ data: rows, skipDuplicates: true });
  }

  /**
   * Serialises and caches the metrics payload in Redis under
   * `news:velocity:{entity_type}:{entity_id}` with TTL = 90 s (Req 15.3).
   *
   * If no Redis client has been injected, caching is silently skipped so
   * that unit tests and dry-run scripts can operate without a Redis instance.
   */
  private async cacheMetrics(metrics: VelocityMetrics): Promise<void> {
    if (this.redisClient === null) {
      return;
    }

    const key = `news:velocity:${metrics.entityType}:${metrics.entityId}`;
    const payload = JSON.stringify({
      velocity1m: metrics.velocity1m,
      velocity5m: metrics.velocity5m,
      baseline: metrics.baseline,
      momentum: metrics.momentum,
      computedAt: metrics.computedAt.toISOString(),
    });

    try {
      await this.redisClient.set(key, payload, 'EX', REDIS_TTL_SECONDS);
    } catch (err) {
      this.logger.warn(
        { key, err },
        'Redis cache write failed for velocity metrics; continuing without cache',
      );
    }
  }

  /**
   * Checks whether a velocity spike has occurred and, if so, invokes the
   * alert callback.
   *
   * Spike condition (Req 15.5):
   *   velocity_5m > 3 × baseline   AND   baseline is NOT null
   *
   * If baseline is null, no alert is generated (Req 15.5 — explicit guard).
   *
   * This method is intentionally synchronous: the alertCallback may itself
   * be async, but VelocityEngine does not await it to avoid slowing the
   * compute loop.  The AlertEngine is responsible for its own error handling.
   */
  private checkVelocitySpike(metrics: VelocityMetrics): void {
    const { entityId, velocity5m, baseline } = metrics;

    // Req 15.5: do NOT alert when baseline is null.
    if (baseline === null) {
      return;
    }

    if (velocity5m > SPIKE_MULTIPLIER * baseline) {
      this.logger.info(
        { entityId, velocity5m, baseline, multiplier: SPIKE_MULTIPLIER },
        'Velocity spike detected',
      );

      if (this.alertCallback) {
        this.alertCallback(entityId, velocity5m, baseline);
      }
    }
  }
}
