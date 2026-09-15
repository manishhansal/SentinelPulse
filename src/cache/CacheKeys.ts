/**
 * Redis cache key constants and builder functions for SentinelPulse.
 *
 * Defines all cache keys and their TTLs as specified in Req 27.1.
 * Every key used in the system must be declared here to avoid
 * magic strings scattered across the codebase.
 *
 * Requirements: Req 27.1
 */

// TTL constants (in seconds)
export const TTL = {
  LATEST_NEWS: 60,      // news:latest:india, news:latest:global
  ASSET_NEWS: 30,       // news:asset:{assetId}
  SIGNAL: 30,           // news:signal:{instrument}
  IMPACT: 30,           // news:impact:{instrument}
  REGIME: 20 * 60,      // news:regime (20 minutes)
  HOT_EVENTS: 60,       // news:hot-events
  VELOCITY: 90,         // news:velocity:{type}:{id}
  BREADTH: 6 * 60,      // news:breadth:india, news:breadth:global
} as const;

// Key builder functions
export const CacheKeys = {
  latestIndia: () => 'news:latest:india',
  latestGlobal: () => 'news:latest:global',
  asset: (assetId: string) => `news:asset:${assetId}`,
  signal: (instrument: string) => `news:signal:${instrument}`,
  impact: (instrument: string) => `news:impact:${instrument}`,
  regime: (marketId?: string) => (marketId ? `news:regime:${marketId}` : 'news:regime'),
  hotEvents: () => 'news:hot-events',
  velocity: (entityType: string, entityId: string) => `news:velocity:${entityType}:${entityId}`,
  breadthIndia: () => 'news:breadth:india',
  breadthGlobal: () => 'news:breadth:global',
} as const;
