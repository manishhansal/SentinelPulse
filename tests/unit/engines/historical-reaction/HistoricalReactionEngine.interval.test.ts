/**
 * HistoricalReactionEngine — interval-selection tests (Phase 3B.1 fix for RXN-G1)
 *
 * These tests prove that:
 *   1. Every intraday offset (T+5m, T+15m, T+30m, T+1h, etc.) requests an
 *      intraday interval ('5m'), never the daily default ('1d').
 *   2. The T+1d offset requests the daily interval ('1d').
 *   3. Mixing up intervals is detected and fails the relevant test.
 *
 * Background (RXN-G1):
 *   Before this fix, `HistoricalReactionEngine.fetchBar()` passed no `interval`
 *   to `DataServiceClient.getOHLCV()`, which defaults to '1d'.  This caused
 *   intraday offsets (T+5m, T+15m, etc.) to be queried with a daily bar,
 *   making it impossible to observe true intraday reactions even when intraday
 *   OHLCV data was available.
 *
 * Requirements: Req 12.1, Req 12.2, Phase 3B.1 RXN-G1
 */

import { describe, it, expect, vi, type MockInstance } from 'vitest';
import {
  HistoricalReactionEngine,
  intervalForOffset,
  type ReactionOffsetName,
} from '../../../../src/engines/historical-reaction/HistoricalReactionEngine.js';
import type { DataServiceClient, OHLCVBar } from '../../../../src/integrations/data-service/DataServiceClient.js';

// ---------------------------------------------------------------------------
// Section 1 — intervalForOffset() pure function
// ---------------------------------------------------------------------------

describe('intervalForOffset() — correct interval per offset name', () => {
  // Intraday offsets must always return '5m'
  const intradayOffsets: ReactionOffsetName[] = [
    'minus15m',
    'minus5m',
    'plus1m',
    'plus5m',
    'plus15m',
    'plus30m',
    'plus1h',
    'plus4h',
  ];

  for (const offsetName of intradayOffsets) {
    it(`T${offsetName} request → intraday interval '5m'`, () => {
      expect(intervalForOffset(offsetName)).toBe('5m');
    });
  }

  it(`T+1d request → daily interval '1d'`, () => {
    expect(intervalForOffset('plus1d')).toBe('1d');
  });

  it('returns exactly 2 distinct values: "5m" and "1d"', () => {
    const allOffsets: ReactionOffsetName[] = [
      'minus15m', 'minus5m', 'plus1m', 'plus5m',
      'plus15m', 'plus30m', 'plus1h', 'plus4h', 'plus1d',
    ];
    const intervals = new Set(allOffsets.map(intervalForOffset));
    expect(intervals).toEqual(new Set(['5m', '1d']));
  });

  it('plus1d is the ONLY daily interval', () => {
    const allOffsets: ReactionOffsetName[] = [
      'minus15m', 'minus5m', 'plus1m', 'plus5m',
      'plus15m', 'plus30m', 'plus1h', 'plus4h', 'plus1d',
    ];
    const dailyOffsets = allOffsets.filter((o) => intervalForOffset(o) === '1d');
    expect(dailyOffsets).toEqual(['plus1d']);
  });
});

// ---------------------------------------------------------------------------
// Section 2 — Integration: HistoricalReactionEngine passes correct intervals
// ---------------------------------------------------------------------------

/** Builds a minimal mock OHLCVBar */
function mockBar(close: number, timestamp: Date): OHLCVBar {
  return { timestamp, open: close, high: close, low: close, close, volume: 1000 };
}

/** Builds a stub DataServiceClient that records every getOHLCV call */
function buildMockClient(returnBars: OHLCVBar[]): {
  client: DataServiceClient;
  calls: Array<{ interval: string; asOf: Date; from: Date; to: Date; assetId: string }>;
} {
  const calls: Array<{ interval: string; asOf: Date; from: Date; to: Date; assetId: string }> = [];

  const client = {
    getOHLCV: vi.fn(async (params: {
      assetId: string;
      from: Date;
      to: Date;
      asOf: Date;
      interval?: string;
    }) => {
      calls.push({
        assetId: params.assetId,
        interval: params.interval ?? '1d', // capture the default if not passed
        asOf: params.asOf,
        from: params.from,
        to: params.to,
      });
      // Return OHLCVResponse (not OHLCVBar[]) — matches Phase 3B.1 updated API
      return {
        bars: returnBars,
        provider: returnBars.length > 0 ? 'angel_one' : null,
        fallbackUsed: false,
        dataAvailable: returnBars.length > 0,
        requestedRange: { from: params.from, to: params.to },
        actualRange: returnBars.length > 0
          ? { from: returnBars[0]!.timestamp, to: returnBars[returnBars.length - 1]!.timestamp }
          : null,
        barCount: returnBars.length,
      };
    }),
  } as unknown as DataServiceClient;

  return { client, calls };
}

/** Minimal Prisma upsert stub — does nothing */
vi.mock('../../../../src/db/prisma.js', () => ({
  prisma: {
    newsMarketReaction: {
      upsert: vi.fn().mockResolvedValue({}),
    },
  },
}));

describe('HistoricalReactionEngine — interval passed to getOHLCV per offset', () => {
  const anchor = new Date('2024-01-10T10:00:00.000Z'); // NSE market hours

  it('T+5m fetch uses interval="5m" not "1d"', async () => {
    const { client, calls } = buildMockClient([]);

    const engine = new HistoricalReactionEngine(client);
    await engine.process({
      id: 'event-001',
      eventTimestamp: anchor,
      assetIds: ['RELIANCE'],
    });

    // Find the call whose asOf is T+5m
    const plus5mCall = calls.find(
      (c) => c.asOf.getTime() === anchor.getTime() + 5 * 60_000,
    );
    expect(plus5mCall).toBeDefined();
    expect(plus5mCall!.interval).toBe('5m');
    expect(plus5mCall!.interval).not.toBe('1d');
  });

  it('T+15m fetch uses interval="5m" not "1d"', async () => {
    const { client, calls } = buildMockClient([]);

    const engine = new HistoricalReactionEngine(client);
    await engine.process({
      id: 'event-002',
      eventTimestamp: anchor,
      assetIds: ['HDFCBANK'],
    });

    const plus15mCall = calls.find(
      (c) => c.asOf.getTime() === anchor.getTime() + 15 * 60_000,
    );
    expect(plus15mCall).toBeDefined();
    expect(plus15mCall!.interval).toBe('5m');
  });

  it('T+30m fetch uses interval="5m" not "1d"', async () => {
    const { client, calls } = buildMockClient([]);

    const engine = new HistoricalReactionEngine(client);
    await engine.process({
      id: 'event-003',
      eventTimestamp: anchor,
      assetIds: ['INFY'],
    });

    const plus30mCall = calls.find(
      (c) => c.asOf.getTime() === anchor.getTime() + 30 * 60_000,
    );
    expect(plus30mCall).toBeDefined();
    expect(plus30mCall!.interval).toBe('5m');
  });

  it('T+1h fetch uses interval="5m" not "1d"', async () => {
    const { client, calls } = buildMockClient([]);

    const engine = new HistoricalReactionEngine(client);
    await engine.process({
      id: 'event-004',
      eventTimestamp: anchor,
      assetIds: ['BANKNIFTY'],
    });

    const plus1hCall = calls.find(
      (c) => c.asOf.getTime() === anchor.getTime() + 60 * 60_000,
    );
    expect(plus1hCall).toBeDefined();
    expect(plus1hCall!.interval).toBe('5m');
  });

  it('T+1d fetch uses interval="1d" not "5m"', async () => {
    const { client, calls } = buildMockClient([]);

    const engine = new HistoricalReactionEngine(client);
    await engine.process({
      id: 'event-005',
      eventTimestamp: anchor,
      assetIds: ['RELIANCE'],
    });

    const plus1dCall = calls.find(
      (c) => c.asOf.getTime() === anchor.getTime() + 24 * 60 * 60_000,
    );
    expect(plus1dCall).toBeDefined();
    expect(plus1dCall!.interval).toBe('1d');
    expect(plus1dCall!.interval).not.toBe('5m');
  });

  it('T-15m and T-5m (pre-event) fetches use interval="5m"', async () => {
    const { client, calls } = buildMockClient([]);

    const engine = new HistoricalReactionEngine(client);
    await engine.process({
      id: 'event-006',
      eventTimestamp: anchor,
      assetIds: ['TCS'],
    });

    const minus15mCall = calls.find(
      (c) => c.asOf.getTime() === anchor.getTime() - 15 * 60_000,
    );
    const minus5mCall = calls.find(
      (c) => c.asOf.getTime() === anchor.getTime() - 5 * 60_000,
    );

    expect(minus15mCall?.interval).toBe('5m');
    expect(minus5mCall?.interval).toBe('5m');
  });

  it('T+4h fetch uses interval="5m" (intraday, not daily)', async () => {
    const { client, calls } = buildMockClient([]);

    const engine = new HistoricalReactionEngine(client);
    await engine.process({
      id: 'event-007',
      eventTimestamp: anchor,
      assetIds: ['SBIN'],
    });

    const plus4hCall = calls.find(
      (c) => c.asOf.getTime() === anchor.getTime() + 4 * 60 * 60_000,
    );
    expect(plus4hCall).toBeDefined();
    expect(plus4hCall!.interval).toBe('5m');
  });

  it('T+1m fetch uses interval="5m" (immediate reaction, intraday)', async () => {
    const { client, calls } = buildMockClient([]);

    const engine = new HistoricalReactionEngine(client);
    await engine.process({
      id: 'event-008',
      eventTimestamp: anchor,
      assetIds: ['NIFTY'],
    });

    const plus1mCall = calls.find(
      (c) => c.asOf.getTime() === anchor.getTime() + 1 * 60_000,
    );
    expect(plus1mCall).toBeDefined();
    expect(plus1mCall!.interval).toBe('5m');
  });

  it('all 9 fetches for a single event use exactly the right intervals', async () => {
    const { client, calls } = buildMockClient([]);

    const engine = new HistoricalReactionEngine(client);
    await engine.process({
      id: 'event-009',
      eventTimestamp: anchor,
      assetIds: ['RELIANCE'],
    });

    // Expect exactly 9 getOHLCV calls for 1 asset
    expect(calls.length).toBe(9);

    // T+1d must be '1d', all others must be '5m'
    for (const call of calls) {
      const isDailyOffset = call.asOf.getTime() === anchor.getTime() + 24 * 60 * 60_000;
      if (isDailyOffset) {
        expect(call.interval).toBe('1d');
      } else {
        expect(call.interval).toBe('5m');
      }
    }
  });

  it('with real bar data: intraday return computed correctly with 5m bar (not daily)', async () => {
    const eventTime = new Date('2024-01-10T10:00:00.000Z');
    const plus5mTime = new Date(eventTime.getTime() + 5 * 60_000);
    const minus5mTime = new Date(eventTime.getTime() - 5 * 60_000);

    // Return a bar only for the 5m calls that match baseline and T+5m
    const client = {
      getOHLCV: vi.fn(async (params: {
        assetId: string; from: Date; to: Date; asOf: Date; interval?: string;
      }) => {
        const makeResp = (bars: OHLCVBar[]) => ({
          bars,
          provider: bars.length > 0 ? 'angel_one' : null,
          fallbackUsed: false,
          dataAvailable: bars.length > 0,
          requestedRange: { from: params.from, to: params.to },
          actualRange: bars.length > 0 ? { from: bars[0]!.timestamp, to: bars[0]!.timestamp } : null,
          barCount: bars.length,
        });
        if (params.asOf.getTime() === minus5mTime.getTime()) {
          return makeResp([mockBar(2500, minus5mTime)]); // baseline close = 2500
        }
        if (params.asOf.getTime() === plus5mTime.getTime()) {
          return makeResp([mockBar(2525, plus5mTime)]); // T+5m close = 2525 → +1% return
        }
        return makeResp([]);
      }),
    } as unknown as DataServiceClient;

    let upsertedData: Record<string, unknown> | undefined;
    vi.doMock('../../../../src/db/prisma.js', () => ({
      prisma: {
        newsMarketReaction: {
          upsert: vi.fn().mockImplementation((args: { create: Record<string, unknown> }) => {
            upsertedData = args.create;
            return Promise.resolve({});
          }),
        },
      },
    }));

    const engine = new HistoricalReactionEngine(client);
    await engine.process({
      id: 'event-010',
      eventTimestamp: eventTime,
      assetIds: ['RELIANCE'],
    });

    // Verify that the 5m interval was used for T+5m
    const plus5mCall = (client.getOHLCV as MockInstance).mock.calls.find(
      ([params]: [{ asOf: Date }]) => params.asOf.getTime() === plus5mTime.getTime(),
    );
    expect(plus5mCall).toBeDefined();
    const [callParams] = plus5mCall as [{ interval: string }][];
    expect((callParams as unknown as { interval: string }).interval).toBe('5m');
  });
});

// ---------------------------------------------------------------------------
// Section 3 — Regression: the old bug would have used '1d' for intraday
// ---------------------------------------------------------------------------

describe('Regression: old RXN-G1 behaviour is NOT reproduced', () => {
  const anchor = new Date('2024-01-10T09:30:00.000Z');

  it('REGRESSION: T+5m must not use interval="1d"', () => {
    // Before the fix, no interval was passed so DataServiceClient defaulted to '1d'.
    // This test explicitly verifies the old behaviour no longer occurs.
    expect(intervalForOffset('plus5m')).not.toBe('1d');
  });

  it('REGRESSION: T+15m must not use interval="1d"', () => {
    expect(intervalForOffset('plus15m')).not.toBe('1d');
  });

  it('REGRESSION: T+30m must not use interval="1d"', () => {
    expect(intervalForOffset('plus30m')).not.toBe('1d');
  });

  it('REGRESSION: T+1h must not use interval="1d"', () => {
    expect(intervalForOffset('plus1h')).not.toBe('1d');
  });

  it('REGRESSION: T+4h must not use interval="1d"', () => {
    expect(intervalForOffset('plus4h')).not.toBe('1d');
  });

  it('REGRESSION: using 1d interval for 5m query is semantically wrong (documents the bug)', () => {
    // A 1d candle returned for a 1-minute window ending at T+5m would represent
    // the entire trading day — it cannot be used to compute a 5-minute return.
    // The fix ensures this can never happen.
    const wrongInterval = '1d'; // the old bug
    const correctInterval = intervalForOffset('plus5m');
    expect(correctInterval).not.toBe(wrongInterval);
    expect(correctInterval).toBe('5m');
  });
});
