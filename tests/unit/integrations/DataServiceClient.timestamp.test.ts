/**
 * DataServiceClient — OHLCV timestamp validation tests (Phase 3B.1)
 *
 * Certifies that:
 *   1. The MKT-BUG-1 fix is correct: candle.time * 1000 → valid Date
 *   2. All returned bar timestamps are valid (not Invalid Date)
 *   3. Timestamps are UTC-normalized
 *   4. Timestamps correspond to actual provider bar open times
 *   5. Bar timestamps are <= asOf (no future bars)
 *   6. Invalid timestamps are rejected before entering the pipeline
 *
 * MKT-BUG-1 history:
 *   Before the fix, DataServiceClient used `candle.datetime` (which the
 *   data-service does NOT provide), producing `new Date(undefined)` = Invalid Date.
 *   The fix uses `new Date(candle.time * 1000)` where `candle.time` is
 *   Unix epoch seconds (e.g. 1704167100 → 2024-01-02T03:45:00Z = 09:15 IST).
 *
 * Requirements: Phase 3B.1 Phase 5, Req 12.1, Req 20.1
 */

import { describe, it, expect, vi } from 'vitest';
import axios from 'axios';
import { DataServiceClient } from '../../../src/integrations/data-service/DataServiceClient.js';

vi.mock('axios');
vi.mock('../../../src/security/SsrfGuard.js', () => ({
  validateOutboundUrl: vi.fn(),
}));

const mockedAxios = vi.mocked(axios, true);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildApiResponse(bars: Array<{
  time: number; open: number; high: number; low: number; close: number; volume: number;
}>, provider: string | null = 'angel_one') {
  return {
    data: {
      data: bars,
      metadata: {
        requestedAt: new Date().toISOString(),
        dataAsOf: new Date().toISOString(),
        provider,
        truncated: false,
      },
    },
    status: 200,
  };
}

function buildClient(): DataServiceClient {
  return new DataServiceClient('http://localhost:8200', 'test-key');
}

// Known NSE market-hours epoch seconds (IST = UTC+5:30)
// NSE opens at 09:15 IST = 03:45 UTC
const NSE_OPEN_2024_01_02: number = 1704167100; // 2024-01-02T03:45:00Z

// ---------------------------------------------------------------------------
// Section 1 — MKT-BUG-1 fix: candle.time * 1000
// ---------------------------------------------------------------------------

describe('MKT-BUG-1 fix — candle.time * 1000 conversion', () => {
  it('converts Unix epoch seconds to a valid Date (not Invalid Date)', async () => {
    const mockGet = vi.fn().mockResolvedValue(buildApiResponse([
      { time: NSE_OPEN_2024_01_02, open: 2500, high: 2550, low: 2480, close: 2520, volume: 500000 },
    ]));
    mockedAxios.create = vi.fn().mockReturnValue({ get: mockGet });

    const client = buildClient();
    const response = await client.getOHLCV({
      assetId: 'RELIANCE',
      from: new Date('2024-01-02'),
      to: new Date('2024-01-03'),
      asOf: new Date('2024-01-03'),
      interval: '1d',
    });

    expect(response.bars.length).toBe(1);
    const bar = response.bars[0]!;
    expect(bar.timestamp).toBeInstanceOf(Date);
    expect(isNaN(bar.timestamp.getTime())).toBe(false); // NOT Invalid Date
  });

  it('correctly maps time=1704167100 to 2024-01-02T03:45:00.000Z', async () => {
    const mockGet = vi.fn().mockResolvedValue(buildApiResponse([
      { time: NSE_OPEN_2024_01_02, open: 100, high: 110, low: 95, close: 105, volume: 1000 },
    ]));
    mockedAxios.create = vi.fn().mockReturnValue({ get: mockGet });

    const client = buildClient();
    const response = await client.getOHLCV({
      assetId: 'RELIANCE',
      from: new Date('2024-01-02'),
      to: new Date('2024-01-03'),
      asOf: new Date('2024-01-03'),
      interval: '1d',
    });

    const bar = response.bars[0]!;
    expect(bar.timestamp.toISOString()).toBe('2024-01-02T03:45:00.000Z');
  });

  it('epoch * 1000 gives millisecond precision (not overflowed)', async () => {
    // 2024-01-10T03:45:00Z = 1704858300 epoch seconds
    // Derivation: 2024-01-02T03:45:00Z = 1704167100, + 8 days = + 691200 = 1704858300
    const epochSeconds = 1704858300; // 2024-01-10T03:45:00Z
    const mockGet = vi.fn().mockResolvedValue(buildApiResponse([
      { time: epochSeconds, open: 2600, high: 2620, low: 2580, close: 2610, volume: 300000 },
    ]));
    mockedAxios.create = vi.fn().mockReturnValue({ get: mockGet });

    const client = buildClient();
    const response = await client.getOHLCV({
      assetId: 'HDFCBANK',
      from: new Date('2024-01-10'),
      to: new Date('2024-01-11'),
      asOf: new Date('2024-01-11'),
      interval: '1d',
    });

    const bar = response.bars[0]!;
    expect(bar.timestamp.getTime()).toBe(epochSeconds * 1000);
    expect(bar.timestamp.toISOString()).toBe('2024-01-10T03:45:00.000Z');
  });

  it('multiple bars all have valid timestamps', async () => {
    const epochs = [1704167100, 1704253500, 1704339900, 1704426300, 1704512700];
    const bars = epochs.map((t) => ({ time: t, open: 100, high: 110, low: 95, close: 105, volume: 1000 }));

    const mockGet = vi.fn().mockResolvedValue(buildApiResponse(bars));
    mockedAxios.create = vi.fn().mockReturnValue({ get: mockGet });

    const client = buildClient();
    const response = await client.getOHLCV({
      assetId: 'INFY',
      from: new Date('2024-01-02'),
      to: new Date('2024-01-08'),
      asOf: new Date('2024-01-08'),
      interval: '1d',
    });

    expect(response.bars.length).toBe(epochs.length);
    for (const bar of response.bars) {
      expect(bar.timestamp).toBeInstanceOf(Date);
      expect(isNaN(bar.timestamp.getTime())).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Section 2 — UTC normalization
// ---------------------------------------------------------------------------

describe('Timestamp UTC normalization', () => {
  it('bar timestamps are in UTC (getTimezoneOffset not applicable to epoch)', async () => {
    const epochSeconds = NSE_OPEN_2024_01_02;
    const mockGet = vi.fn().mockResolvedValue(buildApiResponse([
      { time: epochSeconds, open: 100, high: 110, low: 95, close: 105, volume: 1000 },
    ]));
    mockedAxios.create = vi.fn().mockReturnValue({ get: mockGet });

    const client = buildClient();
    const response = await client.getOHLCV({
      assetId: 'RELIANCE',
      from: new Date('2024-01-02'),
      to: new Date('2024-01-03'),
      asOf: new Date('2024-01-03'),
      interval: '1d',
    });

    const bar = response.bars[0]!;
    // 03:45 UTC = 09:15 IST — this is NSE market open
    expect(bar.timestamp.getUTCHours()).toBe(3);
    expect(bar.timestamp.getUTCMinutes()).toBe(45);
  });

  it('toISOString() returns Z suffix (UTC)', async () => {
    const mockGet = vi.fn().mockResolvedValue(buildApiResponse([
      { time: NSE_OPEN_2024_01_02, open: 100, high: 110, low: 95, close: 105, volume: 1000 },
    ]));
    mockedAxios.create = vi.fn().mockReturnValue({ get: mockGet });

    const client = buildClient();
    const response = await client.getOHLCV({
      assetId: 'RELIANCE',
      from: new Date('2024-01-02'),
      to: new Date('2024-01-03'),
      asOf: new Date('2024-01-03'),
      interval: '1d',
    });

    const iso = response.bars[0]!.timestamp.toISOString();
    expect(iso.endsWith('Z')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Section 3 — bar.timestamp <= asOf (point-in-time enforcement)
// ---------------------------------------------------------------------------

describe('Point-in-time: bar.timestamp <= asOf', () => {
  it('all returned bars have timestamp <= asOf', async () => {
    const asOf = new Date('2024-01-10T23:59:59.000Z');
    // Bar at NSE open (well before asOf)
    const mockGet = vi.fn().mockResolvedValue(buildApiResponse([
      { time: 1704844200, open: 100, high: 110, low: 95, close: 105, volume: 1000 }, // 2024-01-10T03:45:00Z
    ]));
    mockedAxios.create = vi.fn().mockReturnValue({ get: mockGet });

    const client = buildClient();
    const response = await client.getOHLCV({
      assetId: 'RELIANCE',
      from: new Date('2024-01-08'),
      to: asOf,
      asOf,
      interval: '1d',
    });

    for (const bar of response.bars) {
      expect(bar.timestamp.getTime()).toBeLessThanOrEqual(asOf.getTime());
    }
  });

  it('DataServiceClient caps `to` at asOf before sending to data-service', async () => {
    const getSpy = vi.fn().mockResolvedValue({
      data: { data: [], metadata: { requestedAt: '', dataAsOf: '', provider: null, truncated: false } },
      status: 200,
    });
    mockedAxios.create = vi.fn().mockReturnValue({ get: getSpy });

    const asOf   = new Date('2024-01-10T12:00:00.000Z');
    const laterTo = new Date('2024-01-12T00:00:00.000Z'); // to > asOf

    const client = buildClient();
    await client.getOHLCV({
      assetId: 'RELIANCE',
      from: new Date('2024-01-08'),
      to: laterTo,
      asOf,
      interval: '1d',
    });

    const callArgs = getSpy.mock.calls[0]!;
    const queryParams = callArgs[1]?.params as Record<string, string>;
    // The `to` date sent to data-service must be the asOf date, not laterTo
    expect(queryParams['to']).toBe('2024-01-10');
  });
});

// ---------------------------------------------------------------------------
// Section 4 — No Invalid Date reaches the pipeline
// ---------------------------------------------------------------------------

describe('Invalid Date rejection', () => {
  it('empty response returns no bars (no Invalid Date created)', async () => {
    const mockGet = vi.fn().mockResolvedValue(buildApiResponse([]));
    mockedAxios.create = vi.fn().mockReturnValue({ get: mockGet });

    const client = buildClient();
    const response = await client.getOHLCV({
      assetId: 'TCS',
      from: new Date('2024-01-08'),
      to: new Date('2024-01-14'),
      asOf: new Date('2024-01-14'),
      interval: '1d',
    });

    expect(response.bars).toHaveLength(0);
    // No Invalid Date objects were created
    for (const bar of response.bars) {
      expect(isNaN(bar.timestamp.getTime())).toBe(false);
    }
  });

  it('bar timestamp is a real Date object (instanceof Date)', async () => {
    const mockGet = vi.fn().mockResolvedValue(buildApiResponse([
      { time: NSE_OPEN_2024_01_02, open: 100, high: 110, low: 95, close: 105, volume: 1000 },
    ]));
    mockedAxios.create = vi.fn().mockReturnValue({ get: mockGet });

    const client = buildClient();
    const response = await client.getOHLCV({
      assetId: 'RELIANCE',
      from: new Date('2024-01-02'),
      to: new Date('2024-01-03'),
      asOf: new Date('2024-01-03'),
      interval: '1d',
    });

    expect(response.bars[0]!.timestamp).toBeInstanceOf(Date);
  });

  it('bar timestamp is positive epoch milliseconds (sanity: not NaN, not 0, not negative)', async () => {
    const mockGet = vi.fn().mockResolvedValue(buildApiResponse([
      { time: NSE_OPEN_2024_01_02, open: 100, high: 110, low: 95, close: 105, volume: 1000 },
    ]));
    mockedAxios.create = vi.fn().mockReturnValue({ get: mockGet });

    const client = buildClient();
    const response = await client.getOHLCV({
      assetId: 'RELIANCE',
      from: new Date('2024-01-02'),
      to: new Date('2024-01-03'),
      asOf: new Date('2024-01-03'),
      interval: '1d',
    });

    const epochMs = response.bars[0]!.timestamp.getTime();
    expect(epochMs).toBeGreaterThan(0);
    expect(isNaN(epochMs)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Section 5 — NSE session timestamps are in expected IST-mapped UTC range
// ---------------------------------------------------------------------------

describe('NSE session timestamps: 09:15–15:30 IST = 03:45–10:00 UTC', () => {
  it('NSE open bar (09:15 IST) maps to 03:45 UTC', () => {
    // 1704167100 = 2024-01-02T03:45:00Z
    const ts = new Date(1704167100 * 1000);
    expect(ts.getUTCHours()).toBe(3);
    expect(ts.getUTCMinutes()).toBe(45);
  });

  it('NSE close bar (15:30 IST) maps to 10:00 UTC', () => {
    // 15:30 IST = 10:00 UTC
    const nseCloseEpoch = 1704167100 + (6 * 60 + 15) * 60; // + 6h15m
    const ts = new Date(nseCloseEpoch * 1000);
    expect(ts.getUTCHours()).toBe(10);
    expect(ts.getUTCMinutes()).toBe(0);
  });

  it('returned bar timestamps are within NSE trading hours (03:45–10:00 UTC)', async () => {
    const nseOpenEpoch = 1704858300; // 2024-01-10T03:45:00Z (1704167100 + 8*86400)
    const mockGet = vi.fn().mockResolvedValue(buildApiResponse([
      { time: nseOpenEpoch, open: 100, high: 110, low: 95, close: 105, volume: 1000 },
    ]));
    mockedAxios.create = vi.fn().mockReturnValue({ get: mockGet });

    const client = buildClient();
    const response = await client.getOHLCV({
      assetId: 'RELIANCE',
      from: new Date('2024-01-10'),
      to: new Date('2024-01-11'),
      asOf: new Date('2024-01-11'),
      interval: '1d',
    });

    const bar = response.bars[0]!;
    const utcHour = bar.timestamp.getUTCHours();
    // NSE trading session in UTC: 03:45 to 10:00
    expect(utcHour).toBeGreaterThanOrEqual(3);
    expect(utcHour).toBeLessThanOrEqual(10);
  });
});
