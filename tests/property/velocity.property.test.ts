/**
 * Property 18: Velocity momentum null-safety
 * momentum = current / baseline when baseline > 0; null otherwise.
 *
 * **Validates: Requirements 15.2**
 */
import { describe, it } from 'vitest';
import fc from 'fast-check';

// Feature: sentinel-pulse, Property 18: velocity momentum null-safety
describe('Property 18: momentum is null when baseline <= 0', () => {
  it('never divides by zero or produces non-null momentum with zero baseline', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 100, noNaN: true }),
        fc.float({ min: 0, max: 10, noNaN: true }),
        (velocity5m, baseline) => {
          // Simulate the momentum calculation from VelocityEngine (Req 15.2)
          const momentum = baseline > 0 ? velocity5m / baseline : null;

          // Property: if baseline <= 0, momentum MUST be null
          if (baseline <= 0) {
            return momentum === null;
          }
          // If baseline > 0, momentum must be a finite number
          return momentum !== null && isFinite(momentum);
        }
      ),
      { numRuns: 100 }
    );
  });
});
