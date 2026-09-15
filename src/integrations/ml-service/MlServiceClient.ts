/**
 * MlServiceClient — HTTP client for the AlphaForge ml-service.
 *
 * Provides a typed interface to the ml-service REST API (v1.0.0 running at
 * http://localhost:8100).  Auth: none (internal service).
 *
 * Endpoints wrapped:
 *   POST /predict/regime   — MarketRegimePrediction from NIFTY/VIX/breadth data
 *   GET  /health           — liveness probe
 *
 * This client is the ONLY authoritative source of regime data for
 * SentinelPulse. DataServiceClient.getRegimeSignals() is permanently
 * deprecated and always returns [].
 *
 * Requirements: Req 13.1, Req 13.5 (fallback on unavailability)
 */

import axios, { type AxiosInstance, type AxiosError } from 'axios';
import { validateOutboundUrl } from '../../security/SsrfGuard.js';
import { pino } from 'pino';

const logger = pino({ name: 'MlServiceClient' });

// ---------------------------------------------------------------------------
// Request / response types — mirror ml-service OpenAPI schema
// ---------------------------------------------------------------------------

/**
 * Required fields for regime prediction (ml-service RegimePredictionRequest).
 * All numeric fields reflect intraday market state at prediction time.
 */
export interface RegimePredictionRequest {
  /** NIFTY 50 intraday % change */
  nifty_change_pct: number;
  /** BANKNIFTY intraday % change */
  banknifty_change_pct: number;
  /** India VIX level */
  india_vix: number;
  /** NIFTY ATR(14) as % of price */
  nifty_atr_pct: number;
  /** NIFTY ADX(14) */
  nifty_adx: number;
  /** NSE advance/decline ratio */
  advance_decline_ratio: number;
  /** % of F&O stocks above 20 SMA */
  market_breadth: number;
  /** Avg sector % change */
  sector_strength: number;
  /** Market volume vs 20-day avg */
  volume_ratio: number;
  /** Opening gap % from previous close */
  gap_pct: number;
  // Optional fields
  vix_change_pct?: number | null;
  nifty_rsi?: number | null;
  nifty_macd_hist?: number | null;
  fii_net_cr?: number | null;
}

/**
 * Response from ml-service POST /predict/regime.
 */
export interface RegimePredictionResponse {
  regime: string;
  confidence: number;
  probabilities: Record<string, number>;
  features_used: number;
  model_version: string;
}

/**
 * The result returned to SentinelPulse callers.
 * Wraps the ml-service response with availability metadata.
 */
export interface RegimeResult {
  /** The classified regime string (e.g. 'TRENDING_BULL'). */
  regime: string;
  /** Confidence in [0, 1]. */
  confidence: number;
  /** Probability distribution across all regime classes. */
  probabilities: Record<string, number>;
  /** ml-service model version used for this prediction. */
  modelVersion: string;
  /** Timestamp when the prediction was obtained. */
  predictedAt: Date;
  /** Always true when this struct is returned (false → caller gets null). */
  available: true;
}

// ---------------------------------------------------------------------------
// MlServiceClient
// ---------------------------------------------------------------------------

/**
 * Typed HTTP client for the AlphaForge ml-service.
 *
 * Default URL: `http://localhost:8100`  (overridden by `ML_SERVICE_URL` env var).
 * Default timeout: 5 000 ms (regime prediction must be fast).
 */
export class MlServiceClient {
  private readonly http: AxiosInstance;
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = (
      baseUrl ?? process.env['ML_SERVICE_URL'] ?? 'http://localhost:8100'
    ).replace(/\/$/, '');

    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: 5_000,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'SentinelPulse-MlServiceClient/1.0',
      },
    });
  }

  // --------------------------------------------------------------------------
  // Regime prediction — POST /predict/regime
  // --------------------------------------------------------------------------

  /**
   * Requests a market regime prediction from the ml-service.
   *
   * The ml-service RegimePredictionRequest requires 10+ market data fields
   * derived from live intraday quotes. When the data-service cannot provide
   * them (e.g. provider circuit open), callers MUST NOT call this method —
   * they should set `regime_data_available = false` on the feature vector
   * instead of fabricating input values (Req 13.5).
   *
   * Returns `null` when the ml-service is unavailable or returns a non-2xx
   * response. Callers MUST treat `null` as `regime_data_available = false`.
   *
   * Requirements: Req 13.1, Req 13.5
   */
  async predictRegime(
    request: RegimePredictionRequest,
  ): Promise<RegimeResult | null> {
    try {
      validateOutboundUrl(this.baseUrl);

      const response = await this.http.post<RegimePredictionResponse>(
        '/predict/regime',
        request,
      );

      const data = response.data;

      return {
        regime: data.regime,
        confidence: data.confidence,
        probabilities: data.probabilities,
        modelVersion: data.model_version,
        predictedAt: new Date(),
        available: true,
      };
    } catch (err) {
      const axiosErr = err as AxiosError | undefined;
      logger.warn(
        {
          baseUrl: this.baseUrl,
          status: axiosErr?.response?.status,
          message: axiosErr?.message,
        },
        '[MlServiceClient] predictRegime failed — returning null (regime_data_available=false)',
      );
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // Health check — GET /health
  // --------------------------------------------------------------------------

  /**
   * Returns `true` when the ml-service responds with HTTP 2xx on GET /health.
   */
  async healthCheck(): Promise<boolean> {
    try {
      validateOutboundUrl(this.baseUrl);
      const response = await this.http.get<unknown>('/health');
      return response.status >= 200 && response.status < 300;
    } catch {
      return false;
    }
  }
}
