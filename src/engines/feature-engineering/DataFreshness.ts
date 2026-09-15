/**
 * DataFreshness — staleness protection for SentinelPulse feature vectors.
 *
 * Every feature vector must carry explicit freshness metadata so consumers
 * can determine whether the data was current at prediction time.
 *
 * Freshness states:
 *   FRESH      — data_as_of is within the FRESH threshold
 *   STALE      — data_as_of is older than FRESH but within the STALE threshold
 *   EXPIRED    — data_as_of exceeds the STALE threshold; data MUST NOT be
 *                silently used by AlphaForge — callers must mark features
 *                as unavailable
 *   UNAVAILABLE — data was never obtained (no record, API down, etc.)
 *
 * Thresholds (configurable via env):
 *   FRESH_THRESHOLD_SECONDS   — default 300  (5 minutes)
 *   STALE_THRESHOLD_SECONDS   — default 3600 (1 hour)
 *
 * Point-in-time rule:
 *   feature_as_of MUST be <= prediction_timestamp for every ML feature.
 *   This is enforced by the LookAheadGuard; DataFreshness is the labelling
 *   layer that makes the freshness state explicit in the output.
 *
 * Requirements: Phase 3A staleness protection mandate
 */

// ---------------------------------------------------------------------------
// Freshness states
// ---------------------------------------------------------------------------

export type FreshnessState = 'FRESH' | 'STALE' | 'EXPIRED' | 'UNAVAILABLE';

// ---------------------------------------------------------------------------
// Thresholds (seconds)
// ---------------------------------------------------------------------------

const FRESH_THRESHOLD_SECONDS = parseInt(
  process.env['FRESHNESS_FRESH_THRESHOLD_SECONDS'] ?? '300',
  10,
);

const STALE_THRESHOLD_SECONDS = parseInt(
  process.env['FRESHNESS_STALE_THRESHOLD_SECONDS'] ?? '3600',
  10,
);

// ---------------------------------------------------------------------------
// FreshnessMetadata — attached to every feature vector
// ---------------------------------------------------------------------------

/**
 * Freshness metadata block attached to every SentinelPulse feature vector
 * and every data point passed to AlphaForge.
 */
export interface FreshnessMetadata {
  /**
   * Timestamp when the data was valid as-of (the data source's own timestamp,
   * not the computation timestamp). This is the timestamp used for look-ahead
   * validation.
   */
  feature_as_of: Date;
  /**
   * Wall-clock time when the feature was computed.
   */
  feature_timestamp: Date;
  /**
   * Age of the data in seconds: (feature_timestamp − feature_as_of) in seconds.
   */
  freshness_seconds: number;
  /**
   * Explicit freshness classification.
   */
  freshness_state: FreshnessState;
  /**
   * Whether the underlying data was available at all.
   * false when the data source was unreachable, returned no data, or when
   * the regime/embedding API is not configured.
   */
  data_available: boolean;
}

// ---------------------------------------------------------------------------
// DataFreshness — stateless utility class
// ---------------------------------------------------------------------------

export class DataFreshness {
  // --------------------------------------------------------------------------
  // classify() — main entry point
  // --------------------------------------------------------------------------

  /**
   * Computes freshness metadata for a data point.
   *
   * @param dataAsOf      The timestamp the data reflects (e.g. quote.asOf).
   *                      Pass null when the data is unavailable.
   * @param computedAt    When the feature was computed (defaults to now).
   * @returns A complete FreshnessMetadata block.
   */
  static classify(
    dataAsOf: Date | null,
    computedAt: Date = new Date(),
  ): FreshnessMetadata {
    if (!dataAsOf) {
      return {
        feature_as_of: computedAt,
        feature_timestamp: computedAt,
        freshness_seconds: 0,
        freshness_state: 'UNAVAILABLE',
        data_available: false,
      };
    }

    const freshnessSeconds = Math.floor(
      (computedAt.getTime() - dataAsOf.getTime()) / 1000,
    );

    let state: FreshnessState;
    if (freshnessSeconds < 0) {
      // dataAsOf is in the future relative to computedAt — this is a
      // look-ahead violation and will be caught by LookAheadGuard, but
      // we label it UNAVAILABLE here to prevent silent propagation.
      state = 'UNAVAILABLE';
    } else if (freshnessSeconds <= FRESH_THRESHOLD_SECONDS) {
      state = 'FRESH';
    } else if (freshnessSeconds <= STALE_THRESHOLD_SECONDS) {
      state = 'STALE';
    } else {
      state = 'EXPIRED';
    }

    return {
      feature_as_of: dataAsOf,
      feature_timestamp: computedAt,
      freshness_seconds: Math.max(0, freshnessSeconds),
      freshness_state: state,
      data_available: true,
    };
  }

  /**
   * Returns a FreshnessMetadata indicating the data is available at the
   * current moment (used when data is computed in real-time with no lag).
   */
  static fresh(computedAt: Date = new Date()): FreshnessMetadata {
    return DataFreshness.classify(computedAt, computedAt);
  }

  /**
   * Returns a FreshnessMetadata indicating the data is completely unavailable.
   * Use this when an API is unconfigured, down, or returned no data.
   */
  static unavailable(computedAt: Date = new Date()): FreshnessMetadata {
    return DataFreshness.classify(null, computedAt);
  }

  // --------------------------------------------------------------------------
  // isUsable() — guard for feature consumers
  // --------------------------------------------------------------------------

  /**
   * Returns true when the data is safe to use: FRESH or STALE.
   * Returns false for EXPIRED or UNAVAILABLE.
   *
   * Callers MUST check this before feeding features to AlphaForge or the
   * ml-service. Expired news MUST NOT silently influence downstream signals.
   */
  static isUsable(metadata: FreshnessMetadata): boolean {
    return (
      metadata.data_available &&
      (metadata.freshness_state === 'FRESH' ||
        metadata.freshness_state === 'STALE')
    );
  }

  // --------------------------------------------------------------------------
  // forRegime() — convenience for regime data
  // --------------------------------------------------------------------------

  /**
   * Computes freshness for regime data.
   *
   * @param regimeValidFrom The regime record's validFrom timestamp (or null
   *                        when no regime is available).
   */
  static forRegime(regimeValidFrom: Date | null): FreshnessMetadata {
    return DataFreshness.classify(regimeValidFrom);
  }

  // --------------------------------------------------------------------------
  // forNewsArticle() — convenience for article data
  // --------------------------------------------------------------------------

  /**
   * Computes freshness for news article data.
   *
   * @param publishedAt The article's publishedAt timestamp.
   * @param scrapedAt   When the article was ingested (the computedAt base).
   */
  static forNewsArticle(
    publishedAt: Date,
    scrapedAt: Date = new Date(),
  ): FreshnessMetadata {
    return DataFreshness.classify(publishedAt, scrapedAt);
  }

  // --------------------------------------------------------------------------
  // merge() — combine multiple metadata blocks
  // --------------------------------------------------------------------------

  /**
   * Returns the "worst" (least fresh) freshness state from multiple blocks.
   * Used when a feature depends on several data sources.
   *
   * Priority (worst to best): UNAVAILABLE > EXPIRED > STALE > FRESH
   */
  static merge(...blocks: FreshnessMetadata[]): FreshnessMetadata {
    const priority: Record<FreshnessState, number> = {
      UNAVAILABLE: 3,
      EXPIRED: 2,
      STALE: 1,
      FRESH: 0,
    };

    let worst = blocks[0];
    if (!worst) return DataFreshness.unavailable();

    for (const block of blocks.slice(1)) {
      if (priority[block.freshness_state] > priority[worst.freshness_state]) {
        worst = block;
      }
    }

    return worst;
  }
}
