/**
 * CoinDeskAdapter — Tier-2 RSS-based adapter for CoinDesk.
 *
 * CoinDesk provides a public RSS feed at:
 *   https://www.coindesk.com/arc/outboundfeeds/rss/
 *
 * This adapter uses that feed as its primary fetch mechanism (Req 1.4:
 * prefer official feed over scraping). It extends AbstractNewsSourceAdapter
 * which provides:
 *   - SSRF allowlist validation on all outbound URLs (Req 30.4)
 *   - 10-second outbound request timeout enforcement (Req 30.6)
 *   - Exponential-backoff retry logic (Req 2.3)
 *
 * CoinDesk covers crypto and digital asset news. When an RSS item carries no
 * explicit category tag, `normalize()` defaults to 'CRYPTO_MARKET'.
 *
 * Configuration (all read from environment variables, Req 1.9):
 *
 *   NEWS_SOURCE_COINDESK_BASE_URL   — RSS feed URL
 *                                     Default: https://www.coindesk.com/arc/outboundfeeds/rss/
 *   NEWS_SOURCE_COINDESK_RPM        — requests-per-minute limit (optional, default 5)
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

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger = pino({ name: 'coindesk-adapter' });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COINDESK_SOURCE_ID = 'coindesk' as const;
const COINDESK_SOURCE_NAME = 'CoinDesk' as const;
const ADAPTER_VERSION = '1.0.0' as const;

/** Default RSS feed URL. Overridable via NEWS_SOURCE_COINDESK_BASE_URL. */
const DEFAULT_FEED_URL = 'https://www.coindesk.com/arc/outboundfeeds/rss/';

/** Fallback category for CoinDesk articles with no category tag. */
const DEFAULT_CATEGORY = 'CRYPTO_MARKET';

/** Maximum content length in characters before truncation (Req 3.5). */
const MAX_CONTENT_LENGTH = 50_000;

// ---------------------------------------------------------------------------
// RSS item shape — internal to this module
// ---------------------------------------------------------------------------

interface RssItem {
  guid: string;
  link: string;
  title: string;
  description: string;
  pubDate: string;
  author: string;
  /** Category tag extracted from <category> or <media:category>. */
  category: string;
}

// ---------------------------------------------------------------------------
// CoinDeskAdapter
// ---------------------------------------------------------------------------

/**
 * Tier-2 adapter for CoinDesk news via their public RSS feed.
 *
 * `healthCheckImpl()` probes the feed URL and checks for HTTP 200.
 * `fetchLatestImpl()` fetches and parses the RSS XML, returning up to
 * `options.limit` (default: 50) articles.
 * `fetchHistoricalImpl()` is a best-effort date-range filter over the
 * same RSS feed (RSS has no server-side historical pagination).
 * `normalize()` maps RawArticle fields to the canonical NormalizedArticle,
 * defaulting category to 'CRYPTO_MARKET' when none is present.
 */
export class CoinDeskAdapter extends AbstractNewsSourceAdapter {
  // ------------------------------------------------------------------
  // NewsSourceAdapter identity
  // ------------------------------------------------------------------
  readonly sourceId = COINDESK_SOURCE_ID;
  readonly sourceName = COINDESK_SOURCE_NAME;
  readonly adapterVersion = ADAPTER_VERSION;
  readonly tier = 2 as const;

  // ------------------------------------------------------------------
  // Configuration
  // ------------------------------------------------------------------
  private readonly feedUrl: string;
  private readonly _requestsPerMinute: number;
  private readonly http: AxiosInstance;

  constructor() {
    super();

    this.feedUrl =
      process.env['NEWS_SOURCE_COINDESK_BASE_URL'] ?? DEFAULT_FEED_URL;

    // Tier-2 conservative default of 5 RPM (CoinDesk has no published
    // rate-limit policy for RSS; 5 RPM is safe for a public feed).
    this._requestsPerMinute = Math.max(
      1,
      parseInt(process.env['NEWS_SOURCE_COINDESK_RPM'] ?? '5', 10) || 5,
    );

    this.http = axios.create({
      timeout: 10_000,
      headers: {
        Accept: 'application/rss+xml, application/xml, text/xml, */*',
        'User-Agent': `SentinelPulse-CoinDeskAdapter/${this.adapterVersion}`,
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
   * Probes the CoinDesk RSS endpoint and checks for an HTTP 200 response.
   * Measures round-trip latency and returns it in the HealthStatus.
   */
  protected async healthCheckImpl(): Promise<HealthStatus> {
    const checkedAt = new Date();
    const start = Date.now();

    try {
      const res = await this.http.get<string>(this.feedUrl, {
        responseType: 'text',
        maxContentLength: 4096, // Only need enough to detect a valid response
      });
      const latencyMs = Date.now() - start;
      const healthy = res.status >= 200 && res.status < 300;

      return {
        healthy,
        message: healthy
          ? 'CoinDesk RSS feed is reachable'
          : `CoinDesk RSS feed returned HTTP ${res.status}`,
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
          : 'Unknown error during CoinDesk health check';

      logger.warn({ err, sourceId: this.sourceId }, 'CoinDesk health check failed');

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
   * Fetches the CoinDesk RSS feed and returns parsed articles as RawArticle[].
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
      'Parsed RSS items from CoinDesk feed',
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
   * Fetches historical articles from the CoinDesk RSS feed.
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
   * Maps a CoinDesk RawArticle into the canonical NormalizedArticle.
   *
   * - Absent optional fields are set to `null` (Req 3.1).
   * - `category` defaults to 'CRYPTO_MARKET' when no category is present,
   *   since CoinDesk exclusively covers crypto and digital asset news.
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
          'CoinDesk: could not parse publishedAt — inferring current UTC time',
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

    // ------------------------------------------------------------------
    // Category — default to CRYPTO_MARKET for CoinDesk content
    // ------------------------------------------------------------------
    const category = raw.category ?? DEFAULT_CATEGORY;

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
      category: item.category || undefined,
      adapterVersion: this.adapterVersion,
    };
  }
}

// ---------------------------------------------------------------------------
// RSS XML parser — no external dependencies required
// ---------------------------------------------------------------------------

/**
 * Parses the `<item>` elements from an RSS 2.0 XML string.
 *
 * Handles:
 *   - CDATA sections: `<![CDATA[...]]>`
 *   - Self-closing or empty elements
 *   - `<dc:creator>` as an alternative author field
 *   - `<author>` containing either a bare name or an RFC 5322 address
 *     (`email (Name)` or `Name <email>`)
 *   - `<category>` and `<media:category>` for article topic classification
 *
 * Returns an empty array if the XML cannot be parsed or contains no items.
 */
export function parseRssItems(xmlString: string): RssItem[] {
  if (!xmlString || typeof xmlString !== 'string') return [];

  // Extract all <item>...</item> blocks (non-greedy, handles multi-line)
  const itemPattern = /<item>([\s\S]*?)<\/item>/gi;
  const items: RssItem[] = [];
  let itemMatch: RegExpExecArray | null;

  while ((itemMatch = itemPattern.exec(xmlString)) !== null) {
    const itemXml = itemMatch[1] ?? '';

    items.push({
      guid: extractField(itemXml, 'guid'),
      link: extractField(itemXml, 'link'),
      title: extractField(itemXml, 'title'),
      description: extractField(itemXml, 'description'),
      pubDate: extractField(itemXml, 'pubDate'),
      author: extractAuthor(itemXml),
      category: extractCategory(itemXml),
    });
  }

  return items;
}

/**
 * Extracts the text content of the first occurrence of `<tagName>...</tagName>`
 * within `xml`, unwrapping any CDATA section and decoding HTML entities.
 *
 * Returns an empty string when the tag is not found.
 */
function extractField(xml: string, tagName: string): string {
  const pattern = new RegExp(
    `<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`,
    'i',
  );
  const match = pattern.exec(xml);
  if (!match || match[1] === undefined) return '';

  return unwrapAndDecode(match[1]);
}

/**
 * Extracts the article author from either `<author>` or `<dc:creator>`.
 * Prefers `<dc:creator>` which is more commonly used in news RSS feeds.
 */
function extractAuthor(itemXml: string): string {
  // Try <dc:creator> first (Dublin Core, used by many news RSS feeds)
  const dcCreator = extractField(itemXml, 'dc:creator');
  if (dcCreator) return dcCreator;

  // Fall back to <author> — may contain "email (Name)" RFC 5322 format
  const author = extractField(itemXml, 'author');
  if (!author) return '';

  // If the author looks like an RFC 5322 address (contains '@'), attempt to
  // extract just the display name portion.
  if (author.includes('@')) {
    // Format: "email@example.com (Display Name)"
    const parenMatch = /\(([^)]+)\)/.exec(author);
    if (parenMatch && parenMatch[1]) return parenMatch[1].trim();

    // Format: "Display Name <email@example.com>"
    const angleMatch = /^([^<]+)</.exec(author);
    if (angleMatch && angleMatch[1]) return angleMatch[1].trim();
  }

  return author;
}

/**
 * Extracts the category from `<category>` or `<media:category>`.
 * Returns an empty string when neither tag is present.
 */
function extractCategory(itemXml: string): string {
  // Try <category> first
  const category = extractField(itemXml, 'category');
  if (category) return category;

  // Fall back to <media:category>
  return extractField(itemXml, 'media:category');
}

/**
 * Strips a CDATA wrapper (if present) and decodes common HTML entities
 * from a raw XML text node.
 */
function unwrapAndDecode(raw: string): string {
  let text = raw.trim();

  // Unwrap CDATA: <![CDATA[...]]>
  const cdataMatch = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(text);
  if (cdataMatch && cdataMatch[1] !== undefined) {
    text = cdataMatch[1];
  }

  // Decode common XML / HTML entities
  return decodeHtmlEntities(text);
}

/**
 * Decodes common XML / HTML character entities.
 * Covers the five predefined XML entities plus the most common HTML ones.
 */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCharCode(parseInt(code, 10)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(/&nbsp;/gi, ' ')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&ldquo;/gi, '\u201C')
    .replace(/&rdquo;/gi, '\u201D')
    .replace(/&lsquo;/gi, '\u2018')
    .replace(/&rsquo;/gi, '\u2019')
    .replace(/&hellip;/gi, '…');
}

// ---------------------------------------------------------------------------
// HTML stripper — used during normalize()
// ---------------------------------------------------------------------------

/**
 * Strips HTML tags from a string, converting block-level elements to
 * newlines to preserve paragraph structure (Req 3.4).
 *
 * Processing order:
 *   1. Replace block-level closing tags with newlines.
 *   2. Remove all remaining tags.
 *   3. Decode HTML entities.
 *   4. Collapse excessive blank lines (> 2 consecutive newlines).
 *   5. Trim leading/trailing whitespace.
 */
export function stripHtml(html: string): string {
  if (!html) return '';

  let text = html;

  // Replace block-level closing tags with a newline to preserve structure
  const blockTags =
    /(<\/(?:p|div|br|li|h[1-6]|blockquote|article|section|header|footer|nav|aside|pre|tr|td|th)[^>]*>)/gi;
  text = text.replace(blockTags, '\n');

  // Also replace self-closing <br /> with newlines
  text = text.replace(/<br\s*\/?>/gi, '\n');

  // Strip all remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode entities
  text = decodeHtmlEntities(text);

  // Collapse excessive blank lines (more than two consecutive newlines)
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}
