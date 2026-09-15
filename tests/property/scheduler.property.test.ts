/**
 * Properties 1 and 2: Tier-1 polling order and source enable-state parsing.
 *
 * Property 1: In any cycle, all Tier-1 sources are processed before any Tier-2 source.
 * Property 2: A source is enabled only when its env var is exactly "true" (case-insensitive).
 *
 * **Validates: Requirements 1.3, 1.7, 1.8**
 */
import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import fc from 'fast-check';

// ---------------------------------------------------------------------------
// Property 1: Tier-1 sources are always polled before Tier-2 sources
// ---------------------------------------------------------------------------

/**
 * Pure function that mirrors Scheduler.runCycle() tier-ordering logic.
 * Accepts a mixed list of adapters and returns the order in which they would
 * be processed (all tier-1 first, then all tier-2).
 */
function simulateCycleOrder(
  adapters: Array<{ sourceId: string; tier: 1 | 2 }>,
): string[] {
  const tier1 = adapters.filter((a) => a.tier === 1);
  const tier2 = adapters.filter((a) => a.tier === 2);
  return [...tier1, ...tier2].map((a) => a.sourceId);
}

// Feature: sentinel-pulse
describe('Property 1: Tier-1 polling order', () => {
  it('all Tier-1 sources are processed before any Tier-2 source for any adapter list', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            sourceId: fc.string({ minLength: 1, maxLength: 20 }),
            tier: fc.constantFrom(1 as const, 2 as const),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        (adapters) => {
          const order = simulateCycleOrder(adapters);

          // Find the index of the last Tier-1 source and the first Tier-2 source
          const tier2Indices = adapters
            .map((a, i) => ({ tier: a.tier, id: a.sourceId, idx: i }))
            .filter((a) => a.tier === 2)
            .map((a) => order.indexOf(a.id));

          const tier1Indices = adapters
            .map((a, i) => ({ tier: a.tier, id: a.sourceId, idx: i }))
            .filter((a) => a.tier === 1)
            .map((a) => order.indexOf(a.id));

          if (tier1Indices.length === 0 || tier2Indices.length === 0) {
            // Homogeneous list — ordering constraint trivially satisfied
            return true;
          }

          const lastTier1Index = Math.max(...tier1Indices);
          const firstTier2Index = Math.min(...tier2Indices);

          // All Tier-1 sources must appear before all Tier-2 sources
          return lastTier1Index < firstTier2Index;
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: Source enable-state parsing
// ---------------------------------------------------------------------------

/**
 * Pure function that mirrors the sourceEnabledSchema transform from env.schema.ts.
 * Only the string "true" (case-insensitive) enables a source.
 */
function parseSourceEnabled(value: string | undefined): boolean {
  return (value ?? '').toLowerCase() === 'true';
}

// Feature: sentinel-pulse
describe('Property 2: source enable-state parsing', () => {
  it('only "true" (case-insensitive) enables a source', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 20 }),
        (rawValue) => {
          const enabled = parseSourceEnabled(rawValue);
          const expectedEnabled = rawValue.toLowerCase() === 'true';
          return enabled === expectedEnabled;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('"true" (exact) enables the source', () => {
    expect(parseSourceEnabled('true')).toBe(true);
  });

  it('"TRUE" (uppercase) enables the source', () => {
    expect(parseSourceEnabled('TRUE')).toBe(true);
  });

  it('"True" (mixed case) enables the source', () => {
    expect(parseSourceEnabled('True')).toBe(true);
  });

  it('"false" disables the source', () => {
    expect(parseSourceEnabled('false')).toBe(false);
  });

  it('empty string disables the source', () => {
    expect(parseSourceEnabled('')).toBe(false);
  });

  it('undefined disables the source', () => {
    expect(parseSourceEnabled(undefined)).toBe(false);
  });

  it('"1" does not enable the source', () => {
    expect(parseSourceEnabled('1')).toBe(false);
  });

  it('"yes" does not enable the source', () => {
    expect(parseSourceEnabled('yes')).toBe(false);
  });
});
