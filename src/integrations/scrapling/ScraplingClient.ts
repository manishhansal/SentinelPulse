/**
 * ScraplingClient — HTTP client for the Scrapling sidecar microservice.
 *
 * Sends scrape requests to the co-located Python sidecar that uses the
 * Scrapling library for structured content extraction. Applies SSRF
 * validation on the sidecar base URL before every request.
 *
 * Requirements: Req 1.5, Req 30.6
 */

import axios from 'axios';
import { validateOutboundUrl } from '../../security/SsrfGuard.js';

// ---------------------------------------------------------------------------
// Request / response shapes (mirror the Python Pydantic models in
// docker/scrapling_service.py)
// ---------------------------------------------------------------------------

/** CSS selector hints for the Scrapling sidecar to use per source. */
export interface ScrapeSelectors {
  title?: string;
  content?: string;
  author?: string;
  publishedAt?: string;
}

/** Payload sent to POST /scrape on the Scrapling sidecar. */
export interface ScrapeRequest {
  url: string;
  sourceName: string;
  selectors: ScrapeSelectors;
}

/** Response returned by the Scrapling sidecar. */
export interface ScrapedContent {
  url: string;
  title: string | null;
  content: string | null;
  author: string | null;
  /** ISO-8601 string or raw datetime attribute value from the page. */
  publishedAt: string | null;
  success: boolean;
  error: string | null;
}

// ---------------------------------------------------------------------------
// ScraplingClient
// ---------------------------------------------------------------------------

/**
 * HTTP client wrapper around the Scrapling sidecar service.
 *
 * Default sidecar URL: `http://localhost:8001`  (overridden by
 * `SCRAPLING_URL` env var or constructor argument).
 *
 * Default request timeout: 10 000 ms  (Req 30.6).
 */
export class ScraplingClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(baseUrl?: string, timeoutMs = 10_000) {
    this.baseUrl = (
      baseUrl ?? process.env['SCRAPLING_URL'] ?? 'http://localhost:8001'
    ).replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Returns true when the sidecar responds with `{ status: "healthy" }` on
   * GET /health within the configured timeout.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await axios.get<{ status: string }>(
        `${this.baseUrl}/health`,
        { timeout: this.timeoutMs },
      );
      return response.data?.status === 'healthy';
    } catch {
      return false;
    }
  }

  /**
   * Submits a scrape request to POST /scrape on the sidecar.
   *
   * Validates the sidecar base URL against the SSRF allowlist before
   * making the outbound HTTP call (Req 30.4). Respects the configured
   * request timeout (Req 30.6).
   *
   * @throws {SsrfBlockedError} if the sidecar URL is not in the allowlist.
   * @throws {AxiosError} on HTTP error or timeout.
   */
  async scrape(req: ScrapeRequest): Promise<ScrapedContent> {
    // SSRF protection — validates the sidecar base URL, not the target
    // article URL (the sidecar itself is responsible for validating its
    // own outbound requests).
    validateOutboundUrl(this.baseUrl);

    const response = await axios.post<ScrapedContent>(
      `${this.baseUrl}/scrape`,
      {
        url: req.url,
        source_name: req.sourceName,
        selectors: req.selectors,
      },
      { timeout: this.timeoutMs },
    );

    return response.data;
  }
}
