/**
 * Cache invalidation logic for SentinelPulse.
 *
 * Rules (from design doc):
 * - Cache is **never** the write target. All writes go to PostgreSQL first.
 * - Within 5 seconds of a PostgreSQL write that supersedes a cached key,
 *   the key is deleted here (Req 27.5).
 * - On cache miss: caller serves from PostgreSQL and asynchronously
 *   repopulates the cache key (Req 27.3).
 *
 * Requirements: Req 27.3, Req 27.5, Req 13.3
 */

import { pino } from 'pino';
import { prisma } from '../db/prisma.js';
import { RedisClient } from './RedisClient.js';

const logger = pino({ name: 'cache-invalidation' });

/** Events with an importance score above this threshold are purged on regime change (Req 13.3). */
const HIGH_IMPORTANCE_THRESHOLD = 0.7;

export class CacheInvalidation {
  constructor(private readonly redis: RedisClient) {}

  // ---------------------------------------------------------------------------
  // Req 27.5 — Generic write-triggered key invalidation
  // ---------------------------------------------------------------------------

  /**
   * Invalidates a cached key within 5 seconds of a PostgreSQL write that
   * supersedes it.  Call immediately after any write that renders a cached
   * entry stale (Req 27.5).
   */
  async invalidateOnWrite(key: string): Promise<void> {
    await this.redis.del(key);
    logger.debug({ key }, 'Cache key invalidated on write');
  }

  // ---------------------------------------------------------------------------
  // Req 13.3 — Regime-change cache purge
  // ---------------------------------------------------------------------------

  /**
   * Purges cached data when the market regime changes for `marketId`.
   *
   * Steps (per design doc):
   *   1. Delete `news:regime:{marketId}`
   *   2. Find all high-importance events (importanceScore > 0.7) linked to
   *      assets in the given market via NewsMarketImpact, then delete
   *      `news:signal:{assetId}` for each.
   *
   * Requirements: Req 13.3
   */
  async regimePurge(marketId: string): Promise<void> {
    // Step 1: delete the regime cache key
    await this.redis.del(`news:regime:${marketId}`);
    logger.info({ marketId }, 'Purged regime cache key');

    // Step 2: scan + delete news:signal:* for high-importance events
    try {
      // Find market impacts for events whose importance_score > 0.7.
      // NewsMarketImpact gives us the assetId (instrument) that maps to
      // the news:signal:{instrument} cache key.
      const impacts = await prisma.newsMarketImpact.findMany({
        where: {
          event: {
            importance_: {
              importanceScore: { gt: HIGH_IMPORTANCE_THRESHOLD },
            },
          },
        },
        select: { assetId: true },
        distinct: ['assetId'],
        take: 1000,
      });

      const assetIds = impacts
        .map((r) => r.assetId)
        .filter((id): id is string => id !== '' && id !== null && id !== undefined);

      for (const assetId of assetIds) {
        await this.redis.del(`news:signal:${assetId}`);
      }

      logger.info(
        { marketId, purgedSignals: assetIds.length },
        'Purged news:signal:* keys for high-importance events on regime change',
      );
    } catch (err) {
      logger.warn({ marketId, err }, 'Failed to purge signal caches on regime change');
    }
  }

  // ---------------------------------------------------------------------------
  // Convenience invalidation helpers (called by pipeline workers)
  // ---------------------------------------------------------------------------

  /**
   * Invalidates all cache keys for a specific asset (Req 27.5).
   * Call after a new article or market impact is written for this asset.
   */
  async invalidateAsset(assetId: string): Promise<void> {
    await Promise.all([
      this.invalidateOnWrite(`news:asset:${assetId}`),
      this.invalidateOnWrite(`news:signal:${assetId}`),
      this.invalidateOnWrite(`news:impact:${assetId}`),
    ]);
  }

  /**
   * Invalidates the latest-news bundle for a market category (Req 27.5).
   * Call after a new article is published in the given market category.
   */
  async invalidateLatest(market: 'india' | 'global'): Promise<void> {
    await this.invalidateOnWrite(`news:latest:${market}`);
  }

  /**
   * Invalidates the hot-events list (Req 27.5).
   * Call after a new high-importance event is stored.
   */
  async invalidateHotEvents(): Promise<void> {
    await this.invalidateOnWrite('news:hot-events');
  }

  /**
   * Invalidates velocity cache for an entity (Req 27.5).
   * Call after the VelocityEngine completes a 60-second recompute cycle.
   */
  async invalidateVelocity(type: string, id: string): Promise<void> {
    await this.invalidateOnWrite(`news:velocity:${type}:${id}`);
  }

  /**
   * Invalidates breadth cache for a market (Req 27.5).
   * Call after the BreadthEngine completes a 5-minute recompute cycle.
   */
  async invalidateBreadth(market: 'india' | 'global'): Promise<void> {
    await this.invalidateOnWrite(`news:breadth:${market}`);
  }
}
