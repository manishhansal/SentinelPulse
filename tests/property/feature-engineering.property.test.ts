/**
 * Property 16: Point-in-time correctness enforcement
 *
 * **Validates: Requirements 20.2, 21.1**
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { LookAheadGuard, LookAheadBiasError } from '../../src/engines/feature-engineering/LookAheadGuard.js';

// Feature: sentinel-pulse, Property 16: point-in-time correctness enforcement
describe('Property 16: LookAheadGuard throws on any future data point', () => {
  const guard = new LookAheadGuard();

  it('throws LookAheadBiasError when any recordTimestamp > eventTimestamp', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2020-01-01'), max: new Date('2025-01-01') }),
        fc.integer({ min: 1, max: 86400000 }), // 1ms to 1 day offset
        (eventTimestamp, offsetMs) => {
          const futureTimestamp = new Date(eventTimestamp.getTime() + offsetMs);
          let threw = false;
          try {
            guard.validate(
              [{ featureName: 'test_feature', recordTimestamp: futureTimestamp }],
              eventTimestamp,
            );
          } catch (err) {
            threw = err instanceof LookAheadBiasError;
          }
          return threw;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('does NOT throw when all recordTimestamps <= eventTimestamp', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2020-01-01'), max: new Date('2025-01-01') }),
        fc.integer({ min: 0, max: 86400000 }),
        (eventTimestamp, offsetMs) => {
          const pastOrEqualTimestamp = new Date(eventTimestamp.getTime() - offsetMs);
          let threw = false;
          try {
            guard.validate(
              [{ featureName: 'test_feature', recordTimestamp: pastOrEqualTimestamp }],
              eventTimestamp,
            );
          } catch {
            threw = true;
          }
          return !threw;
        }
      ),
      { numRuns: 100 }
    );
  });
});
