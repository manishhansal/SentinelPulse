/**
 * NormalizationEngine.ts — Article normalization pipeline for SentinelPulse.
 *
 * Consumes RawArticle payloads from the `news.raw` BullMQ queue, produces
 * NormalizedArticle records, persists them to `news_articles`, and publishes
 * them to the `news.normalized` BullMQ queue.
 *
 * Error handling:
 *   - Normalization failure  → write to `news_processing_errors`;
 *     if DB unavailable, retry 3× at 20 s intervals (Req 3.9).
 *   - `news.normalized` unavailable → retry enqueue 3× at 5 s intervals,
 *     then write error record and discard (Req 3.10).
 *
 * Requirements: Req 3.1–3.10, Req 7.1–7.3
 */

import { randomUUID, createHash } from 'node:crypto';
import { pino } from 'pino';
import type { Queue } from 'bullmq';
import type { RawArticle, NormalizedArticle } from '../../adapters/base/NewsSourceAdapter.js';
import { HtmlStripper } from './HtmlStripper.js';
import { LanguageDetector } from './LanguageDetector.js';
import { prisma } from '../../db/prisma.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger = pino({ name: 'normalization-engine' });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum content length in characters after HTML stripping (Req 3.5). */
const MAX_CONTENT_LENGTH = 50_000;

/** Minimum confidence for taxonomy category classification (Req 7.2). */
const CATEGORY_CONFIDENCE_THRESHOLD = 0.6;

/** Confidence returned when a keyword match is found. */
const MATCHED_CONFIDENCE = 0.7;

/** Confidence recorded when no category is determinable (UNCLASSIFIED). */
const UNCLASSIFIED_CONFIDENCE = 0.4;

/** Maximum number of secondary categories (Req 7.1). */
const MAX_SECONDARY_CATEGORIES = 5;

/** Maximum retries for writing to news_processing_errors (Req 3.9). */
const ERROR_WRITE_MAX_RETRIES = 3;

/** Delay between error-write retries in milliseconds (Req 3.9). */
const ERROR_WRITE_RETRY_DELAY_MS = 20_000;

/** Maximum retries for publishing to news.normalized queue (Req 3.10). */
const QUEUE_PUBLISH_MAX_RETRIES = 3;

/** Delay between queue publish retries in milliseconds (Req 3.10). */
const QUEUE_PUBLISH_RETRY_DELAY_MS = 5_000;

// ---------------------------------------------------------------------------
// Content depth classification
//
// Determines how much substance the article body actually carries.
// Reuters via Google News RSS returns snippet-length summaries only;
// assigning full-content confidence to these would misrepresent data quality.
// ---------------------------------------------------------------------------

/**
 * Depth of available article content.
 *
 *   FULL_ARTICLE   — full article body (≥ 500 words after stripping)
 *   SUMMARY        — multi-sentence abstract (100–499 words)
 *   HEADLINE_ONLY  — title plus at most a one-sentence snippet (< 100 words)
 */
export type ContentDepth = 'FULL_ARTICLE' | 'SUMMARY' | 'HEADLINE_ONLY';

/**
 * Word-count thresholds for content depth classification.
 * Calibrated empirically against live RSS feed samples (Phase 2):
 *   Reuters Google News: 15–35 words → HEADLINE_ONLY
 *   Moneycontrol RSS:    80–200 words → SUMMARY
 *   Economic Times RSS:  50–400 words → SUMMARY / FULL_ARTICLE
 *   CoinDesk RSS:        50–250 words → SUMMARY
 */
const FULL_ARTICLE_WORD_THRESHOLD = 500;
const SUMMARY_WORD_THRESHOLD = 100;

/** Per-source content-depth overrides for known summary-only adapters. */
const SOURCE_DEPTH_OVERRIDES: Record<string, ContentDepth> = {
  // Reuters articles arrive via Google News RSS which provides only
  // the title + one-sentence snippet regardless of article length.
  reuters: 'HEADLINE_ONLY',
};

/**
 * Classifies the content depth of an article.
 *
 * Priority:
 *   1. Explicit per-source override (always authoritative).
 *   2. Word-count heuristic on the combined title + content text.
 */
function classifyContentDepth(
  sourceId: string,
  title: string,
  content: string | null,
): ContentDepth {
  // 1. Source-level override
  const override = SOURCE_DEPTH_OVERRIDES[sourceId];
  if (override) return override;

  // 2. Word-count heuristic
  const text = [title, content].filter(Boolean).join(' ');
  const wordCount = text.trim().split(/\s+/).filter((w) => w.length > 0).length;

  if (wordCount >= FULL_ARTICLE_WORD_THRESHOLD) return 'FULL_ARTICLE';
  if (wordCount >= SUMMARY_WORD_THRESHOLD) return 'SUMMARY';
  return 'HEADLINE_ONLY';
}

/**
 * Computes a content quality score in [0, 1].
 *
 * The score reflects how much raw information is available for downstream
 * sentiment/entity/event extraction.  It incorporates:
 *   - content_depth weight
 *   - whether the timestamp was inferred (reduces confidence)
 *   - whether content was truncated (minor penalty)
 *
 * This score is stored in news_articles.content_quality_score and used by
 * the source-confidence calculation in ImportanceEngine.
 */
function computeContentQualityScore(
  depth: ContentDepth,
  timestampInferred: boolean,
  contentTruncated: boolean,
): number {
  const depthScore: Record<ContentDepth, number> = {
    FULL_ARTICLE: 1.0,
    SUMMARY: 0.65,
    HEADLINE_ONLY: 0.25,
  };

  let score = depthScore[depth];

  // Penalties
  if (timestampInferred) score -= 0.10;
  if (contentTruncated) score -= 0.05;

  return Math.max(0, Math.min(1, score));
}

// ---------------------------------------------------------------------------
// Taxonomy keyword map (Req 7.1)
//
// Maps each taxonomy category to an array of case-insensitive keyword strings.
// All categories from the spec are represented.
// ---------------------------------------------------------------------------

const TAXONOMY_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  // Indian Market
  NIFTY50: ['nifty 50', 'nifty50', 'nifty index'],
  SENSEX: ['sensex', 'bse sensex', 'bse 30'],
  BANKNIFTY: ['banknifty', 'bank nifty', 'nifty bank'],
  NIFTY_MIDCAP: ['nifty midcap', 'midcap 100', 'midcap index'],
  NIFTY_SMALLCAP: ['nifty smallcap', 'smallcap 100', 'smallcap index'],
  SEBI: ['sebi', 'securities and exchange board', 'market regulator india'],
  FII_DII_FLOWS: ['fii', 'dii', 'foreign institutional investor', 'domestic institutional investor', 'fpi flows'],
  INDIA_MACRO: ['india gdp', 'india inflation', 'india cpi', 'india iip', 'india pmi', 'rbi policy', 'india economy'],

  // Global Market
  US_MARKET: ['dow jones', 'nasdaq', 's&p 500', 'sp500', 'wall street', 'nyse', 'us stock', 'american stock'],
  EUROPE_MARKET: ['ftse', 'dax', 'cac 40', 'eurostoxx', 'european market', 'london stock exchange'],
  ASIA_MARKET: ['nikkei', 'hang seng', 'kospi', 'shanghai composite', 'asia market', 'asx 200'],
  GLOBAL_MACRO: ['global gdp', 'world economy', 'imf', 'world bank', 'global recession', 'global inflation'],
  FED_POLICY: ['federal reserve', 'fed rate', 'fomc', 'jerome powell', 'fed funds rate', 'us monetary policy'],
  ECB_POLICY: ['ecb', 'european central bank', 'lagarde', 'euro rate', 'eurozone rate'],

  // Commodities
  CRUDE_OIL: ['crude oil', 'brent crude', 'wti', 'petroleum', 'oil price', 'opec'],
  GOLD: ['gold price', 'gold futures', 'spot gold', 'precious metal', 'gold etf'],
  SILVER: ['silver price', 'silver futures', 'spot silver'],
  NATURAL_GAS: ['natural gas', 'lng', 'gas price', 'henry hub'],
  AGRI_COMMODITIES: ['wheat', 'corn', 'soybean', 'rice price', 'sugar price', 'agri commodity', 'cotton price'],
  METALS: ['copper price', 'aluminum price', 'zinc price', 'steel price', 'base metal'],

  // Crypto
  BITCOIN: ['bitcoin', 'btc price', 'btc usd'],
  ETHEREUM: ['ethereum', 'eth price', 'eth usd', 'ether'],
  CRYPTO_REGULATION: ['crypto regulation', 'cryptocurrency regulation', 'sec crypto', 'crypto ban', 'crypto law'],
  CRYPTO_MARKET: ['crypto market', 'cryptocurrency', 'blockchain', 'defi', 'altcoin', 'digital asset'],

  // Company Events
  EARNINGS: [
    'quarterly results',
    'earnings report',
    'q1 results',
    'q2 results',
    'q3 results',
    'q4 results',
    'net profit',
    'revenue miss',
    'revenue beat',
    'eps',
  ],
  MERGERS_ACQUISITIONS: ['merger', 'acquisition', 'takeover', 'm&a', 'buyout', 'deal announcement'],
  IPO: ['ipo', 'initial public offering', 'listing', 'public offering', 'ipo subscription'],
  DIVIDENDS: ['dividend', 'dividend announcement', 'dividend yield', 'interim dividend', 'final dividend'],
  BUYBACKS: ['buyback', 'share repurchase', 'stock buyback'],
  MANAGEMENT_CHANGE: ['ceo change', 'cfo change', 'ceo resign', 'ceo appoint', 'management change', 'board change'],

  // Geopolitical
  MIDDLE_EAST: ['middle east', 'israel', 'iran', 'saudi arabia conflict', 'gaza', 'lebanon'],
  RUSSIA_UKRAINE: ['russia ukraine', 'ukraine war', 'russia sanctions', 'ukraine conflict'],
  US_CHINA: ['us china trade', 'china tariff', 'china sanctions', 'us china tension'],
  INDIA_CHINA: ['india china border', 'lac tension', 'india china conflict', 'doklam', 'galwan'],
  GLOBAL_SANCTIONS: ['sanctions', 'economic sanctions', 'trade embargo', 'export restriction'],

  // Central Banks
  RBI: ['rbi', 'reserve bank of india', 'repo rate', 'reverse repo', 'rbi governor', 'monetary policy committee'],
  FED: ['federal reserve', 'fed meeting', 'fomc meeting', 'powell', 'fed decision'],
  ECB: ['ecb', 'european central bank', 'ecb meeting', 'ecb rate'],
  BOJ: ['bank of japan', 'boj', 'boj rate', 'ueda', 'yen policy'],
  PBC: ['pboc', "people's bank of china", 'china central bank', 'pboc rate'],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolves after `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Truncates `text` to at most `maxLength` characters at a complete word
 * boundary. Returns the original string unchanged if it is within the limit.
 * (Req 3.5)
 */
function truncateAtWordBoundary(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;

  // Walk backwards from maxLength to find the last space / word boundary.
  let end = maxLength;
  while (end > 0 && !/\s/.test(text[end - 1]!)) {
    end--;
  }

  // If no whitespace was found in the prefix, fall back to a hard cut.
  if (end === 0) end = maxLength;

  return text.slice(0, end).trimEnd();
}

// ---------------------------------------------------------------------------
// Taxonomy classifier
// ---------------------------------------------------------------------------

interface TaxonomyResult {
  primary: string;
  secondary: string[];
  confidence: number;
}

/**
 * Simple keyword-based taxonomy classifier (Req 7.1, 7.2).
 *
 * Searches the combined `title + content` text (lowercased) for keyword
 * matches from TAXONOMY_KEYWORDS.  Returns:
 *   - `primary`    — the category with the most keyword hits (or UNCLASSIFIED).
 *   - `secondary`  — up to 5 other matched categories, sorted by hit count desc.
 *   - `confidence` — 0.7 when at least one match was found; 0.4 for UNCLASSIFIED.
 */
function classifyTaxonomy(title: string, content: string): TaxonomyResult {
  const haystack = (title + ' ' + content).toLowerCase();
  const hitCounts: Map<string, number> = new Map();

  for (const [category, keywords] of Object.entries(TAXONOMY_KEYWORDS)) {
    let hits = 0;
    for (const kw of keywords) {
      // Count how many times this keyword appears (simple indexOf loop).
      let pos = 0;
      const kwLower = kw.toLowerCase();
      while (true) {
        const idx = haystack.indexOf(kwLower, pos);
        if (idx === -1) break;
        hits++;
        pos = idx + kwLower.length;
      }
    }
    if (hits > 0) {
      hitCounts.set(category, hits);
    }
  }

  if (hitCounts.size === 0) {
    return {
      primary: 'UNCLASSIFIED',
      secondary: [],
      confidence: UNCLASSIFIED_CONFIDENCE,
    };
  }

  // Sort categories by hit count descending.
  const sorted = [...hitCounts.entries()].sort((a, b) => b[1] - a[1]);

  const primary = sorted[0]![0];
  const secondary = sorted
    .slice(1, 1 + MAX_SECONDARY_CATEGORIES)
    .map(([cat]) => cat);

  return {
    primary,
    secondary,
    confidence: MATCHED_CONFIDENCE,
  };
}

// ---------------------------------------------------------------------------
// NormalizationEngine
// ---------------------------------------------------------------------------

/**
 * Normalizes raw articles from the `news.raw` queue into `NormalizedArticle`
 * records, persists them to `news_articles`, and publishes them to the
 * `news.normalized` queue.
 *
 * Requirements: Req 3.1–3.10, Req 7.1–7.3
 */
export class NormalizationEngine {
  private readonly htmlStripper = new HtmlStripper();
  private readonly languageDetector = new LanguageDetector();

  constructor(
    /** BullMQ Queue instance for `news.normalized` (Req 3.10). */
    private readonly normalizedQueue: Queue,
  ) {}

  // --------------------------------------------------------------------------
  // Public entry point
  // --------------------------------------------------------------------------

  /**
   * Processes a single `RawArticle` through the full normalization pipeline.
   *
   * Steps:
   *   1. Strip HTML from content
   *   2. Truncate at 50,000-char word boundary (Req 3.5)
   *   3. Detect language (Req 3.6)
   *   4. Compute SHA-256 hashes (Req 3.7)
   *   5. Parse publishedAt; set timestampInferred when absent (Req 3.2, 3.3)
   *   6. Classify taxonomy categories (Req 7.1, 7.2)
   *   7. Upsert to `news_articles`
   *   8. Publish to `news.normalized`
   *
   * On failure: writes to `news_processing_errors` and does NOT re-enqueue
   * the article (Req 3.8).
   */
  async process(raw: RawArticle): Promise<NormalizedArticle> {
    const scrapedAt = new Date();

    try {
      // ------------------------------------------------------------------
      // Step 1 & 2: Strip HTML from content and truncate
      // ------------------------------------------------------------------
      const rawContent = raw.rawHtml
        ? this.htmlStripper.process(raw.rawHtml)
        : raw.content
          ? this.htmlStripper.process(raw.content)
          : null;

      let content: string | null = rawContent;
      let contentTruncated = false;

      if (content !== null && content.length > MAX_CONTENT_LENGTH) {
        content = truncateAtWordBoundary(content, MAX_CONTENT_LENGTH);
        contentTruncated = true;
      }

      // ------------------------------------------------------------------
      // Step 3: Language detection (Req 3.6)
      // ------------------------------------------------------------------
      const detectionText = content ?? raw.title;
      const langResult = this.languageDetector.detect(detectionText);

      // ------------------------------------------------------------------
      // Step 4: Compute hashes (Req 3.7)
      // ------------------------------------------------------------------
      const contentHash = this.computeContentHash(content ?? '');
      const titleHash = this.computeTitleHash(raw.title);

      // ------------------------------------------------------------------
      // Step 5: Timestamps (Req 3.2, 3.3)
      // ------------------------------------------------------------------
      let publishedAt: Date;
      let timestampInferred = false;

      if (raw.publishedAt) {
        const parsed = new Date(raw.publishedAt);
        if (isNaN(parsed.getTime())) {
          // Unparsable timestamp → fall back to scrapedAt
          publishedAt = scrapedAt;
          timestampInferred = true;
          logger.warn(
            { sourceId: raw.sourceId, externalId: raw.externalId, rawTimestamp: raw.publishedAt },
            'Unparsable publishedAt — using scrapedAt as fallback',
          );
        } else {
          publishedAt = parsed;
        }
      } else {
        publishedAt = scrapedAt;
        timestampInferred = true;
      }

      // ------------------------------------------------------------------
      // Step 6: Taxonomy classification (Req 7.1, 7.2)
      // ------------------------------------------------------------------
      const taxonomy = classifyTaxonomy(raw.title, content ?? '');

      let category: string;
      let secondaryCategories: string[];
      let categoryConfidence: number;

      if (taxonomy.confidence >= CATEGORY_CONFIDENCE_THRESHOLD) {
        category = taxonomy.primary;
        secondaryCategories = taxonomy.secondary;
        categoryConfidence = taxonomy.confidence;
      } else {
        // Confidence below threshold — assign UNCLASSIFIED (Req 7.2)
        category = 'UNCLASSIFIED';
        secondaryCategories = [];
        categoryConfidence = taxonomy.confidence;
      }

      // ------------------------------------------------------------------
      // Step 6b: Content depth + quality score (Phase 3A)
      // Classify based on per-source override and word-count heuristic.
      // ------------------------------------------------------------------
      const contentDepth = classifyContentDepth(raw.sourceId, raw.title, content);
      const contentQualityScore = computeContentQualityScore(
        contentDepth,
        timestampInferred,
        contentTruncated,
      );

      // ------------------------------------------------------------------
      // Build the NormalizedArticle (Req 3.1)
      // All optional fields absent from raw MUST be null, never undefined.
      // ------------------------------------------------------------------
      const normalized: NormalizedArticle = {
        id: randomUUID(),
        sourceId: raw.sourceId,
        sourceName: raw.sourceName,
        externalId: raw.externalId,
        canonicalUrl: raw.url,
        title: raw.title,
        summary: raw.summary ?? null,
        content,
        author: raw.author ?? null,
        language: langResult.language,
        languageConfidence: langResult.confidence,
        publishedAt,
        scrapedAt,
        category,
        secondaryCategories,
        categoryConfidence,
        contentHash,
        titleHash,
        contentTruncated,
        timestampInferred,
        contentDepth,
        contentQualityScore,
      };

      // ------------------------------------------------------------------
      // Step 7: Upsert to news_articles
      // ------------------------------------------------------------------
      await this.upsertArticle(normalized);

      // ------------------------------------------------------------------
      // Step 8: Publish to news.normalized (Req 3.10)
      // ------------------------------------------------------------------
      await this.publishWithRetry(normalized);

      logger.info(
        {
          id: normalized.id,
          sourceId: normalized.sourceId,
          externalId: normalized.externalId,
          language: normalized.language,
          category: normalized.category,
          contentTruncated,
          timestampInferred,
        },
        'Article normalized and published',
      );

      return normalized;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorType =
        err instanceof Error ? err.constructor.name : 'UnknownError';

      logger.error(
        { sourceId: raw.sourceId, externalId: raw.externalId, err },
        'Normalization failed — writing processing error',
      );

      // Req 3.8: write error record; do NOT re-enqueue
      await this.writeProcessingError({
        sourceId: raw.sourceId,
        externalId: raw.externalId,
        errorType,
        errorMessage,
      });

      throw err;
    }
  }

  // --------------------------------------------------------------------------
  // Hash computation (Req 3.7)
  // --------------------------------------------------------------------------

  /**
   * SHA-256 of stripped, whitespace-normalised content.
   * Collapses all consecutive whitespace to a single space, then trims.
   */
  private computeContentHash(content: string): string {
    const normalised = content.trim().replace(/\s+/g, ' ');
    return createHash('sha256').update(normalised, 'utf8').digest('hex');
  }

  /**
   * SHA-256 of lowercased, punctuation-stripped, whitespace-normalised title.
   */
  private computeTitleHash(title: string): string {
    const normalised = title
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return createHash('sha256').update(normalised, 'utf8').digest('hex');
  }

  // --------------------------------------------------------------------------
  // Database persistence
  // --------------------------------------------------------------------------

  /**
   * Upserts a `NormalizedArticle` into `news_articles` using the compound
   * unique key `(sourceId, externalId)`.
   *
   * On conflict the mutable fields are updated while the original `id` and
   * `createdAt` are preserved (idempotent re-processing).
   */
  private async upsertArticle(article: NormalizedArticle): Promise<void> {
    await prisma.newsArticle.upsert({
      where: {
        sourceId_externalId: {
          sourceId: article.sourceId,
          externalId: article.externalId,
        },
      },
      create: {
        id: article.id,
        sourceId: article.sourceId,
        externalId: article.externalId,
        canonicalUrl: article.canonicalUrl,
        title: article.title,
        summary: article.summary ?? undefined,
        content: article.content ?? undefined,
        author: article.author ?? undefined,
        language: article.language,
        languageConfidence: article.languageConfidence,
        publishedAt: article.publishedAt,
        scrapedAt: article.scrapedAt,
        category: article.category,
        contentHash: article.contentHash,
        titleHash: article.titleHash,
        contentTruncated: article.contentTruncated,
        timestampInferred: article.timestampInferred,
        contentDepth: article.contentDepth,
        contentQualityScore: article.contentQualityScore,
      },
      update: {
        canonicalUrl: article.canonicalUrl,
        title: article.title,
        summary: article.summary ?? undefined,
        content: article.content ?? undefined,
        author: article.author ?? undefined,
        language: article.language,
        languageConfidence: article.languageConfidence,
        publishedAt: article.publishedAt,
        scrapedAt: article.scrapedAt,
        category: article.category,
        contentHash: article.contentHash,
        titleHash: article.titleHash,
        contentTruncated: article.contentTruncated,
        timestampInferred: article.timestampInferred,
        contentDepth: article.contentDepth,
        contentQualityScore: article.contentQualityScore,
      },
    });
  }

  // --------------------------------------------------------------------------
  // Queue publishing with retry (Req 3.10)
  // --------------------------------------------------------------------------

  /**
   * Publishes the NormalizedArticle to the `news.normalized` queue.
   * Retries up to 3× at 5-second intervals.
   * If all retries fail: writes a processing error record and discards.
   */
  private async publishWithRetry(article: NormalizedArticle): Promise<void> {
    let lastErr: unknown;

    for (let attempt = 1; attempt <= QUEUE_PUBLISH_MAX_RETRIES; attempt++) {
      try {
        await this.normalizedQueue.add('normalized', article, {
          jobId: article.id,
          removeOnComplete: { count: 1000 },
          removeOnFail: { count: 500 },
        });
        return; // success
      } catch (err: unknown) {
        lastErr = err;
        logger.warn(
          {
            articleId: article.id,
            attempt,
            maxAttempts: QUEUE_PUBLISH_MAX_RETRIES,
            err,
          },
          'Failed to publish to news.normalized — will retry',
        );

        if (attempt < QUEUE_PUBLISH_MAX_RETRIES) {
          await sleep(QUEUE_PUBLISH_RETRY_DELAY_MS);
        }
      }
    }

    // All retries exhausted — write error record and discard (Req 3.10)
    const errorMessage =
      lastErr instanceof Error ? lastErr.message : String(lastErr);
    logger.error(
      { articleId: article.id, err: lastErr },
      'news.normalized queue unavailable after 3 retries — discarding article',
    );

    await this.writeProcessingError({
      sourceId: article.sourceId,
      externalId: article.externalId,
      errorType: 'QueueUnavailable',
      errorMessage: `Failed to publish to news.normalized after ${QUEUE_PUBLISH_MAX_RETRIES} attempts: ${errorMessage}`,
    });
  }

  // --------------------------------------------------------------------------
  // Error record persistence with retry (Req 3.9)
  // --------------------------------------------------------------------------

  /**
   * Writes a record to `news_processing_errors`.
   *
   * If the DB is unavailable, retains metadata in memory and retries up to
   * 3× at 20-second intervals before discarding (Req 3.9).
   */
  private async writeProcessingError(data: {
    sourceId: string;
    externalId: string;
    errorType: string;
    errorMessage: string;
  }): Promise<void> {
    for (let attempt = 1; attempt <= ERROR_WRITE_MAX_RETRIES; attempt++) {
      try {
        await prisma.newsProcessingError.create({
          data: {
            sourceId: data.sourceId,
            externalId: data.externalId,
            stage: 'normalization',
            errorType: data.errorType,
            errorMessage: data.errorMessage,
          },
        });
        return; // success
      } catch (err: unknown) {
        logger.warn(
          {
            sourceId: data.sourceId,
            externalId: data.externalId,
            attempt,
            maxAttempts: ERROR_WRITE_MAX_RETRIES,
            err,
          },
          'Failed to write processing error — will retry',
        );

        if (attempt < ERROR_WRITE_MAX_RETRIES) {
          await sleep(ERROR_WRITE_RETRY_DELAY_MS);
        } else {
          // All retries exhausted — discard the record (Req 3.9)
          logger.error(
            { sourceId: data.sourceId, externalId: data.externalId },
            'news_processing_errors table unavailable after 3 retries — discarding error record',
          );
        }
      }
    }
  }
}
