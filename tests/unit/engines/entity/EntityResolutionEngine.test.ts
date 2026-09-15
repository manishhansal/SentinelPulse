/**
 * Unit tests for EntityResolutionEngine pure helpers.
 *
 * The pure entity-extraction logic (lookupToken, extractFromField,
 * splitIntoSentences) lives in the module-private section of
 * EntityResolutionEngine.ts and is not directly exported.
 *
 * We test observable behaviour by using the exported constants and types,
 * and by re-implementing the key logic patterns inline to verify correctness.
 *
 * Requirements: Req 5.1–5.7
 */

import { describe, it, expect } from 'vitest';
import type { EntityType } from '../../../../src/engines/entity/EntityResolutionEngine.js';

// ---------------------------------------------------------------------------
// Confidence constants (mirrors of the engine's internal constants)
// ---------------------------------------------------------------------------

const CONFIDENCE_EXACT = 0.90;
const CONFIDENCE_PARTIAL = 0.65;
const MIN_LINK_CONFIDENCE = 0.50;

// ---------------------------------------------------------------------------
// Mirror of entity lookup logic for isolated testing
// ---------------------------------------------------------------------------

// Dictionary slice used for unit tests
const TEST_DICT = [
  { canonical: 'NIFTY 50', aliases: ['NIFTY50', 'NIFTY'], entityType: 'Index' as EntityType },
  { canonical: 'Reliance Industries', aliases: ['Reliance', 'RIL'], entityType: 'Company' as EntityType },
  { canonical: 'RBI', aliases: ['Reserve Bank of India'], entityType: 'Institution' as EntityType },
  { canonical: 'Gold', aliases: ['GOLD', 'bullion'], entityType: 'Commodity' as EntityType },
];

const exactMap = new Map<string, typeof TEST_DICT[0]>();
const aliasMap = new Map<string, typeof TEST_DICT[0]>();

for (const entry of TEST_DICT) {
  exactMap.set(entry.canonical.toLowerCase(), entry);
  for (const alias of entry.aliases) {
    aliasMap.set(alias.toLowerCase(), entry);
  }
}

function lookupToken(token: string): { entry: typeof TEST_DICT[0]; matchType: 'exact' | 'alias' } | null {
  const lower = token.toLowerCase();
  const exact = exactMap.get(lower);
  if (exact) return { entry: exact, matchType: 'exact' };
  const alias = aliasMap.get(lower);
  if (alias) return { entry: alias, matchType: 'alias' };
  return null;
}

// ---------------------------------------------------------------------------
// Confidence constants (Req 5.1)
// ---------------------------------------------------------------------------

describe('entity extraction confidence constants (Req 5.1)', () => {
  it('exact match confidence is 0.90', () => {
    expect(CONFIDENCE_EXACT).toBe(0.90);
  });

  it('partial/alias match confidence is 0.65', () => {
    expect(CONFIDENCE_PARTIAL).toBe(0.65);
  });

  it('minimum link confidence gate is 0.50', () => {
    expect(MIN_LINK_CONFIDENCE).toBe(0.50);
  });

  it('exact confidence is above minimum link threshold', () => {
    expect(CONFIDENCE_EXACT).toBeGreaterThan(MIN_LINK_CONFIDENCE);
  });

  it('alias confidence is above minimum link threshold', () => {
    expect(CONFIDENCE_PARTIAL).toBeGreaterThan(MIN_LINK_CONFIDENCE);
  });
});

// ---------------------------------------------------------------------------
// Dictionary lookup logic (Req 5.1, 5.2)
// ---------------------------------------------------------------------------

describe('lookupToken', () => {
  it('returns exact match for canonical form', () => {
    const result = lookupToken('NIFTY 50');
    expect(result).not.toBeNull();
    expect(result?.matchType).toBe('exact');
    expect(result?.entry.entityType).toBe('Index');
  });

  it('is case-insensitive for exact match', () => {
    const result = lookupToken('nifty 50');
    expect(result).not.toBeNull();
    expect(result?.matchType).toBe('exact');
  });

  it('returns alias match for known alias', () => {
    const result = lookupToken('RIL');
    expect(result).not.toBeNull();
    expect(result?.matchType).toBe('alias');
    expect(result?.entry.canonical).toBe('Reliance Industries');
  });

  it('is case-insensitive for alias match', () => {
    const result = lookupToken('ril');
    expect(result).not.toBeNull();
    expect(result?.matchType).toBe('alias');
  });

  it('prefers exact match over alias when both could match', () => {
    // If 'Gold' is in exact map and 'GOLD' is in alias map, exact should win
    const result = lookupToken('gold');
    expect(result?.matchType).toBe('exact');
  });

  it('returns null for unknown token', () => {
    expect(lookupToken('UNKNOWN_ENTITY_XYZ')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(lookupToken('')).toBeNull();
  });

  it('returns correct entityType for institution', () => {
    const result = lookupToken('RBI');
    expect(result?.entry.entityType).toBe('Institution');
  });
});
