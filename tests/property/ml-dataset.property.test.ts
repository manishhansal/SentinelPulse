/**
 * Property 17: ML label assignment determinism
 *
 * **Validates: Requirements 22.2**
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { MLDatasetGenerator } from '../../src/engines/ml-dataset/MLDatasetGenerator.js';

// Feature: sentinel-pulse, Property 17: ML label assignment determinism
describe('Property 17: label assignment is deterministic', () => {
  // MLDatasetGenerator.assignLabel is a pure public method; no DB needed.
  const gen = new MLDatasetGenerator();

  it('same return value always maps to same label', () => {
    fc.assert(
      fc.property(
        fc.float({ min: -10, max: 10, noNaN: true }),
        (returnPct) => {
          const label1 = gen.assignLabel(returnPct);
          const label2 = gen.assignLabel(returnPct);
          return label1 === label2;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('null input always produces null label', () => {
    fc.assert(
      fc.property(fc.constant(null), (nullVal) => {
        return gen.assignLabel(nullVal) === null;
      }),
      { numRuns: 10 }
    );
  });
});
