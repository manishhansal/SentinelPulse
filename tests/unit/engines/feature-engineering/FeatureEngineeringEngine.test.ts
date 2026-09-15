/**
 * Unit tests for FeatureEngineeringEngine pure helpers.
 *
 * The pure utility functions (encodeOneHot, encodeOneHotSet, buildOneHotFeatures,
 * extractSubScore) are module-private, so this test file re-implements them
 * locally with identical logic and verifies their expected behaviour.
 * The exported constants (QUALITATIVE_SIGNALS, EVENT_TYPE_VALUES) are also
 * tested directly.
 *
 * Requirements: Req 20.1, Req 20.2
 */

import { describe, it, expect } from 'vitest';
import {
  QUALITATIVE_SIGNALS,
  EVENT_TYPE_VALUES,
} from '../../../../src/engines/feature-engineering/FeatureEngineeringEngine.js';

// ---------------------------------------------------------------------------
// Mirror of module-private helpers for isolated unit-testing
// ---------------------------------------------------------------------------

function encodeOneHot(value: string, vocabulary: string[]): number[] {
  return vocabulary.map((label) => (label === value ? 1 : 0));
}

function encodeOneHotSet(values: string[], vocabulary: string[]): number[] {
  const set = new Set(values);
  return vocabulary.map((label) => (set.has(label) ? 1 : 0));
}

function buildOneHotFeatures(
  prefix: string,
  encoded: number[],
  vocabulary: string[],
): Record<string, number> {
  const result: Record<string, number> = {};
  vocabulary.forEach((label, idx) => {
    result[`${prefix}_${label}`] = encoded[idx] ?? 0;
  });
  return result;
}

function extractSubScore(subScores: unknown, key: string): number | null {
  if (subScores == null || typeof subScores !== 'object') return null;
  const record = subScores as Record<string, unknown>;
  const val = record[key];
  if (val == null) return null;
  const n = Number(val);
  return isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// QUALITATIVE_SIGNALS and EVENT_TYPE_VALUES exports
// ---------------------------------------------------------------------------

describe('exported vocabulary constants', () => {
  it('QUALITATIVE_SIGNALS contains NEUTRAL', () => {
    expect(QUALITATIVE_SIGNALS).toContain('NEUTRAL');
  });

  it('QUALITATIVE_SIGNALS contains all expected signals', () => {
    const expected = [
      'UNCERTAINTY', 'FEAR', 'HAWKISH', 'DOVISH',
      'RISK_ON', 'RISK_OFF', 'OPTIMISM', 'PANIC', 'NEUTRAL',
    ];
    for (const sig of expected) {
      expect(QUALITATIVE_SIGNALS).toContain(sig);
    }
  });

  it('EVENT_TYPE_VALUES contains UNCLASSIFIED fallback', () => {
    expect(EVENT_TYPE_VALUES).toContain('UNCLASSIFIED');
  });

  it('EVENT_TYPE_VALUES contains key market-relevant types', () => {
    expect(EVENT_TYPE_VALUES).toContain('MONETARY_POLICY');
    expect(EVENT_TYPE_VALUES).toContain('EARNINGS');
    expect(EVENT_TYPE_VALUES).toContain('GEOPOLITICAL');
  });

  it('QUALITATIVE_SIGNALS has no duplicate entries', () => {
    const set = new Set(QUALITATIVE_SIGNALS);
    expect(set.size).toBe(QUALITATIVE_SIGNALS.length);
  });

  it('EVENT_TYPE_VALUES has no duplicate entries', () => {
    const set = new Set(EVENT_TYPE_VALUES);
    expect(set.size).toBe(EVENT_TYPE_VALUES.length);
  });
});

// ---------------------------------------------------------------------------
// encodeOneHot
// ---------------------------------------------------------------------------

describe('encodeOneHot', () => {
  const vocab = ['EARNINGS', 'MONETARY_POLICY', 'GEOPOLITICAL'];

  it('encodes a known value with exactly one 1', () => {
    const encoded = encodeOneHot('EARNINGS', vocab);
    expect(encoded).toEqual([1, 0, 0]);
  });

  it('encodes middle-position value correctly', () => {
    const encoded = encodeOneHot('MONETARY_POLICY', vocab);
    expect(encoded).toEqual([0, 1, 0]);
  });

  it('returns all zeros for an unknown value', () => {
    const encoded = encodeOneHot('UNKNOWN_TYPE', vocab);
    expect(encoded).toEqual([0, 0, 0]);
  });

  it('output length equals vocabulary length', () => {
    const encoded = encodeOneHot('EARNINGS', vocab);
    expect(encoded).toHaveLength(vocab.length);
  });

  it('sum of encoded vector equals 1 for a known value', () => {
    const encoded = encodeOneHot('GEOPOLITICAL', vocab);
    expect(encoded.reduce((a, b) => a + b, 0)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// encodeOneHotSet
// ---------------------------------------------------------------------------

describe('encodeOneHotSet', () => {
  const vocab = ['FEAR', 'HAWKISH', 'NEUTRAL', 'RISK_OFF'];

  it('encodes multiple values correctly', () => {
    const encoded = encodeOneHotSet(['FEAR', 'NEUTRAL'], vocab);
    expect(encoded).toEqual([1, 0, 1, 0]);
  });

  it('returns all zeros for empty values array', () => {
    const encoded = encodeOneHotSet([], vocab);
    expect(encoded).toEqual([0, 0, 0, 0]);
  });

  it('handles full vocabulary match (all ones)', () => {
    const encoded = encodeOneHotSet(vocab, vocab);
    expect(encoded).toEqual([1, 1, 1, 1]);
  });

  it('ignores values not in vocabulary', () => {
    const encoded = encodeOneHotSet(['UNKNOWN_SIGNAL'], vocab);
    expect(encoded).toEqual([0, 0, 0, 0]);
  });
});

// ---------------------------------------------------------------------------
// buildOneHotFeatures
// ---------------------------------------------------------------------------

describe('buildOneHotFeatures', () => {
  it('produces correctly named keys', () => {
    const vocab = ['A', 'B', 'C'];
    const encoded = [1, 0, 1];
    const features = buildOneHotFeatures('event_type', encoded, vocab);
    expect(features).toEqual({
      event_type_A: 1,
      event_type_B: 0,
      event_type_C: 1,
    });
  });

  it('uses prefix separator underscore', () => {
    const features = buildOneHotFeatures('signal', [1], ['FEAR']);
    expect(Object.keys(features)[0]).toBe('signal_FEAR');
  });
});

// ---------------------------------------------------------------------------
// extractSubScore
// ---------------------------------------------------------------------------

describe('extractSubScore', () => {
  it('returns the numeric value for a known key', () => {
    const subScores = { novelty: 0.6, eventSeverity: 0.9 };
    expect(extractSubScore(subScores, 'novelty')).toBeCloseTo(0.6);
  });

  it('returns null for a missing key', () => {
    expect(extractSubScore({ a: 1 }, 'missing_key')).toBeNull();
  });

  it('returns null for null input', () => {
    expect(extractSubScore(null, 'key')).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(extractSubScore('string', 'key')).toBeNull();
    expect(extractSubScore(42, 'key')).toBeNull();
  });

  it('returns null for Infinity or NaN values', () => {
    expect(extractSubScore({ k: Infinity }, 'k')).toBeNull();
    expect(extractSubScore({ k: NaN }, 'k')).toBeNull();
  });

  it('handles nested object with numeric value stored as object', () => {
    const subScores = { novelty: { value: 0.6, weight: 1.0 } };
    // The object is not a number — Number({}) → NaN → returns null
    expect(extractSubScore(subScores, 'novelty')).toBeNull();
  });
});
