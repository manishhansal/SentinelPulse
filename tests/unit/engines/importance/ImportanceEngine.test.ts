/**
 * Unit tests for ImportanceEngine pure helpers.
 *
 * Covers:
 *   - resolveEventSeverity          (Req 9.1)
 *   - resolveGeopoliticalSignificance (Req 9.1)
 *   - resolveMacroSignificance       (Req 9.1)
 *   - computeWeightedMean            (Req 9.1)
 *   - clamp                          (utility)
 *
 * Requirements: Req 9.1–9.4
 */

import { describe, it, expect } from 'vitest';
import {
  resolveEventSeverity,
  resolveGeopoliticalSignificance,
  resolveMacroSignificance,
  computeWeightedMean,
  clamp,
  type SubScores,
} from '../../../../src/engines/importance/ImportanceEngine.js';

// ---------------------------------------------------------------------------
// resolveEventSeverity (Req 9.1)
// ---------------------------------------------------------------------------

describe('resolveEventSeverity (Req 9.1)', () => {
  it('returns 0.95 for GEOPOLITICAL', () => {
    expect(resolveEventSeverity('GEOPOLITICAL')).toBe(0.95);
  });

  it('returns 0.90 for MONETARY_POLICY', () => {
    expect(resolveEventSeverity('MONETARY_POLICY')).toBe(0.90);
  });

  it('returns 0.70 for EARNINGS', () => {
    expect(resolveEventSeverity('EARNINGS')).toBe(0.70);
  });

  it('returns 0.40 for UNCLASSIFIED', () => {
    expect(resolveEventSeverity('UNCLASSIFIED')).toBe(0.40);
  });

  it('falls back to UNCLASSIFIED value for unknown event type', () => {
    expect(resolveEventSeverity('UNKNOWN_TYPE')).toBe(0.40);
  });

  it('all known event types return values in [0, 1]', () => {
    const types = [
      'GEOPOLITICAL', 'MONETARY_POLICY', 'CREDIT_EVENT', 'COMMODITY_SHOCK',
      'NATURAL_DISASTER', 'TRADE_POLICY', 'ECONOMIC_DATA', 'MACRO_DATA',
      'CURRENCY_EVENT', 'EARNINGS', 'REGULATORY', 'CORPORATE_ACTION',
      'SECTOR_ROTATION', 'UNCLASSIFIED',
    ];
    for (const t of types) {
      const v = resolveEventSeverity(t);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// resolveGeopoliticalSignificance
// ---------------------------------------------------------------------------

describe('resolveGeopoliticalSignificance', () => {
  it('returns 1.00 for GEOPOLITICAL (highest significance)', () => {
    expect(resolveGeopoliticalSignificance('GEOPOLITICAL')).toBe(1.00);
  });

  it('returns 0.05 for UNCLASSIFIED (lowest significance)', () => {
    expect(resolveGeopoliticalSignificance('UNCLASSIFIED')).toBe(0.05);
  });

  it('falls back to UNCLASSIFIED for unknown type', () => {
    expect(resolveGeopoliticalSignificance('FOOBAR')).toBe(0.05);
  });
});

// ---------------------------------------------------------------------------
// resolveMacroSignificance
// ---------------------------------------------------------------------------

describe('resolveMacroSignificance', () => {
  it('returns 1.00 for MONETARY_POLICY', () => {
    expect(resolveMacroSignificance('MONETARY_POLICY')).toBe(1.00);
  });

  it('returns 0.10 for UNCLASSIFIED', () => {
    expect(resolveMacroSignificance('UNCLASSIFIED')).toBe(0.10);
  });

  it('falls back to UNCLASSIFIED for unknown type', () => {
    expect(resolveMacroSignificance('FOOBAR')).toBe(0.10);
  });
});

// ---------------------------------------------------------------------------
// computeWeightedMean (Req 9.1)
// ---------------------------------------------------------------------------

describe('computeWeightedMean (Req 9.1)', () => {
  const makeSubScores = (value: number): SubScores => ({
    sourceReliability: value,
    eventSeverity: value,
    affectedAssetWeight: value,
    affectedSectorCount: value,
    historicalImpactMagnitude: value,
    novelty: value,
    surpriseFactor: value,
    geopoliticalSignificance: value,
    macroSignificance: value,
  });

  it('returns 0 when all sub-scores are 0', () => {
    expect(computeWeightedMean(makeSubScores(0))).toBe(0);
  });

  it('returns 1 when all sub-scores are 1', () => {
    expect(computeWeightedMean(makeSubScores(1))).toBeCloseTo(1, 10);
  });

  it('returns 0.5 when all sub-scores are 0.5', () => {
    expect(computeWeightedMean(makeSubScores(0.5))).toBeCloseTo(0.5, 10);
  });

  it('result is in [0, 1] for valid sub-score inputs', () => {
    const mixed: SubScores = {
      sourceReliability: 0.8,
      eventSeverity: 0.9,
      affectedAssetWeight: 0.3,
      affectedSectorCount: 0.5,
      historicalImpactMagnitude: 0.7,
      novelty: 0.6,
      surpriseFactor: 0.0,
      geopoliticalSignificance: 0.65,
      macroSignificance: 0.7,
    };
    const score = computeWeightedMean(mixed);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// clamp
// ---------------------------------------------------------------------------

describe('clamp', () => {
  it('clamps value below min to min', () => {
    expect(clamp(-0.5, 0, 1)).toBe(0);
  });

  it('clamps value above max to max', () => {
    expect(clamp(1.5, 0, 1)).toBe(1);
  });

  it('leaves a value within range unchanged', () => {
    expect(clamp(0.7, 0, 1)).toBe(0.7);
  });

  it('works with symmetric negative range', () => {
    expect(clamp(-10, -5, 5)).toBe(-5);
    expect(clamp(10, -5, 5)).toBe(5);
    expect(clamp(3, -5, 5)).toBe(3);
  });
});
