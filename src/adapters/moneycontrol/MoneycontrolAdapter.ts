/**
 * MoneycontrolAdapter — Tier-1 RSS-based adapter for Moneycontrol.
 *
 * Moneycontrol publishes a public RSS feed which is used as the primary
 * fetch mechanism (Req 1.4: prefer official feed over scraping).
 * The ScraplingClient is used only for the health check's target-site
 * reachability probe; article fetching is fully RSS-driven.
 *
 * The adapter extends AbstractNewsSourceAdapter which provides:
 *   - SSRF allowlist validation on all outbound URLs (Req 30.4)
 *   - 10-second outbound request timeout enforcement (Req 30.6)
 *   - Exponential-backoff retry logic (Req 2.3)
 *
 * Configuration (all read from environment variables, Req 1.9):
 *
 *   NEWS_SOURCE_MONEYCONTROL_BASE_URL  — RSS feed URL
 *                                        Default: https://www.moneycontrol.com/rss/MCtopnews.xml
 *   NEWS_SOURCE_MONEYCONTROL_RPM       — requests-per-minute limit (optional, default 10)
 *   SCRAPLING_URL                      — Scrapling sidecar base URL (optional)
 *                                        Default: http://localhost:8001
 *
 * Requirements: Req 1.2, Req 1.5
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
  parseRssItems,
  stripHtml,
  type RssItem,
} from '../base/rss-parser.js';
import { ScraplingClient } from '../../integrations/scrapling/ScraplingClient.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger = pino({ name: 'moneycontrol-adapter' });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MC_SOURCE_ID = 'moneycontrol';
const MC_SOURCE_NAME = 'Moneycontrol';
const ADAPTER_VERSION = '1.0.0';

/** Default RSS feed URL. Overridable via NEWS_SOURCE_MONEYCONTROL_BASE_URL. */
const DEFAULT_FEED_URL = 'https://www.moneycontrol.com/rss/MCtopnews.xml';

/** Maximum content length in characters before truncation (Req 3.5). */
const MAX_CONTENT_LENGTH = 50_000;

// ---------------------------------------------------------------------------
// MoneycontrolAdapter
// ---------------------------------------------------------------------------

/**
 * Tier-1 adapter for Moneycontrol news via their public RSS feed.
 *
 * `healthCheckImpl()` verifies both the Scrapling sidecar (via
 * ScraplingClient.healthCheck()) and the Moneycontrol RSS feed itself
 * (HTTP 200 check).
 *
 * `fetchLatestImpl()` fetches and parses the RSS XML, returning up to
 * `options.limit` (default 50) articles.
 *
 * `fetchHistoricalImpl()` is a best-effort client-side date-range filter
 * over the same RSS feed (RSS has no server-side historical pagination).
 *
 * `normalize()` maps RawArticle fields to the canonical NormalizedArticle,
 * using the same SHA-256 hash logic as ReutersAdapter.
 */
export class MoneycontrolAdapter extends AbstractNewsSourceAdapter {
  // ------------------------------------------------------------------
  // NewsSourceAdapter identity
  // ------------------------------------------------------------------
  readonly sourceId = MC_SOURCE_ID;
  readonly sourceName = MC_SOURCE_NAME;
  readonly adapterVersion = ADAPTER_VERSION;
  readonly tier = 1;

  // ------------------------------------------------------------------
  // Configuration
  // ------------------------------------------------------------------
  private readonly feedUrl: string;
  private readonly _requestsPerMinute: number;
  private readonly http: AxiosInstance;
  private readonly scraplingClient: ScraplingClient;

  constructor(scraplingClient?: ScraplingClient) {
    super();

    this.feedUrl =
      process.env['NEWS_SOURCE_MONEYCONTROL_BASE_URL'] ?? DEFAULT_FEED_URL;

    this._requestsPerMinute = Math.max(
      1,
      parseInt(process.env['NEWS_SOURCE_MONEYCONTROL_RPM'] ?? '10', 10) || 10,
    );

    this.http = axios.create({
      timeout: 10_000,
      headers: {
        Accept: 'application/rss+xml, application/xml, text/xml, */*',
        'User-Agent': `SentinelPulse-MoneycontrolAdapter/${this.adapterVersion}`,
      },
    });

    // Allow injection for testing; default to a real ScraplingClient
    this.scraplingClient = scraplingClient ?? new ScraplingClient();
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
   * Checks health by:
   *   1. Probing the Scrapling sidecar via ScraplingClient.healthCheck().
   *   2. Probing the Moneycontrol RSS feed URL for an HTTP 200 response.
   *
   * Reports healthy only when both checks pass. Returns a combined message
   * and latency for the RSS endpoint.
   */
  protected async healthCheckImpl(): Promise<HealthStatus> {
    const checkedAt = new Date();
    const start = Date.now();

    // --- Scrapling sidecar check ---
    let sidecarHealthy = false;
    try {
      sidecarHealthy = await this.scraplingClient.healthCheck();
    } catch (err: unknown) {
      logger.warn(
        { err, sourceId: this.sourceId },
        'Moneycontrol: Scrapling sidecar health check threw',
      );
    }

    if (!sidecarHealthy) {
      const latencyMs = Date.now() - start;
      logger.warn(
        { sourceId: this.sourceId, latencyMs },
        'Moneycontrol health check failed: Scrapling sidecar is not healthy',
      );
      return {
        healthy: false,
        message: 'Scrapling sidecar is not healthy',
        checkedAt,
        latencyMs,
      };
    }

    // --- Moneycontrol RSS feed check ---
    try {
      const res = await this.http.get<string>(this.feedUrl, {
        responseType: 'text',
        maxContentLength: 512_000,
      });
      const latencyMs = Date.now() - start;
      const healthy = res.status >= 200 && res.status < 300;

      return {
        healthy,
        message: healthy
          ? 'Moneycontrol RSS feed is reachable'
          : `Moneycontrol RSS feed returned HTTP ${res.status}`,
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
          : 'Unknown error during Moneycontrol health check';

      logger.warn(
        { err, sourceId: this.sourceId },
        'Moneycontrol RSS feed health check failed',
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
   * Fetches the Moneycontrol RSS feed and returns parsed articles as
   * RawArticle[].
   *
   * Applies `options.limit` (default: 50) and optionally filters by
   * `options.since` (earliest publication date).
   */
  protected async fetchLatestImpl(options: FetchOptions): Promise<RawArticle[]> {
    const limit = options.limit ?? 50;

    const res = await this.http.get<string>(this.feedUrl, {
      responseType: 'text',
    });

    const items = parseRssItems(res.data);
    logger.debug(
      { sourceId: this.sourceId, itemCount: items.length },
      'Parsed RSS items from Moneycontrol feed',
    );

    let articles = items.map((item) => this.mapRssItemToRawArticle(item));

    // Filter by `since` if provided
    if (options.since) {
      const since = options.since;
      articles = articles.filter((a) => {
        if (!a.publishedAt) return true;
        const parsed = new Date(a.publishedAt);
        return isNaN(parsed.getTime()) || parsed >= since;
      });
    }

    return articles.slice(0, limit);
  }

  /**
   * Fetches historical articles from the Moneycontrol RSS feed.
   *
   * RSS feeds do not support server-side historical pagination. This
   * implementation fetches the same live feed and applies a client-side
   * date-range filter. Articles outside `[from, to]` are discarded.
   */
  protected async fetchHistoricalImpl(
    options: HistoricalFetchOptions,
  ): Promise<RawArticle[]> {
    const latest = await this.fetchLatestImpl({
      limit: options.limit,
      since: options.from,
      extra: options.extra,
    });

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
   * Maps a Moneycontrol RawArticle into the canonical NormalizedArticle.
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
          'Moneycontrol: could not parse publishedAt — inferring current UTC time',
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
    // ------------------------------------------------------------------
    const rawContent = raw.content ?? raw.summary ?? null;
    let stripped: string | null =
      rawContent !== null ? stripHtml(rawContent) : null;

    let contentTruncated = false;
    if (stripped !== null && stripped.length > MAX_CONTENT_LENGTH) {
      const slice = stripped.slice(0, MAX_CONTENT_LENGTH);
      const lastSpace = slice.lastIndexOf(' ');
      stripped = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
      contentTruncated = true;
    }

    const summary = raw.summary ? stripHtml(raw.summary) : null;

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
      contentDepth: 'SUMMARY' as const,
      contentQualityScore: 0.5,
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
