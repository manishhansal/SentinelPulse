/**
 * Property 4: Exponential backoff delay formula.
 *
 * For any valid RetryConfig and attempt number, `computeRetryDelay()` must:
 *   - Always return a non-negative value.
 *   - Never exceed MAX_ATTEMPT_DELAY_MS (the 300 000 ms cap).
 *   - Be monotonically non-decreasing as attempt increases.
 *   - Equal `min(baseDelayMs × multiplier^(attempt-1), MAX_ATTEMPT_DELAY_MS)`.
 *
 * **Validates: Requirements 2.3**
 */
import { describe, it } from 'vitest';
import fc from 'fast-check';
import {
  computeRetryDelay,
  MAX_ATTEMPT_DELAY_MS,
  type RetryConfig,
} from '../../src/adapters/base/NewsSourceAdapter.js';

// Feature: sentinel-pulse
describe('Property 4: exponential backoff delay', () => {
  it('delay is always in [0, MAX_ATTEMPT_DELAY_MS]', () => {
    fc.assert(
      fc.property(
        fc.record({
          maxAttempts: fc.integer({ min: 1, max: 10 }),
          baseDelayMs: fc.integer({ min: 100, max: 60_000 }),
          multiplier: fc.float({ min: 1, max: 10, noNaN: true }),
        }),
        fc.integer({ min: 1, max: 10 }),
        (cfg: RetryConfig, attempt: number) => {
          const delay = computeRetryDelay(cfg, attempt);
          return delay >= 0 && delay <= MAX_ATTEMPT_DELAY_MS;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('delay is non-decreasing as attempt increases', () => {
    fc.assert(
      fc.property(
        fc.record({
          maxAttempts: fc.integer({ min: 1, max: 10 }),
          baseDelayMs: fc.integer({ min: 100, max: 60_000 }),
          multiplier: fc.float({ min: 1, max: 10, noNaN: true }),
        }),
        fc.integer({ min: 1, max: 9 }), // attempt n
        (cfg: RetryConfig, attempt: number) => {
          const delayN = computeRetryDelay(cfg, attempt);
          const delayN1 = computeRetryDelay(cfg, attempt + 1);
          // Delay for attempt n+1 must be >= delay for attempt n
          return delayN1 >= delayN;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('formula: delay = min(base × multiplier^(attempt-1), cap)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 5_000 }),           // baseDelayMs
        fc.float({ min: 1, max: 5, noNaN: true }),      // multiplier
        fc.integer({ min: 1, max: 8 }),                  // attempt
        (baseDelayMs, multiplier, attempt) => {
          const cfg: RetryConfig = {
            maxAttempts: 10,
            baseDelayMs,
            multiplier,
          };
          const expected = Math.min(
            baseDelayMs * Math.pow(multiplier, attempt - 1),
            MAX_ATTEMPT_DELAY_MS,
          );
          const actual = computeRetryDelay(cfg, attempt);
          // Allow a small floating-point tolerance
          return Math.abs(actual - expected) < 0.001;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('attempt=1 returns exactly baseDelayMs (multiplier^0 = 1)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 60_000 }),
        (baseDelayMs) => {
          const cfg: RetryConfig = { maxAttempts: 3, baseDelayMs, multiplier: 2 };
          return computeRetryDelay(cfg, 1) === baseDelayMs;
        },
      ),
      { numRuns: 50 },
    );
  });

  it('delay is capped at MAX_ATTEMPT_DELAY_MS for large attempts', () => {
    const cfg: RetryConfig = { maxAttempts: 10, baseDelayMs: 60_000, multiplier: 10 };
    // attempt 5: 60000 * 10^4 = 600_000_000 >> MAX_ATTEMPT_DELAY_MS
    const delay = computeRetryDelay(cfg, 5);
    expect(delay).toBe(MAX_ATTEMPT_DELAY_MS);
  });
});
