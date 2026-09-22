/**
 * LookAheadGuard — comprehensive test suite
 *
 * Phase 3B-Preflight redesign: validates the point-in-time model that
 * separates information_as_of from computed_at.
 *
 * Sections:
 *   1. Unit tests — LookAheadBiasError construction
 *   2. Unit tests — validate() (batch)
 *   3. Unit tests — validateOne() (single source)
 *   4. Unit tests — validateLabelCutoff()
 *   5. Named case tests — CASE A through CASE F (from TEMPORAL_DATA_CONTRACT.md)
 *   6. Integration tests — realistic pipeline scenarios
 *   7. Property tests — exhaustive boundary conditions
 *   8. SQL validation query tests (pure logic)
 *
 * Requirements: Req 20.2, Req 21.1, Req 21.2, Req 22.4
 */

import { describe, it, expect } from 'vitest';
import {
  LookAheadGuard,
  LookAheadBiasError,
  type FeatureSource,
} from '../../../../src/engines/feature-engineering/LookAheadGuard.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Creates a Date at an absolute ISO string, preventing clock dependency. */
function ts(isoString: string): Date {
  return new Date(isoString);
}

/** Event anchor: 2024-05-10 14:30 UTC */
const EVENT_TS = ts('2024-05-10T14:30:00.000Z');

/** A safe information_as_of at exactly the event timestamp. */
const AT_EVENT = ts('2024-05-10T14:30:00.000Z');

/** One millisecond before the event — always PASS. */
const BEFORE_EVENT = ts('2024-05-10T14:29:59.999Z');

/** One millisecond after the event — always FAIL. */
const AFTER_EVENT = ts('2024-05-10T14:30:00.001Z');

/** Far past — an article published years before the event. */
const HISTORICAL_ARTICLE = ts('2024-01-15T09:00:00.000Z');

/** Far future — computed_at for a backfill run in 2026. */
const COMPUTED_AT_2026 = ts('2026-09-16T10:00:00.000Z');

// ---------------------------------------------------------------------------
// Section 1 — LookAheadBiasError construction
// ---------------------------------------------------------------------------

describe('LookAheadBiasError', () => {
  it('has name LookAheadBiasError', () => {
    const err = new LookAheadBiasError('test_feature', AFTER_EVENT, EVENT_TS);
    expect(err.name).toBe('LookAheadBiasError');
  });

  it('is an instance of Error', () => {
    const err = new LookAheadBiasError('test_feature', AFTER_EVENT, EVENT_TS);
    expect(err).toBeInstanceOf(Error);
  });

  it('exposes offendingFeature', () => {
    const err = new LookAheadBiasError('my_feature', AFTER_EVENT, EVENT_TS);
    expect(err.offendingFeature).toBe('my_feature');
  });

  it('exposes informationAsOf', () => {
    const err = new LookAheadBiasError('f', AFTER_EVENT, EVENT_TS);
    expect(err.informationAsOf).toEqual(AFTER_EVENT);
  });

  it('exposes eventTimestamp', () => {
    const err = new LookAheadBiasError('f', AFTER_EVENT, EVENT_TS);
    expect(err.eventTimestamp).toEqual(EVENT_TS);
  });

  it('includes informationAsOf ISO string in message', () => {
    const err = new LookAheadBiasError('sentiment', AFTER_EVENT, EVENT_TS);
    expect(err.message).toContain('2024-05-10T14:30:00.001Z');
  });

  it('includes eventTimestamp ISO string in message', () => {
    const err = new LookAheadBiasError('sentiment', AFTER_EVENT, EVENT_TS);
    expect(err.message).toContain('2024-05-10T14:30:00.000Z');
  });

  it('includes offendingFeature name in message', () => {
    const err = new LookAheadBiasError('ohlcv_baseline', AFTER_EVENT, EVENT_TS);
    expect(err.message).toContain('ohlcv_baseline');
  });

  it('message clarifies that computed_at is irrelevant', () => {
    const err = new LookAheadBiasError('f', AFTER_EVENT, EVENT_TS);
    expect(err.message).toContain('computed_at is irrelevant');
  });
});

// ---------------------------------------------------------------------------
// Section 2 — validate() (batch)
// ---------------------------------------------------------------------------

describe('LookAheadGuard.validate() — batch validation', () => {
  const guard = new LookAheadGuard();

  it('passes for empty sources array', () => {
    expect(() => guard.validate([], EVENT_TS)).not.toThrow();
  });

  it('passes when all sources are exactly at event_timestamp', () => {
    const sources: FeatureSource[] = [
      { featureName: 'sentiment', informationAsOf: AT_EVENT },
      { featureName: 'importance', informationAsOf: AT_EVENT },
    ];
    expect(() => guard.validate(sources, EVENT_TS)).not.toThrow();
  });

  it('passes when all sources are before event_timestamp', () => {
    const sources: FeatureSource[] = [
      { featureName: 'sentiment', informationAsOf: BEFORE_EVENT },
      { featureName: 'velocity', informationAsOf: HISTORICAL_ARTICLE },
    ];
    expect(() => guard.validate(sources, EVENT_TS)).not.toThrow();
  });

  it('throws on first violation in a batch', () => {
    const sources: FeatureSource[] = [
      { featureName: 'sentiment', informationAsOf: BEFORE_EVENT },
      { featureName: 'ohlcv_future', informationAsOf: AFTER_EVENT },
      { featureName: 'importance', informationAsOf: BEFORE_EVENT },
    ];
    expect(() => guard.validate(sources, EVENT_TS)).toThrow(LookAheadBiasError);
  });

  it('throws with the name of the first violating feature', () => {
    const sources: FeatureSource[] = [
      { featureName: 'sentiment', informationAsOf: BEFORE_EVENT },
      { featureName: 'bad_feature', informationAsOf: AFTER_EVENT },
    ];
    try {
      guard.validate(sources, EVENT_TS);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as LookAheadBiasError).offendingFeature).toBe('bad_feature');
    }
  });

  it('does not inspect remaining sources after first violation', () => {
    // Only the first bad source should appear in the error
    const sources: FeatureSource[] = [
      { featureName: 'first_bad', informationAsOf: AFTER_EVENT },
      { featureName: 'second_bad', informationAsOf: AFTER_EVENT },
    ];
    try {
      guard.validate(sources, EVENT_TS);
    } catch (err) {
      expect((err as LookAheadBiasError).offendingFeature).toBe('first_bad');
    }
  });

  it('LookAheadGuard.source() factory produces correct FeatureSource', () => {
    const src = LookAheadGuard.source('my_feature', BEFORE_EVENT);
    expect(src).toEqual({ featureName: 'my_feature', informationAsOf: BEFORE_EVENT });
  });
});

// ---------------------------------------------------------------------------
// Section 3 — validateOne() (single source)
// ---------------------------------------------------------------------------

describe('LookAheadGuard.validateOne()', () => {
  const guard = new LookAheadGuard();

  it('passes when informationAsOf equals event_timestamp exactly', () => {
    expect(() =>
      guard.validateOne('sentiment', AT_EVENT, EVENT_TS),
    ).not.toThrow();
  });

  it('passes when informationAsOf is 1ms before event_timestamp', () => {
    expect(() =>
      guard.validateOne('sentiment', BEFORE_EVENT, EVENT_TS),
    ).not.toThrow();
  });

  it('throws when informationAsOf is 1ms after event_timestamp', () => {
    expect(() =>
      guard.validateOne('sentiment', AFTER_EVENT, EVENT_TS),
    ).toThrow(LookAheadBiasError);
  });

  it('throws when informationAsOf is far in the future (future price bar)', () => {
    const futureBar = ts('2024-05-10T15:30:00.000Z'); // 1h after event
    expect(() =>
      guard.validateOne('ohlcv_1h_future', futureBar, EVENT_TS),
    ).toThrow(LookAheadBiasError);
  });

  it('CRITICAL: does NOT throw when computed_at (2026) vs historical article (2024)', () => {
    // Phase 3B-Preflight core requirement:
    // If the caller correctly passes article.published_at as informationAsOf,
    // a historical backfill must PASS even when computed_at is in 2026.
    //
    // This test validates the correct usage pattern.
    const articlePublishedAt = ts('2024-05-10T14:30:00.000Z');
    // computed_at = 2026 is irrelevant — we never pass it to the guard
    expect(() =>
      guard.validateOne('sentiment.informationAsOf', articlePublishedAt, EVENT_TS),
    ).not.toThrow();
  });

  it('passes for a very old article (2019) processed in 2026 against 2019 event', () => {
    const oldArticle = ts('2019-03-15T08:00:00.000Z');
    const oldEvent = ts('2019-03-15T08:00:00.000Z');
    expect(() =>
      guard.validateOne('sentiment.informationAsOf', oldArticle, oldEvent),
    ).not.toThrow();
  });

  it('returns undefined (no return value)', () => {
    const result = guard.validateOne('f', BEFORE_EVENT, EVENT_TS);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Section 4 — validateLabelCutoff()
// ---------------------------------------------------------------------------

describe('LookAheadGuard.validateLabelCutoff()', () => {
  const guard = new LookAheadGuard();

  it('passes when labelCutoff is strictly after event_timestamp', () => {
    const cutoff5m = ts('2024-05-10T14:35:00.000Z');
    expect(() =>
      guard.validateLabelCutoff('5m', cutoff5m, EVENT_TS),
    ).not.toThrow();
  });

  it('throws when labelCutoff equals event_timestamp', () => {
    expect(() =>
      guard.validateLabelCutoff('5m', AT_EVENT, EVENT_TS),
    ).toThrow(LookAheadBiasError);
  });

  it('throws when labelCutoff is 1ms before event_timestamp', () => {
    expect(() =>
      guard.validateLabelCutoff('5m', BEFORE_EVENT, EVENT_TS),
    ).toThrow(LookAheadBiasError);
  });

  it('error feature name includes horizon label', () => {
    try {
      guard.validateLabelCutoff('1d', BEFORE_EVENT, EVENT_TS);
    } catch (err) {
      expect((err as LookAheadBiasError).offendingFeature).toBe('label_cutoff_1d');
    }
  });

  it('passes for all standard horizons at correct offsets', () => {
    const t = EVENT_TS.getTime();
    const cutoffs: Array<[string, number]> = [
      ['5m', 5 * 60_000],
      ['15m', 15 * 60_000],
      ['30m', 30 * 60_000],
      ['1h', 60 * 60_000],
      ['1d', 24 * 60 * 60_000],
    ];
    for (const [label, offsetMs] of cutoffs) {
      const cutoff = new Date(t + offsetMs);
      expect(() =>
        guard.validateLabelCutoff(label, cutoff, EVENT_TS),
      ).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Section 5 — Named cases from TEMPORAL_DATA_CONTRACT.md
// ---------------------------------------------------------------------------

describe('Named cases — TEMPORAL_DATA_CONTRACT.md §3.3', () => {
  const guard = new LookAheadGuard();

  /**
   * CASE A: historical article processed years later → PASS
   * Article published 2024-05-10; sentiment computed 2026-09-16 from article text only.
   * informationAsOf = article.published_at = 2024-05-10 (NOT computed_at = 2026)
   */
  it('CASE A: historical article processed years later → PASS', () => {
    const articlePublishedAt = ts('2024-05-10T14:30:00.000Z');
    const eventTimestamp     = ts('2024-05-10T14:30:00.000Z');
    // computed_at = 2026 — irrelevant, not passed to guard
    expect(() =>
      guard.validateOne('sentiment.informationAsOf', articlePublishedAt, eventTimestamp),
    ).not.toThrow();
  });

  /**
   * CASE B: historical OHLCV query accidentally returns future candle → FAIL
   * Bar timestamp is 5 minutes after the event.
   */
  it('CASE B: OHLCV query returns future candle → FAIL', () => {
    const barTimestamp   = ts('2024-05-10T14:35:00.000Z'); // +5min future bar
    const eventTimestamp = ts('2024-05-10T14:30:00.000Z');
    expect(() =>
      guard.validateOne('ohlcv_bar.timestamp', barTimestamp, eventTimestamp),
    ).toThrow(LookAheadBiasError);
  });

  /**
   * CASE C: feature uses future market price → FAIL
   * The market close at 17:00 is used as an input feature for a 14:30 event.
   */
  it('CASE C: feature uses future market price → FAIL', () => {
    const marketClose17h = ts('2024-05-10T17:00:00.000Z');
    const eventTimestamp = ts('2024-05-10T14:30:00.000Z');
    expect(() =>
      guard.validateOne('market_close_eod', marketClose17h, eventTimestamp),
    ).toThrow(LookAheadBiasError);
  });

  /**
   * CASE D: historical article text processed later → PASS
   * Same as CASE A — using article.published_at as informationAsOf.
   */
  it('CASE D: historical article text processed later → PASS', () => {
    const articlePublishedAt = ts('2019-11-20T06:00:00.000Z');
    const eventTimestamp     = ts('2019-11-20T06:00:00.000Z');
    expect(() =>
      guard.validateOne('sentiment.informationAsOf', articlePublishedAt, eventTimestamp),
    ).not.toThrow();
  });

  /**
   * CASE E: analyst estimate revised after prediction_timestamp → FAIL
   * The estimate's revisedAt (2024-05-15) is after event_timestamp (2024-05-10).
   */
  it('CASE E: analyst estimate revised after prediction_timestamp → FAIL', () => {
    const estimateRevisedAt = ts('2024-05-15T09:00:00.000Z');
    const eventTimestamp    = ts('2024-05-10T14:30:00.000Z');
    expect(() =>
      guard.validateOne('analyst_estimate.revisedAt', estimateRevisedAt, eventTimestamp),
    ).toThrow(LookAheadBiasError);
  });

  /**
   * CASE F: future label data used as feature → FAIL
   * The close price at T+5m is used as a feature (not a label).
   */
  it('CASE F: future label data used as feature → FAIL', () => {
    const labelCutoff5m  = ts('2024-05-10T14:35:00.000Z'); // event + 5 min
    const eventTimestamp = ts('2024-05-10T14:30:00.000Z');
    expect(() =>
      guard.validateOne('close_at_T+5m_as_feature', labelCutoff5m, eventTimestamp),
    ).toThrow(LookAheadBiasError);
  });

  /**
   * Additional case: macro sentiment window uses only articles published before event.
   * This is the fetchMacroScores() pattern — all sentiment records are filtered
   * by article.publishedAt <= eventTimestamp. → PASS
   */
  it('CASE G: macro sentiment from pre-event articles → PASS', () => {
    // The macro window query only includes publishedAt <= eventTimestamp,
    // so the informationAsOf for macro scores is bounded by eventTimestamp.
    const macroWindowEnd = ts('2024-05-10T14:30:00.000Z'); // bounded by eventTimestamp
    const eventTimestamp = ts('2024-05-10T14:30:00.000Z');
    expect(() =>
      guard.validateOne('macro_sentiment.window_end', macroWindowEnd, eventTimestamp),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Section 6 — Integration scenarios
// ---------------------------------------------------------------------------

describe('Integration scenarios — realistic pipeline usage', () => {
  const guard = new LookAheadGuard();

  /**
   * Realistic backfill scenario:
   *   - Event from 2024-05-10 RBI rate announcement
   *   - Sentiment computed in 2026 (backfill run)
   *   - OHLCV bar correctly fetched at event timestamp
   *   - All feature sources pass because informationAsOf is correctly set
   */
  it('backfill scenario: all sources use informationAsOf, not computed_at', () => {
    const eventTimestamp = ts('2024-05-10T10:00:00.000Z'); // RBI announcement

    const sources: FeatureSource[] = [
      // Sentiment from article published same day as event
      LookAheadGuard.source('sentiment', ts('2024-05-10T09:45:00.000Z')),
      // Importance from same article
      LookAheadGuard.source('importance', ts('2024-05-10T09:45:00.000Z')),
      // Velocity: last article in window was 30 min before event
      LookAheadGuard.source('velocity', ts('2024-05-10T09:30:00.000Z')),
      // Macro scores: most recent article in 24h window before event
      LookAheadGuard.source('macro_sentiment', ts('2024-05-09T16:00:00.000Z')),
      // OHLCV bar at event timestamp (data-service asOf = event_timestamp)
      LookAheadGuard.source('ohlcv_baseline', ts('2024-05-10T09:55:00.000Z')),
    ];

    // All should PASS — none of these are future relative to event_timestamp
    expect(() => guard.validate(sources, eventTimestamp)).not.toThrow();
  });

  /**
   * Bad scenario: one feature accidentally got a future OHLCV bar.
   * data-service asOf was not set correctly.
   */
  it('bad scenario: future OHLCV bar causes rejection', () => {
    const eventTimestamp = ts('2024-05-10T10:00:00.000Z');

    const sources: FeatureSource[] = [
      LookAheadGuard.source('sentiment', ts('2024-05-10T09:45:00.000Z')),
      // BUG: asOf was set to now() instead of event_timestamp
      LookAheadGuard.source('ohlcv_bar', ts('2024-05-10T14:30:00.000Z')), // 4.5h future
    ];

    expect(() => guard.validate(sources, eventTimestamp)).toThrow(LookAheadBiasError);
  });

  /**
   * Regime feature scenario:
   * Regime classification was computed using NIFTY data at event_timestamp.
   * informationAsOf = timestamp of the NIFTY data used (before event).
   */
  it('regime feature: NIFTY data at event_timestamp is safe', () => {
    const eventTimestamp = ts('2024-05-10T10:00:00.000Z');
    // NIFTY data from the last completed bar before event
    const niftyBarTimestamp = ts('2024-05-10T09:59:00.000Z');
    expect(() =>
      guard.validateOne('regime.nifty_bar', niftyBarTimestamp, eventTimestamp),
    ).not.toThrow();
  });

  /**
   * Label validation: label_cutoff_1d is always after event_timestamp.
   * This should always pass by construction.
   */
  it('label cutoff at +1 day is always valid', () => {
    const eventTimestamp = ts('2024-05-10T10:00:00.000Z');
    const labelCutoff1d = new Date(eventTimestamp.getTime() + 24 * 60 * 60_000);
    expect(() =>
      guard.validateLabelCutoff('1d', labelCutoff1d, eventTimestamp),
    ).not.toThrow();
  });

  /**
   * Cross-market relationship feature:
   * The relationship data (correlation, confidence) was computed from
   * historical data available before the event.
   */
  it('cross-market relationship: historical correlation data passes', () => {
    const eventTimestamp = ts('2024-05-10T10:00:00.000Z');
    // Relationship was last updated a month ago — well before event
    const relationshipLastUpdated = ts('2024-04-01T00:00:00.000Z');
    expect(() =>
      guard.validateOne('cross_market.last_updated', relationshipLastUpdated, eventTimestamp),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Section 7 — Property tests (boundary conditions)
// ---------------------------------------------------------------------------

describe('Property tests — boundary conditions', () => {
  const guard = new LookAheadGuard();

  it('property: validate() with N sources all at event_timestamp passes for any N', () => {
    for (const n of [0, 1, 5, 10, 100]) {
      const sources: FeatureSource[] = Array.from({ length: n }, (_, i) => ({
        featureName: `feature_${i}`,
        informationAsOf: EVENT_TS,
      }));
      expect(() => guard.validate(sources, EVENT_TS)).not.toThrow();
    }
  });

  it('property: validate() fails for any single future source regardless of batch size', () => {
    for (const n of [1, 5, 10]) {
      const sources: FeatureSource[] = [
        // n-1 safe sources
        ...Array.from({ length: n - 1 }, (_, i) => ({
          featureName: `safe_${i}`,
          informationAsOf: BEFORE_EVENT,
        })),
        // one future source at the end
        { featureName: 'future_source', informationAsOf: AFTER_EVENT },
      ];
      expect(() => guard.validate(sources, EVENT_TS)).toThrow(LookAheadBiasError);
    }
  });

  it('property: millisecond precision — 1ms after always fails', () => {
    const base = EVENT_TS.getTime();
    for (const deltaMsAfter of [1, 2, 1000, 60_000, 3_600_000]) {
      const futureTs = new Date(base + deltaMsAfter);
      expect(() =>
        guard.validateOne('f', futureTs, EVENT_TS),
      ).toThrow(LookAheadBiasError);
    }
  });

  it('property: millisecond precision — exactly at or before always passes', () => {
    const base = EVENT_TS.getTime();
    for (const deltaMsBefore of [0, 1, 1000, 60_000, 3_600_000, 365 * 24 * 60 * 60_000]) {
      const safeTs = new Date(base - deltaMsBefore);
      expect(() =>
        guard.validateOne('f', safeTs, EVENT_TS),
      ).not.toThrow();
    }
  });

  it('property: computed_at in 2026 does NOT appear in guard inputs for text features', () => {
    // Verify that the guard never sees computed_at directly when used correctly.
    // The correct pattern is: pass article.published_at, not row.computed_at.
    const articlePublishedAt_2024 = ts('2024-05-10T14:30:00.000Z');
    const eventTimestamp_2024     = ts('2024-05-10T14:30:00.000Z');
    // computed_at_2026 = ts('2026-09-16T10:00:00.000Z') — never passed to guard

    // The guard only sees article.published_at → passes
    expect(() =>
      guard.validateOne('sentiment.informationAsOf', articlePublishedAt_2024, eventTimestamp_2024),
    ).not.toThrow();
  });

  it('property: LookAheadBiasError is always an instance of Error', () => {
    try {
      guard.validateOne('f', AFTER_EVENT, EVENT_TS);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(LookAheadBiasError);
    }
  });

  it('property: validateLabelCutoff passes for every positive offset horizon', () => {
    const positiveOffsets = [1, 60_000, 300_000, 900_000, 1_800_000, 3_600_000, 86_400_000];
    for (const offsetMs of positiveOffsets) {
      const cutoff = new Date(EVENT_TS.getTime() + offsetMs);
      expect(() =>
        guard.validateLabelCutoff('test', cutoff, EVENT_TS),
      ).not.toThrow();
    }
  });

  it('property: validateLabelCutoff fails for every non-positive offset', () => {
    const nonPositiveOffsets = [0, -1, -60_000, -3_600_000];
    for (const offsetMs of nonPositiveOffsets) {
      const cutoff = new Date(EVENT_TS.getTime() + offsetMs);
      expect(() =>
        guard.validateLabelCutoff('test', cutoff, EVENT_TS),
      ).toThrow(LookAheadBiasError);
    }
  });

  it('property: batch validation is order-dependent (first bad source is reported)', () => {
    const sources: FeatureSource[] = [
      { featureName: 'safe', informationAsOf: BEFORE_EVENT },
      { featureName: 'first_bad', informationAsOf: AFTER_EVENT },
      { featureName: 'second_bad', informationAsOf: AFTER_EVENT },
    ];
    try {
      guard.validate(sources, EVENT_TS);
    } catch (err) {
      expect((err as LookAheadBiasError).offendingFeature).toBe('first_bad');
    }
  });
});

// ---------------------------------------------------------------------------
// Section 8 — SQL validation query logic
// ---------------------------------------------------------------------------

/**
 * These tests validate the pure logic of the SQL look-ahead checks that will
 * be executed against the database.  The SQL queries are described in
 * POINT_IN_TIME_DATASET_CERTIFICATION.md; this section validates their
 * predicate logic in TypeScript.
 */
describe('SQL validation logic — point-in-time predicates', () => {
  /**
   * SQL equivalent:
   *   SELECT count(*) FROM news_features nf
   *   JOIN news_events ne ON nf.event_id = ne.id
   *   JOIN news_articles na ON ne.article_id = na.id
   *   WHERE na.published_at > ne.event_timestamp
   *
   * Should return 0.
   */
  it('article.published_at <= event.event_timestamp always holds', () => {
    const cases = [
      { publishedAt: ts('2024-05-10T09:45:00Z'), eventTs: ts('2024-05-10T14:30:00Z') },
      { publishedAt: ts('2024-05-10T14:30:00Z'), eventTs: ts('2024-05-10T14:30:00Z') },
    ];
    for (const c of cases) {
      expect(c.publishedAt <= c.eventTs).toBe(true);
    }
  });

  /**
   * SQL equivalent:
   *   SELECT count(*) FROM news_training_samples
   *   WHERE label_cutoff_5m <= event_timestamp
   *
   * Should return 0.
   */
  it('label_cutoff_5m > event_timestamp is always required', () => {
    const eventTimestamp = ts('2024-05-10T14:30:00Z');
    const cutoff5m = ts('2024-05-10T14:35:00Z');
    expect(cutoff5m > eventTimestamp).toBe(true);

    // Negative: cutoff at event time is a violation
    const badCutoff = ts('2024-05-10T14:30:00Z');
    expect(badCutoff > eventTimestamp).toBe(false);
  });

  /**
   * SQL equivalent:
   *   SELECT count(*) FROM news_market_reactions nmr
   *   JOIN news_events ne ON nmr.event_id = ne.id
   *   WHERE nmr.computed_at <= ne.event_timestamp
   *   AND nmr.return_5m IS NOT NULL
   *
   * Should return 0 (reactions are always computed after the event).
   * Note: computed_at of a reaction record is always > event_timestamp.
   * This is correct — reactions are measured from post-event OHLCV bars.
   */
  it('reaction.computed_at > event_timestamp is expected and correct', () => {
    const eventTimestamp = ts('2024-05-10T14:30:00Z');
    const reactionComputedAt = ts('2024-05-10T15:30:00Z'); // computed 1h after
    // computed_at > event_timestamp is OK for reactions — they are measured
    // from future OHLCV bars by design.  This is NOT a look-ahead violation.
    expect(reactionComputedAt > eventTimestamp).toBe(true);
  });

  /**
   * The critical distinction:
   * For FEATURES: information_as_of must be <= event_timestamp.
   * For LABELS/REACTIONS: the cutoff/computed_at is > event_timestamp by design.
   */
  it('feature vs label temporal direction is opposite', () => {
    const eventTimestamp = ts('2024-05-10T14:30:00Z');

    // Feature: informationAsOf must be <= event
    const featureInfoAsOf = ts('2024-05-10T09:45:00Z');
    expect(featureInfoAsOf <= eventTimestamp).toBe(true); // PASS

    // Label: cutoff must be > event
    const labelCutoff5m = ts('2024-05-10T14:35:00Z');
    expect(labelCutoff5m > eventTimestamp).toBe(true); // PASS
  });
});
