/**
 * SurpriseScoreCalculator
 *
 * Computes the quantitative surprise score for a NewsEvent by comparing a
 * reported (actual) value against the consensus expectation.
 *
 * Formula (Req 14.1):
 *   surprise_score = (quantitativeValue - expectedValue) / |expectedValue|
 *
 * Post-processing:
 *   - Capped to the range [-5.0, +5.0]
 *   - Rounded to 4 decimal places
 *
 * Special cases:
 *   - expectedValue === 0  → surprise_score = null, surprise_score_error = "division_by_zero"
 *   - expectedValue is null/undefined → surprise_score = null, direction = UNKNOWN
 *
 * Direction rules (Req 6.4, 6.6):
 *   - |score| > threshold AND score > 0  → BEAT
 *   - |score| > threshold AND score < 0  → MISS
 *   - Otherwise (|score| <= threshold)   → IN_LINE
 *
 * Requirements: Req 6.3, Req 6.4, Req 6.5, Req 6.6, Req 14.1
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SurpriseResult {
  /** Computed surprise score in [-5.0, +5.0], null when undetermined. */
  surpriseScore: number | null;
  /** Directional classification of the surprise. */
  surpriseDirection: 'BEAT' | 'MISS' | 'IN_LINE' | 'UNKNOWN';
  /**
   * Set to "division_by_zero" when expectedValue is zero; absent otherwise.
   * Maps to surprise_score_err in news_events (Req 14.1).
   */
  surpriseScoreError?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum absolute value the surprise score is capped to (Req 14.1). */
const SURPRISE_CAP = 5.0 as const;

/** Decimal places the surprise score is rounded to (Req 14.1). */
const ROUND_PRECISION = 4 as const;

/** Factor used for rounding to ROUND_PRECISION decimal places. */
const ROUND_FACTOR = Math.pow(10, ROUND_PRECISION); // 10_000

// ---------------------------------------------------------------------------
// SurpriseScoreCalculator
// ---------------------------------------------------------------------------

export class SurpriseScoreCalculator {
  /**
   * Configurable beat/miss threshold (default 0.05 = 5%).
   *
   * A score whose absolute value exceeds this threshold is classified as
   * BEAT (positive) or MISS (negative).  Scores within the threshold are
   * classified as IN_LINE.
   */
  private readonly beatMissThreshold: number;

  /**
   * @param threshold - Absolute surprise-score threshold for BEAT/MISS
   *   classification.  Defaults to 0.05 (5%).
   */
  constructor(threshold = 0.05) {
    if (threshold < 0) {
      throw new RangeError(
        `SurpriseScoreCalculator: threshold must be >= 0, got ${threshold}`,
      );
    }
    this.beatMissThreshold = threshold;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Computes the surprise score and direction for an event's reported and
   * expected values.
   *
   * @param quantitativeValue - The actual/reported value (e.g., reported EPS,
   *   rate decision, GDP print).  Null/undefined is treated the same as
   *   expectedValue being absent — no score can be computed.
   * @param expectedValue - The consensus expected value.
   *   - `null` / `undefined` → direction = UNKNOWN, score = null (Req 6.5, 14.2)
   *   - `0`                  → score = null, error = "division_by_zero" (Req 14.1)
   *   - Any other number     → formula applied, capped, rounded
   */
  compute(
    quantitativeValue: number | null | undefined,
    expectedValue: number | null | undefined,
  ): SurpriseResult {
    // Case 1: expectedValue absent → UNKNOWN (Req 6.5, 14.2)
    if (expectedValue === null || expectedValue === undefined) {
      return {
        surpriseScore: null,
        surpriseDirection: 'UNKNOWN',
      };
    }

    // Case 2: expectedValue is zero → division_by_zero (Req 14.1)
    if (expectedValue === 0) {
      return {
        surpriseScore: null,
        surpriseDirection: 'UNKNOWN',
        surpriseScoreError: 'division_by_zero',
      };
    }

    // Case 3: quantitativeValue absent but expectedValue present → UNKNOWN
    // (cannot compute without the actual value)
    if (quantitativeValue === null || quantitativeValue === undefined) {
      return {
        surpriseScore: null,
        surpriseDirection: 'UNKNOWN',
      };
    }

    // Case 4: both values present — compute, cap, round
    const raw = (quantitativeValue - expectedValue) / Math.abs(expectedValue);

    // Clamp to [-5.0, +5.0]
    const capped = Math.max(-SURPRISE_CAP, Math.min(SURPRISE_CAP, raw));

    // Round to 4 decimal places (avoid floating-point drift)
    const surpriseScore = Math.round(capped * ROUND_FACTOR) / ROUND_FACTOR;

    const surpriseDirection = this.classify(surpriseScore);

    return { surpriseScore, surpriseDirection };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Classifies a numeric surprise score into a directional label.
   *
   * - score > threshold  → BEAT  (Req 6.4)
   * - score < -threshold → MISS  (Req 6.4)
   * - otherwise          → IN_LINE (Req 6.6)
   */
  private classify(
    score: number,
  ): 'BEAT' | 'MISS' | 'IN_LINE' {
    const abs = Math.abs(score);
    if (abs > this.beatMissThreshold) {
      return score > 0 ? 'BEAT' : 'MISS';
    }
    return 'IN_LINE';
  }
}
