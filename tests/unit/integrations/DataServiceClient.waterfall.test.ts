/**
 * DataServiceClient — provider waterfall certification tests (Phase 3B.1)
 *
 * These tests certify the provider waterfall:
 *   Angel One  →  Upstox  →  Yahoo Finance
 *
 * Four scenarios are tested (Tests A–D from the Phase 3B.1 spec):
 *
 *   Test A: Angel One available             → provider = 'angel_one'
 *   Test B: Angel One forced-off            → provider = 'upstox' or 'yahoo_finance'
 *   Test C: Angel One + Upstox forced-off   → provider = 'yahoo_finance'
 *   Test D: All providers forced-off        → data_available = false, provider = null
 *
 * Implementation note on provider injection:
 *   The data-service does NOT expose a kill-switch or circuit-breaker endpoint.
 *   To avoid modifying production behavior, we use the `providerOverride`
 *   constructor option on DataServiceClient, which appends `force_provider=<X>`
 *   to the query string.  The data-service respects this parameter in test
 *   environments.  This is the DI mechanism specified in Phase 3B.1.
 *
 * For unit testing (no live data-service), we mock the HTTP layer so each
 * test can simulate any provider response without requiring a live endpoint.
 * The live integration versions of these tests are in:
 *   tests/integration/DataServiceClient.waterfall.integration.test.ts
 *
 * Requirements: Phase 3B.1 Phase 3 — Provider Waterfall Certification
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { DataServiceClient, type OHLCVResponse } from '../../../src/integrations/data-service/DataServiceClient.js';

// ---------------------------------------------------------------------------
// Mock axios so tests don't require a live data-service
// ---------------------------------------------------------------------------

vi.mock('axios');

const mockedAxios = vi.mocked(axios, true);

/** Builds a mock axios instance that returns the provided response */
function buildMockHttp(responseData: {
  data: {
    data: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>;
    metadata: { requestedAt: string; dataAsOf: string; provider: string | null; truncated: boolean };
  };
}) {
  const getMock = vi.fn().mockResolvedValue({ data: responseData.data, status: 200 });
  return { get: getMock };
}

/** Mock SSRF guard — always passes in test environment */
vi.mock('../../../src/security/SsrfGuard.js', () => ({
  validateOutboundUrl: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const TEST_INSTRUMENTS = ['RELIANCE', 'HDFCBANK', 'INFY', 'BANKNIFTY', 'TCS', 'ICICIBANK', 'SBIN', 'NIFTY'] as const;

const SAMPLE_DAILY_BAR = { time: 1704844200, open: 2500, high: 2550, low: 2480, close: 2520, volume: 500000 };
// 2024-01-10T03:45:00Z → 09:15 IST (NSE open)

const from = new Date('2024-01-08T00:00:00.000Z');
const to   = new Date('2024-01-14T23:59:59.000Z');
const asOf = new Date('2024-01-14T23:59:59.000Z');

// ---------------------------------------------------------------------------
// Helper: build OHLCVResponse metadata
// ---------------------------------------------------------------------------

function buildMetadata(provider: string | null, truncated = false) {
  return {
    requestedAt: new Date().toISOString(),
    dataAsOf: asOf.toISOString(),
    provider,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Test A — Angel One available → provider = 'angel_one'
// ---------------------------------------------------------------------------

describe('Test A — Angel One available', () => {
  it('RELIANCE: provider should be angel_one when Angel One is available', async () => {
    const mockHttp = buildMockHttp({
      data: {
        data: [SAMPLE_DAILY_BAR],
        metadata: buildMetadata('angel_one'),
      },
    });

    mockedAxios.create = vi.fn().mockReturnValue(mockHttp);

    const client = new DataServiceClient('http://localhost:8200', 'test-key');
    const response: OHLCVResponse = await client.getOHLCV({
      assetId: 'RELIANCE',
      from,
      to,
      asOf,
      interval: '1d',
    });

    expect(response.provider).toBe('angel_one');
    expect(response.dataAvailable).toBe(true);
    expect(response.barCount).toBeGreaterThan(0);
    expect(response.fallbackUsed).toBe(false);
  });

  it('when Angel One serves, fallbackUsed is false', async () => {
    const mockHttp = buildMockHttp({
      data: {
        data: [SAMPLE_DAILY_BAR],
        metadata: buildMetadata('angel_one'),
      },
    });

    mockedAxios.create = vi.fn().mockReturnValue(mockHttp);

    const client = new DataServiceClient('http://localhost:8200', 'test-key');
    const response = await client.getOHLCV({
      assetId: 'HDFCBANK', from, to, asOf, interval: '1d',
    });

    expect(response.fallbackUsed).toBe(false);
    expect(response.provider).toBe('angel_one');
  });

  it('bars are returned with valid timestamps when Angel One serves', async () => {
    const mockHttp = buildMockHttp({
      data: {
        data: [SAMPLE_DAILY_BAR],
        metadata: buildMetadata('angel_one'),
      },
    });

    mockedAxios.create = vi.fn().mockReturnValue(mockHttp);

    const client = new DataServiceClient('http://localhost:8200', 'test-key');
    const response = await client.getOHLCV({
      assetId: 'RELIANCE', from, to, asOf, interval: '1d',
    });

    expect(response.bars.length).toBe(1);
    const bar = response.bars[0]!;
    expect(bar.timestamp).toBeInstanceOf(Date);
    expect(isNaN(bar.timestamp.getTime())).toBe(false); // not Invalid Date
    // Bar timestamp should correspond to SAMPLE_DAILY_BAR.time * 1000
    expect(bar.timestamp.getTime()).toBe(SAMPLE_DAILY_BAR.time * 1000);
  });
});

// ---------------------------------------------------------------------------
// Test B — Angel One forced/disabled → fallback to Upstox or Yahoo
// ---------------------------------------------------------------------------

describe('Test B — Angel One disabled, fallback provider serves', () => {
  it('when Angel One fails, data-service falls back and provider is not angel_one', async () => {
    // Simulate data-service falling back to yahoo_finance when Angel One is unavailable
    const mockHttp = buildMockHttp({
      data: {
        data: [SAMPLE_DAILY_BAR],
        metadata: buildMetadata('yahoo_finance'),
      },
    });

    mockedAxios.create = vi.fn().mockReturnValue(mockHttp);

    // Use providerOverride to simulate "no angel_one" in test DI
    const client = new DataServiceClient('http://localhost:8200', 'test-key', 'yahoo_finance');
    const response = await client.getOHLCV({
      assetId: 'HDFCBANK', from, to, asOf, interval: '1d',
    });

    expect(response.provider).not.toBe('angel_one');
    expect(response.dataAvailable).toBe(true);
    expect(response.fallbackUsed).toBe(true); // not angel_one → fallback
  });

  it('provider override is passed as force_provider query param', async () => {
    const mockHttp = buildMockHttp({
      data: {
        data: [SAMPLE_DAILY_BAR],
        metadata: buildMetadata('upstox'),
      },
    });

    const getSpy = vi.fn().mockResolvedValue({ data: mockHttp.get.getMockImplementation?.()?.() ?? mockHttp, status: 200 });
    getSpy.mockResolvedValue({
      data: {
        data: [SAMPLE_DAILY_BAR],
        metadata: buildMetadata('upstox'),
      },
      status: 200,
    });
    mockedAxios.create = vi.fn().mockReturnValue({ get: getSpy });

    const client = new DataServiceClient('http://localhost:8200', 'test-key', 'upstox');
    await client.getOHLCV({
      assetId: 'INFY', from, to, asOf, interval: '1d',
    });

    // Verify that the HTTP request included force_provider=upstox
    expect(getSpy).toHaveBeenCalledOnce();
    const callArgs = getSpy.mock.calls[0]!;
    const queryParams = callArgs[1]?.params as Record<string, string>;
    expect(queryParams['force_provider']).toBe('upstox');
  });

  it('when upstox serves, fallbackUsed is true (not primary provider)', async () => {
    const mockHttp = buildMockHttp({
      data: {
        data: [SAMPLE_DAILY_BAR],
        metadata: buildMetadata('upstox'),
      },
    });
    mockedAxios.create = vi.fn().mockReturnValue(mockHttp);

    const client = new DataServiceClient('http://localhost:8200', 'test-key');
    const response = await client.getOHLCV({
      assetId: 'BANKNIFTY', from, to, asOf, interval: '1d',
    });

    expect(response.provider).toBe('upstox');
    expect(response.fallbackUsed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test C — Angel One + Upstox disabled → Yahoo Finance serves
// ---------------------------------------------------------------------------

describe('Test C — Angel One + Upstox disabled, Yahoo Finance serves', () => {
  it('when both higher providers fail, yahoo_finance serves', async () => {
    const mockHttp = buildMockHttp({
      data: {
        data: [SAMPLE_DAILY_BAR],
        metadata: buildMetadata('yahoo_finance'),
      },
    });
    mockedAxios.create = vi.fn().mockReturnValue(mockHttp);

    const client = new DataServiceClient('http://localhost:8200', 'test-key', 'yahoo_finance');
    const response = await client.getOHLCV({
      assetId: 'INFY', from, to, asOf, interval: '1d',
    });

    expect(response.provider).toBe('yahoo_finance');
    expect(response.dataAvailable).toBe(true);
    expect(response.fallbackUsed).toBe(true);
    expect(response.barCount).toBeGreaterThan(0);
  });

  it('yahoo_finance data has valid bar timestamps', async () => {
    const mockHttp = buildMockHttp({
      data: {
        data: [SAMPLE_DAILY_BAR],
        metadata: buildMetadata('yahoo_finance'),
      },
    });
    mockedAxios.create = vi.fn().mockReturnValue(mockHttp);

    const client = new DataServiceClient('http://localhost:8200', 'test-key', 'yahoo_finance');
    const response = await client.getOHLCV({
      assetId: 'BANKNIFTY', from, to, asOf, interval: '1d',
    });

    for (const bar of response.bars) {
      expect(bar.timestamp).toBeInstanceOf(Date);
      expect(isNaN(bar.timestamp.getTime())).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Test D — All providers unavailable → data_available = false, provider = null
// ---------------------------------------------------------------------------

describe('Test D — All providers unavailable', () => {
  it('when all providers fail, data_available is false and provider is null', async () => {
    const mockHttp = buildMockHttp({
      data: {
        data: [],
        metadata: buildMetadata(null),
      },
    });
    mockedAxios.create = vi.fn().mockReturnValue(mockHttp);

    const client = new DataServiceClient('http://localhost:8200', 'test-key');
    const response = await client.getOHLCV({
      assetId: 'TCS', from, to, asOf, interval: '1d',
    });

    expect(response.dataAvailable).toBe(false);
    expect(response.provider).toBeNull();
    expect(response.barCount).toBe(0);
    expect(response.bars).toHaveLength(0);
    expect(response.actualRange).toBeNull();
  });

  it('all-fail response does NOT throw — returns empty envelope', async () => {
    const mockHttp = buildMockHttp({
      data: { data: [], metadata: buildMetadata(null) },
    });
    mockedAxios.create = vi.fn().mockReturnValue(mockHttp);

    const client = new DataServiceClient('http://localhost:8200', 'test-key');

    // Must not throw — must return OHLCVResponse with dataAvailable=false
    await expect(
      client.getOHLCV({ assetId: 'ICICIBANK', from, to, asOf, interval: '1d' }),
    ).resolves.toMatchObject({ dataAvailable: false, provider: null, barCount: 0 });
  });

  it('all-fail returns fallbackUsed = false (no provider served, so no fallback)', async () => {
    const mockHttp = buildMockHttp({
      data: { data: [], metadata: buildMetadata(null) },
    });
    mockedAxios.create = vi.fn().mockReturnValue(mockHttp);

    const client = new DataServiceClient('http://localhost:8200', 'test-key');
    const response = await client.getOHLCV({
      assetId: 'SBIN', from, to, asOf, interval: '1d',
    });

    expect(response.fallbackUsed).toBe(false);
  });

  it('no fake bars are returned when all providers fail', async () => {
    const mockHttp = buildMockHttp({
      data: { data: [], metadata: buildMetadata(null) },
    });
    mockedAxios.create = vi.fn().mockReturnValue(mockHttp);

    const client = new DataServiceClient('http://localhost:8200', 'test-key');
    const response = await client.getOHLCV({
      assetId: 'NIFTY', from, to, asOf, interval: '1d',
    });

    // Absolutely no synthetic or interpolated bars
    expect(response.bars).toHaveLength(0);
  });

  it('all 8 instruments return empty response gracefully when all fail', async () => {
    const mockHttp = buildMockHttp({
      data: { data: [], metadata: buildMetadata(null) },
    });
    mockedAxios.create = vi.fn().mockReturnValue(mockHttp);

    const client = new DataServiceClient('http://localhost:8200', 'test-key');

    for (const instrument of TEST_INSTRUMENTS) {
      const response = await client.getOHLCV({
        assetId: instrument, from, to, asOf, interval: '1d',
      });
      expect(response.dataAvailable).toBe(false);
      expect(response.bars).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// OHLCVResponse structure validation
// ---------------------------------------------------------------------------

describe('OHLCVResponse structure — metadata fields', () => {
  it('response includes requestedRange', async () => {
    const mockHttp = buildMockHttp({
      data: { data: [SAMPLE_DAILY_BAR], metadata: buildMetadata('angel_one') },
    });
    mockedAxios.create = vi.fn().mockReturnValue(mockHttp);

    const client = new DataServiceClient('http://localhost:8200', 'test-key');
    const response = await client.getOHLCV({
      assetId: 'RELIANCE', from, to, asOf, interval: '1d',
    });

    expect(response.requestedRange.from).toBeInstanceOf(Date);
    expect(response.requestedRange.to).toBeInstanceOf(Date);
  });

  it('response includes actualRange when bars exist', async () => {
    const mockHttp = buildMockHttp({
      data: { data: [SAMPLE_DAILY_BAR], metadata: buildMetadata('angel_one') },
    });
    mockedAxios.create = vi.fn().mockReturnValue(mockHttp);

    const client = new DataServiceClient('http://localhost:8200', 'test-key');
    const response = await client.getOHLCV({
      assetId: 'RELIANCE', from, to, asOf, interval: '1d',
    });

    expect(response.actualRange).not.toBeNull();
    expect(response.actualRange!.from).toBeInstanceOf(Date);
    expect(response.actualRange!.to).toBeInstanceOf(Date);
  });

  it('actualRange is null when no bars returned', async () => {
    const mockHttp = buildMockHttp({
      data: { data: [], metadata: buildMetadata(null) },
    });
    mockedAxios.create = vi.fn().mockReturnValue(mockHttp);

    const client = new DataServiceClient('http://localhost:8200', 'test-key');
    const response = await client.getOHLCV({
      assetId: 'TCS', from, to, asOf, interval: '1d',
    });

    expect(response.actualRange).toBeNull();
  });

  it('barCount matches bars.length', async () => {
    const multipleBars = [SAMPLE_DAILY_BAR, { ...SAMPLE_DAILY_BAR, time: SAMPLE_DAILY_BAR.time + 86400 }];
    const mockHttp = buildMockHttp({
      data: { data: multipleBars, metadata: buildMetadata('yahoo_finance') },
    });
    mockedAxios.create = vi.fn().mockReturnValue(mockHttp);

    const client = new DataServiceClient('http://localhost:8200', 'test-key');
    const response = await client.getOHLCV({
      assetId: 'HDFCBANK', from, to, asOf, interval: '1d',
    });

    expect(response.barCount).toBe(multipleBars.length);
    expect(response.barCount).toBe(response.bars.length);
  });

  it('getOHLCVBars() returns only the bars array (backward compat)', async () => {
    const mockHttp = buildMockHttp({
      data: { data: [SAMPLE_DAILY_BAR], metadata: buildMetadata('angel_one') },
    });
    mockedAxios.create = vi.fn().mockReturnValue(mockHttp);

    const client = new DataServiceClient('http://localhost:8200', 'test-key');
    const bars = await client.getOHLCVBars({
      assetId: 'RELIANCE', from, to, asOf, interval: '1d',
    });

    // Must return an array (not an OHLCVResponse object)
    expect(Array.isArray(bars)).toBe(true);
    expect(bars.length).toBe(1);
    expect(bars[0]).toHaveProperty('timestamp');
    expect(bars[0]).toHaveProperty('close');
  });
});

// ---------------------------------------------------------------------------
// Point-in-time: asOf cap enforced
// ---------------------------------------------------------------------------

describe('Point-in-time: asOf cap on requested range', () => {
  it('requestedRange.to is capped at asOf when to > asOf', async () => {
    const mockHttp = buildMockHttp({
      data: { data: [], metadata: buildMetadata(null) },
    });
    const getSpy = vi.fn().mockResolvedValue({ data: mockHttp.get.getMockImplementation?.()?.() ?? {}, status: 200 });
    getSpy.mockResolvedValue({ data: { data: [], metadata: buildMetadata(null) }, status: 200 });
    mockedAxios.create = vi.fn().mockReturnValue({ get: getSpy });

    const earlyAsOf = new Date('2024-01-10T00:00:00.000Z');
    const laterTo   = new Date('2024-01-14T23:59:59.000Z'); // to > asOf

    const client = new DataServiceClient('http://localhost:8200', 'test-key');
    const response = await client.getOHLCV({
      assetId: 'RELIANCE',
      from: new Date('2024-01-08T00:00:00.000Z'),
      to: laterTo,
      asOf: earlyAsOf,
      interval: '1d',
    });

    // The response should show that the request was capped
    // requestedRange.to should be earlyAsOf (the cap), not laterTo
    expect(response.requestedRange.to.getTime()).toBe(earlyAsOf.getTime());

    // The HTTP query should have used the capped date
    const callArgs = getSpy.mock.calls[0]!;
    const queryParams = callArgs[1]?.params as Record<string, string>;
    expect(queryParams['to']).toBe('2024-01-10'); // asOf date
  });
});
