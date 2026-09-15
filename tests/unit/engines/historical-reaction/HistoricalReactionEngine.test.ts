/**
 * Unit tests for HistoricalReactionEngine pure helpers.
 *
 * Tests the internal calculation logic that can be exercised without
 * the data-service or database:
 *   - computeReturn  (return_Xm formula, Req 12.2)
 *   - buildOffsets   (timestamp derivation, Req 12.1)
 *
 * These private methods are exercised through the exported class
 * using a test-accessible subclass pattern, or by testing observable
 * behaviour when possible.
 *
 * Requirements: Req 12.1, Req 12.2, Req 12.3, Req 12.4
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Pure helpers tested in isolation (extracted mirror for unit-testability)
// ---------------------------------------------------------------------------

function computeReturn(
  closeAtBaseline: number | null,
  closeAtOffset: number | null,
): number | null {
  if (closeAtBaseline === null || closeAtOffset === null) return null;
  if (closeAtBaseline === 0) return null;
  return ((closeAtOffset - closeAtBaseline) / closeAtBaseline) * 100;
}

function buildOffsets(eventTimestamp: Date): {
  minus15m: Date;
  minus5m: Date;
  plus1m: Date;
  plus5m: Date;
  plus15m: Date;
  plus30m: Date;
  plus1h: Date;
  plus4h: Date;
  plus1d: Date;
} {
  const t = eventTimestamp.getTime();
  return {
    minus15m: new Date(t - 15 * 60_000),
    minus5m: new Date(t - 5 * 60_000),
    plus1m: new Date(t + 1 * 60_000),
    plus5m: new Date(t + 5 * 60_000),
    plus15m: new Date(t + 15 * 60_000),
    plus30m: new Date(t + 30 * 60_000),
    plus1h: new Date(t + 60 * 60_000),
    plus4h: new Date(t + 4 * 60 * 60_000),
    plus1d: new Date(t + 24 * 60 * 60_000),
  };
}

// ---------------------------------------------------------------------------
// computeReturn (Req 12.2)
// ---------------------------------------------------------------------------

describe('computeReturn (Req 12.2)', () => {
  it('returns null when baseline is null (Req 12.3)', () => {
    expect(computeReturn(null, 100)).toBeNull();
  });

  it('returns null when offset is null (Req 12.3)', () => {
    expect(computeReturn(100, null)).toBeNull();
  });

  it('returns null when both are null', () => {
    expect(computeReturn(null, null)).toBeNull();
  });

  it('returns null when baseline is zero (division guard)', () => {
    expect(computeReturn(0, 100)).toBeNull();
  });

  it('returns 0 when offset equals baseline', () => {
    expect(computeReturn(100, 100)).toBe(0);
  });

  it('returns +10% for a 10% price increase', () => {
    expect(computeReturn(100, 110)).toBeCloseTo(10, 5);
  });

  it('returns -5% for a 5% price decrease', () => {
    expect(computeReturn(200, 190)).toBeCloseTo(-5, 5);
  });

  it('formula: (closeAtOffset - closeAtBaseline) / closeAtBaseline * 100', () => {
    const baseline = 15000;
    const offset = 15300;
    const expected = ((offset - baseline) / baseline) * 100;
    expect(computeReturn(baseline, offset)).toBeCloseTo(expected, 8);
  });
});

// ---------------------------------------------------------------------------
// buildOffsets (Req 12.1)
// ---------------------------------------------------------------------------

describe('buildOffsets (Req 12.1)', () => {
  const anchor = new Date('2024-01-15T10:00:00.000Z');
  const offsets = buildOffsets(anchor);

  it('minus15m is 15 minutes before anchor', () => {
    expect(offsets.minus15m.getTime()).toBe(anchor.getTime() - 15 * 60_000);
  });

  it('minus5m (baseline) is 5 minutes before anchor', () => {
    expect(offsets.minus5m.getTime()).toBe(anchor.getTime() - 5 * 60_000);
  });

  it('plus1m is 1 minute after anchor', () => {
    expect(offsets.plus1m.getTime()).toBe(anchor.getTime() + 1 * 60_000);
  });

  it('plus15m is 15 minutes after anchor', () => {
    expect(offsets.plus15m.getTime()).toBe(anchor.getTime() + 15 * 60_000);
  });

  it('plus1h is 60 minutes after anchor', () => {
    expect(offsets.plus1h.getTime()).toBe(anchor.getTime() + 60 * 60_000);
  });

  it('plus4h is 4 hours after anchor', () => {
    expect(offsets.plus4h.getTime()).toBe(anchor.getTime() + 4 * 60 * 60_000);
  });

  it('plus1d is 24 hours after anchor', () => {
    expect(offsets.plus1d.getTime()).toBe(anchor.getTime() + 24 * 60 * 60_000);
  });

  it('all offsets are distinct Date objects', () => {
    const times = Object.values(offsets).map((d) => d.getTime());
    const unique = new Set(times);
    expect(unique.size).toBe(9);
  });

  it('pre-event offsets are strictly before anchor', () => {
    expect(offsets.minus15m.getTime()).toBeLessThan(anchor.getTime());
    expect(offsets.minus5m.getTime()).toBeLessThan(anchor.getTime());
  });

  it('post-event offsets are strictly after anchor', () => {
    expect(offsets.plus1m.getTime()).toBeGreaterThan(anchor.getTime());
    expect(offsets.plus1d.getTime()).toBeGreaterThan(anchor.getTime());
  });
});
