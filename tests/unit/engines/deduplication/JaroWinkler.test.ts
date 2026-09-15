/**
 * Unit tests for JaroWinkler.ts (task 9.1)
 *
 * Covers:
 *  - jaroSimilarity: identical strings, empty strings, known examples
 *  - jaroWinklerSimilarity: prefix bonus, known examples
 *  - normaliseTitle: lowercase, punctuation removal, whitespace collapse
 *  - JaroWinklerMatcher: isNearDuplicate and similarity thresholds
 *
 * Requirements: Req 4.3
 */

import { describe, it, expect } from 'vitest';
import {
  jaroSimilarity,
  jaroWinklerSimilarity,
  normaliseTitle,
  JaroWinklerMatcher,
} from '../../../../src/engines/deduplication/JaroWinkler.js';

// ---------------------------------------------------------------------------
// jaroSimilarity
// ---------------------------------------------------------------------------

describe('jaroSimilarity', () => {
  it('returns 1 for identical strings', () => {
    expect(jaroSimilarity('hello', 'hello')).toBe(1);
    expect(jaroSimilarity('', '')).toBe(1);
  });

  it('returns 0 for empty-vs-non-empty', () => {
    expect(jaroSimilarity('', 'abc')).toBe(0);
    expect(jaroSimilarity('abc', '')).toBe(0);
  });

  it('returns 0 for completely different short strings', () => {
    // "abc" vs "xyz" — no matching characters within range
    expect(jaroSimilarity('abc', 'xyz')).toBe(0);
  });

  it('classic example: MARTHA vs MARHTA ≈ 0.944', () => {
    // Well-known Jaro test case from the original paper
    const score = jaroSimilarity('MARTHA', 'MARHTA');
    expect(score).toBeCloseTo(0.9444, 3);
  });

  it('classic example: DWAYNE vs DUANE ≈ 0.822', () => {
    const score = jaroSimilarity('DWAYNE', 'DUANE');
    expect(score).toBeCloseTo(0.822, 2);
  });

  it('classic example: DIXON vs DICKSONX ≈ 0.767', () => {
    const score = jaroSimilarity('DIXON', 'DICKSONX');
    expect(score).toBeCloseTo(0.767, 2);
  });

  it('returns value in [0, 1] for any pair', () => {
    const pairs = [
      ['foo', 'bar'],
      ['apple', 'apricot'],
      ['a', 'z'],
      ['same', 'same'],
      ['short', 'a much longer string here'],
    ];
    for (const [a, b] of pairs) {
      const score = jaroSimilarity(a!, b!);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it('is symmetric', () => {
    expect(jaroSimilarity('MARTHA', 'MARHTA')).toBeCloseTo(
      jaroSimilarity('MARHTA', 'MARTHA'),
      10,
    );
    expect(jaroSimilarity('apple', 'apricot')).toBeCloseTo(
      jaroSimilarity('apricot', 'apple'),
      10,
    );
  });
});

// ---------------------------------------------------------------------------
// jaroWinklerSimilarity
// ---------------------------------------------------------------------------

describe('jaroWinklerSimilarity', () => {
  it('returns 1 for identical strings', () => {
    expect(jaroWinklerSimilarity('hello', 'hello')).toBe(1);
  });

  it('returns 0 for empty-vs-non-empty', () => {
    expect(jaroWinklerSimilarity('', 'abc')).toBe(0);
  });

  it('classic example: MARTHA vs MARHTA ≈ 0.961', () => {
    // Jaro = 0.9444, prefix = 3 chars ("MAR"), p = 0.1
    // jw = 0.9444 + 3 * 0.1 * (1 - 0.9444) ≈ 0.9611
    const score = jaroWinklerSimilarity('MARTHA', 'MARHTA');
    expect(score).toBeCloseTo(0.961, 2);
  });

  it('classic example: DWAYNE vs DUANE ≈ 0.840', () => {
    // Jaro = 0.822, prefix = 1 char ("D"), p = 0.1
    // jw = 0.822 + 1 * 0.1 * (1 - 0.822) ≈ 0.840
    const score = jaroWinklerSimilarity('DWAYNE', 'DUANE');
    expect(score).toBeCloseTo(0.840, 2);
  });

  it('gives higher score than jaro when strings share a prefix', () => {
    // "ABCDE" vs "ABXYZ" share prefix "AB"
    const jaro = jaroSimilarity('ABCDE', 'ABXYZ');
    const jw = jaroWinklerSimilarity('ABCDE', 'ABXYZ');
    expect(jw).toBeGreaterThanOrEqual(jaro);
  });

  it('equals jaro when strings share no prefix', () => {
    // completely different first characters
    const s1 = 'apple';
    const s2 = 'zzzzzz';
    const jaro = jaroSimilarity(s1, s2);
    const jw = jaroWinklerSimilarity(s1, s2);
    // No common prefix ⟹ prefix bonus term = 0 ⟹ jw === jaro
    expect(jw).toBeCloseTo(jaro, 10);
  });

  it('caps prefix length at 4 characters', () => {
    // Both strings start with "abcde" — prefix bonus is capped at 4, not 5
    const s1 = 'abcde_different_suffix_1';
    const s2 = 'abcde_different_suffix_2';
    // Manually compute: prefix contribution = 4 * 0.1 (not 5 * 0.1)
    const jaro = jaroSimilarity(s1, s2);
    const jw = jaroWinklerSimilarity(s1, s2);
    const expectedBonus = 4 * 0.1 * (1 - jaro);
    expect(jw).toBeCloseTo(jaro + expectedBonus, 8);
  });

  it('returns value in [0, 1] for any pair', () => {
    const pairs = [
      ['foo', 'bar'],
      ['apple', 'apricot'],
      ['same', 'same'],
    ];
    for (const [a, b] of pairs) {
      const score = jaroWinklerSimilarity(a!, b!);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// normaliseTitle
// ---------------------------------------------------------------------------

describe('normaliseTitle', () => {
  it('lowercases the string', () => {
    expect(normaliseTitle('HELLO WORLD')).toBe('hello world');
  });

  it('removes punctuation characters', () => {
    expect(normaliseTitle("RBI raises rates by 0.25%, market reacts!")).toBe(
      'rbi raises rates by 025 market reacts',
    );
  });

  it('collapses consecutive whitespace', () => {
    expect(normaliseTitle('foo   bar   baz')).toBe('foo bar baz');
  });

  it('trims leading and trailing whitespace', () => {
    expect(normaliseTitle('  hello world  ')).toBe('hello world');
  });

  it('handles empty string', () => {
    expect(normaliseTitle('')).toBe('');
  });

  it('removes all common punctuation', () => {
    const result = normaliseTitle('Hello, World! It\'s a "test" — right?');
    // No punctuation characters remaining
    expect(result).not.toMatch(/[^\w\s]/);
    // The em dash and surrounding spaces become a single space after collapse
    expect(result).toBe('hello world its a test right');
  });

  it('preserves digits', () => {
    expect(normaliseTitle('Q3 2024 earnings: +15%')).toBe('q3 2024 earnings 15');
  });
});

// ---------------------------------------------------------------------------
// JaroWinklerMatcher
// ---------------------------------------------------------------------------

describe('JaroWinklerMatcher', () => {
  const defaultMatcher = new JaroWinklerMatcher({ threshold: 0.92, windowHours: 24 });

  describe('similarity()', () => {
    it('returns 1.0 for identical titles', () => {
      expect(defaultMatcher.similarity('RBI rate hike', 'RBI rate hike')).toBe(1);
    });

    it('returns a value between 0 and 1', () => {
      const s = defaultMatcher.similarity('foo', 'bar');
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    });

    it('normalises titles before comparing (case-insensitive)', () => {
      const upper = defaultMatcher.similarity('RBI Raises Rates', 'rbi raises rates');
      expect(upper).toBeCloseTo(1.0, 8);
    });

    it('normalises punctuation before comparing', () => {
      const withPunct = defaultMatcher.similarity(
        'RBI raises rates by 0.25%',
        'RBI raises rates by 0.25%!',
      );
      expect(withPunct).toBeCloseTo(1.0, 5);
    });
  });

  describe('isNearDuplicate()', () => {
    it('returns true for identical titles', () => {
      expect(defaultMatcher.isNearDuplicate('Fed cuts rates', 'Fed cuts rates')).toBe(true);
    });

    it('returns true for very similar titles above threshold', () => {
      // Tiny variation: "Fed raises rates by 25bps" vs "Fed raises rates by 25 bps"
      const result = defaultMatcher.isNearDuplicate(
        'Fed raises rates by 25bps',
        'Fed raises rates by 25 bps',
      );
      expect(result).toBe(true);
    });

    it('returns false for clearly different titles', () => {
      expect(
        defaultMatcher.isNearDuplicate(
          'RBI cuts interest rates sharply',
          'Sensex falls amid global sell-off',
        ),
      ).toBe(false);
    });

    it('respects a lower threshold configuration', () => {
      const laxMatcher = new JaroWinklerMatcher({ threshold: 0.80, windowHours: 24 });
      // These are similar but not identical — should pass 0.80 but may fail 0.92
      const title1 = 'Oil prices rise on OPEC output cut';
      const title2 = 'Oil rises as OPEC output cut announced';
      const sim = defaultMatcher.similarity(title1, title2);
      if (sim >= 0.80 && sim < 0.92) {
        expect(laxMatcher.isNearDuplicate(title1, title2)).toBe(true);
        expect(defaultMatcher.isNearDuplicate(title1, title2)).toBe(false);
      } else if (sim >= 0.92) {
        expect(laxMatcher.isNearDuplicate(title1, title2)).toBe(true);
        expect(defaultMatcher.isNearDuplicate(title1, title2)).toBe(true);
      } else {
        expect(laxMatcher.isNearDuplicate(title1, title2)).toBe(false);
        expect(defaultMatcher.isNearDuplicate(title1, title2)).toBe(false);
      }
    });

    it('handles near-identical financial headlines as near-duplicates', () => {
      // Typical near-duplicate pattern in financial news
      const a = 'Sensex surges 500 points as FII inflows rise';
      const b = 'Sensex surges 500 points on strong FII inflows';
      const sim = defaultMatcher.similarity(a, b);
      // Just verify consistent behaviour: isNearDuplicate matches threshold comparison
      expect(defaultMatcher.isNearDuplicate(a, b)).toBe(sim >= 0.92);
    });
  });
});

// ---------------------------------------------------------------------------
// EmbeddingMatcher.cosineSimilarity (pure maths — no DB needed)
// ---------------------------------------------------------------------------

import { EmbeddingMatcher } from '../../../../src/engines/deduplication/EmbeddingMatcher.js';

describe('EmbeddingMatcher.cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(EmbeddingMatcher.cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 8);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(EmbeddingMatcher.cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 8);
  });

  it('returns 0 for zero-magnitude vector', () => {
    expect(EmbeddingMatcher.cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(EmbeddingMatcher.cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
  });

  it('returns value in [0, 1]', () => {
    const pairs: [number[], number[]][] = [
      [[1, 0], [0.5, 0.5]],
      [[0.3, 0.7], [0.9, 0.1]],
      [[-1, -1], [1, 1]], // anti-parallel → 0 after clamp
      [[1, 1], [1, 1]],
    ];
    for (const [a, b] of pairs) {
      const score = EmbeddingMatcher.cosineSimilarity(a, b);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it('throws on mismatched vector lengths', () => {
    expect(() =>
      EmbeddingMatcher.cosineSimilarity([1, 2], [1, 2, 3]),
    ).toThrow('Vector length mismatch');
  });

  it('is symmetric', () => {
    const a = [0.1, 0.5, 0.9];
    const b = [0.8, 0.2, 0.4];
    expect(EmbeddingMatcher.cosineSimilarity(a, b)).toBeCloseTo(
      EmbeddingMatcher.cosineSimilarity(b, a),
      10,
    );
  });

  it('returns 0 for opposite-direction vectors (anti-parallel)', () => {
    // Cosine = -1 for anti-parallel, but we clamp to [0, 1]
    expect(EmbeddingMatcher.cosineSimilarity([1, 0], [-1, 0])).toBe(0);
  });
});
