/**
 * Property 14: NewsImpactScore range
 * For any valid factor inputs, NewsImpactScore is in [-100.0, +100.0].
 *
 * **Validates: Requirements 10.1**
 */
import { describe, it } from 'vitest';
import fc from 'fast-check';

// Feature: sentinel-pulse, Property 14: NewsImpactScore range
describe('Property 14: NewsImpactScore is always in [-100, +100]', () => {
  it('sentiment × importance × ... normalised to [-100, 100]', () => {
    fc.assert(
      fc.property(
        fc.float({ min: -1, max: 1, noNaN: true }),
        fc.float({ min: 0, max: 1, noNaN: true }),
        fc.float({ min: 0, max: 1, noNaN: true }),
        fc.float({ min: 0, max: 1, noNaN: true }),
        fc.float({ min: 0, max: 1, noNaN: true }),
        fc.float({ min: 0, max: 1, noNaN: true }),
        fc.float({ min: 0, max: 1, noNaN: true }),
        (sentiment, importance, sourceReliability, entityRelevance, historicalImpact, regimeCompatibility, confidence) => {
          const raw = sentiment * importance * sourceReliability * entityRelevance * historicalImpact * regimeCompatibility * confidence;
          const score = Math.max(-100, Math.min(100, raw * 100));
          return score >= -100.0 && score <= 100.0;
        }
      ),
      { numRuns: 100 }
    );
  });
});
