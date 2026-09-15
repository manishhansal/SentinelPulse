/**
 * FinancialTimesAdapter — Tier-2 API-based adapter for the Financial Times.
 *
 * Uses the FT Content API (https://developer.ft.com/portal/docs) when an API
 * key is configured. The Content API is a search-and-retrieval API that
 * returns articles as JSON under the CAPI v1 contract.
 *
 * When no API key is configured (NEWS_SOURCE_FINANCIALTIMES_API_KEY is absent
 * or empty) the adapter returns an empty article list with a WARN log rather
 * than throwing an error, preserving ingestion-pipeline stability.
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

const logger = pino({ name: 'financial-times-adapter' });

// ---------------------------------------------------------------------------
// FT Content API response shapes (CAPI v1)
// Reference: https://developer.ft.com/portal/docs-api-v1-reference-content-content-items-by-search
// ---------------------------------------------------------------------------

/** An individual FT article item from the Content API search results. */
interface FtContentItem {
  /** The FT-assigned UUID for this content item. */
  id: string;
  /** Canonical URL of the article (often https://www.ft.com/content/<uuid>). */
  webUrl?: string;
  /** Primary headline. */
  title?: string;
  /**
   * Article standfirst / introductory paragraph.
   * Present under the "summary" aspect.
   */
  summary?: {
    excerpt?: string;
  };
  /**
   * Full article body as plain text or HTML.
   * Present only when the "body" aspect is requested and the subscription
   * tier allows it.
   */
  body?: {
    body?: string;
  };
  /** Author information. */
  byline?: string;
  /** ISO 8601 first-published timestamp. */
  publishedDate?: string;
  /** Generic genre/stream label (e.g., "Companies", "Markets"). */
  genre?: string;
  /** Primary section the content belongs to. */
  section?: {
    term?: {
      name?: string;
    };
  };
}

/** Wrapper returned by a CAPI search query. */
interface FtSearchResponse {
  results?: Array<{
    hits?: FtContentItem[];
    /** Total number of results available for the query (for pagination). */
    indexCount?: number;
  }>;
}

/** Lightweight response from the CAPI health / self-describe endpoint. */
interface FtHealthResponse {
  status?: string;
}

// ---------------------------------------------------------------------------
// FinancialTimesAdapter
// ---------------------------------------------------------------------------

/**
 * Tier-2 adapter for the Financial Times via the FT Content API (CAPI v1).
 *
 * Configuration (all read from environment variables):
 *
 *   NEWS_SOURCE_FINANCIALTIMES_BASE_URL  — CAPI base URL
 *                                          (default: https://api.ft.com)
 *   NEWS_SOURCE_FINANCIALTIMES_API_KEY   — FT developer API key (required for live data)
 *   NEWS_SOURCE_FINANCIALTIMES_RPM       — requests-per-minute limit (optional, default 60)
 */
export class FinancialTimesAdapter extends AbstractNewsSourceAdapter {
  // ------------------------------------------------------------------
  // NewsSourceAdapter identity
  // ------------------------------------------------------------------
  readonly sourceId = 'financial-times' as const;
  readonly sourceName = 'Financial Times' as const;
  readonly adapterVersion = '1.0.0' as const;
  readonly tier = 2 as const;

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
      process.env['NEWS_SOURCE_FINANCIALTIMES_BASE_URL'] ?? 'https://api.ft.com';

    this.apiKey =
      process.env['NEWS_SOURCE_FINANCIALTIMES_API_KEY'] ?? null;

    this._requestsPerMinute = Math.max(
      1,
      parseInt(process.env['NEWS_SOURCE_FINANCIALTIMES_RPM'] ?? '60', 10) || 60,
    );

    this.http = axios.create({
      baseURL: this._baseUrl,
      timeout: 10_000, // 10 s; reinforced by AbstractNewsSourceAdapter
      headers: {
        Accept: 'application/json',
        'User-Agent': `SentinelPulse-FinancialTimesAdapter/${this.adapterVersion}`,
        ...(this.apiKey ? { 'X-Api-Key': this.apiKey } : {}),
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
   * Probes the FT Content API to verify reachability and key validity.
   *
   * Calls the CAPI root endpoint (`GET /`) with the configured API key.
   * A 200–299 response is considered healthy; 401/403 indicates a
   * credential problem.
   */
  protected async healthCheckImpl(): Promise<HealthStatus> {
    const checkedAt = new Date();

    if (!this.apiKey) {
      return {
        healthy: false,
        message:
          'FT Content API key not configured (NEWS_SOURCE_FINANCIALTIMES_API_KEY is missing)',
        checkedAt,
      };
    }

    const start = Date.now();
    try {
      const res: AxiosResponse<FtHealthResponse> = await this.http.get('/', {
        timeout: 10_000,
      });
      const latencyMs = Date.now() - start;
      const healthy = res.status >= 200 && res.status < 300;
      return {
        healthy,
        message: healthy
          ? 'Financial Times Content API is reachable'
          : `Financial Times API returned HTTP ${res.status}`,
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
        err instanceof Error
          ? err.message
          : 'Unknown error during FT health check';
      logger.warn(
        { err, sourceId: this.sourceId },
        'Financial Times health check failed',
      );
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
   * Fetches the latest articles from the FT Content API.
   *
   * Issues a search query sorted by `lastPublished` (descending) and
   * requests the `title`, `summary`, `body`, and `lifecycle` aspects.
   *
   * Returns an empty array when the API key is not configured.
   */
  protected async fetchLatestImpl(options: FetchOptions): Promise<RawArticle[]> {
    if (!this.apiKey) {
      logger.warn(
        { sourceId: this.sourceId },
        'FT Content API key not configured — skipping fetch and returning empty list. ' +
          'Set NEWS_SOURCE_FINANCIALTIMES_API_KEY to enable live data.',
      );
      return [];
    }

    const limit = options.limit ?? 50;

    const queryBody = this.buildSearchQuery({
      since: options.since,
      limit,
      extra: options.extra,
    });

    const res: AxiosResponse<FtSearchResponse> = await this.http.post(
      '/content/search/v1',
      queryBody,
    );

    const hits = res.data.results?.[0]?.hits ?? [];
    return this.mapContentItems(hits);
  }

  /**
   * Fetches historical articles within a date range from the FT Content API.
   *
   * Returns an empty array when the API key is not configured.
   */
  protected async fetchHistoricalImpl(
    options: HistoricalFetchOptions,
  ): Promise<RawArticle[]> {
    if (!this.apiKey) {
      logger.warn(
        { sourceId: this.sourceId },
        'FT Content API key not configured — skipping historical fetch and returning empty list.',
      );
      return [];
    }

    const limit = options.limit ?? 50;
    const page = options.page ?? 1;
    const offset = (page - 1) * limit;

    const queryBody = this.buildSearchQuery({
      from: options.from,
      to: options.to,
      since: options.since,
      limit,
      offset,
      extra: options.extra,
    });

    const res: AxiosResponse<FtSearchResponse> = await this.http.post(
      '/content/search/v1',
      queryBody,
    );

    const hits = res.data.results?.[0]?.hits ?? [];
    return this.mapContentItems(hits);
  }

  // ------------------------------------------------------------------
  // normalize — maps a RawArticle to NormalizedArticle (Req 3.1)
  // ------------------------------------------------------------------

  /**
   * Maps a Financial Times RawArticle into the canonical NormalizedArticle
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
          'FinancialTimes: could not parse publishedAt — inferring current UTC time',
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
    };
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  /**
   * Builds a CAPI v1 search query body.
   *
   * The FT Content API accepts a JSON search request with a `queryString`,
   * optional date-range filters, result limit/offset, and aspect requests.
   *
   * Reference: https://developer.ft.com/portal/docs-api-v1-reference-content-content-items-by-search
   */
  private buildSearchQuery(opts: {
    from?: Date;
    to?: Date;
    since?: Date;
    limit: number;
    offset?: number;
    extra?: Record<string, unknown>;
  }): Record<string, unknown> {
    const queryContext: Record<string, unknown> = {
      curations: ['ARTICLES'],
    };

    // Date filters — prefer explicit from/to range over rolling `since`
    const dateRange: Record<string, string> = {};
    if (opts.from) {
      dateRange['greaterThan'] = opts.from.toISOString();
    } else if (opts.since) {
      dateRange['greaterThan'] = opts.since.toISOString();
    }
    if (opts.to) {
      dateRange['lessThan'] = opts.to.toISOString();
    }
    if (Object.keys(dateRange).length > 0) {
      queryContext['dateRange'] = dateRange;
    }

    const body: Record<string, unknown> = {
      queryContext,
      resultContext: {
        maxResults: opts.limit,
        offset: opts.offset ?? 0,
        aspects: ['title', 'summary', 'body', 'lifecycle', 'byline', 'classifiers'],
        sortOrder: 'DESC',
        sortField: 'lastPublishDateTime',
      },
    };

    // Pass through any caller-supplied extra parameters
    if (opts.extra) {
      for (const [key, value] of Object.entries(opts.extra)) {
        body[key] = value;
      }
    }

    return body;
  }

  /**
   * Maps FT CAPI content items into the adapter's RawArticle shape.
   *
   * Falls back gracefully when optional fields are absent.
   */
  private mapContentItems(items: FtContentItem[]): RawArticle[] {
    return items
      .filter((item) => item.id && item.title)
      .map((item): RawArticle => {
        // Canonical URL: prefer webUrl; fall back to constructing from id
        const url =
          item.webUrl ?? `https://www.ft.com/content/${item.id}`;

        // Section label used as category
        const category = item.section?.term?.name ?? item.genre ?? undefined;

        return {
          sourceId: this.sourceId,
          sourceName: this.sourceName,
          externalId: item.id,
          url,
          // CAPI returns title as a plain string at `title` after the
          // `title` aspect is requested.  The field is typed as optional
          // in the interface because the aspect may not be requested,
          // but the filter above guarantees it is present here.
          title: item.title ?? '',
          summary: item.summary?.excerpt,
          content: item.body?.body,
          author: item.byline,
          publishedAt: item.publishedDate,
          category,
          adapterVersion: this.adapterVersion,
        };
      });
  }
}
