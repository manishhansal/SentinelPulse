/**
 * EventDetectionEngine
 *
 * Extracts structured NewsEvent records from a normalised article using
 * keyword/pattern matching.  Each detected event is upserted into
 * `news_events` (idempotency key: article_id + event_type + actor), linked to
 * the source article via `news_article_event_links`, and — on success — the
 * article_id and event_id list are published as a job on the `news.events`
 * BullMQ queue.
 *
 * Pipeline position:
 *   news.entities → EventDetectionEngine → news.events
 *
 * Supported event types (Req 6.2):
 *   MONETARY_POLICY, EARNINGS, ECONOMIC_DATA, COMMODITY_SHOCK, GEOPOLITICAL,
 *   REGULATORY, CORPORATE_ACTION, MACRO_DATA, CREDIT_EVENT, NATURAL_DISASTER,
 *   TRADE_POLICY, CURRENCY_EVENT, SECTOR_ROTATION, UNCLASSIFIED
 *
 * Idempotency (Req 6.8):
 *   Uses prisma.newsEvent.upsert with the composite unique key
 *   (article_id, event_type, actor) — safe to reprocess without creating
 *   duplicate rows.
 *
 * Failure semantics (Req 6.9, 6.10):
 *   - Persistence failure → error surfaced to calling worker; queue NOT
 *     published.
 *   - Persistence success → { article_id, event_ids[] } published to
 *     news.events.
 *
 * Requirements: Req 6.1–6.10, Req 14.1–14.3
 */

import { randomUUID } from 'crypto';
import { pino } from 'pino';
import type { Queue } from 'bullmq';
import { prisma } from '../../db/prisma.js';
import {
  SurpriseScoreCalculator,
  type SurpriseResult,
} from './SurpriseScoreCalculator.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger = pino({ name: 'EventDetectionEngine' });

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

export const EVENT_TYPES = [
  'MONETARY_POLICY',
  'EARNINGS',
  'ECONOMIC_DATA',
  'COMMODITY_SHOCK',
  'GEOPOLITICAL',
  'REGULATORY',
  'CORPORATE_ACTION',
  'MACRO_DATA',
  'CREDIT_EVENT',
  'NATURAL_DISASTER',
  'TRADE_POLICY',
  'CURRENCY_EVENT',
  'SECTOR_ROTATION',
  'UNCLASSIFIED',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** Fully extracted event before persistence. */
export interface ExtractedEvent {
  eventType: EventType;
  actor: string | null;
  action: string | null;
  targetEntities: string[];
  quantitativeValue: number | null;
  expectedValue: number | null;
  expectedValueSrc: string | null;
  surpriseDirection: 'BEAT' | 'MISS' | 'IN_LINE' | 'UNKNOWN';
  surpriseScore: number | null;
  surpriseScoreErr: string | null;
  /** Preliminary importance score [0.0, 1.0] — refined later by ImportanceEngine. */
  importance: number;
  /** Detection confidence [0.0, 1.0]. */
  confidence: number;
  /** UTC timestamp of the underlying event (defaults to article publishedAt). */
  eventTimestamp: Date;
}

/** Minimum article payload required by EventDetectionEngine.process(). */
export interface ArticleInput {
  id: string;
  title: string;
  summary: string | null;
  content: string | null;
  publishedAt: Date;
  sourceId: string;
}

// ---------------------------------------------------------------------------
// Internal pattern-matching types
// ---------------------------------------------------------------------------

interface PatternRule {
  eventType: EventType;
  /** If provided, all patterns in the list must match the text. */
  allOf?: RegExp[];
  /** If provided, at least one pattern must match the text. */
  anyOf?: RegExp[];
  /** Action string to assign when this rule fires. */
  action?: string;
  /** Base confidence for the match [0.0, 1.0]. */
  confidence: number;
  /** Base preliminary importance [0.0, 1.0]. */
  importance: number;
}

// ---------------------------------------------------------------------------
// Pattern ruleset
// ---------------------------------------------------------------------------
//
// Rules are evaluated in order; the FIRST matching rule wins for the primary
// event classification.  After the primary rule fires, additional rules are
// scanned for secondary events (a single article may emit multiple events).
//
// Pattern design: case-insensitive regexes run against the combined
// "title + summary + content" text.
//

const PATTERN_RULES: PatternRule[] = [
  // ── MONETARY_POLICY ────────────────────────────────────────────────────────
  {
    eventType: 'MONETARY_POLICY',
    allOf: [/\b(repo\s+rate|policy\s+rate|interest\s+rate|base\s+rate)\b/i,
             /\b(unchanged|hold|pause|kept|maintain|status\s+quo)\b/i],
    action: 'RATE_HOLD',
    confidence: 0.90,
    importance: 0.75,
  },
  {
    eventType: 'MONETARY_POLICY',
    allOf: [/\b(repo\s+rate|policy\s+rate|interest\s+rate|fed\s+funds\s+rate)\b/i,
             /\b(hike|hikes|hiked|raised?|raises?|increase[sd]?|tightening)\b/i],
    action: 'RATE_HIKE',
    confidence: 0.92,
    importance: 0.85,
  },
  {
    eventType: 'MONETARY_POLICY',
    allOf: [/\b(repo\s+rate|policy\s+rate|interest\s+rate|fed\s+funds\s+rate)\b/i,
             /\b(cut[s]?|cuts|cutting|reduce[sd]?|easing|lower[ed]?|dovish\s+pivot)\b/i],
    action: 'RATE_CUT',
    confidence: 0.92,
    importance: 0.85,
  },
  {
    eventType: 'MONETARY_POLICY',
    anyOf: [/\b(monetary\s+policy|central\s+bank\s+decision|rbi\s+policy|fed\s+policy|mpc\s+meeting|fomc)\b/i],
    action: 'POLICY_DECISION',
    confidence: 0.75,
    importance: 0.70,
  },

  // ── EARNINGS ────────────────────────────────────────────────────────────────
  {
    eventType: 'EARNINGS',
    anyOf: [
      /\b(quarterly\s+results?|quarterly\s+earnings|q[1-4]\s+results?|q[1-4]\s+earnings)\b/i,
      /\b(earnings\s+per\s+share|eps\s+(beat|miss|report))\b/i,
      /\b(net\s+(profit|loss)\s+(rose|fell|jumped|dropped|surged|plunged))\b/i,
      /\b(revenue\s+(beat|miss|topped|fell\s+short))\b/i,
    ],
    action: 'EARNINGS_REPORT',
    confidence: 0.85,
    importance: 0.70,
  },

  // ── COMMODITY_SHOCK ─────────────────────────────────────────────────────────
  {
    eventType: 'COMMODITY_SHOCK',
    anyOf: [
      /\b(crude\s+oil|brent\s+crude|wti|oil\s+prices?)\s+(rose?|falls?|jumped?|dropped?|surged?|plunged?|hits?\s+\$?\d)/i,
      /\b(gold\s+prices?|silver\s+prices?|metal\s+prices?)\s+(rose?|falls?|spiked?|plunged?)\b/i,
      /\b(commodity\s+shock|supply\s+disruption)\b/i,
      /\bopec\b.{0,60}\b(output|cut|production|quota)\b/i,
    ],
    action: 'COMMODITY_PRICE_MOVE',
    confidence: 0.80,
    importance: 0.65,
  },

  // ── GEOPOLITICAL ────────────────────────────────────────────────────────────
  {
    eventType: 'GEOPOLITICAL',
    anyOf: [
      /\b(war|conflict|invasion|missile|airstrike|ceasefire)\b/i,
      /\b(sanctions|trade\s+ban|embargo)\b/i,
      /\b(geopolitic|military\s+tensions?|border\s+standoff)\b/i,
      /\b(russia.{0,20}ukraine|israel.{0,20}(gaza|hamas)|india.{0,20}china\s+border)\b/i,
    ],
    action: 'GEOPOLITICAL_EVENT',
    confidence: 0.78,
    importance: 0.80,
  },

  // ── REGULATORY ──────────────────────────────────────────────────────────────
  {
    eventType: 'REGULATORY',
    anyOf: [
      /\b(sebi\s+(circular|order|directive|ban|penalty|fine))\b/i,
      /\b(rbi\s+(circular|directive|guidelines?|notification))\b/i,
      /\b(regulator[y]?\s+(action|decision|order|fine|penalty|probe|investigation))\b/i,
      /\b(compliance|enforcement\s+action|consent\s+order|show-cause\s+notice)\b/i,
    ],
    action: 'REGULATORY_ACTION',
    confidence: 0.82,
    importance: 0.68,
  },

  // ── CORPORATE_ACTION ────────────────────────────────────────────────────────
  {
    eventType: 'CORPORATE_ACTION',
    anyOf: [
      /\b(merger|acquisition|takeover|buyout|m&a)\b/i,
      /\b(ipo|initial\s+public\s+offering|goes?\s+public)\b/i,
      /\b(share\s+buyback|stock\s+repurchase|buy\s+back)\b/i,
      /\b(dividend|bonus\s+shares?|stock\s+split|rights?\s+issue)\b/i,
      /\b(management\s+change|ceo\s+(resign|appoint|step\s+down)|cfo\s+(resign|appoint))\b/i,
      /\b(demerger|spin-?off|disinvestment|divestiture)\b/i,
    ],
    action: 'CORPORATE_ACTION',
    confidence: 0.83,
    importance: 0.65,
  },

  // ── MACRO_DATA ───────────────────────────────────────────────────────────────
  {
    eventType: 'MACRO_DATA',
    anyOf: [
      /\b(gdp\s+(growth|data|print|figure|number))\b/i,
      /\b(inflation\s+data|cpi\s+(data|print|reading)|wpi\s+(data|print))\b/i,
      /\b(pmi\s+(data|reading|index|print))\b/i,
      /\b(unemployment\s+rate|jobless\s+(claims?|rate)|nonfarm\s+payroll)\b/i,
    ],
    action: 'MACRO_DATA_RELEASE',
    confidence: 0.85,
    importance: 0.72,
  },

  // ── ECONOMIC_DATA ────────────────────────────────────────────────────────────
  {
    eventType: 'ECONOMIC_DATA',
    anyOf: [
      /\b(industrial\s+production|iip\s+data|trade\s+deficit|trade\s+surplus|current\s+account)\b/i,
      /\b(foreign\s+(exchange|forex)\s+(reserves?|data))\b/i,
      /\b(retail\s+sales|consumer\s+(confidence|spending))\b/i,
      /\b(fiscal\s+deficit|government\s+spending|budget\s+data)\b/i,
    ],
    action: 'ECONOMIC_DATA_RELEASE',
    confidence: 0.80,
    importance: 0.65,
  },

  // ── CREDIT_EVENT ─────────────────────────────────────────────────────────────
  {
    eventType: 'CREDIT_EVENT',
    anyOf: [
      /\b(credit\s+rating\s+(downgrad|upgrad|affirm|place\s+on\s+watch))\b/i,
      /\b(default|debt\s+restructuring|bond\s+default|sovereign\s+default)\b/i,
      /\b(moody.{0,5}s|s&p|fitch|icra|crisil).{0,30}(downgrad|upgrad|outlook)\b/i,
    ],
    action: 'CREDIT_RATING_EVENT',
    confidence: 0.85,
    importance: 0.75,
  },

  // ── NATURAL_DISASTER ─────────────────────────────────────────────────────────
  {
    eventType: 'NATURAL_DISASTER',
    anyOf: [
      /\b(earthquake|tsunami|hurricane|cyclone|typhoon|flood[s]?|wildfire|drought)\b/i,
      /\b(natural\s+disaster|force\s+majeure|supply\s+chain\s+disruption\s+due\s+to)\b/i,
    ],
    action: 'NATURAL_DISASTER',
    confidence: 0.82,
    importance: 0.60,
  },

  // ── TRADE_POLICY ─────────────────────────────────────────────────────────────
  {
    eventType: 'TRADE_POLICY',
    anyOf: [
      /\b(tariff[s]?|import\s+duty|anti-dumping|trade\s+war)\b/i,
      /\b(free\s+trade\s+agreement|fta|trade\s+deal|trade\s+negotiations?)\b/i,
      /\b(export\s+(ban|restriction|curb|limit)|import\s+(ban|restriction))\b/i,
    ],
    action: 'TRADE_POLICY_CHANGE',
    confidence: 0.80,
    importance: 0.68,
  },

  // ── CURRENCY_EVENT ───────────────────────────────────────────────────────────
  {
    eventType: 'CURRENCY_EVENT',
    anyOf: [
      /\b(rupee\s+(falls?|drops?|rises?|hits?\s+(all-time|record|low|high)|weakens?|strengthens?))\b/i,
      /\b(currency\s+(devaluation|depreciation|appreciation|crisis))\b/i,
      /\b(forex\s+(intervention|reserves?|inflow|outflow))\b/i,
      /\b(dollar\s+index|dxy|usd\/inr|euro[\/\s]dollar)\b/i,
    ],
    action: 'CURRENCY_MOVE',
    confidence: 0.80,
    importance: 0.62,
  },

  // ── SECTOR_ROTATION ──────────────────────────────────────────────────────────
  {
    eventType: 'SECTOR_ROTATION',
    anyOf: [
      /\b(sector\s+rotation|money\s+moving\s+(into|out\s+of))\b/i,
      /\b(fii\s+(buying|selling)\s+(banks?|it\s+stocks?|pharma|auto|fmcg))\b/i,
      /\b(broad.{0,20}rally|broad.{0,20}sell.?off)\b/i,
    ],
    action: 'SECTOR_ROTATION',
    confidence: 0.65,
    importance: 0.55,
  },
];

// ---------------------------------------------------------------------------
// Number extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the first percentage figure from text that is clearly associated
 * with a rate/value change.  Returns null if none found.
 *
 * Examples matched:
 *   "raised rates by 0.25%"  → 0.25
 *   "cut by 50 basis points" → 0.50  (bps → percent)
 *   "GDP grew 6.7%"          → 6.7
 */
function extractQuantitativeValue(text: string): number | null {
  // Pattern 1: explicit percentage after a change verb or "at"/"to"/"by"
  const pctMatch = text.match(
    /\b(?:by|at|to|of|rose?|fell?|grew?|declined?|increased?|decreased?|printed?|beat|miss(?:ed)?)\s+(\d{1,5}(?:\.\d{1,4})?)\s*%/i,
  );
  if (pctMatch) {
    const val = parseFloat(pctMatch[1] ?? '');
    if (!isNaN(val)) return val;
  }

  // Pattern 2: basis points → convert to percent
  const bpsMatch = text.match(/(\d{1,5}(?:\.\d{1,2})?)\s*(?:bps|basis\s+points?)/i);
  if (bpsMatch) {
    const val = parseFloat(bpsMatch[1] ?? '');
    if (!isNaN(val)) return val / 100;
  }

  // Pattern 3: standalone percentage (e.g., "inflation at 5.1%")
  const standaloneMatch = text.match(/\b(\d{1,5}(?:\.\d{1,4})?)\s*%/);
  if (standaloneMatch) {
    const val = parseFloat(standaloneMatch[1] ?? '');
    if (!isNaN(val)) return val;
  }

  return null;
}

/**
 * Extracts an expected/consensus value from phrases such as:
 *   "vs expected 0.25%", "consensus forecast of 6.5%", "expectation of 50bps"
 */
function extractExpectedValue(text: string): {
  value: number | null;
  src: string | null;
} {
  const patterns: { re: RegExp; src: string }[] = [
    {
      re: /\b(?:vs\.?\s+)?(?:expected?|expectations?|est(?:imate)?[sd]?|forecast[ed]?|consensus)\s+(?:of\s+)?(\d{1,5}(?:\.\d{1,4})?)\s*%/i,
      src: 'article_text',
    },
    {
      re: /\b(?:vs\.?\s+)?(?:expected?|expectations?|est(?:imate)?[sd]?|forecast[ed]?|consensus)\s+(?:of\s+)?(\d{1,5}(?:\.\d{1,4})?)\s*(?:bps|basis\s+points?)/i,
      src: 'article_text_bps',
    },
  ];

  for (const { re, src } of patterns) {
    const match = text.match(re);
    if (match) {
      let val = parseFloat(match[1] ?? '');
      if (isNaN(val)) continue;
      if (src === 'article_text_bps') val = val / 100;
      return { value: val, src: 'article_text' };
    }
  }

  return { value: null, src: null };
}

// ---------------------------------------------------------------------------
// Actor extraction
// ---------------------------------------------------------------------------

/**
 * Heuristically extracts the primary institutional actor from text.
 *
 * Looks for well-known institution mentions; falls back to the first
 * proper-noun-like sequence when no known institution is found.
 */
function extractActor(text: string): string | null {
  const knownActors: [RegExp, string][] = [
    [/\bRBI\b|Reserve\s+Bank\s+of\s+India/i, 'RBI'],
    [/\bFed(?:eral\s+Reserve)?\b|Federal\s+Open\s+Market\s+Committee|FOMC/i, 'Federal Reserve'],
    [/\bECB\b|European\s+Central\s+Bank/i, 'ECB'],
    [/\bBoJ\b|Bank\s+of\s+Japan/i, 'Bank of Japan'],
    [/\bPBoC\b|People.{0,5}Bank\s+of\s+China/i, 'PBoC'],
    [/\bSEBI\b/i, 'SEBI'],
    [/\bOpec\b/i, 'OPEC'],
    [/\bIMF\b/i, 'IMF'],
    [/\bWorld\s+Bank\b/i, 'World Bank'],
    [/\bS&P\b|Standard\s+&?\s*Poor.{0,3}s/i, 'S&P'],
    [/\bMoody.{0,3}s\b/i, "Moody's"],
    [/\bFitch\b/i, 'Fitch'],
    [/\bICRA\b/i, 'ICRA'],
    [/\bCRISIL\b/i, 'CRISIL'],
    [/\bNSE\b|National\s+Stock\s+Exchange/i, 'NSE'],
    [/\bBSE\b|Bombay\s+Stock\s+Exchange/i, 'BSE'],
  ];

  for (const [re, name] of knownActors) {
    if (re.test(text)) return name;
  }

  // Fallback: first sequence of Title-Case words (2–4 words, all alphabetical)
  const titleCaseMatch = text.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\b/);
  if (titleCaseMatch) return titleCaseMatch[1] ?? null;

  return null;
}

// ---------------------------------------------------------------------------
// EventDetectionEngine
// ---------------------------------------------------------------------------

export class EventDetectionEngine {
  private readonly surpriseCalc: SurpriseScoreCalculator;

  constructor(
    private readonly eventsQueue: Queue,
    surpriseThreshold = 0.05,
  ) {
    this.surpriseCalc = new SurpriseScoreCalculator(surpriseThreshold);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Processes a single article:
   *  1. Extracts events via keyword/pattern matching.
   *  2. Upserts each event to `news_events` (idempotency via composite key).
   *  3. Links each event to the article via `news_article_event_links`.
   *  4. On full success, publishes { article_id, event_ids } to `news.events`.
   *
   * Throws on any persistence failure so the calling worker can retry
   * (Req 6.9).
   *
   * Requirements: Req 6.1–6.10, Req 14.1–14.3
   */
  async process(article: ArticleInput): Promise<void> {
    const text = this.buildSearchText(article);

    // 1. Extract events
    const extracted = this.extractEvents(text, article.publishedAt);

    if (extracted.length === 0) {
      // Always produce at least one UNCLASSIFIED event so the pipeline can
      // continue downstream (importance/sentiment still run per-article).
      extracted.push(this.buildUnclassifiedEvent(text, article.publishedAt));
    }

    logger.debug(
      { articleId: article.id, eventCount: extracted.length },
      '[EventDetectionEngine] Extracted events',
    );

    // 2. Persist events + links (Req 6.7, 6.8, 14.3)
    const persistedIds: string[] = [];

    for (const ev of extracted) {
      try {
        const persisted = await this.persistEvent(article.id, ev);
        persistedIds.push(persisted.id);
      } catch (err) {
        // Req 6.9: on persistence failure, do NOT publish; surface error
        logger.error(
          { articleId: article.id, eventType: ev.eventType, err },
          '[EventDetectionEngine] Persistence failed — aborting queue publish (Req 6.9)',
        );
        throw err;
      }
    }

    // 3. Publish to news.events (Req 6.10)
    await this.publishToQueue(article.id, persistedIds);
  }

  // -------------------------------------------------------------------------
  // Private: text assembly
  // -------------------------------------------------------------------------

  /** Concatenates title + summary + content into a single searchable string. */
  private buildSearchText(article: ArticleInput): string {
    return [article.title, article.summary ?? '', article.content ?? '']
      .filter(Boolean)
      .join(' ');
  }

  // -------------------------------------------------------------------------
  // Private: pattern matching + extraction
  // -------------------------------------------------------------------------

  /**
   * Runs all pattern rules against `text` and returns a de-duplicated list
   * of extracted events.  Multiple rules for the same eventType may fire
   * (e.g., EARNINGS mentioned twice); only the first match per eventType is
   * kept to avoid creating semantically duplicate events from a single article.
   */
  private extractEvents(text: string, publishedAt: Date): ExtractedEvent[] {
    const seenEventTypes = new Set<EventType>();
    const results: ExtractedEvent[] = [];

    for (const rule of PATTERN_RULES) {
      if (!this.ruleMatches(rule, text)) continue;
      if (seenEventTypes.has(rule.eventType)) continue;

      seenEventTypes.add(rule.eventType);

      const quantitativeValue = extractQuantitativeValue(text);
      const { value: expectedValue, src: expectedValueSrc } = extractExpectedValue(text);

      let surprise: SurpriseResult;
      if (quantitativeValue !== null) {
        surprise = this.surpriseCalc.compute(quantitativeValue, expectedValue);
      } else {
        surprise = { surpriseScore: null, surpriseDirection: 'UNKNOWN' };
      }

      results.push({
        eventType: rule.eventType,
        actor: extractActor(text),
        action: rule.action ?? null,
        targetEntities: [],        // entity resolution is a downstream stage
        quantitativeValue,
        expectedValue: expectedValue ?? null,
        expectedValueSrc,
        surpriseDirection: surprise.surpriseDirection,
        surpriseScore: surprise.surpriseScore,
        surpriseScoreErr: surprise.surpriseScoreError ?? null,
        importance: rule.importance,
        confidence: rule.confidence,
        eventTimestamp: publishedAt,
      });
    }

    return results;
  }

  /** Evaluates a single pattern rule against the search text. */
  private ruleMatches(rule: PatternRule, text: string): boolean {
    if (rule.allOf) {
      if (!rule.allOf.every((re) => re.test(text))) return false;
    }
    if (rule.anyOf) {
      if (!rule.anyOf.some((re) => re.test(text))) return false;
    }
    // A rule with no patterns always matches (shouldn't happen but guard it)
    if (!rule.allOf && !rule.anyOf) return false;
    return true;
  }

  /** Builds an UNCLASSIFIED fallback event. */
  private buildUnclassifiedEvent(text: string, publishedAt: Date): ExtractedEvent {
    const quantitativeValue = extractQuantitativeValue(text);
    const { value: expectedValue, src: expectedValueSrc } = extractExpectedValue(text);

    let surprise: SurpriseResult;
    if (quantitativeValue !== null) {
      surprise = this.surpriseCalc.compute(quantitativeValue, expectedValue);
    } else {
      surprise = { surpriseScore: null, surpriseDirection: 'UNKNOWN' };
    }

    return {
      eventType: 'UNCLASSIFIED',
      actor: extractActor(text),
      action: null,
      targetEntities: [],
      quantitativeValue,
      expectedValue: expectedValue ?? null,
      expectedValueSrc,
      surpriseDirection: surprise.surpriseDirection,
      surpriseScore: surprise.surpriseScore,
      surpriseScoreErr: surprise.surpriseScoreError ?? null,
      importance: 0.3,
      confidence: 0.4,
      eventTimestamp: publishedAt,
    };
  }

  // -------------------------------------------------------------------------
  // Private: persistence (Req 6.7, 6.8, 14.3)
  // -------------------------------------------------------------------------

  /**
   * Upserts a NewsEvent and creates the article–event link.
   *
   * Idempotency key: (article_id, event_type, actor) — safe to reprocess
   * (Req 6.8).
   *
   * Stores surprise_score, surprise_direction, quantitativeValue, and
   * expectedValue per Req 14.3.
   */
  private async persistEvent(
    articleId: string,
    ev: ExtractedEvent,
  ): Promise<{ id: string }> {
    // Normalise actor: Prisma unique constraint requires non-null value
    const actor = ev.actor ?? '';

    // Upsert the NewsEvent row (Req 6.8, 14.3)
    const event = await prisma.newsEvent.upsert({
      where: {
        articleId_eventType_actor: {
          articleId,
          eventType: ev.eventType,
          actor,
        },
      },
      create: {
        id: randomUUID(),
        articleId,
        eventType: ev.eventType,
        actor,
        action: ev.action,
        targetEntities: ev.targetEntities,
        quantitativeValue: ev.quantitativeValue,
        expectedValue: ev.expectedValue,
        expectedValueSrc: ev.expectedValueSrc,
        surpriseDirection: ev.surpriseDirection,
        surpriseScore: ev.surpriseScore,
        surpriseScoreErr: ev.surpriseScoreErr,
        importance: ev.importance,
        confidence: ev.confidence,
        eventTimestamp: ev.eventTimestamp,
      },
      update: {
        // On re-processing: refresh scores but preserve identity (Req 6.8)
        action: ev.action,
        targetEntities: ev.targetEntities,
        quantitativeValue: ev.quantitativeValue,
        expectedValue: ev.expectedValue,
        expectedValueSrc: ev.expectedValueSrc,
        surpriseDirection: ev.surpriseDirection,
        surpriseScore: ev.surpriseScore,
        surpriseScoreErr: ev.surpriseScoreErr,
        importance: ev.importance,
        confidence: ev.confidence,
        updatedAt: new Date(),
      },
      select: { id: true },
    });

    // Upsert the article–event link (idempotent via composite PK, Req 6.7)
    await prisma.newsArticleEventLink.upsert({
      where: {
        articleId_eventId: {
          articleId,
          eventId: event.id,
        },
      },
      create: { articleId, eventId: event.id },
      update: {},   // nothing to update — link is immutable
    });

    return event;
  }

  // -------------------------------------------------------------------------
  // Private: queue publish (Req 6.10)
  // -------------------------------------------------------------------------

  /**
   * Publishes `{ article_id, event_ids }` to the `news.events` BullMQ queue.
   *
   * Uses a deterministic jobId (`events-{articleId}`) so BullMQ deduplicates
   * the job if it is re-enqueued before being consumed (supports idempotency
   * across worker retries, Req 6.8).
   *
   * Requirements: Req 6.10
   */
  private async publishToQueue(
    articleId: string,
    eventIds: string[],
  ): Promise<void> {
    await this.eventsQueue.add(
      'events',
      { articleId, eventIds },
      { jobId: `events-${articleId}` },
    );

    logger.debug(
      { articleId, eventCount: eventIds.length },
      '[EventDetectionEngine] Published to news.events queue (Req 6.10)',
    );
  }
}
