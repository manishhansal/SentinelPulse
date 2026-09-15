/**
 * BloombergAdapter — Tier-2 API-based adapter for Bloomberg.
 *
 * Bloomberg does not offer a free public API. This adapter is designed to
 * be wired to the Bloomberg Terminal API, the Bloomberg Enterprise Access
 * Point (EAP), or an approved third-party Bloomberg data provider.
 *
 * When no API key is configured (NEWS_SOURCE_BLOOMBERG_API_KEY is absent or
 * empty) the adapter returns an empty article list with a WARN log rather
 * than throwing an error, so that the rest of the ingestion pipeline is
 * unaffected.
 *
 * Requirements: Req 1.2, Req 1.4
 */

import crypto from 'node:crypto';
import { pino } from 'pino';
import axios, { type AxiosInstance, type AxiosResponse } from 'axios';
import { v4 as uuidv4 } from 'uuid';
import {
  AbstractNewsSourceAdapter,
  type FetchOptions,
  type HealthStatus,
  type HistoricalFetchOptions,
  type NormalizedArticle,
  type RateLimitConfig,
  type RawArticle,
} from '../base/NewsSourceAdapter.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger = pino({ name: 'bloomberg-adapter' });

// ---------------------------------------------------------------------------
// Bloomberg API response shapes
// These interfaces reflect a generic Bloomberg-compatible REST API contract.
// Adjust field names once the actual API documentation is available.
// ---------------------------------------------------------------------------

interface BloombergApiArticle {
  /** Unique identifier for the story on Bloomberg's systems. */
  id: string;
  /** Story headline. */
  headline: string;
  /** Short summary / lede paragraph. */
  summary?: string;
  /** Full story body, if provided by the tier of access. */
  body?: string;
  /** Byline / author credit. */
  byline?: string;
  /** ISO 8601 publication timestamp. */
  publishedAt?: string;
  /** Bloomberg topic / sector tag. */
  topic?: string;
  /** Canonical URL to the article on bloomberg.com. */
  url?: string;
}

interface BloombergApiResponse {
  articles: BloombergApiArticle[];
  /** Total number of results available (for pagination). */
  totalResults?: number;
}

interface BloombergHealthResponse {
  status: string;
}

// ---------------------------------------------------------------------------
// BloombergAdapter
// ---------------------------------------------------------------------------

/**
 * Tier-2 adapter for Bloomberg news via a REST API.
 *
 * Configuration (all read from environment variables):
 *
 *   NEWS_SOURCE_BLOOMBERG_BASE_URL  — API base URL (required for live calls)
 *   NEWS_SOURCE_BLOOMBERG_API_KEY   — API key or bearer token (required)
 *   NEWS_SOURCE_BLOOMBERG_RPM       — requests-per-minute limit (optional, default 60)
 */
export class BloombergAdapter extends AbstractNewsSourceAdapter {
  // ------------------------------------------------------------------
  // NewsSourceAdapter identity
  // ------------------------------------------------------------------
  readonly sourceId = 'bloomberg';
  readonly sourceName = 'Bloomberg';
  readonly adapterVersion = '1.0.0';
  readonly tier = 2;

  // ------------------------------------------------------------------
  // Configuration read from environment at construction time
  // ------------------------------------------------------------------
  private readonly _baseUrl: string;
  private readonly apiKey: string | null;
  private readonly http: AxiosInstance;
  private readonly _requestsPerMinute: number;

  constructor() {
    super();

    this._baseUrl =
      process.env['NEWS_SOURCE_BLOOMBERG_BASE_URL'] ??
      'https://bloomberg-api.example.com/v1';

    this.apiKey = process.env['NEWS_SOURCE_BLOOMBERG_API_KEY'] ?? null;

    this._requestsPerMinute = Math.max(
      1,
      parseInt(process.env['NEWS_SOURCE_BLOOMBERG_RPM'] ?? '60', 10) || 60,
    );

    this.http = axios.create({
      baseURL: this._baseUrl,
      timeout: 10_000, // 10 s hard ceiling enforced by AbstractNewsSourceAdapter too
      headers: {
        Accept: 'application/json',
        'User-Agent': `SentinelPulse-BloombergAdapter/${this.adapterVersion}`,
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
    });
  }

  // ------------------------------------------------------------------
  // AbstractNewsSourceAdapter — baseUrl
  // ------------------------------------------------------------------

  protected override get baseUrl(): string {
    return this._baseUrl;
  }

  // ------------------------------------------------------------------
  // Interface: getRateLimit
  // ------------------------------------------------------------------

  getRateLimit(): RateLimitConfig {
    return { requestsPerMinute: this._requestsPerMinute };
  }

  // ------------------------------------------------------------------
  // Implementation hooks
  // ------------------------------------------------------------------

  /**
   * Probes the Bloomberg API with a lightweight request to verify
   * reachability and credential validity.
   *
   * Uses a HEAD request to the base URL when no dedicated health endpoint
   * is known; falls back to a GET /health if HEAD is rejected.
   */
  protected async healthCheckImpl(): Promise<HealthStatus> {
    const checkedAt = new Date();

    if (!this.apiKey) {
      return {
        healthy: false,
        message:
          'Bloomberg API key not configured (NEWS_SOURCE_BLOOMBERG_API_KEY is missing)',
        checkedAt,
      };
    }

    const start = Date.now();
    try {
      const res: AxiosResponse<BloombergHealthResponse> = await this.http.get(
        '/health',
        { timeout: 10_000 },
      );
      const latencyMs = Date.now() - start;
      const healthy = res.status >= 200 && res.status < 300;
      return {
        healthy,
        message: healthy
          ? 'Bloomberg API is reachable'
          : `Bloomberg API returned HTTP ${res.status}`,
        checkedAt,
        statusCode: res.status,
        latencyMs,
      };
    } catch (err: unknown) {
      const latencyMs = Date.now() - start;
      const statusCode = axios.isAxiosError(err)
        ? (err.response?.status ?? undefined)
        : undefined;
      const message =
        err instanceof Error ? err.message : 'Unknown error during health check';
      logger.warn({ err, sourceId: this.sourceId }, 'Bloomberg health check failed');
      return {
        healthy: false,
        message,
        checkedAt,
        statusCode,
        latencyMs,
      };
    }
  }

  /**
   * Fetches the latest articles from the Bloomberg API.
   *
   * Returns an empty array when the API key is not configured (with a WARN
   * log) so that the ingestion engine is not disrupted by an unconfigured
   * optional source.
   */
  protected async fetchLatestImpl(options: FetchOptions): Promise<RawArticle[]> {
    if (!this.apiKey) {
      logger.warn(
        { sourceId: this.sourceId },
        'Bloomberg API key not configured — skipping fetch and returning empty list. ' +
          'Set NEWS_SOURCE_BLOOMBERG_API_KEY to enable live data.',
      );
      return [];
    }

    const limit = options.limit ?? 50;
    const params: Record<string, string | number> = { limit };
    if (options.since) {
      params['since'] = options.since.toISOString();
    }
    if (options.extra) {
      for (const [key, value] of Object.entries(options.extra)) {
        if (typeof value === 'string' || typeof value === 'number') {
          params[key] = value;
        }
      }
    }

    const res: AxiosResponse<BloombergApiResponse> = await this.http.get(
      '/news/latest',
      { params },
    );

    return this.mapApiArticles(res.data.articles ?? []);
  }

  /**
   * Fetches historical articles within a date range from the Bloomberg API.
   *
   * Returns an empty array when the API key is not configured.
   */
  protected async fetchHistoricalImpl(
    options: HistoricalFetchOptions,
  ): Promise<RawArticle[]> {
    if (!this.apiKey) {
      logger.warn(
        { sourceId: this.sourceId },
        'Bloomberg API key not configured — skipping historical fetch and returning empty list.',
      );
      return [];
    }

    const limit = options.limit ?? 50;
    const page = options.page ?? 1;
    const params: Record<string, string | number> = {
      from: options.from.toISOString(),
      to: options.to.toISOString(),
      limit,
      page,
    };
    if (options.since) {
      params['since'] = options.since.toISOString();
    }
    if (options.extra) {
      for (const [key, value] of Object.entries(options.extra)) {
        if (typeof value === 'string' || typeof value === 'number') {
          params[key] = value;
        }
      }
    }

    const res: AxiosResponse<BloombergApiResponse> = await this.http.get(
      '/news/historical',
      { params },
    );

    return this.mapApiArticles(res.data.articles ?? []);
  }

  // ------------------------------------------------------------------
  // normalize — maps a RawArticle to NormalizedArticle (Req 3.1)
  // ------------------------------------------------------------------

  /**
   * Maps a Bloomberg RawArticle into the canonical NormalizedArticle
   * representation.
   *
   * - Absent optional fields are set to `null` (never `undefined`).
   * - `contentHash` and `titleHash` are computed as SHA-256 hex digests.
   * - `publishedAt` falls back to the current UTC time when the raw
   *   timestamp is absent or unparseable (`timestampInferred = true`).
   */
  normalize(raw: RawArticle): NormalizedArticle {
    const scrapedAt = new Date();

    // ------------------------------------------------------------------
    // Timestamp
    // ------------------------------------------------------------------
    let publishedAt: Date;
    let timestampInferred = false;
    if (raw.publishedAt) {
      const parsed = new Date(raw.publishedAt);
      if (isNaN(parsed.getTime())) {
        logger.warn(
          { sourceId: this.sourceId, rawPublishedAt: raw.publishedAt },
          'Bloomberg: could not parse publishedAt — inferring current UTC time',
        );
        publishedAt = scrapedAt;
        timestampInferred = true;
      } else {
        publishedAt = parsed;
      }
    } else {
      publishedAt = scrapedAt;
      timestampInferred = true;
    }

    // ------------------------------------------------------------------
    // Content processing
    // ------------------------------------------------------------------
    const rawContent = raw.content ?? null;
    let content: string | null = rawContent;
    let contentTruncated = false;
    const MAX_CONTENT_LENGTH = 50_000;
    if (content !== null && content.length > MAX_CONTENT_LENGTH) {
      // Truncate at the last word boundary at or before the limit
      const slice = content.slice(0, MAX_CONTENT_LENGTH);
      const lastSpace = slice.lastIndexOf(' ');
      content = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
      contentTruncated = true;
    }

    // ------------------------------------------------------------------
    // Hashes (SHA-256)
    // ------------------------------------------------------------------
    const contentForHash = (content ?? '').trim().replace(/\s+/g, ' ');
    const contentHash = crypto
      .createHash('sha256')
      .update(contentForHash, 'utf8')
      .digest('hex');

    const titleForHash = raw.title
      .toLowerCase()
      .replace(/[^\w\s]/g, '')   // strip punctuation
      .replace(/\s+/g, ' ')
      .trim();
    const titleHash = crypto
      .createHash('sha256')
      .update(titleForHash, 'utf8')
      .digest('hex');

    // ------------------------------------------------------------------
    // Category
    // ------------------------------------------------------------------
    const category = raw.category ?? null;

    return {
      id: uuidv4(),
      sourceId: raw.sourceId,
      sourceName: raw.sourceName,
      externalId: raw.externalId,
      canonicalUrl: raw.url,
      title: raw.title,
      summary: raw.summary ?? null,
      content,
      author: raw.author ?? null,
      language: 'en',
      languageConfidence: 0,
      publishedAt,
      scrapedAt,
      category,
      secondaryCategories: [],
      categoryConfidence: 0,
      contentHash,
      titleHash,
      contentTruncated,
      timestampInferred,
      contentDepth: 'FULL_ARTICLE' as const,
      contentQualityScore: 0.9,
    };
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  /** Maps raw Bloomberg API article objects to the adapter's RawArticle shape. */
  private mapApiArticles(articles: BloombergApiArticle[]): RawArticle[] {
    return articles.map((a): RawArticle => ({
      sourceId: this.sourceId,
      sourceName: this.sourceName,
      externalId: a.id,
      url: a.url ?? `${this._baseUrl}/news/${a.id}`,
      title: a.headline,
      summary: a.summary,
      content: a.body,
      author: a.byline,
      publishedAt: a.publishedAt,
      category: a.topic,
      adapterVersion: this.adapterVersion,
    }));
  }
}
