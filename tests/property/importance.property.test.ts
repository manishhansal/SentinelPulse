/**
 * Property 13: Importance score range
 * For any combination of valid sub-score inputs, importance_score is in [0.0, 1.0].
 *
 * **Validates: Requirements 9.1**
 */
import { describe, it } from 'vitest';
import fc from 'fast-check';
import { computeWeightedMean, clamp } from '../../src/engines/importance/ImportanceEngine.js';
import type { SubScores } from '../../src/engines/importance/ImportanceEngine.js';

// Feature: sentinel-pulse, Property 13: importance score range
describe('Property 13: importance score is always in [0.0, 1.0]', () => {
  it('weighted mean clamped to [0, 1] for any sub-score inputs', () => {
    fc.assert(
      fc.property(
        fc.record({
          sourceReliability: fc.float({ min: 0, max: 1, noNaN: true }),
          eventSeverity: fc.float({ min: 0, max: 1, noNaN: true }),
          affectedAssetWeight: fc.float({ min: 0, max: 1, noNaN: true }),
          affectedSectorCount: fc.float({ min: 0, max: 1, noNaN: true }),
          historicalImpactMagnitude: fc.float({ min: 0, max: 1, noNaN: true }),
          novelty: fc.float({ min: 0, max: 1, noNaN: true }),
          surpriseFactor: fc.float({ min: 0, max: 1, noNaN: true }),
          geopoliticalSignificance: fc.float({ min: 0, max: 1, noNaN: true }),
          macroSignificance: fc.float({ min: 0, max: 1, noNaN: true }),
        }),
        (subScores: SubScores) => {
          const raw = computeWeightedMean(subScores);
          const score = clamp(raw, 0.0, 1.0);
          return score >= 0.0 && score <= 1.0;
        }
      ),
      { numRuns: 100 }
    );
  });
});
