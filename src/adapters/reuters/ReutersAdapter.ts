/**
 * ReutersAdapter — Tier-1 RSS-based adapter for Reuters.
 *
 * Reuters provides a public RSS feed that serves as the primary fetch
 * mechanism for this adapter (Req 1.4: prefer official feed over scraping).
 *
 * The adapter extends AbstractNewsSourceAdapter which provides:
 *   - SSRF allowlist validation on all outbound URLs (Req 30.4)
 *   - 10-second outbound request timeout enforcement (Req 30.6)
 *   - Exponential-backoff retry logic (Req 2.3)
 *
 * Configuration (all read from environment variables, Req 1.9):
 *
 *   NEWS_SOURCE_REUTERS_BASE_URL      — RSS feed URL
 *                                       Default: https://feeds.reuters.com/reuters/topNews
 *   NEWS_SOURCE_REUTERS_RPM           — requests-per-minute limit (optional, default 10)
 *
 * Requirements: Req 1.2, Req 1.4
 */

import crypto from 'node:crypto';
import { pino } from 'pino';
import axios, { type AxiosInstance } from 'axios';
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
import {
  parseRssItems as _parseRssItems,
  stripHtml as _stripHtml,
  type RssItem,
} from '../base/rss-parser.js';

// ---------------------------------------------------------------------------
// Re-export shared utilities so that existing consumers (tests, other modules)
// that import from this file continue to work without modification.
// ---------------------------------------------------------------------------
export { parseRssItems, stripHtml, decodeHtmlEntities } from '../base/rss-parser.js';
export type { RssItem } from '../base/rss-parser.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger = pino({ name: 'reuters-adapter' });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REUTERS_SOURCE_ID = 'reuters' as const;
const REUTERS_SOURCE_NAME = 'Reuters' as const;
const ADAPTER_VERSION = '1.0.0' as const;

/** Default RSS feed URL. Overridable via NEWS_SOURCE_REUTERS_BASE_URL. */
const DEFAULT_FEED_URL = 'https://feeds.reuters.com/reuters/topNews';

/** Maximum content length in characters before truncation (Req 3.5). */
const MAX_CONTENT_LENGTH = 50_000;

// RssItem type is imported and re-exported from the shared rss-parser module.

// ---------------------------------------------------------------------------
// ReutersAdapter
// ---------------------------------------------------------------------------

/**
 * Tier-1 adapter for Reuters news via their public RSS feed.
 *
 * `healthCheckImpl()` probes the feed URL and checks for HTTP 200.
 * `fetchLatestImpl()` fetches and parses the RSS XML, returning up to
 * `options.limit` (default: 50) articles.
 * `fetchHistoricalImpl()` is a best-effort date-range filter over the
 * same RSS feed (RSS has no server-side historical pagination).
 * `normalize()` maps RawArticle fields to the canonical NormalizedArticle.
 */
export class ReutersAdapter extends AbstractNewsSourceAdapter {
  // ------------------------------------------------------------------
  // NewsSourceAdapter identity
  // ------------------------------------------------------------------
  readonly sourceId = REUTERS_SOURCE_ID;
  readonly sourceName = REUTERS_SOURCE_NAME;
  readonly adapterVersion = ADAPTER_VERSION;
  readonly tier = 1 as const;

  // ------------------------------------------------------------------
  // Configuration
  // ------------------------------------------------------------------
  private readonly feedUrl: string;
  private readonly _requestsPerMinute: number;
  private readonly http: AxiosInstance;

  constructor() {
    super();

    this.feedUrl =
      process.env['NEWS_SOURCE_REUTERS_BASE_URL'] ?? DEFAULT_FEED_URL;

    this._requestsPerMinute = Math.max(
      1,
      parseInt(process.env['NEWS_SOURCE_REUTERS_RPM'] ?? '10', 10) || 10,
    );

    this.http = axios.create({
      timeout: 10_000,
      headers: {
        Accept: 'application/rss+xml, application/xml, text/xml, */*',
        'User-Agent': `SentinelPulse-ReutersAdapter/${this.adapterVersion}`,
      },
    });
  }

  // ------------------------------------------------------------------
  // AbstractNewsSourceAdapter — baseUrl (drives SSRF guard)
  // ------------------------------------------------------------------

  protected override get baseUrl(): string {
    return this.feedUrl;
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
   * Probes the Reuters RSS endpoint and checks for an HTTP 200 response.
   * Measures round-trip latency and returns it in the HealthStatus.
   */
  protected async healthCheckImpl(): Promise<HealthStatus> {
    const checkedAt = new Date();
    const start = Date.now();

    try {
      const res = await this.http.get<string>(this.feedUrl, {
        // A HEAD request would be lighter but many RSS servers reject it;
        // fetch with a streaming response and abort early instead.
        responseType: 'text',
        maxContentLength: 4096, // Only need enough to detect a valid response
      });
      const latencyMs = Date.now() - start;
      const healthy = res.status >= 200 && res.status < 300;

      return {
        healthy,
        message: healthy
          ? 'Reuters RSS feed is reachable'
          : `Reuters RSS feed returned HTTP ${res.status}`,
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
          : 'Unknown error during Reuters health check';

      logger.warn({ err, sourceId: this.sourceId }, 'Reuters health check failed');

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
   * Fetches the Reuters RSS feed and returns parsed articles as RawArticle[].
   *
   * Applies `options.limit` (default: 50) and optionally filters by
   * `options.since` (earliest publication date).
   */
  protected async fetchLatestImpl(options: FetchOptions): Promise<RawArticle[]> {
    const limit = options.limit ?? 50;

    const res = await this.http.get<string>(this.feedUrl, {
      responseType: 'text',
    });

    const items = _parseRssItems(res.data);
    logger.debug(
      { sourceId: this.sourceId, itemCount: items.length },
      'Parsed RSS items from Reuters feed',
    );

    let articles = items.map((item) => this.mapRssItemToRawArticle(item));

    // Filter by `since` if provided
    if (options.since) {
      const since = options.since;
      articles = articles.filter((a) => {
        if (!a.publishedAt) return true; // keep articles with no date
        const parsed = new Date(a.publishedAt);
        return isNaN(parsed.getTime()) || parsed >= since;
      });
    }

    return articles.slice(0, limit);
  }

  /**
   * Fetches historical articles from the Reuters RSS feed.
   *
   * RSS feeds do not support server-side historical pagination. This
   * implementation fetches the same live feed and applies a client-side
   * date-range filter. Articles outside `[from, to]` are discarded.
   *
   * For true historical backfill, a dedicated historical data provider
   * would be needed; this best-effort approach satisfies the interface
   * contract for sources that only expose a rolling feed.
   */
  protected async fetchHistoricalImpl(
    options: HistoricalFetchOptions,
  ): Promise<RawArticle[]> {
    // Reuse fetchLatestImpl with the `since` filter for the lower bound
    const latest = await this.fetchLatestImpl({
      limit: options.limit,
      since: options.from,
      extra: options.extra,
    });

    // Apply upper bound filter (options.to)
    const to = options.to;
    return latest.filter((a) => {
      if (!a.publishedAt) return true;
      const parsed = new Date(a.publishedAt);
      return isNaN(parsed.getTime()) || parsed <= to;
    });
  }

  // ------------------------------------------------------------------
  // normalize — maps a RawArticle to NormalizedArticle (Req 3.1)
  // ------------------------------------------------------------------

  /**
   * Maps a Reuters RawArticle into the canonical NormalizedArticle.
   *
   * - Absent optional fields are set to `null` (Req 3.1).
   * - `publishedAt` falls back to scrapedAt when missing or unparseable,
   *   and `timestampInferred` is set to `true` (Req 3.3).
   * - `contentHash`: SHA-256 of stripped, whitespace-normalised content (Req 3.7).
   * - `titleHash`: SHA-256 of lowercased, punctuation-stripped,
   *   whitespace-normalised title (Req 3.7).
   * - Content is truncated at a word boundary at or before 50,000 chars (Req 3.5).
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
          'Reuters: could not parse publishedAt — inferring current UTC time',
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
    // Content — strip HTML tags and normalise whitespace (Req 3.4)
    // RSS <description> fields often contain HTML entities and tags.
    // ------------------------------------------------------------------
    const rawContent = raw.content ?? raw.summary ?? null;
    let stripped: string | null =
      rawContent !== null ? _stripHtml(rawContent) : null;

    let contentTruncated = false;
    if (stripped !== null && stripped.length > MAX_CONTENT_LENGTH) {
      const slice = stripped.slice(0, MAX_CONTENT_LENGTH);
      const lastSpace = slice.lastIndexOf(' ');
      stripped = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
      contentTruncated = true;
    }

    const summary = raw.summary ? _stripHtml(raw.summary) : null;

    // ------------------------------------------------------------------
    // Hashes (SHA-256, Req 3.7)
    // ------------------------------------------------------------------
    const contentForHash = (stripped ?? '').trim().replace(/\s+/g, ' ');
    const contentHash = crypto
      .createHash('sha256')
      .update(contentForHash, 'utf8')
      .digest('hex');

    const titleForHash = raw.title
      .toLowerCase()
      .replace(/[^\w\s]/g, '') // strip punctuation
      .replace(/\s+/g, ' ')
      .trim();
    const titleHash = crypto
      .createHash('sha256')
      .update(titleForHash, 'utf8')
      .digest('hex');

    return {
      id: uuidv4(),
      sourceId: raw.sourceId,
      sourceName: raw.sourceName,
      externalId: raw.externalId,
      canonicalUrl: raw.url,
      title: raw.title,
      summary: summary ?? null,
      content: stripped,
      author: raw.author ?? null,
      language: 'en',
      languageConfidence: 0,
      publishedAt,
      scrapedAt,
      category: raw.category ?? null,
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

  /** Maps a parsed RSS item to the RawArticle shape. */
  private mapRssItemToRawArticle(item: RssItem): RawArticle {
    return {
      sourceId: this.sourceId,
      sourceName: this.sourceName,
      // Prefer <guid> as the stable external identifier; fall back to the link.
      externalId: item.guid || item.link,
      url: item.link,
      title: item.title,
      summary: item.description || undefined,
      content: item.description || undefined,
      author: item.author || undefined,
      publishedAt: item.pubDate || undefined,
      adapterVersion: this.adapterVersion,
    };
  }
}

// ---------------------------------------------------------------------------
// RSS parsing and HTML utilities are provided by the shared
// src/adapters/base/rss-parser.ts module and re-exported above.
// ---------------------------------------------------------------------------
