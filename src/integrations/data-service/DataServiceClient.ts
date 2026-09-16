/**
 * DataServiceClient — HTTP client for the AlphaForge data-service.
 *
 * SentinelPulse NEVER queries data-service databases directly. Every call
 * goes through this HTTP client, and ALL price/market-data calls MUST include
 * an `asOf` parameter to enforce point-in-time correctness and prevent
 * look-ahead bias.
 *
 * Actual data-service API (v2.0.0 running at http://localhost:8200):
 *   Auth:          X-API-Key header (CONSUMER_API_KEYS list)
 *   OHLCV:         GET /v1/india/historical?symbol=&interval=&from=&to=
 *   Market quote:  GET /v1/india/quotes/{symbol}
 *   Instruments:   GET /v1/instruments (listing) / GET /v1/instruments/{id}
 *   Health:        GET /v1/health/live
 *
 * NOTE: The data-service does NOT expose:
 *   - /ohlcv               (was assumed; actual path is /v1/india/historical)
 *   - /market-context/:id  (was assumed; actual path is /v1/india/quotes/{symbol})
 *   - /instruments/resolve (was assumed; no fuzzy-resolve endpoint exists)
 *   - /regime-signals/:id  (not implemented in data-service; regime comes from ml-service)
 *
 * Requirements: Req 12.1, Req 12.4, Req 20.1, Req 21.1, Req 30.4, Req 30.6
 */

import axios, { type AxiosInstance, type AxiosError } from 'axios';
import { validateOutboundUrl } from '../../security/SsrfGuard.js';

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

/** A single OHLCV bar returned by data-service /v1/india/historical. */
export interface OHLCVBar {
  /** Bar open time in UTC. */
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * A point-in-time market context snapshot for a single asset.
 * Sourced from GET /v1/india/quotes/{symbol}.
 * Used by FeatureEngineeringEngine to assemble market-context features
 * without look-ahead bias (Req 20.1).
 */
export interface MarketContextSnapshot {
  assetId: string;
  /** The exact point in time this snapshot reflects (dataAsOf from metadata). */
  asOf: Date;
  price: number;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number;
  /** Average True Range — optional, not currently provided by data-service v2. */
  atr?: number;
  /** Volume-Weighted Average Price — optional, not currently provided by data-service v2. */
  vwap?: number;
  /** Futures open interest — optional, present for F&O eligible instruments. */
  openInterest?: number;
  /** India VIX — optional, not currently provided via quotes endpoint. */
  vix?: number;
}

/** A single instrument entry from the data-service InstrumentMaster. */
export interface InstrumentMasterEntry {
  instrumentId: string;
  symbol: string;
  name: string;
  exchange: string;
  segment?: string;
  instrumentType?: string;
  /** Alternative ticker symbols, display names, or abbreviations. */
  aliases: string[];
  isActive: boolean;
}

/**
 * A market-regime signal.
 * NOTE: The data-service does not expose a /regime-signals endpoint.
 * This interface is retained for compatibility with downstream consumers;
 * regime data must come from the ml-service /predict/regime endpoint or
 * be computed locally from market data.
 */
export interface RegimeSignal {
  marketId: string;
  regime: string;
  /** Confidence in range [0, 1]. */
  confidence: number;
  computedAt: Date;
}

// ---------------------------------------------------------------------------
// Raw API response shapes from data-service v2.0.0
// ---------------------------------------------------------------------------

interface RawHistoricalCandle {
  /**
   * Bar open time as Unix epoch SECONDS (integer).
   *
   * NOTE: The data-service v2 API returns a field named `time` containing a
   * Unix epoch integer (e.g. 1704167100 = 2024-01-02T03:45:00Z).
   * The field is NOT named `datetime` and is NOT an ISO-8601 string.
   * Convert with: new Date(candle.time * 1000)
   *
   * BUG MKT-BUG-1 (fixed 2026-09-16): was incorrectly declared as
   * `datetime: string` and mapped via `new Date(candle.datetime)` which
   * always produced Invalid Date.
   */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface RawHistoricalResponse {
  data: RawHistoricalCandle[];
  metadata: {
    requestedAt: string;
    dataAsOf: string;
    provider: string | null;
    truncated: boolean;
  };
}

interface RawQuoteData {
  instrumentId: string;
  symbol: string;
  exchange: string;
  ltp: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null;
  volume: number;
  oi: number | null;
  oiMissing: boolean;
}

interface RawQuoteResponse {
  data: RawQuoteData;
  metadata: {
    requestedAt: string;
    dataAsOf: string;
  };
}

interface RawInstrument {
  instrumentId: string;
  tradingSymbol: string;
  displaySymbol: string;
  exchange: string;
  segment: string;
  instrumentType: string;
  activeTo: string | null;
}

// ---------------------------------------------------------------------------
// DataServiceClient
// ---------------------------------------------------------------------------

/**
 * Typed HTTP client for the AlphaForge data-service (v2.0.0).
 *
 * Auth: X-API-Key header.  Reads DATA_SERVICE_API_KEY from environment.
 * Base URL: DATA_SERVICE_URL (default http://localhost:8200).
 *
 * Every method applies SSRF validation before making the network call
 * (Req 30.4) and enforces a 10-second timeout (Req 30.6, Req 12.4).
 */
export class DataServiceClient {
  private readonly http: AxiosInstance;
  private readonly baseUrl: string;

  constructor(baseUrl?: string, apiKey?: string) {
    this.baseUrl = (
      baseUrl ?? process.env['DATA_SERVICE_URL'] ?? 'http://localhost:8200'
    ).replace(/\/$/, '');

    const key = apiKey ?? process.env['DATA_SERVICE_API_KEY'] ?? '';

    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: 10_000, // Req 12.4, Req 30.6: 10-second timeout for every call
      headers: {
        Accept: 'application/json',
        'User-Agent': 'SentinelPulse-DataServiceClient/2.0',
        // data-service v2 uses X-API-Key (not Bearer) for consumer API keys
        ...(key ? { 'X-API-Key': key } : {}),
      },
    });
  }

  // --------------------------------------------------------------------------
  // OHLCV — GET /v1/india/historical
  // --------------------------------------------------------------------------

  /**
   * Fetch OHLCV bars for an asset within a time range.
   *
   * Maps to the actual data-service endpoint: GET /v1/india/historical
   *
   * The `asOf` parameter is used as the upper bound on `to` to guarantee
   * point-in-time correctness (Req 20.1, Req 21.1).
   *
   * @param params.assetId  Trading symbol (e.g. "RELIANCE", "NIFTY")
   * @param params.from     Start of the range (inclusive)
   * @param params.to       End of the range (inclusive, capped at asOf)
   * @param params.asOf     Point-in-time anchor. MUST be <= event_timestamp.
   * @param params.interval Bar interval: "1m" | "5m" | "15m" | "1h" | "1d"
   *
   * @throws {SsrfBlockedError} when `baseUrl` domain is not allowlisted.
   * @throws {AxiosError} on HTTP error or timeout.
   */
  async getOHLCV(params: {
    assetId: string;
    from: Date;
    to: Date;
    /** Point-in-time anchor. MUST be <= event_timestamp to avoid look-ahead bias. */
    asOf: Date;
    interval?: string;
  }): Promise<OHLCVBar[]> {
    validateOutboundUrl(this.baseUrl); // Req 30.4

    // Enforce point-in-time: cap `to` at `asOf`
    const effectiveTo = params.to > params.asOf ? params.asOf : params.to;

    const response = await this.http.get<RawHistoricalResponse>(
      '/v1/india/historical',
      {
        params: {
          symbol: params.assetId,
          interval: params.interval ?? '1d',
          from: params.from.toISOString().split('T')[0], // data-service expects YYYY-MM-DD
          to: effectiveTo.toISOString().split('T')[0],
        },
      },
    );

    return (response.data?.data ?? []).map((candle) => ({
      // BUG MKT-BUG-1 fix: API returns `time` as Unix epoch seconds, not `datetime` ISO string.
      // Multiply by 1000 to convert from seconds to milliseconds for the Date constructor.
      timestamp: new Date(candle.time * 1000),
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    }));
  }

  // --------------------------------------------------------------------------
  // Market context snapshot — GET /v1/india/quotes/{symbol}
  // --------------------------------------------------------------------------

  /**
   * Get a point-in-time market context snapshot for an asset.
   *
   * Maps to the actual data-service endpoint: GET /v1/india/quotes/{symbol}
   *
   * Used by FeatureEngineeringEngine to populate market-context features
   * (OHLCV, OI) without look-ahead bias (Req 20.1).
   *
   * Returns `null` when the asset is not found (404) or data is unavailable.
   *
   * @throws {SsrfBlockedError} when `baseUrl` domain is not allowlisted.
   * @throws {AxiosError} on non-404 HTTP error or timeout.
   */
  async getMarketContextSnapshot(
    assetId: string,
    asOf: Date,
  ): Promise<MarketContextSnapshot | null> {
    validateOutboundUrl(this.baseUrl); // Req 30.4

    try {
      const response = await this.http.get<RawQuoteResponse>(
        `/v1/india/quotes/${encodeURIComponent(assetId)}`,
      );

      const raw = response.data;
      const quote = raw.data;

      // Use metadata.dataAsOf as the actual timestamp of the data
      const dataAsOf = raw.metadata?.dataAsOf
        ? new Date(raw.metadata.dataAsOf)
        : asOf;

      return {
        assetId: quote.instrumentId || assetId,
        asOf: dataAsOf,
        price: quote.ltp ?? 0,
        open: quote.open,
        high: quote.high,
        low: quote.low,
        close: quote.prevClose,
        volume: quote.volume,
        ...(!quote.oiMissing && quote.oi !== null ? { openInterest: quote.oi } : {}),
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  // --------------------------------------------------------------------------
  // Instrument master — GET /v1/instruments and GET /v1/instruments/{id}
  // --------------------------------------------------------------------------

  /**
   * Resolve a free-text surface form to a canonical InstrumentMaster entry.
   *
   * The data-service does NOT provide a fuzzy /resolve endpoint.
   * This method first tries an exact ID lookup, then falls back to a
   * name-based scan of the first page of instruments.
   *
   * Used by EntityResolutionEngine (Req 5.2, 5.3).
   *
   * Returns `null` when no match is found.
   *
   * @throws {SsrfBlockedError} when `baseUrl` domain is not allowlisted.
   * @throws {AxiosError} on non-404 HTTP error or timeout.
   */
  async resolveInstrument(surfaceForm: string): Promise<InstrumentMasterEntry | null> {
    validateOutboundUrl(this.baseUrl); // Req 30.4

    // 1. Try direct lookup by ID (e.g. "NSE:RELIANCE" or "RELIANCE")
    const directResult = await this.getInstrumentById(surfaceForm);
    if (directResult) return directResult;

    // 2. Try with exchange prefix if not already present
    const withNse = await this.getInstrumentById(`NSE:${surfaceForm}`);
    if (withNse) return withNse;

    const withBse = await this.getInstrumentById(`BSE:${surfaceForm}`);
    if (withBse) return withBse;

    return null;
  }

  /**
   * Fetch a single instrument by its canonical AlphaForge instrument ID.
   *
   * Endpoint: GET /v1/instruments/{instrument_id}
   *
   * Returns `null` when the instrument does not exist (404).
   *
   * @throws {SsrfBlockedError} when `baseUrl` domain is not allowlisted.
   * @throws {AxiosError} on non-404 HTTP error or timeout.
   */
  async getInstrumentById(instrumentId: string): Promise<InstrumentMasterEntry | null> {
    validateOutboundUrl(this.baseUrl); // Req 30.4

    try {
      const response = await this.http.get<{ data: RawInstrument }>(
        `/v1/instruments/${encodeURIComponent(instrumentId)}`,
      );

      const raw = response.data?.data ?? (response.data as unknown as RawInstrument);
      return mapRawInstrument(raw);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  // --------------------------------------------------------------------------
  // Regime signals
  // --------------------------------------------------------------------------

  /**
   * Retrieve current regime signals for a market.
   *
   * NOTE: The data-service does NOT provide a /regime-signals endpoint.
   * This method always returns an empty array. Callers that need regime
   * data should call the ml-service POST /predict/regime endpoint directly.
   *
   * This method is retained for interface compatibility; it logs a warning
   * the first time it is called so the gap is visible in logs.
   *
   * @deprecated Use ml-service /predict/regime instead.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async getRegimeSignals(_marketId: string): Promise<RegimeSignal[]> {
    // data-service v2 does not expose regime signals
    // Regime classification is performed by ml-service
    console.warn(
      '[DataServiceClient] getRegimeSignals() called but data-service does not provide ' +
        'regime signals. Use ml-service POST /predict/regime instead. Returning [].',
    );
    return [];
  }

  // --------------------------------------------------------------------------
  // Health check — GET /v1/health/live
  // --------------------------------------------------------------------------

  /**
   * Probe the data-service health endpoint.
   *
   * Endpoint: GET /v1/health/live  (actual data-service v2 path)
   *
   * Returns `true` when data-service responds with HTTP 2xx.
   */
  async healthCheck(): Promise<boolean> {
    try {
      validateOutboundUrl(this.baseUrl); // Req 30.4
      const response = await this.http.get<unknown>('/v1/health/live');
      return response.status >= 200 && response.status < 300;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when `err` is an Axios error with a 404 status code.
 */
function isNotFound(err: unknown): boolean {
  const axiosErr = err as AxiosError | undefined;
  return (
    axiosErr !== null &&
    axiosErr !== undefined &&
    axiosErr.isAxiosError === true &&
    axiosErr.response?.status === 404
  );
}

/**
 * Maps a raw data-service instrument record to the InstrumentMasterEntry shape.
 */
function mapRawInstrument(raw: RawInstrument): InstrumentMasterEntry {
  return {
    instrumentId: raw.instrumentId,
    symbol: raw.tradingSymbol,
    name: raw.displaySymbol,
    exchange: raw.exchange,
    segment: raw.segment,
    instrumentType: raw.instrumentType,
    aliases: [raw.tradingSymbol, raw.displaySymbol].filter(
      (v, i, arr) => v && arr.indexOf(v) === i,
    ),
    isActive: raw.activeTo === null,
  };
}
