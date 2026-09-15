/**
 * Property 15: Surprise score formula and capping
 *
 * **Validates: Requirements 14.1**
 */
import { describe, it } from 'vitest';
import fc from 'fast-check';
import { SurpriseScoreCalculator } from '../../src/engines/event-detection/SurpriseScoreCalculator.js';

// Feature: sentinel-pulse, Property 15: surprise score formula and capping
describe('Property 15: surprise score formula correctness', () => {
  const calc = new SurpriseScoreCalculator(0.05);

  it('result is always in [-5, +5] or null', () => {
    fc.assert(
      fc.property(
        fc.option(fc.float({ min: -1000, max: 1000, noNaN: true })),
        fc.option(fc.float({ min: -1000, max: 1000, noNaN: true })),
        (quantitative, expected) => {
          const result = calc.compute(quantitative, expected);
          if (result.surpriseScore !== null) {
            return result.surpriseScore >= -5.0 && result.surpriseScore <= 5.0;
          }
          return true; // null is always valid
        }
      ),
      { numRuns: 100 }
    );
  });

  it('division by zero always produces null with error flag', () => {
    fc.assert(
      fc.property(
        fc.float({ min: -100, max: 100, noNaN: true }),
        (quantitative) => {
          const result = calc.compute(quantitative, 0);
          return result.surpriseScore === null && result.surpriseScoreError === 'division_by_zero';
        }
      ),
      { numRuns: 100 }
    );
  });
});
