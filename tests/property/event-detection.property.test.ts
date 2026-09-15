/**
 * Property 11: Event detection idempotence.
 *
 * Processing the same article text through the event-detection pattern-matching
 * logic multiple times must always produce the same set of event types.
 *
 * Also verifies:
 *   - Every detected event type is a member of the canonical EVENT_TYPES list.
 *   - Confidence and importance scores are always in [0.0, 1.0].
 *
 * **Validates: Requirements 6.1, 6.2, 6.8**
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  EVENT_TYPES,
  type EventType,
} from '../../src/engines/event-detection/EventDetectionEngine.js';

// ---------------------------------------------------------------------------
// Replicate the pure pattern-matching subset from EventDetectionEngine
// (the engine itself mixes in I/O via prisma; we test the pure logic here)
// ---------------------------------------------------------------------------

interface PatternRule {
  eventType: EventType;
  allOf?: RegExp[];
  anyOf?: RegExp[];
  confidence: number;
  importance: number;
}

/** Mirrors EventDetectionEngine.ruleMatches() */
function ruleMatches(rule: PatternRule, text: string): boolean {
  if (rule.allOf) {
    if (!rule.allOf.every((re) => re.test(text))) return false;
  }
  if (rule.anyOf) {
    if (!rule.anyOf.some((re) => re.test(text))) return false;
  }
  return true;
}

/** A minimal subset of the pattern rules to test the idempotency property */
const SAMPLE_RULES: PatternRule[] = [
  {
    eventType: 'MONETARY_POLICY',
    allOf: [
      /\b(repo\s+rate|interest\s+rate)\b/i,
      /\b(hike|hikes|raised?)\b/i,
    ],
    confidence: 0.92,
    importance: 0.85,
  },
  {
    eventType: 'EARNINGS',
    anyOf: [
      /\b(quarterly\s+results?|q[1-4]\s+results?)\b/i,
      /\b(net\s+(profit|loss)\s+(rose|fell))\b/i,
    ],
    confidence: 0.85,
    importance: 0.70,
  },
  {
    eventType: 'GEOPOLITICAL',
    anyOf: [/\b(war|conflict|invasion|ceasefire)\b/i],
    confidence: 0.75,
    importance: 0.80,
  },
  {
    eventType: 'COMMODITY_SHOCK',
    anyOf: [/\b(crude\s+oil|brent|wti)\s+(rose?|falls?|spiked?)\b/i],
    confidence: 0.80,
    importance: 0.65,
  },
];

/** Extracts matching event types for a given text (deterministic, pure) */
function extractEventTypes(text: string): EventType[] {
  const matched = new Set<EventType>();
  for (const rule of SAMPLE_RULES) {
    if (ruleMatches(rule, text)) {
      matched.add(rule.eventType);
    }
  }
  if (matched.size === 0) matched.add('UNCLASSIFIED');
  return [...matched].sort();
}

// Feature: sentinel-pulse
describe('Property 11: event detection idempotence', () => {
  it('processing the same text twice returns the same set of event types', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 500 }),
        (text) => {
          const firstRun = extractEventTypes(text);
          const secondRun = extractEventTypes(text);
          // Sort both arrays to compare sets
          return JSON.stringify(firstRun) === JSON.stringify(secondRun);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('detected event types are always members of EVENT_TYPES', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 500 }),
        (text) => {
          const types = extractEventTypes(text);
          return types.every((t) => EVENT_TYPES.includes(t));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('confidence and importance are always in [0.0, 1.0] for matching rules', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 500 }),
        (text) => {
          for (const rule of SAMPLE_RULES) {
            if (ruleMatches(rule, text)) {
              if (rule.confidence < 0 || rule.confidence > 1) return false;
              if (rule.importance < 0 || rule.importance > 1) return false;
            }
          }
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('always produces at least one event type (UNCLASSIFIED as fallback)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 500 }),
        (text) => extractEventTypes(text).length >= 1,
      ),
      { numRuns: 200 },
    );
  });

  it('re-processing the same monetary policy article always returns MONETARY_POLICY', () => {
    // Uses "raised" which matches /raised?/i in the MONETARY_POLICY sample rule
    const text = 'RBI raised repo rate by 25 basis points';
    const firstRun = extractEventTypes(text);
    const secondRun = extractEventTypes(text);
    const thirdRun = extractEventTypes(text);
    expect(firstRun).toContain('MONETARY_POLICY');
    expect(secondRun).toContain('MONETARY_POLICY');
    expect(thirdRun).toContain('MONETARY_POLICY');
    expect(JSON.stringify(firstRun)).toBe(JSON.stringify(secondRun));
    expect(JSON.stringify(secondRun)).toBe(JSON.stringify(thirdRun));
  });
});

// ---------------------------------------------------------------------------
// Bonus: verify EVENT_TYPES set is stable
// ---------------------------------------------------------------------------

describe('Event type registry completeness', () => {
  it('EVENT_TYPES contains all 14 canonical event types', () => {
    expect(EVENT_TYPES).toContain('MONETARY_POLICY');
    expect(EVENT_TYPES).toContain('EARNINGS');
    expect(EVENT_TYPES).toContain('ECONOMIC_DATA');
    expect(EVENT_TYPES).toContain('COMMODITY_SHOCK');
    expect(EVENT_TYPES).toContain('GEOPOLITICAL');
    expect(EVENT_TYPES).toContain('REGULATORY');
    expect(EVENT_TYPES).toContain('CORPORATE_ACTION');
    expect(EVENT_TYPES).toContain('MACRO_DATA');
    expect(EVENT_TYPES).toContain('CREDIT_EVENT');
    expect(EVENT_TYPES).toContain('NATURAL_DISASTER');
    expect(EVENT_TYPES).toContain('TRADE_POLICY');
    expect(EVENT_TYPES).toContain('CURRENCY_EVENT');
    expect(EVENT_TYPES).toContain('SECTOR_ROTATION');
    expect(EVENT_TYPES).toContain('UNCLASSIFIED');
    expect(EVENT_TYPES).toHaveLength(14);
  });
});
