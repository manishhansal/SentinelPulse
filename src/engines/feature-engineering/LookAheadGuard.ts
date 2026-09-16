/**
 * LookAheadGuard — enforces point-in-time correctness in feature engineering.
 *
 * # PHASE 3B-PREFLIGHT REDESIGN (2026-09-16)
 *
 * ## The core rule
 *
 *   feature_as_of  <=  prediction_timestamp
 *
 * where `feature_as_of` is the LATEST INFORMATION TIMESTAMP across all data
 * sources used to build the feature, NOT the wall-clock time at which the
 * engine ran (computed_at).
 *
 * ## Why computed_at is wrong for historical backfill
 *
 * When SentinelPulse backfills a 2024-05-10 article in 2026:
 *   - article.published_at  = 2024-05-10   ← information timestamp (correct anchor)
 *   - sentiment.computed_at = 2026-09-16   ← wall-clock when engine ran (irrelevant)
 *
 * The sentiment was derived ONLY from the 2024-05-10 article text.
 * No future information was consumed.  The correct information_as_of is
 * 2024-05-10, which satisfies:  2024-05-10 <= 2024-05-10 (event_timestamp).
 *
 * Using computed_at (2026-09-16) > event_timestamp (2024-05-10) would falsely
 * reject this as look-ahead leakage.
 *
 * ## Information source → information_as_of mapping
 *
 * | Source                        | information_as_of              |
 * |-------------------------------|-------------------------------|
 * | Article text                  | article.published_at           |
 * | OHLCV bar                     | bar.timestamp (bar open time)  |
 * | Velocity / breadth feature    | latest underlying data point   |
 * | Analyst consensus estimate    | estimate.validFrom             |
 * | Regime classification         | OHLCV data used for regime     |
 *
 * ## Validation cases
 *
 * CASE A: historical article processed years later
 *   information_as_of = article.published_at (2024-05-10)
 *   event_timestamp   = 2024-05-10
 *   Result: PASS  (information_as_of <= event_timestamp)
 *
 * CASE B: OHLCV query returns a future candle
 *   information_as_of = bar.timestamp (2024-05-10 15:00)
 *   event_timestamp   = 2024-05-10 14:30
 *   Result: FAIL  (bar is from after the event)
 *
 * CASE C: feature uses future market price directly
 *   information_as_of = 2024-05-10 17:00
 *   event_timestamp   = 2024-05-10 14:30
 *   Result: FAIL
 *
 * CASE D: historical article text processed later (same as CASE A)
 *   information_as_of = article.published_at (2024-05-10)
 *   event_timestamp   = 2024-05-10
 *   Result: PASS
 *
 * CASE E: analyst estimate revised after prediction_timestamp
 *   information_as_of = estimate.revisedAt (2024-05-15)
 *   event_timestamp   = 2024-05-10
 *   Result: FAIL
 *
 * CASE F: future label data used as feature
 *   information_as_of = label_cutoff_5m (event_timestamp + 5min)
 *   event_timestamp   = 2024-05-10 14:30
 *   Result: FAIL
 *
 * Requirements: Req 20.2, Req 21.1, Req 21.2
 */

// ---------------------------------------------------------------------------
// LookAheadBiasError
// ---------------------------------------------------------------------------

/**
 * Thrown when a data source provides information that was not yet available
 * at the event_timestamp.  The feature vector is NOT persisted when this
 * error is thrown.
 */
export class LookAheadBiasError extends Error {
  constructor(
    /** Human-readable label identifying which feature/source violated the constraint. */
    public readonly offendingFeature: string,
    /**
     * The INFORMATION timestamp of the violating source (i.e. when the
     * underlying information was first available, NOT computed_at).
     */
    public readonly informationAsOf: Date,
    /** The event's point-in-time anchor. */
    public readonly eventTimestamp: Date,
  ) {
    super(
      `Look-ahead bias detected: feature "${offendingFeature}" has ` +
        `information_as_of=${informationAsOf.toISOString()} which is AFTER ` +
        `event_timestamp=${eventTimestamp.toISOString()}. ` +
        `(computed_at is irrelevant — only information_as_of is validated)`,
    );
    this.name = 'LookAheadBiasError';
  }
}

// ---------------------------------------------------------------------------
// FeatureSource — the input type for batch validation
// ---------------------------------------------------------------------------

/**
 * A single data source contributing to a feature vector.
 *
 * IMPORTANT: `informationAsOf` must be the timestamp of the INFORMATION
 * consumed — e.g. article.published_at for text-derived features, or
 * bar.timestamp for market-data features.
 *
 * It must NOT be the computed_at wall-clock timestamp of the engine run.
 */
export interface FeatureSource {
  /** Human-readable name for error reporting (e.g. "sentiment", "ohlcv_baseline") */
  featureName: string;
  /**
   * The timestamp representing when the underlying information was first
   * publicly available.  This is the value validated against eventTimestamp.
   *
   * Examples:
   *   - Article text:  article.published_at
   *   - OHLCV bar:     bar.timestamp (the bar's open time)
   *   - Velocity:      latestDataPointTimestamp (article.published_at of newest article)
   *   - Breadth:       latestDataPointTimestamp
   */
  informationAsOf: Date;
}

// ---------------------------------------------------------------------------
// LookAheadGuard
// ---------------------------------------------------------------------------

export class LookAheadGuard {
  // --------------------------------------------------------------------------
  // Batch validation
  // --------------------------------------------------------------------------

  /**
   * Validates that ALL provided feature sources have
   * `informationAsOf <= eventTimestamp`.
   *
   * Throws `LookAheadBiasError` on the FIRST violation found.
   *
   * @param sources       Array of feature sources, each carrying its
   *                      information_as_of timestamp.
   * @param eventTimestamp The point-in-time anchor for the event.
   *
   * @throws {LookAheadBiasError} on first violation.
   *
   * Requirements: Req 20.2, Req 21.1
   */
  validate(sources: FeatureSource[], eventTimestamp: Date): void {
    for (const src of sources) {
      if (src.informationAsOf > eventTimestamp) {
        throw new LookAheadBiasError(
          src.featureName,
          src.informationAsOf,
          eventTimestamp,
        );
      }
    }
  }

  // --------------------------------------------------------------------------
  // Single-source validation
  // --------------------------------------------------------------------------

  /**
   * Validates a single feature source.  Convenience overload for inline use.
   *
   * @param featureName     Human-readable label (for error message).
   * @param informationAsOf The information timestamp of this source.
   * @param eventTimestamp  The point-in-time anchor.
   *
   * @throws {LookAheadBiasError} when `informationAsOf > eventTimestamp`.
   *
   * Requirements: Req 20.2, Req 21.1
   */
  validateOne(
    featureName: string,
    informationAsOf: Date,
    eventTimestamp: Date,
  ): void {
    if (informationAsOf > eventTimestamp) {
      throw new LookAheadBiasError(featureName, informationAsOf, eventTimestamp);
    }
  }

  // --------------------------------------------------------------------------
  // Label timestamp validation (separate concern from feature validation)
  // --------------------------------------------------------------------------

  /**
   * Validates that a label cutoff timestamp is strictly AFTER the event
   * timestamp.  A label cutoff at or before the event would mean the label
   * reflects information available at or before the prediction time —
   * that is also look-ahead leakage.
   *
   * @param horizonLabel    Human-readable horizon label (e.g. "5m", "1d").
   * @param labelCutoff     The timestamp at which the outcome was observed.
   * @param eventTimestamp  The point-in-time anchor.
   *
   * @throws {LookAheadBiasError} when `labelCutoff <= eventTimestamp`.
   *
   * Requirements: Req 22.4
   */
  validateLabelCutoff(
    horizonLabel: string,
    labelCutoff: Date,
    eventTimestamp: Date,
  ): void {
    if (labelCutoff <= eventTimestamp) {
      throw new LookAheadBiasError(
        `label_cutoff_${horizonLabel}`,
        labelCutoff,
        eventTimestamp,
      );
    }
  }

  // --------------------------------------------------------------------------
  // Static factory helper
  // --------------------------------------------------------------------------

  /**
   * Creates a `FeatureSource` object for use with `validate()`.
   *
   * @param featureName     Human-readable label.
   * @param informationAsOf The information timestamp (NOT computed_at).
   */
  static source(featureName: string, informationAsOf: Date): FeatureSource {
    return { featureName, informationAsOf };
  }

  // --------------------------------------------------------------------------
  // Legacy compatibility shim (DEPRECATED)
  // --------------------------------------------------------------------------

  /**
   * @deprecated Use `validateOne(featureName, informationAsOf, eventTimestamp)`.
   *
   * This shim exists only to ease migration.  The parameter previously called
   * `recordTimestamp` was incorrectly set to `computed_at` by callers.  Any
   * new caller MUST pass `informationAsOf` (e.g. article.published_at) — NOT
   * `computed_at`.
   *
   * Will be removed in Phase 3C.
   */
  validateCompat(
    featureName: string,
    /** Must be information_as_of, NOT computed_at. */
    informationAsOf: Date,
    eventTimestamp: Date,
  ): void {
    this.validateOne(featureName, informationAsOf, eventTimestamp);
  }

  /**
   * @deprecated Use `validate(sources, eventTimestamp)` with `FeatureSource[]`.
   *
   * The old `DataPoint` interface used `recordTimestamp` which was incorrectly
   * mapped to `computed_at`.  Retained for test compatibility only.
   * Will be removed in Phase 3C.
   */
  validateDataPoints(
    dataPoints: Array<{ featureName: string; recordTimestamp: Date }>,
    eventTimestamp: Date,
  ): void {
    for (const dp of dataPoints) {
      this.validateOne(dp.featureName, dp.recordTimestamp, eventTimestamp);
    }
  }
}

// ---------------------------------------------------------------------------
// Backward-compatible re-export (Phase 3A code used DataPoint interface)
// ---------------------------------------------------------------------------

/**
 * @deprecated Use `FeatureSource` instead.
 * Retained for backward compatibility with Phase 3A test files.
 */
export interface DataPoint {
  featureName: string;
  /** @deprecated Pass informationAsOf (article.published_at), not computed_at. */
  recordTimestamp: Date;
}
