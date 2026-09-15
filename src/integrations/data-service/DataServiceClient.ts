/**
 * DataServiceClient — HTTP client for the AlphaForge data-service.
 *
 * SentinelPulse NEVER queries data-service databases directly. Every call
 * goes through this HTTP client, and ALL price/market-data calls MUST include
 * an `asOf` parameter to enforce point-in-time correctness and prevent
 * look-ahead bias.
 *
 * Requirements: Req 12.1, Req 12.4, Req 20.1, Req 21.1, Req 30.4, Req 30.6
 */

import axios, { type AxiosInstance, type AxiosError } from 'axios';
import { validateOutboundUrl } from '../../security/SsrfGuard.js';

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

/** A single OHLCV bar returned by data-service. */
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
 * Used by FeatureEngineeringEngine to assemble market-context features
 * without look-ahead bias (Req 20.1).
 */
export interface MarketContextSnapshot {
  assetId: string;
  /** The exact point in time this snapshot reflects. */
  asOf: Date;
  price: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Average True Range — optional, omitted when unavailable. */
  atr?: number;
  /** Volume-Weighted Average Price — optional. */
  vwap?: number;
  /** Futures open interest — optional. */
  openInterest?: number;
  /** India VIX value — optional, present only for Indian market assets. */
  vix?: number;
}

/** A single instrument/security entry from the InstrumentMaster. */
export interface InstrumentMasterEntry {
  instrumentId: string;
  symbol: string;
  name: string;
  exchange: string;
  sector?: string;
  /** Alternative ticker symbols, display names, or abbreviations. */
  aliases: string[];
  isActive: boolean;
}

/** A market-regime signal emitted by data-service for a given market. */
export interface RegimeSignal {
  marketId: string;
  regime: string;
  /** Confidence in range [0, 1]. */
  confidence: number;
  computedAt: Date;
}

// ---------------------------------------------------------------------------
// Raw API response shapes (before date coercion)
// ---------------------------------------------------------------------------

interface RawOHLCVBar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface RawMarketContextSnapshot {
  assetId: string;
  asOf: string;
  price: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  atr?: number;
  vwap?: number;
  openInterest?: number;
  vix?: number;
}

interface RawRegimeSignal {
  marketId: string;
  regime: string;
  confidence: number;
  computedAt: string;
}

// ---------------------------------------------------------------------------
// DataServiceClient
// ---------------------------------------------------------------------------

/**
 * Typed HTTP client for the AlphaForge data-service.
 *
 * Reads `DATA_SERVICE_URL` and `DATA_SERVICE_API_KEY` from environment
 * variables. Both can be overridden via constructor arguments.
 *
 * Every method applies SSRF validation before making the network call
 * (Req 30.4) and enforces a 10-second timeout (Req 30.6, Req 12.4).
 */
export class DataServiceClient {
  private readonly http: AxiosInstance;
  private readonly baseUrl: string;

  constructor(baseUrl?: string, apiKey?: string) {
    this.baseUrl = (
      baseUrl ?? process.env['DATA_SERVICE_URL'] ?? 'http://localhost:4000'
    ).replace(/\/$/, '');

    const key = apiKey ?? process.env['DATA_SERVICE_API_KEY'] ?? '';

    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: 10_000, // Req 12.4, Req 30.6: 10-second timeout for every call
      headers: {
        Accept: 'application/json',
        'User-Agent': 'SentinelPulse-DataServiceClient/1.0',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
    });
  }

  // --------------------------------------------------------------------------
  // OHLCV
  // --------------------------------------------------------------------------

  /**
   * Fetch OHLCV bars for an asset within a time range.
   *
   * The `asOf` parameter MUST be <= the event timestamp being processed to
   * guarantee point-in-time correctness (Req 20.1, Req 21.1).
   *
   * Endpoint: GET /ohlcv?assetId=&from=&to=&asOf=
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
  }): Promise<OHLCVBar[]> {
    validateOutboundUrl(this.baseUrl); // Req 30.4

    const response = await this.http.get<RawOHLCVBar[]>('/ohlcv', {
      params: {
        assetId: params.assetId,
        from: params.from.toISOString(),
        to: params.to.toISOString(),
        asOf: params.asOf.toISOString(),
      },
    });

    return (response.data ?? []).map((bar) => ({
      timestamp: new Date(bar.timestamp),
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
    }));
  }

  // --------------------------------------------------------------------------
  // Market context snapshot
  // --------------------------------------------------------------------------

  /**
   * Get a point-in-time market context snapshot for an asset.
   *
   * Used by FeatureEngineeringEngine to populate market-context features
   * (OHLCV, ATR, VWAP, OI, VIX) without look-ahead bias (Req 20.1).
   *
   * Endpoint: GET /market-context/:assetId?asOf=
   *
   * Returns `null` when the asset is not found (404) or when no data is
   * available at the requested `asOf` timestamp.
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
      const response = await this.http.get<RawMarketContextSnapshot>(
        `/market-context/${encodeURIComponent(assetId)}`,
        { params: { asOf: asOf.toISOString() } },
      );

      const raw = response.data;
      return {
        assetId: raw.assetId,
        asOf: new Date(raw.asOf),
        price: raw.price,
        open: raw.open,
        high: raw.high,
        low: raw.low,
        close: raw.close,
        volume: raw.volume,
        ...(raw.atr !== undefined ? { atr: raw.atr } : {}),
        ...(raw.vwap !== undefined ? { vwap: raw.vwap } : {}),
        ...(raw.openInterest !== undefined ? { openInterest: raw.openInterest } : {}),
        ...(raw.vix !== undefined ? { vix: raw.vix } : {}),
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  // --------------------------------------------------------------------------
  // Instrument master
  // --------------------------------------------------------------------------

  /**
   * Resolve a free-text surface form (e.g., "Reliance", "TCS", "HDFC Bank")
   * to a canonical InstrumentMaster entry.
   *
   * Used by EntityResolutionEngine (Req 5.2, 5.3). SentinelPulse is read-only
   * with respect to InstrumentMaster — it never creates or modifies entries.
   *
   * Endpoint: GET /instruments/resolve?q=
   *
   * Returns `null` when no match is found.
   *
   * @throws {SsrfBlockedError} when `baseUrl` domain is not allowlisted.
   * @throws {AxiosError} on non-404 HTTP error or timeout.
   */
  async resolveInstrument(surfaceForm: string): Promise<InstrumentMasterEntry | null> {
    validateOutboundUrl(this.baseUrl); // Req 30.4

    try {
      const response = await this.http.get<InstrumentMasterEntry>(
        '/instruments/resolve',
        { params: { q: surfaceForm } },
      );
      return response.data ?? null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /**
   * Fetch a single instrument by its canonical AlphaForge instrument ID.
   *
   * Endpoint: GET /instruments/:id
   *
   * Returns `null` when the instrument does not exist (404).
   *
   * @throws {SsrfBlockedError} when `baseUrl` domain is not allowlisted.
   * @throws {AxiosError} on non-404 HTTP error or timeout.
   */
  async getInstrumentById(instrumentId: string): Promise<InstrumentMasterEntry | null> {
    validateOutboundUrl(this.baseUrl); // Req 30.4

    try {
      const response = await this.http.get<InstrumentMasterEntry>(
        `/instruments/${encodeURIComponent(instrumentId)}`,
      );
      return response.data ?? null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  // --------------------------------------------------------------------------
  // Regime signals
  // --------------------------------------------------------------------------

  /**
   * Retrieve the current regime signals for a market (e.g., "india", "us",
   * "global"). Used by MarketRegimeEngine (Req 13.1–13.5).
   *
   * Endpoint: GET /regime-signals/:marketId
   *
   * Returns an empty array when no signals are available (404 treated as
   * an empty result, not an error).
   *
   * @throws {SsrfBlockedError} when `baseUrl` domain is not allowlisted.
   * @throws {AxiosError} on non-404 HTTP error or timeout.
   */
  async getRegimeSignals(marketId: string): Promise<RegimeSignal[]> {
    validateOutboundUrl(this.baseUrl); // Req 30.4

    try {
      const response = await this.http.get<RawRegimeSignal[]>(
        `/regime-signals/${encodeURIComponent(marketId)}`,
      );

      return (response.data ?? []).map((sig) => ({
        marketId: sig.marketId,
        regime: sig.regime,
        confidence: sig.confidence,
        computedAt: new Date(sig.computedAt),
      }));
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
  }

  // --------------------------------------------------------------------------
  // Health check
  // --------------------------------------------------------------------------

  /**
   * Probe the data-service health endpoint.
   *
   * Returns `true` when data-service responds with HTTP 2xx within the
   * configured timeout. Returns `false` on any error (network failure,
   * timeout, non-2xx response, or SSRF rejection).
   *
   * Endpoint: GET /health
   */
  async healthCheck(): Promise<boolean> {
    try {
      validateOutboundUrl(this.baseUrl); // Req 30.4
      const response = await this.http.get<unknown>('/health');
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
 * Used to convert "not found" HTTP responses into `null` return values
 * rather than thrown exceptions.
 */
function isNotFound(err: unknown): boolean {
  const axiosErr = err as AxiosError | undefined;
  return (
    axiosErr != null &&
    axiosErr.isAxiosError === true &&
    axiosErr.response?.status === 404
  );
}
