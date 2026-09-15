/**
 * Unit tests for MarketImpactEngine pure helper functions.
 *
 * Tests:
 *   - flipDirection   (exported pure helper)
 *   - mergeImpacts    (exported pure helper)
 *
 * Requirements: Req 10.1–10.8
 */

import { describe, it, expect } from 'vitest';
import {
  flipDirection,
  mergeImpacts,
} from '../../../../src/engines/market-impact/MarketImpactEngine.js';
import type { AssetImpact } from '../../../../src/engines/market-impact/IndianMarketImpactEngine.js';

// ---------------------------------------------------------------------------
// flipDirection
// ---------------------------------------------------------------------------

describe('flipDirection', () => {
  it('flips POSITIVE to NEGATIVE', () => {
    expect(flipDirection('POSITIVE')).toBe('NEGATIVE');
  });

  it('flips NEGATIVE to POSITIVE', () => {
    expect(flipDirection('NEGATIVE')).toBe('POSITIVE');
  });

  it('leaves NEUTRAL unchanged', () => {
    expect(flipDirection('NEUTRAL')).toBe('NEUTRAL');
  });

  it('leaves UNCERTAIN unchanged', () => {
    expect(flipDirection('UNCERTAIN')).toBe('UNCERTAIN');
  });
});

// ---------------------------------------------------------------------------
// mergeImpacts
// ---------------------------------------------------------------------------

function makeImpact(assetId: string, direction: AssetImpact['direction']): AssetImpact {
  return {
    assetId,
    direction,
    strength: 0.5,
    confidence: 0.8,
    expectedHorizon: 'INTRADAY',
    evidenceType: 'RULE_BASED',
    reason: `Rule-based impact for ${assetId}`,
    sectorId: undefined,
  };
}

describe('mergeImpacts', () => {
  it('returns primary impacts when secondary is empty', () => {
    const primary = [makeImpact('NIFTY50', 'POSITIVE')];
    expect(mergeImpacts(primary, [])).toEqual(primary);
  });

  it('returns secondary impacts when primary is empty', () => {
    const secondary = [makeImpact('BANKNIFTY', 'NEGATIVE')];
    expect(mergeImpacts([], secondary)).toEqual(secondary);
  });

  it('merges unique assets from both arrays', () => {
    const primary = [makeImpact('NIFTY50', 'POSITIVE')];
    const secondary = [makeImpact('BANKNIFTY', 'NEGATIVE')];
    const result = mergeImpacts(primary, secondary);
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.assetId)).toContain('NIFTY50');
    expect(result.map((i) => i.assetId)).toContain('BANKNIFTY');
  });

  it('excludes secondary assets that are already in primary (primary wins)', () => {
    const primary = [makeImpact('NIFTY50', 'POSITIVE')];
    const secondary = [
      makeImpact('NIFTY50', 'NEGATIVE'), // duplicate — should be excluded
      makeImpact('SENSEX', 'NEUTRAL'),
    ];
    const result = mergeImpacts(primary, secondary);
    expect(result).toHaveLength(2);
    const niftyEntry = result.find((i) => i.assetId === 'NIFTY50')!;
    expect(niftyEntry.direction).toBe('POSITIVE'); // primary direction preserved
  });

  it('preserves order: primary first, then new secondary entries', () => {
    const primary = [makeImpact('NIFTY50', 'POSITIVE')];
    const secondary = [makeImpact('BANKNIFTY', 'NEGATIVE')];
    const result = mergeImpacts(primary, secondary);
    expect(result[0]?.assetId).toBe('NIFTY50');
    expect(result[1]?.assetId).toBe('BANKNIFTY');
  });
});
