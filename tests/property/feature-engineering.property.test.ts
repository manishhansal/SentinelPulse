/**
 * Property 16: Point-in-time correctness enforcement
 *
 * **Validates: Requirements 20.2, 21.1**
 *
 * Phase 3B-Preflight update (2026-09-16):
 *   - Uses `FeatureSource` interface (informationAsOf) instead of the deprecated
 *     `DataPoint` interface (recordTimestamp).
 *   - The semantic change: `informationAsOf` = when the underlying information
 *     was AVAILABLE, not when it was computed.
 *   - The invariant being tested is identical: any source whose
 *     `informationAsOf > eventTimestamp` must be rejected.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  LookAheadGuard,
  LookAheadBiasError,
  type FeatureSource,
} from '../../src/engines/feature-engineering/LookAheadGuard.js';

describe('Property 16: LookAheadGuard throws on any future data point', () => {
  const guard = new LookAheadGuard();

  it('throws LookAheadBiasError when any informationAsOf > eventTimestamp', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2020-01-01'), max: new Date('2025-01-01') }),
        fc.integer({ min: 1, max: 86400000 }), // 1ms to 1 day offset
        (eventTimestamp, offsetMs) => {
          const futureInformationAsOf = new Date(eventTimestamp.getTime() + offsetMs);
          let threw = false;
          try {
            const source: FeatureSource = {
              featureName: 'test_feature',
              informationAsOf: futureInformationAsOf,
            };
            guard.validate([source], eventTimestamp);
          } catch (err) {
            threw = err instanceof LookAheadBiasError;
          }
          return threw;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('does NOT throw when all informationAsOf <= eventTimestamp', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2020-01-01'), max: new Date('2025-01-01') }),
        fc.integer({ min: 0, max: 86400000 }),
        (eventTimestamp, offsetMs) => {
          const pastOrEqualInformationAsOf = new Date(eventTimestamp.getTime() - offsetMs);
          let threw = false;
          try {
            const source: FeatureSource = {
              featureName: 'test_feature',
              informationAsOf: pastOrEqualInformationAsOf,
            };
            guard.validate([source], eventTimestamp);
          } catch {
            threw = true;
          }
          return !threw;
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Property: the Phase 3B-Preflight fix.
   *
   * When `informationAsOf = article.published_at` (same as event_timestamp),
   * and `computed_at` is NEVER passed to the guard, backfill must always pass.
   *
   * This formalises: a 2024 article processed in 2026 is NOT look-ahead leakage
   * as long as the sentiment was computed from the 2024 article text alone.
   */
  it('backfill invariant: informationAsOf=published_at never causes false positive', () => {
    fc.assert(
      fc.property(
        // Historical event date range (2020–2024)
        fc.date({ min: new Date('2020-01-01'), max: new Date('2024-12-31') }),
        // Backfill processing delay: 1 day to 3 years later (irrelevant to guard)
        fc.integer({ min: 86400000, max: 3 * 365 * 86400000 }),
        (eventTimestamp, _backfillDelayMs) => {
          // informationAsOf = event publication time (correct anchor)
          // computed_at (now + backfillDelayMs) is never passed to the guard
          const informationAsOf = new Date(eventTimestamp.getTime()); // same as event
          let threw = false;
          try {
            guard.validateOne('sentiment.informationAsOf', informationAsOf, eventTimestamp);
          } catch {
            threw = true;
          }
          return !threw; // must NOT throw
        },
      ),
      { numRuns: 200 },
    );
  });
});
