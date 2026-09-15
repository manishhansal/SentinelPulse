/**
 * SentimentEngine.ts — Multi-dimensional sentiment analysis for SentinelPulse.
 *
 * Pipeline position:
 *   news.sentiment queue → SentimentEngine → news.sentiment output queue
 *
 * Computes five sentiment dimensions per article (Req 8.1):
 *   - sentimentScore    (overall)
 *   - marketSentiment
 *   - companySentiment
 *   - macroSentiment
 *   - riskSentiment
 *
 * Each dimension is a float in [-1.0000, +1.0000] rounded to 4 decimal places.
 *
 * Qualitative signals (Req 8.3):
 *   UNCERTAINTY, FEAR, HAWKISH, DOVISH, RISK_ON, RISK_OFF, OPTIMISM, PANIC, NEUTRAL
 *
 * Idempotency (Req 8.4, 8.5):
 *   Upserts on (article_id, model_version) — new model version creates a new row,
 *   preserving prior scores.
 *
 * Queue publish (Req 8.6):
 *   Publishes { articleId, modelVersion } to the downstream BullMQ queue on success.
 *   Retries up to 3× at 2-second intervals before logging and discarding.
 *
 * Scoring model:
 *   Lexicon-based keyword matching over the article's title + content.
 *   For each dimension: count positive hits, negative hits; normalise to [-1, 1].
 *   Confidence: ratio of matched tokens to total word count, capped at 1.0.
 *
 * Requirements: Req 8.1–8.6
 */

import { pino } from 'pino';
import type { Queue } from 'bullmq';
import { prisma, upsertSentiment } from '../../db/prisma.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger = pino({ name: 'sentiment-engine' });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Model version identifier for this lexicon-based rule engine. */
const MODEL_VERSION = '1.0.0-lexicon';

/** Number of retries for the downstream queue publish (Req 8.6). */
const ENQUEUE_MAX_RETRIES = 3;

/** Delay between queue publish retries in milliseconds. */
const ENQUEUE_RETRY_DELAY_MS = 2_000;

/**
 * Minimum keyword-hit ratio required for a qualitative signal to be assigned.
 * Below this threshold the article receives NEUTRAL.
 */
const SIGNAL_CONFIDENCE_THRESHOLD = 0.005;

// ---------------------------------------------------------------------------
// Lexicons
// ---------------------------------------------------------------------------

/**
 * Market sentiment lexicon.
 * Req 8.1 — scored against marketSentiment dimension.
 */
const MARKET_POSITIVE = [
  'bull', 'rally', 'surge', 'soar', 'gains', 'recovery',
  'breakout', 'upside', 'rebound',
];

const MARKET_NEGATIVE = [
  'bear', 'crash', 'plunge', 'decline', 'selloff', 'correction',
  'panic', 'recession', 'slowdown',
];

/**
 * Company sentiment lexicon.
 * Req 8.1 — scored against companySentiment dimension.
 */
const COMPANY_POSITIVE = [
  'profit', 'earnings beat', 'revenue growth', 'expansion',
  'acquisition', 'buyback', 'dividend',
];

const COMPANY_NEGATIVE = [
  'loss', 'earnings miss', 'bankruptcy', 'fraud', 'layoff',
  'downgrade', 'default', 'write-off',
];

/**
 * Macro sentiment lexicon.
 * Req 8.1 — scored against macroSentiment dimension.
 */
const MACRO_POSITIVE = [
  'gdp growth', 'economic expansion', 'employment',
  'fiscal surplus', 'trade surplus',
];

const MACRO_NEGATIVE = [
  'inflation', 'stagflation', 'recession', 'deficit',
  'unemployment', 'rate hike concern',
];

/**
 * Risk sentiment lexicons (risk-on / risk-off).
 * Req 8.1 — scored against riskSentiment dimension.
 * risk-on → positive direction; risk-off → negative direction.
 */
const RISK_ON_KEYWORDS = ['stable', 'calm', 'growth', 'confidence', 'safe'];
const RISK_OFF_KEYWORDS = ['war', 'crisis', 'uncertainty', 'volatility', 'fear'];

// ---------------------------------------------------------------------------
// Qualitative signal keyword maps
// ---------------------------------------------------------------------------

/**
 * Keyword triggers for qualitative sentiment signals (Req 8.3).
 * NEUTRAL is applied as a fallback when nothing else fires.
 */
const QUALITATIVE_KEYWORD_MAP: Readonly<
  Record<Exclude<QualitativeSignal, 'NEUTRAL'>, readonly string[]>
> = {
  HAWKISH: ['rate hike', 'tighten', 'inflation fight', 'aggressive policy'],
  DOVISH: ['rate cut', 'easy money', 'stimulus', 'accommodative'],
  PANIC: ['crash', 'emergency', 'crisis', 'fear', 'plunge', 'halt'],
  FEAR: ['uncertainty', 'warning', 'risk', 'concern', 'threat'],
  OPTIMISM: ['recovery', 'growth', 'bullish', 'positive', 'strong'],
  UNCERTAINTY: ['unclear', 'unknown', 'uncertain', 'ambiguous', 'speculation'],
  RISK_ON: ['risk on', 'risk-on', 'appetite', 'confidence', 'optimistic'],
  RISK_OFF: ['risk off', 'risk-off', 'safe haven', 'flight to safety', 'caution'],
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export const QUALITATIVE_SIGNALS = [
  'UNCERTAINTY', 'FEAR', 'HAWKISH', 'DOVISH', 'RISK_ON', 'RISK_OFF',
  'OPTIMISM', 'PANIC', 'NEUTRAL',
] as const;

export type QualitativeSignal = (typeof QUALITATIVE_SIGNALS)[number];

export interface SentimentResult {
  sentimentScore: number;
  marketSentiment: number;
  companySentiment: number;
  macroSentiment: number;
  riskSentiment: number;
  qualitativeSignals: QualitativeSignal[];
  confidence: number;
  modelVersion: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Simple sleep utility for retry delays. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Counts how many times at least one keyword from the provided list appears
 * in the lowercased text. Multi-word phrases are matched as substrings.
 *
 * Returns the number of distinct keyword hits (each keyword counted once
 * regardless of how many times it appears in the text).
 */
function countKeywordHits(text: string, keywords: readonly string[]): number {
  let hits = 0;
  for (const kw of keywords) {
    if (text.includes(kw)) {
      hits += 1;
    }
  }
  return hits;
}

/**
 * Computes a dimension score from positive and negative keyword hit counts.
 *
 * Formula:
 *   raw = positiveHits - negativeHits
 *   totalHits = positiveHits + negativeHits
 *
 *   if totalHits === 0 → score = 0 (no signal)
 *   else               → score = raw / totalHits   (normalised to [-1, +1])
 *
 * Returns the score rounded to 4 decimal places (Req 8.1).
 */
function computeDimensionScore(positiveHits: number, negativeHits: number): number {
  const totalHits = positiveHits + negativeHits;
  if (totalHits === 0) return 0;
  const raw = (positiveHits - negativeHits) / totalHits;
  return Math.round(raw * 10_000) / 10_000;
}

/**
 * Computes confidence for a dimension.
 *
 * Confidence = (keywordsMatched / totalKeywordsInLexicon), capped at 1.0.
 * Reflects how much of the lexicon fired, not just whether it fired.
 *
 * Returns a float in [0.0, 1.0], rounded to 4 decimal places (Req 8.2).
 */
function computeDimensionConfidence(
  positiveHits: number,
  negativeHits: number,
  totalLexiconSize: number,
): number {
  if (totalLexiconSize === 0) return 0;
  const matchedFraction = (positiveHits + negativeHits) / totalLexiconSize;
  const capped = Math.min(matchedFraction, 1.0);
  return Math.round(capped * 10_000) / 10_000;
}

/**
 * Computes the overall confidence as the unweighted mean of the five
 * per-dimension confidences.
 */
function computeOverallConfidence(dimensionConfidences: number[]): number {
  if (dimensionConfidences.length === 0) return 0;
  const sum = dimensionConfidences.reduce((acc, c) => acc + c, 0);
  const mean = sum / dimensionConfidences.length;
  return Math.round(mean * 10_000) / 10_000;
}

/**
 * Detects qualitative signals from the article text (Req 8.3).
 *
 * Each signal fires when any of its trigger keywords appears in the text.
 * If no signal fires, NEUTRAL is appended.
 */
function detectQualitativeSignals(
  text: string,
  totalWordCount: number,
): QualitativeSignal[] {
  const signals: QualitativeSignal[] = [];

  for (const [signal, keywords] of Object.entries(QUALITATIVE_KEYWORD_MAP) as [
    Exclude<QualitativeSignal, 'NEUTRAL'>,
    readonly string[],
  ][]) {
    const hits = countKeywordHits(text, keywords);
    if (hits > 0) {
      // Only include signal if hit density exceeds the confidence threshold
      const density = hits / Math.max(totalWordCount, 1);
      if (density >= SIGNAL_CONFIDENCE_THRESHOLD) {
        signals.push(signal);
      }
    }
  }

  // Req 8.3 — NEUTRAL is the fallback when no other signal fires
  if (signals.length === 0) {
    signals.push('NEUTRAL');
  }

  return signals;
}

// ---------------------------------------------------------------------------
// SentimentEngine
// ---------------------------------------------------------------------------

export class SentimentEngine {
  readonly modelVersion = MODEL_VERSION;

  constructor(private readonly sentimentQueue: Queue) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Processes a single article through the sentiment pipeline:
   *   1. Compute 5 sentiment dimensions via lexicon matching (Req 8.1)
   *   2. Compute per-dimension and overall confidence (Req 8.2)
   *   3. Detect qualitative signals (Req 8.3)
   *   4. Upsert into news_sentiment (Req 8.4, 8.5)
   *   5. Publish to downstream queue (Req 8.6)
   *
   * Requirements: Req 8.1–8.6
   */
  async process(article: {
    id: string;
    title: string;
    content: string | null;
    eventId?: string;
  }): Promise<SentimentResult> {
    const { id, title, content, eventId } = article;

    // -----------------------------------------------------------------------
    // 1. Prepare text corpus — lowercase for case-insensitive matching
    // -----------------------------------------------------------------------
    const rawText = `${title} ${content ?? ''}`.trim();
    const lowerText = rawText.toLowerCase();
    const wordCount = lowerText.split(/\s+/).filter(Boolean).length;

    logger.debug(
      { articleId: id, wordCount },
      '[SentimentEngine] Starting sentiment analysis',
    );

    // -----------------------------------------------------------------------
    // 2. Compute per-dimension scores and confidence (Req 8.1, 8.2)
    // -----------------------------------------------------------------------

    // marketSentiment
    const marketPos = countKeywordHits(lowerText, MARKET_POSITIVE);
    const marketNeg = countKeywordHits(lowerText, MARKET_NEGATIVE);
    const marketSentiment = computeDimensionScore(marketPos, marketNeg);
    const marketConf = computeDimensionConfidence(
      marketPos, marketNeg, MARKET_POSITIVE.length + MARKET_NEGATIVE.length,
    );

    // companySentiment
    const companyPos = countKeywordHits(lowerText, COMPANY_POSITIVE);
    const companyNeg = countKeywordHits(lowerText, COMPANY_NEGATIVE);
    const companySentiment = computeDimensionScore(companyPos, companyNeg);
    const companyConf = computeDimensionConfidence(
      companyPos, companyNeg, COMPANY_POSITIVE.length + COMPANY_NEGATIVE.length,
    );

    // macroSentiment
    const macroPos = countKeywordHits(lowerText, MACRO_POSITIVE);
    const macroNeg = countKeywordHits(lowerText, MACRO_NEGATIVE);
    const macroSentiment = computeDimensionScore(macroPos, macroNeg);
    const macroConf = computeDimensionConfidence(
      macroPos, macroNeg, MACRO_POSITIVE.length + MACRO_NEGATIVE.length,
    );

    // riskSentiment — risk-on → positive, risk-off → negative
    const riskOnHits = countKeywordHits(lowerText, RISK_ON_KEYWORDS);
    const riskOffHits = countKeywordHits(lowerText, RISK_OFF_KEYWORDS);
    const riskSentiment = computeDimensionScore(riskOnHits, riskOffHits);
    const riskConf = computeDimensionConfidence(
      riskOnHits, riskOffHits, RISK_ON_KEYWORDS.length + RISK_OFF_KEYWORDS.length,
    );

    // sentimentScore — aggregate of all four dimensions (simple mean)
    const rawOverall =
      (marketSentiment + companySentiment + macroSentiment + riskSentiment) / 4;
    const sentimentScore = Math.round(rawOverall * 10_000) / 10_000;

    // Overall confidence — mean of per-dimension confidences (Req 8.2)
    const confidence = computeOverallConfidence([
      marketConf, companyConf, macroConf, riskConf,
    ]);

    // -----------------------------------------------------------------------
    // 3. Detect qualitative signals (Req 8.3)
    // -----------------------------------------------------------------------
    const qualitativeSignals = detectQualitativeSignals(lowerText, wordCount);

    logger.debug(
      {
        articleId: id,
        sentimentScore,
        marketSentiment,
        companySentiment,
        macroSentiment,
        riskSentiment,
        qualitativeSignals,
        confidence,
      },
      '[SentimentEngine] Computed sentiment dimensions',
    );

    const result: SentimentResult = {
      sentimentScore,
      marketSentiment,
      companySentiment,
      macroSentiment,
      riskSentiment,
      qualitativeSignals,
      confidence,
      modelVersion: this.modelVersion,
    };

    // -----------------------------------------------------------------------
    // 4. Upsert into news_sentiment (Req 8.4, 8.5)
    //    Idempotency key: (article_id, model_version)
    //    New model version → new row, preserving prior scores (Req 8.5)
    // -----------------------------------------------------------------------
    await upsertSentiment({
      articleId: id,
      modelVersion: this.modelVersion,
      sentimentScore,
      marketSentiment,
      companySentiment,
      macroSentiment,
      riskSentiment,
      qualitativeSignals,
      confidence,
    });

    // Attach eventId if provided (nullable FK in schema)
    if (eventId) {
      await prisma.newsSentiment.updateMany({
        where: {
          articleId: id,
          modelVersion: this.modelVersion,
          eventId: null,
        },
        data: { eventId },
      });
    }

    logger.info(
      { articleId: id, modelVersion: this.modelVersion, eventId: eventId ?? null },
      '[SentimentEngine] Upserted sentiment record',
    );

    // -----------------------------------------------------------------------
    // 5. Publish to downstream queue (Req 8.6)
    //    Retries up to ENQUEUE_MAX_RETRIES times with ENQUEUE_RETRY_DELAY_MS
    // -----------------------------------------------------------------------
    await this.publishToSentimentQueue(id, this.modelVersion);

    return result;
  }

  // -------------------------------------------------------------------------
  // Private: publish to news.sentiment output queue (Req 8.6)
  // -------------------------------------------------------------------------

  /**
   * Publishes the processed { articleId, modelVersion } job to the downstream
   * BullMQ queue.  Retries up to ENQUEUE_MAX_RETRIES times with a fixed delay.
   * On exhaustion, logs an error and discards without throwing so that the
   * calling worker can decide whether to nack the original job.
   *
   * Requirements: Req 8.6
   */
  private async publishToSentimentQueue(
    articleId: string,
    modelVersion: string,
  ): Promise<void> {
    const jobData = { articleId, modelVersion };
    let lastError: unknown;

    for (let attempt = 1; attempt <= ENQUEUE_MAX_RETRIES; attempt++) {
      try {
        await this.sentimentQueue.add('sentiment.processed', jobData, {
          jobId: `sentiment-${articleId}-${modelVersion}`, // idempotent key (Req 8.5)
          removeOnComplete: { count: 1000 },
          removeOnFail: { count: 500 },
        });

        logger.debug(
          { articleId, modelVersion, attempt },
          '[SentimentEngine] Published to sentiment queue',
        );
        return; // success
      } catch (err: unknown) {
        lastError = err;
        logger.warn(
          { articleId, modelVersion, attempt, maxAttempts: ENQUEUE_MAX_RETRIES, err },
          `[SentimentEngine] Failed to publish to sentiment queue (attempt ${attempt}/${ENQUEUE_MAX_RETRIES})`,
        );

        if (attempt < ENQUEUE_MAX_RETRIES) {
          await sleep(ENQUEUE_RETRY_DELAY_MS);
        }
      }
    }

    // All retries exhausted — log error, do not rethrow (Req 8.6)
    logger.error(
      { articleId, modelVersion, err: lastError },
      '[SentimentEngine] Exhausted all queue publish retries — sentiment record is persisted but downstream notification was lost',
    );
  }
}
