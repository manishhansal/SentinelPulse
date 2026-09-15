/**
 * Unit tests for DeduplicationEngine pure helpers.
 *
 * Focuses on the consensus_score formula (Req 4.8) and other
 * database-independent behaviour that can be exercised directly.
 */

import { describe, it, expect } from 'vitest';
import { DeduplicationEngine } from '../../../../src/engines/deduplication/DeduplicationEngine.js';
import type { Queue } from 'bullmq';

// Minimal Queue stub — the pure methods don't touch the queue
const stubQueue = {} as Queue;

describe('DeduplicationEngine.computeConsensusScore (Req 4.8)', () => {
  const engine = new DeduplicationEngine(stubQueue);

  it('returns 0 when neither tier is represented', () => {
    expect(engine.computeConsensusScore(0, 0)).toBe(0);
  });

  it('returns ~0.33 when only Tier-2 is represented (1/3)', () => {
    expect(engine.computeConsensusScore(0, 1)).toBeCloseTo(0.33, 2);
  });

  it('returns ~0.67 when only Tier-1 is represented (2/3)', () => {
    expect(engine.computeConsensusScore(1, 0)).toBeCloseTo(0.67, 2);
  });

  it('returns 1.00 when both tiers are represented (3/3)', () => {
    expect(engine.computeConsensusScore(1, 1)).toBe(1.0);
  });

  it('clamps input > 1 for tier counts to 1 (distinct tier presence)', () => {
    // Multiple Tier-1 sources should still count as "Tier-1 present" = weight 2
    expect(engine.computeConsensusScore(5, 0)).toBeCloseTo(0.67, 2);
    expect(engine.computeConsensusScore(0, 10)).toBeCloseTo(0.33, 2);
  });

  it('result is always in [0.00, 1.00]', () => {
    for (const t1 of [0, 1, 2]) {
      for (const t2 of [0, 1, 2]) {
        const score = engine.computeConsensusScore(t1, t2);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    }
  });

  it('result is rounded to 2 decimal places', () => {
    const score = engine.computeConsensusScore(0, 1);
    const asString = score.toString();
    const decimals = asString.includes('.') ? asString.split('.')[1]!.length : 0;
    expect(decimals).toBeLessThanOrEqual(2);
  });
});
