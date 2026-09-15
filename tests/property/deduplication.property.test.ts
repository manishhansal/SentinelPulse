/**
 * Properties 9 and 10: Deduplication idempotence and consensus score.
 *
 * **Validates: Requirements 4.8, 4.10**
 */
import { describe, it } from 'vitest';
import fc from 'fast-check';
import { DeduplicationEngine } from '../../src/engines/deduplication/DeduplicationEngine.js';

// We need a minimal Queue stub to construct DeduplicationEngine so we can call
// computeConsensusScore, which is the public pure-formula method we're testing.
const stubQueue = { add: async () => {} } as unknown as import('bullmq').Queue;

// Feature: sentinel-pulse, Property 10: consensus score formula correctness
describe('Property 10: consensus score formula', () => {
  const engine = new DeduplicationEngine(stubQueue);

  it('consensus_score is always in [0.00, 1.00] for any tier combination', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10 }),
        fc.integer({ min: 0, max: 10 }),
        (tier1Count, tier2Count) => {
          // Call the public method directly — formula:
          // (Σ weights of distinct represented tiers) / (Σ weights of all defined tiers)
          // Tier-1 weight = 2, Tier-2 weight = 1, total = 3
          const score = engine.computeConsensusScore(tier1Count, tier2Count);
          return score >= 0.00 && score <= 1.00;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('tier1-only cluster scores 0.67 (2/3)', () => {
    const score = engine.computeConsensusScore(1, 0);
    // Math.round((2/3) * 100) / 100 = 0.67
    expect(score).toBe(0.67);
  });

  it('tier2-only cluster scores 0.33 (1/3)', () => {
    const score = engine.computeConsensusScore(0, 1);
    // Math.round((1/3) * 100) / 100 = 0.33
    expect(score).toBe(0.33);
  });

  it('both tiers present scores 1.00 (3/3)', () => {
    const score = engine.computeConsensusScore(1, 1);
    expect(score).toBe(1.00);
  });

  it('no tiers present scores 0.00', () => {
    const score = engine.computeConsensusScore(0, 0);
    expect(score).toBe(0.00);
  });
});
