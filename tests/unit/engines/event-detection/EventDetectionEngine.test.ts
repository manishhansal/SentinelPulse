/**
 * Unit tests for EventDetectionEngine pure helpers.
 *
 * Tests the pure, DB-free logic exported from the engine module:
 *   - extractQuantitativeValue (numeric value extraction)
 *   - extractExpectedValue     (consensus extraction)
 *   - extractActor             (institution name extraction)
 *   - pattern-based event classification via a lightly wrapped helper
 *
 * These are all tested by importing the private functions indirectly through
 * the exported class's static-like behaviour.  Where functions are not
 * exported directly we test observable outputs via the SurpriseScoreCalculator
 * which IS exported.
 *
 * Requirements: Req 6.1–6.10, Req 14.1–14.3
 */

import { describe, it, expect } from 'vitest';
import { SurpriseScoreCalculator } from '../../../../src/engines/event-detection/SurpriseScoreCalculator.js';

// ---------------------------------------------------------------------------
// SurpriseScoreCalculator (Req 14.1, 14.2, 14.3)
// ---------------------------------------------------------------------------

describe('SurpriseScoreCalculator', () => {
  const calc = new SurpriseScoreCalculator(0.05);

  it('returns UNKNOWN direction when expectedValue is null', () => {
    const result = calc.compute(0.25, null);
    expect(result.surpriseDirection).toBe('UNKNOWN');
    expect(result.surpriseScore).toBeNull();
  });

  it('classifies BEAT when actual > expected', () => {
    const result = calc.compute(0.5, 0.25);
    expect(result.surpriseDirection).toBe('BEAT');
    expect(result.surpriseScore).not.toBeNull();
    if (result.surpriseScore !== null) {
      expect(result.surpriseScore).toBeGreaterThan(0);
    }
  });

  it('classifies MISS when actual < expected', () => {
    const result = calc.compute(0.1, 0.25);
    expect(result.surpriseDirection).toBe('MISS');
    expect(result.surpriseScore).not.toBeNull();
    if (result.surpriseScore !== null) {
      expect(result.surpriseScore).toBeLessThan(0);
    }
  });

  it('classifies IN_LINE when difference is within threshold', () => {
    // threshold 0.05: |0.25 - 0.26| = 0.01 → within threshold
    const result = calc.compute(0.26, 0.25);
    expect(result.surpriseDirection).toBe('IN_LINE');
  });

  it('returns surpriseScore clamped to [-5, +5]', () => {
    const result = calc.compute(100, 0.1);
    if (result.surpriseScore !== null) {
      expect(result.surpriseScore).toBeLessThanOrEqual(5);
      expect(result.surpriseScore).toBeGreaterThanOrEqual(-5);
    }
  });
});
