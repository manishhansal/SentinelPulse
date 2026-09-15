/**
 * ImportanceEngine — computes a normalised importance_score ∈ [0.0, 1.0] for
 * each NewsEvent by combining nine weighted sub-scores.
 *
 * Pipeline position:
 *   news.events queue → ImportanceEngine → news.impact queue
 *
 * Sub-scores (Req 9.1):
 *   1. source_reliability        — from news_sources.source_reliability
 *   2. event_severity            — heuristic per event_type
 *   3. affected_asset_weight     — linked asset count × 0.1, capped at 1.0
 *   4. affected_sector_count     — distinct sector count normalised to [0, 1]
 *   5. historical_impact_magnitude — avg |return_15m| from news_market_reactions;
 *                                    prior = 0.5 when no data (Req 9.4)
 *   6. novelty                   — 1 / (similar-event count in past 7 days + 1)
 *   7. surprise_factor           — |surprise_score| / 5.0; 0 when null
 *   8. geopolitical_significance — heuristic per event_type
 *   9. macro_significance        — heuristic per event_type
 *
 * Formula (Req 9.1):
 *   importance_score = Σ(sub_score_i × weight_i) / Σ(weight_i), clamped to [0.0, 1.0]
 *
 * Surprise multiplier (Req 14.4):
 *   if surprise_score is non-null:
 *     importance_score = min(importance_score × (1 + |surprise_score| / 5.0), 1.0)
 *
 * Idempotency (Req 9.5): upsert on event_id
 * Audit trail (Req 9.2): all sub_scores stored as JSON
 * Queue publish (Req 9.6): event_id published to news.impact on success
 *
 * Requirements: Req 9.1–9.6, Req 14.4
 */

import { pino } from 'pino';
import type { Queue } from 'bullmq';
import { prisma, upsertImportance } from '../../db/prisma.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger = pino({ name: 'ImportanceEngine' });

// ---------------------------------------------------------------------------
// Event type heuristic tables
// ---------------------------------------------------------------------------

/**
 * Maps each EventType to its event_severity sub-score.
 * Values represent the baseline market-moving potential of each event class.
 */
const EVENT_SEVERITY: Readonly<Record<string, number>> = {
  GEOPOLITICAL: 0.95,
  MONETARY_POLICY: 0.90,
  CREDIT_EVENT: 0.88,
  COMMODITY_SHOCK: 0.85,
  NATURAL_DISASTER: 0.82,
  TRADE_POLICY: 0.78,
  ECONOMIC_DATA: 0.75,
  MACRO_DATA: 0.73,
  CURRENCY_EVENT: 0.72,
  EARNINGS: 0.70,
  REGULATORY: 0.65,
  CORPORATE_ACTION: 0.60,
  SECTOR_ROTATION: 0.55,
  UNCLASSIFIED: 0.40,
} as const;

/**
 * Maps each EventType to its geopolitical_significance sub-score.
 * Events with cross-border / macro political impact score higher.
 */
const GEOPOLITICAL_SIGNIFICANCE: Readonly<Record<string, number>> = {
  GEOPOLITICAL: 1.00,
  TRADE_POLICY: 0.85,
  MONETARY_POLICY: 0.70,
  NATURAL_DISASTER: 0.65,
  COMMODITY_SHOCK: 0.60,
  CURRENCY_EVENT: 0.55,
  CREDIT_EVENT: 0.50,
  ECONOMIC_DATA: 0.40,
  MACRO_DATA: 0.35,
  REGULATORY: 0.30,
  EARNINGS: 0.15,
  CORPORATE_ACTION: 0.10,
  SECTOR_ROTATION: 0.10,
  UNCLASSIFIED: 0.05,
} as const;

/**
 * Maps each EventType to its macro_significance sub-score.
 * Events with broad macro-economic implications score higher.
 */
const MACRO_SIGNIFICANCE: Readonly<Record<string, number>> = {
  MONETARY_POLICY: 1.00,
  MACRO_DATA: 0.95,
  ECONOMIC_DATA: 0.90,
  COMMODITY_SHOCK: 0.80,
  TRADE_POLICY: 0.75,
  CURRENCY_EVENT: 0.70,
  GEOPOLITICAL: 0.65,
  CREDIT_EVENT: 0.60,
  NATURAL_DISASTER: 0.45,
  REGULATORY: 0.35,
  EARNINGS: 0.30,
  CORPORATE_ACTION: 0.20,
  SECTOR_ROTATION: 0.25,
  UNCLASSIFIED: 0.10,
} as const;

// ---------------------------------------------------------------------------
// Weights
// ---------------------------------------------------------------------------

/**
 * Sub-score weights for the weighted mean formula.
 * Weights reflect the relative signal value of each dimension.
 * Must all be positive; they are normalised internally.
 */
const WEIGHTS: Readonly<Record<keyof SubScores, number>> = {
  sourceReliability: 1.5,
  eventSeverity: 2.0,
  affectedAssetWeight: 1.0,
  affectedSectorCount: 0.8,
  historicalImpactMagnitude: 1.5,
  novelty: 1.0,
  surpriseFactor: 1.2,
  geopoliticalSignificance: 1.3,
  macroSignificance: 1.3,
} as const;

/** Pre-computed sum of all weights for efficiency. */
const TOTAL_WEIGHT = (Object.values(WEIGHTS) as number[]).reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------------------
// Configuration defaults
// ---------------------------------------------------------------------------

/** Default prior for historical_impact_magnitude when no reactions exist (Req 9.4). */
const HISTORICAL_PRIOR = 0.5;

/**
 * Maximum sector count used as the normalisation ceiling.
 * A value ≥ MAX_SECTOR_COUNT_NORMALISE maps to 1.0.
 */
const MAX_SECTOR_COUNT_NORMALISE = 10;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Exported EventType string union — mirrors EventDetectionEngine's type. */
export type EventType =
  | 'GEOPOLITICAL'
  | 'MONETARY_POLICY'
  | 'CREDIT_EVENT'
  | 'COMMODITY_SHOCK'
  | 'NATURAL_DISASTER'
  | 'TRADE_POLICY'
  | 'ECONOMIC_DATA'
  | 'MACRO_DATA'
  | 'CURRENCY_EVENT'
  | 'EARNINGS'
  | 'REGULATORY'
  | 'CORPORATE_ACTION'
  | 'SECTOR_ROTATION'
  | 'UNCLASSIFIED';

/**
 * All nine sub-scores computed by the engine, keyed by sub-score name.
 * Each value is in [0.0, 1.0].
 */
export interface SubScores {
  /** From news_sources.source_reliability (Tier-1 default 1.0, Tier-2 default 0.8). */
  sourceReliability: number;
  /** Heuristic severity weight for the event_type. */
  eventSeverity: number;
  /** Linked asset count × 0.1, capped at 1.0. */
  affectedAssetWeight: number;
  /** Distinct sector count from news_sector_links, normalised to [0, 1]. */
  affectedSectorCount: number;
  /** Avg |return_15m| from historical reactions, or prior 0.5 if unavailable. */
  historicalImpactMagnitude: number;
  /** 1 / (similar-event count in past 7 days + 1). */
  novelty: number;
  /** |surprise_score| / 5.0; 0 when surprise_score is null. */
  surpriseFactor: number;
  /** Heuristic geopolitical significance for the event_type. */
  geopoliticalSignificance: number;
  /** Heuristic macro significance for the event_type. */
  macroSignificance: number;
}

/** Full result returned by ImportanceEngine.process(). */
export interface ImportanceResult {
  /** Final importance_score ∈ [0.0, 1.0], after surprise multiplier (Req 14.4). */
  importanceScore: number;
  /** All nine sub-scores with their values. */
  subScores: SubScores;
  /** False when historical_impact_magnitude fell back to the prior (Req 9.4). */
  historicalDataAvailable: boolean;
  /** Model version string for the news_importance row. */
  modelVersion: string;
}

// ---------------------------------------------------------------------------
// ImportanceEngine
// ---------------------------------------------------------------------------

export class ImportanceEngine {
  /** Semantic version identifying the scoring model (Req 9.5). */
  readonly modelVersion = '1.0.0';

  constructor(private readonly impactQueue: Queue) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Computes the importance score for a single NewsEvent.
   *
   * Steps:
   *   1. Resolve all nine sub-scores from the database.
   *   2. Compute weighted mean; clamp to [0, 1].
   *   3. Apply surprise multiplier if surprise_score is non-null.
   *   4. Upsert news_importance record (Req 9.5).
   *   5. Publish event_id to news.impact queue (Req 9.6).
   *
   * Requirements: Req 9.1–9.6, Req 14.4
   */
  async process(event: {
    id: string;
    articleId: string;
    eventType: string;
    sourceId: string;
    surpriseScore: number | null;
    publishedAt: Date;
  }): Promise<ImportanceResult> {
    logger.info({ eventId: event.id, eventType: event.eventType }, 'Computing importance score');

    // ------------------------------------------------------------------
    // 1. Resolve sub-scores (all DB queries run concurrently)
    // ------------------------------------------------------------------
    const [
      sourceReliability,
      affectedAssetCount,
      affectedSectorCount,
      historicalResult,
      similarEventCount,
    ] = await Promise.all([
      this.fetchSourceReliability(event.sourceId),
      this.fetchAffectedAssetCount(event.articleId),
      this.fetchAffectedSectorCount(event.articleId),
      this.fetchHistoricalImpactMagnitude(event.id, event.eventType),
      this.fetchSimilarEventCount(event.eventType, event.publishedAt),
    ]);

    const subScores: SubScores = {
      sourceReliability,
      eventSeverity: resolveEventSeverity(event.eventType),
      affectedAssetWeight: Math.min(affectedAssetCount * 0.1, 1.0),
      affectedSectorCount: Math.min(affectedSectorCount / MAX_SECTOR_COUNT_NORMALISE, 1.0),
      historicalImpactMagnitude: historicalResult.magnitude,
      novelty: 1.0 / (similarEventCount + 1),
      surpriseFactor: event.surpriseScore !== null ? Math.abs(event.surpriseScore) / 5.0 : 0,
      geopoliticalSignificance: resolveGeopoliticalSignificance(event.eventType),
      macroSignificance: resolveMacroSignificance(event.eventType),
    };

    // ------------------------------------------------------------------
    // 2. Weighted mean; clamp to [0.0, 1.0]
    // ------------------------------------------------------------------
    const rawScore = computeWeightedMean(subScores);
    const clampedScore = clamp(rawScore, 0.0, 1.0);

    // ------------------------------------------------------------------
    // 3. Surprise multiplier (Req 14.4)
    // ------------------------------------------------------------------
    let importanceScore: number;
    if (event.surpriseScore !== null) {
      const multiplier = 1.0 + Math.abs(event.surpriseScore) / 5.0;
      importanceScore = Math.min(clampedScore * multiplier, 1.0);
    } else {
      importanceScore = clampedScore;
    }

    const result: ImportanceResult = {
      importanceScore,
      subScores,
      historicalDataAvailable: historicalResult.dataAvailable,
      modelVersion: this.modelVersion,
    };

    // ------------------------------------------------------------------
    // 4. Upsert news_importance (Req 9.2, Req 9.5)
    // ------------------------------------------------------------------
    await this.persist(event.id, result);

    // ------------------------------------------------------------------
    // 5. Publish to news.impact queue (Req 9.6)
    // ------------------------------------------------------------------
    await this.publishToQueue(event.id);

    logger.info(
      {
        eventId: event.id,
        importanceScore,
        historicalDataAvailable: result.historicalDataAvailable,
      },
      'Importance score computed and persisted',
    );

    return result;
  }

  // -------------------------------------------------------------------------
  // Sub-score fetchers
  // -------------------------------------------------------------------------

  /**
   * Fetches source_reliability from news_sources for the given sourceId.
   * Falls back to Tier-2 default (0.8) if the source is not found.
   *
   * Requirement: Req 9.3
   */
  private async fetchSourceReliability(sourceId: string): Promise<number> {
    const source = await prisma.newsSource.findUnique({
      where: { id: sourceId },
      select: { sourceReliability: true },
    });

    if (source === null) {
      logger.warn({ sourceId }, 'Source not found; using Tier-2 default reliability 0.8');
      return 0.8;
    }

    return clamp(source.sourceReliability, 0.0, 1.0);
  }

  /**
   * Returns the number of distinct assets linked to the article.
   *
   * Requirement: Req 9.1 (affected_asset_weight)
   */
  private async fetchAffectedAssetCount(articleId: string): Promise<number> {
    const count = await prisma.newsAssetLink.count({
      where: { articleId },
    });
    return count;
  }

  /**
   * Returns the number of distinct sectors linked to the article.
   *
   * Requirement: Req 9.1 (affected_sector_count)
   */
  private async fetchAffectedSectorCount(articleId: string): Promise<number> {
    const rows = await prisma.newsSectorLink.findMany({
      where: { articleId },
      select: { sectorId: true },
      distinct: ['sectorId'],
    });
    return rows.length;
  }

  /**
   * Fetches the historical impact magnitude from news_market_reactions.
   *
   * Looks up all market reactions recorded for events of the same type and
   * computes the average of |return_15m| as a proxy for historical magnitude.
   * Returns the prior (0.5) when no data is available (Req 9.4).
   *
   * Requirement: Req 9.1 (historical_impact_magnitude), Req 9.4
   */
  private async fetchHistoricalImpactMagnitude(
    eventId: string,
    eventType: string,
  ): Promise<{ magnitude: number; dataAvailable: boolean }> {
    // Query reactions linked directly to the event first
    const directReactions = await prisma.newsMarketReaction.findMany({
      where: { eventId },
      select: { return15m: true },
    });

    if (directReactions.length > 0) {
      const values = directReactions
        .map((r) => r.return15m)
        .filter((v): v is number => v !== null);

      if (values.length > 0) {
        const avg = values.reduce((sum, v) => sum + Math.abs(v), 0) / values.length;
        // return_15m is in percentage points; normalise: cap at 5% → 1.0
        const normalised = clamp(avg / 5.0, 0.0, 1.0);
        return { magnitude: normalised, dataAvailable: true };
      }
    }

    // Fall back to similar events of the same type
    const similarEventIds = await prisma.newsEvent.findMany({
      where: {
        eventType,
        id: { not: eventId },
      },
      select: { id: true },
      take: 50,
    });

    if (similarEventIds.length === 0) {
      return { magnitude: HISTORICAL_PRIOR, dataAvailable: false };
    }

    const ids = similarEventIds.map((e) => e.id);
    const reactions = await prisma.newsMarketReaction.findMany({
      where: { eventId: { in: ids } },
      select: { return15m: true },
    });

    const values = reactions
      .map((r) => r.return15m)
      .filter((v): v is number => v !== null);

    if (values.length === 0) {
      return { magnitude: HISTORICAL_PRIOR, dataAvailable: false };
    }

    const avg = values.reduce((sum, v) => sum + Math.abs(v), 0) / values.length;
    const normalised = clamp(avg / 5.0, 0.0, 1.0);
    return { magnitude: normalised, dataAvailable: true };
  }

  /**
   * Counts events of the same type published in the past 7 days (novelty denominator).
   *
   * Requirement: Req 9.1 (novelty)
   */
  private async fetchSimilarEventCount(eventType: string, publishedAt: Date): Promise<number> {
    const sevenDaysAgo = new Date(publishedAt.getTime() - 7 * 24 * 60 * 60 * 1_000);

    const count = await prisma.newsEvent.count({
      where: {
        eventType,
        eventTimestamp: { gte: sevenDaysAgo, lte: publishedAt },
      },
    });

    return count;
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  /**
   * Upserts the news_importance row for this event_id.
   *
   * The sub_scores JSON includes both the raw values and their weights for a
   * fully traceable audit trail (Req 9.2).
   *
   * Requirements: Req 9.2, Req 9.5
   */
  private async persist(eventId: string, result: ImportanceResult): Promise<void> {
    const subScoresWithWeights = buildSubScoresAudit(result.subScores);

    await upsertImportance({
      eventId,
      importanceScore: result.importanceScore,
      subScores: subScoresWithWeights,
      historicalDataAvailable: result.historicalDataAvailable,
      modelVersion: result.modelVersion,
    });
  }

  // -------------------------------------------------------------------------
  // Queue publishing
  // -------------------------------------------------------------------------

  /**
   * Publishes the event_id to the news.impact BullMQ queue.
   * Logs a WARN on failure but does not throw — the importance record has
   * already been persisted at this point.
   *
   * Requirement: Req 9.6
   */
  private async publishToQueue(eventId: string): Promise<void> {
    try {
      await this.impactQueue.add('importance.computed', { eventId }, { jobId: eventId });
      logger.debug({ eventId }, 'Published event_id to news.impact queue');
    } catch (err) {
      logger.warn({ eventId, err }, 'Failed to publish event_id to news.impact queue');
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Pure helper functions (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Returns the event_severity sub-score for the given event_type string.
 * Falls back to UNCLASSIFIED (0.40) for unknown event types.
 */
export function resolveEventSeverity(eventType: string): number {
  return EVENT_SEVERITY[eventType] ?? EVENT_SEVERITY['UNCLASSIFIED']!;
}

/**
 * Returns the geopolitical_significance sub-score for the given event_type.
 * Falls back to UNCLASSIFIED (0.05) for unknown event types.
 */
export function resolveGeopoliticalSignificance(eventType: string): number {
  return GEOPOLITICAL_SIGNIFICANCE[eventType] ?? GEOPOLITICAL_SIGNIFICANCE['UNCLASSIFIED']!;
}

/**
 * Returns the macro_significance sub-score for the given event_type.
 * Falls back to UNCLASSIFIED (0.10) for unknown event types.
 */
export function resolveMacroSignificance(eventType: string): number {
  return MACRO_SIGNIFICANCE[eventType] ?? MACRO_SIGNIFICANCE['UNCLASSIFIED']!;
}

/**
 * Computes the weighted mean of all sub-scores using the predefined weights.
 * Result is NOT clamped here — clamping is done by the caller.
 */
export function computeWeightedMean(subScores: SubScores): number {
  const keys = Object.keys(WEIGHTS) as Array<keyof SubScores>;
  const weightedSum = keys.reduce((acc, key) => {
    const weight = WEIGHTS[key] ?? 0;
    return acc + subScores[key] * weight;
  }, 0);
  return weightedSum / TOTAL_WEIGHT;
}

/**
 * Clamps a number to the inclusive range [min, max].
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Builds the JSON audit object that is stored in news_importance.sub_scores.
 * Each entry contains the raw value and the weight so that the score can be
 * reconstructed and audited without code access (Req 9.2).
 */
function buildSubScoresAudit(subScores: SubScores): Record<string, { value: number; weight: number }> {
  const keys = Object.keys(WEIGHTS) as Array<keyof SubScores>;
  return Object.fromEntries(
    keys.map((key) => [
      key,
      {
        value: subScores[key],
        weight: WEIGHTS[key] ?? 0,
      },
    ]),
  );
}
