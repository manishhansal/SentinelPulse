/**
 * MarketImpactEngine — orchestrates the full market-impact computation
 * pipeline for a single NewsEvent.
 *
 * Pipeline position:
 *   news.impact queue → MarketImpactEngine → news_market_impacts (DB)
 *
 * Processing steps per event (Req 10.1 – 10.8):
 *   1. Obtain rule-based asset impacts from IndianMarketImpactEngine.
 *   2. For each asset, check news_market_reactions (sample_size >= 10)
 *      and upgrade evidence_type to HISTORICAL when data is available.
 *   3. Fetch qualifying cross-market relationships from
 *      news_event_relationships (confidence >= 0.2, sample_size >= 30,
 *      low_sample = false) and merge additional assets (Req 10.4).
 *   4. Resolve current market regime for India from news_market_regimes
 *      (valid_to IS NULL) for the MarketRegimeCompatibility factor (Req 13.4).
 *   5. Retrieve sentiment and importance data for the event.
 *   6. Compute NewsImpactScore = Sentiment × Importance × SourceReliability
 *      × EntityRelevance × HistoricalImpact × MarketRegimeCompatibility
 *      × Confidence, normalised to [-100, +100] (Req 10.6).
 *   7. Upsert each (event, asset) pair into news_market_impacts using
 *      (event_id, asset_id) as the idempotency key (Req 10.8).
 *
 * Requirements: Req 10.1 – 10.8, Req 13.4
 */

import { pino } from 'pino';
import type { Queue } from 'bullmq';
import { prisma, upsertMarketImpact } from '../../db/prisma.js';
import { IndianMarketImpactEngine, type AssetImpact } from './IndianMarketImpactEngine.js';
import type { Prisma } from '@prisma/client';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger = pino({ name: 'MarketImpactEngine' });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Semantic version string stored in impact_computation_version column. */
const IMPACT_COMPUTATION_VERSION = '1.0.0';

/**
 * Minimum number of HistoricalReaction samples required to upgrade
 * evidence_type from RULE_BASED to HISTORICAL (Req 10.3).
 */
const HISTORICAL_SAMPLE_THRESHOLD = 10;

/**
 * Minimum confidence required to consume a cross-market relationship (Req 10.4).
 */
const CROSS_MARKET_MIN_CONFIDENCE = 0.2;

/**
 * Minimum sample_size required on a cross-market relationship (Req 10.4).
 */
const CROSS_MARKET_MIN_SAMPLE = 30;

/**
 * MarketRegimeCompatibility score when no regime record exists.
 * Neutral assumption — regime is unknown rather than adverse.
 */
const DEFAULT_REGIME_COMPATIBILITY = 0.75;

/**
 * Regime compatibility multipliers per regime classification.
 * Values reflect how conducive each regime is to news-driven price moves.
 */
const REGIME_COMPATIBILITY: Readonly<Record<string, number>> = {
  TRENDING_BULL: 0.90,
  TRENDING_BEAR: 0.85,
  SIDEWAYS: 0.60,
  HIGH_VOLATILITY: 1.00,
  LOW_VOLATILITY: 0.55,
  RISK_ON: 0.88,
  RISK_OFF: 0.92,
  EVENT_DRIVEN: 1.00,
  PANIC: 1.00,
  RECOVERY: 0.80,
} as const;

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

/** Event payload consumed from the news.impact BullMQ queue. */
export interface ImpactEvent {
  /** Primary key of the NewsEvent row. */
  id: string;
  /** Source article that triggered this event. */
  articleId: string;
  /** Classified event type string (e.g. "MONETARY_POLICY"). */
  eventType: string;
  /** Primary actor extracted from the event (e.g. "RBI"). */
  actor: string | null;
  /** Importance score ∈ [0.0, 1.0] from ImportanceEngine. */
  importance: number;
  /** Surprise score ∈ [-5.0, +5.0] or null if not available. */
  surpriseScore: number | null;
  /** Article title — used for keyword matching in IndianMarketImpactEngine. */
  title: string;
  /** Timestamp of the underlying market event. */
  publishedAt: Date;
  /** Source identifier for SourceReliability look-up. */
  sourceId: string;
}

/**
 * Parameters for the NewsImpactScore formula (Req 10.6).
 * All multiplicative factors are ∈ [0.0, 1.0] before normalisation.
 * `sentiment` is ∈ [-1.0, +1.0].
 */
interface NewsImpactScoreParams {
  sentiment: number;
  importance: number;
  sourceReliability: number;
  entityRelevance: number;
  historicalImpact: number;
  regimeCompatibility: number;
  confidence: number;
}

// ---------------------------------------------------------------------------
// MarketImpactEngine
// ---------------------------------------------------------------------------

/**
 * Computes and persists market impact predictions for a single NewsEvent.
 *
 * Requirements: Req 10.1 – 10.8
 */
export class MarketImpactEngine {
  private readonly indianEngine: IndianMarketImpactEngine;

  constructor(
    /**
     * BullMQ queue reference — currently reserved for downstream
     * HistoricalReactionEngine triggering.  Not used within this class
     * to publish but injected for architectural consistency.
     */
    private readonly impactQueue: Queue,
  ) {
    this.indianEngine = new IndianMarketImpactEngine();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Full market-impact computation for a single NewsEvent.
   *
   * Implements the seven-step pipeline described in the module docblock.
   * The method is idempotent — reprocessing the same event_id upserts
   * existing rows in place (Req 10.8).
   *
   * Requirements: Req 10.1 – 10.8
   */
  async process(event: ImpactEvent): Promise<void> {
    logger.info(
      { eventId: event.id, eventType: event.eventType, actor: event.actor },
      'MarketImpactEngine.process — start',
    );

    // ------------------------------------------------------------------
    // 1. Rule-based impacts from IndianMarketImpactEngine (Req 10.2)
    // ------------------------------------------------------------------
    const ruleImpacts = this.indianEngine.getAffectedAssets(
      event.eventType,
      event.actor,
      event.title,
    );

    // ------------------------------------------------------------------
    // 2. Upgrade RULE_BASED → HISTORICAL where supported (Req 10.3)
    // ------------------------------------------------------------------
    const resolvedImpacts = await this.upgradeToHistorical(event.id, ruleImpacts);

    // ------------------------------------------------------------------
    // 3. Merge cross-market relationship assets (Req 10.4)
    // ------------------------------------------------------------------
    const crossMarketImpacts = await this.fetchCrossMarketImpacts(event.id, resolvedImpacts);
    const allImpacts = mergeImpacts(resolvedImpacts, crossMarketImpacts);

    if (allImpacts.length === 0) {
      logger.info({ eventId: event.id }, 'No affected assets identified — skipping upsert');
      return;
    }

    // ------------------------------------------------------------------
    // 4. Resolve current India market regime (Req 13.4)
    // ------------------------------------------------------------------
    const regimeCompatibility = await this.resolveRegimeCompatibility();

    // ------------------------------------------------------------------
    // 5. Fetch sentiment + source reliability (Req 10.6)
    // ------------------------------------------------------------------
    const [sentiment, sourceReliability] = await Promise.all([
      this.fetchSentiment(event.articleId),
      this.fetchSourceReliability(event.sourceId),
    ]);

    // ------------------------------------------------------------------
    // 6 & 7. Compute NewsImpactScore and upsert per (event, asset) pair
    // ------------------------------------------------------------------
    await Promise.all(
      allImpacts.map((impact) =>
        this.persistImpact(event, impact, {
          sentiment,
          sourceReliability,
          regimeCompatibility,
        }),
      ),
    );

    logger.info(
      { eventId: event.id, assetCount: allImpacts.length },
      'MarketImpactEngine.process — completed',
    );
  }

  // -------------------------------------------------------------------------
  // NewsImpactScore computation (Req 10.6, Req 10.7)
  // -------------------------------------------------------------------------

  /**
   * Computes the composite NewsImpactScore for a single (event, asset) pair.
   *
   * Formula (Req 10.6):
   *   raw = Sentiment × Importance × SourceReliability × EntityRelevance
   *         × HistoricalImpact × MarketRegimeCompatibility × Confidence
   *
   * Normalisation: raw ∈ [-1, +1] → scaled to [-100, +100].
   *
   * Because the formula multiplies seven factors, the theoretical range of
   * the product is already [-1, +1] when `sentiment` ∈ [-1, +1] and all
   * other factors ∈ [0, 1].  We multiply by 100 and clamp.
   *
   * Requirements: Req 10.6, Req 10.7
   */
  private computeNewsImpactScore(params: NewsImpactScoreParams): number {
    const {
      sentiment,
      importance,
      sourceReliability,
      entityRelevance,
      historicalImpact,
      regimeCompatibility,
      confidence,
    } = params;

    const raw =
      sentiment *
      importance *
      sourceReliability *
      entityRelevance *
      historicalImpact *
      regimeCompatibility *
      confidence;

    // Normalise to [-100, +100] and clamp
    const score = raw * 100;
    return Math.max(-100, Math.min(100, score));
  }

  // -------------------------------------------------------------------------
  // Historical evidence upgrade (Req 10.3)
  // -------------------------------------------------------------------------

  /**
   * For each rule-based impact, queries news_market_reactions to determine
   * how many distinct historical samples exist for the (eventType, assetId)
   * combination.  When sample_size >= HISTORICAL_SAMPLE_THRESHOLD the
   * evidence_type is upgraded to HISTORICAL and strength/confidence are
   * refreshed from the historical mean.
   *
   * Requirement: Req 10.3
   */
  private async upgradeToHistorical(
    eventId: string,
    impacts: AssetImpact[],
  ): Promise<AssetImpact[]> {
    if (impacts.length === 0) return impacts;

    // Resolve the event's type to query similar-event reactions
    const event = await prisma.newsEvent.findUnique({
      where: { id: eventId },
      select: { eventType: true },
    });

    const eventType = event?.eventType ?? '';

    // For all similar events of the same type, load reactions
    const similarEventIds = await prisma.newsEvent.findMany({
      where: { eventType, id: { not: eventId } },
      select: { id: true },
      take: 200,
    });
    const ids = similarEventIds.map((e) => e.id);

    return Promise.all(
      impacts.map(async (impact) => {
        if (ids.length === 0) return impact;

        const reactions = await prisma.newsMarketReaction.findMany({
          where: {
            eventId: { in: ids },
            assetId: impact.assetId,
          },
          select: { return15m: true },
        });

        if (reactions.length < HISTORICAL_SAMPLE_THRESHOLD) return impact;

        // Enough samples — compute mean direction and strength
        const returns = reactions
          .map((r) => r.return15m)
          .filter((v): v is number => v !== null);

        if (returns.length === 0) return impact;

        const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
        const direction = meanReturn > 0 ? 'POSITIVE' : meanReturn < 0 ? 'NEGATIVE' : 'NEUTRAL';
        // Strength: |mean return| normalised, capped at 1.0 (5% → 1.0)
        const strength = Math.min(Math.abs(meanReturn) / 5.0, 1.0);
        // Confidence scales with sample size up to a ceiling of 0.95
        const confidence = Math.min(0.95, 0.6 + (reactions.length / 100) * 0.35);

        return {
          ...impact,
          direction,
          strength,
          confidence,
          evidenceType: 'HISTORICAL' as const,
          reason: `${impact.reason} [Upgraded to HISTORICAL: ${reactions.length} samples, mean return ${meanReturn.toFixed(2)}%]`,
        };
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Cross-market relationship expansion (Req 10.4)
  // -------------------------------------------------------------------------

  /**
   * Queries news_event_relationships for the assets already identified,
   * expanding to additional target assets where the relationship meets the
   * confidence and sample-size gates (Req 10.4).
   *
   * Returns only NEW impacts (assets not already present in `existing`).
   * The relationship_id is stored for traceability.
   *
   * Requirement: Req 10.4
   */
  private async fetchCrossMarketImpacts(
    _eventId: string,
    existing: AssetImpact[],
  ): Promise<Array<AssetImpact & { relationshipId?: string }>> {
    if (existing.length === 0) return [];

    const existingAssetIds = new Set(existing.map((i) => i.assetId));
    const results: Array<AssetImpact & { relationshipId?: string }> = [];

    for (const impact of existing) {
      const relationships = await prisma.newsEventRelationship.findMany({
        where: {
          sourceEntityId: impact.assetId,
          confidence: { gte: CROSS_MARKET_MIN_CONFIDENCE },
          sampleSize: { gte: CROSS_MARKET_MIN_SAMPLE },
          lowSample: false,
        },
        select: {
          id: true,
          targetEntityId: true,
          relationshipType: true,
          historicalCorrelation: true,
          confidence: true,
        },
      });

      for (const rel of relationships) {
        if (existingAssetIds.has(rel.targetEntityId)) continue; // already covered

        const direction =
          rel.relationshipType === 'POSITIVE_CORRELATION'
            ? impact.direction                          // same direction as source
            : rel.relationshipType === 'NEGATIVE_CORRELATION'
              ? flipDirection(impact.direction)          // inverted
              : 'UNCERTAIN';

        results.push({
          assetId: rel.targetEntityId,
          direction,
          strength: Math.abs(rel.historicalCorrelation) * impact.strength,
          confidence: rel.confidence * impact.confidence,
          expectedHorizon: impact.expectedHorizon,
          evidenceType: 'HISTORICAL',
          reason: `Cross-market relationship from ${impact.assetId} (${rel.relationshipType}, corr=${rel.historicalCorrelation.toFixed(2)}).`,
          relationshipId: rel.id,
        });

        existingAssetIds.add(rel.targetEntityId);
      }
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // Regime compatibility (Req 13.4)
  // -------------------------------------------------------------------------

  /**
   * Reads the current India market regime from news_market_regimes
   * (the row where valid_to IS NULL) and maps it to a compatibility score.
   *
   * Returns `DEFAULT_REGIME_COMPATIBILITY` when no current regime is found.
   *
   * Requirement: Req 13.4
   */
  private async resolveRegimeCompatibility(): Promise<number> {
    try {
      const regime = await prisma.newsMarketRegime.findFirst({
        where: { marketId: 'india', validTo: null },
        select: { regime: true, confidence: true },
        orderBy: { validFrom: 'desc' },
      });

      if (!regime) {
        logger.warn('No current India market regime found; using default compatibility');
        return DEFAULT_REGIME_COMPATIBILITY;
      }

      const baseCompatibility =
        REGIME_COMPATIBILITY[regime.regime] ?? DEFAULT_REGIME_COMPATIBILITY;

      // Weight by regime classification confidence
      return baseCompatibility * regime.confidence + DEFAULT_REGIME_COMPATIBILITY * (1 - regime.confidence);
    } catch (err) {
      logger.warn({ err }, 'Failed to fetch market regime; using default compatibility');
      return DEFAULT_REGIME_COMPATIBILITY;
    }
  }

  // -------------------------------------------------------------------------
  // Sentiment fetch
  // -------------------------------------------------------------------------

  /**
   * Retrieves the most recent market_sentiment score for the article.
   * Falls back to 0 (neutral) when no sentiment record exists.
   *
   * Requirement: Req 10.6 (Sentiment factor)
   */
  private async fetchSentiment(articleId: string): Promise<number> {
    const sentiment = await prisma.newsSentiment.findFirst({
      where: { articleId },
      select: { marketSentiment: true },
      orderBy: { computedAt: 'desc' },
    });

    if (!sentiment) {
      logger.warn({ articleId }, 'No sentiment record found; using neutral 0');
      return 0;
    }

    return Number(sentiment.marketSentiment);
  }

  // -------------------------------------------------------------------------
  // Source reliability fetch
  // -------------------------------------------------------------------------

  /**
   * Returns source_reliability from news_sources.
   * Falls back to Tier-2 default (0.8) when source is not found.
   *
   * Requirement: Req 9.3, Req 10.6 (SourceReliability factor)
   */
  private async fetchSourceReliability(sourceId: string): Promise<number> {
    const source = await prisma.newsSource.findUnique({
      where: { id: sourceId },
      select: { sourceReliability: true },
    });

    if (!source) {
      logger.warn({ sourceId }, 'Source not found; using Tier-2 reliability default 0.8');
      return 0.8;
    }

    return Math.max(0, Math.min(1, source.sourceReliability));
  }

  // -------------------------------------------------------------------------
  // EntityRelevance resolution
  // -------------------------------------------------------------------------

  /**
   * Resolves EntityRelevance for the (article, asset) pair from
   * news_entity_mentions joined through news_entities.
   *
   * Returns the highest confidence mention for the asset in the article,
   * or a default of 0.5 when no mention exists (moderate relevance assumed
   * because the asset was identified by the rule engine).
   *
   * Requirement: Req 10.6 (EntityRelevance factor)
   */
  private async fetchEntityRelevance(articleId: string, assetId: string): Promise<number> {
    const mention = await prisma.newsEntityMention.findFirst({
      where: {
        articleId,
        entity: { instrumentId: assetId },
      },
      select: { confidence: true },
      orderBy: { confidence: 'desc' },
    });

    if (!mention) return 0.5; // default relevance
    return Math.max(0, Math.min(1, Number(mention.confidence)));
  }

  // -------------------------------------------------------------------------
  // HistoricalImpact factor
  // -------------------------------------------------------------------------

  /**
   * Returns the HistoricalImpact factor ∈ [0, 1] for the NewsImpactScore
   * formula.  For HISTORICAL evidence impacts this is derived from the
   * impact strength (which was already normalised from mean historical
   * return).  For RULE_BASED impacts a moderate default (0.5) is used.
   *
   * Requirement: Req 10.6 (HistoricalImpact factor)
   */
  private resolveHistoricalImpactFactor(impact: AssetImpact): number {
    return impact.evidenceType === 'HISTORICAL' ? impact.strength : 0.5;
  }

  // -------------------------------------------------------------------------
  // Persistence (Req 10.5, Req 10.7, Req 10.8)
  // -------------------------------------------------------------------------

  /**
   * Computes the NewsImpactScore and upserts the news_market_impacts row for
   * a single (event, asset) pair.
   *
   * Requirements: Req 10.5, Req 10.6, Req 10.7, Req 10.8
   */
  private async persistImpact(
    event: ImpactEvent,
    impact: AssetImpact & { relationshipId?: string },
    context: {
      sentiment: number;
      sourceReliability: number;
      regimeCompatibility: number;
    },
  ): Promise<void> {
    const entityRelevance = await this.fetchEntityRelevance(event.articleId, impact.assetId);
    const historicalImpact = this.resolveHistoricalImpactFactor(impact);

    // Direction sign for the sentiment component
    const directionSign =
      impact.direction === 'POSITIVE' ? 1 :
      impact.direction === 'NEGATIVE' ? -1 : 0;

    // Treat direction as signed sentiment scalar × confidence
    const effectiveSentiment =
      Math.abs(context.sentiment) > 0
        ? context.sentiment
        : directionSign * impact.strength; // fall back to rule direction

    const scoreParams: NewsImpactScoreParams = {
      sentiment: effectiveSentiment,
      importance: event.importance,
      sourceReliability: context.sourceReliability,
      entityRelevance,
      historicalImpact,
      regimeCompatibility: context.regimeCompatibility,
      confidence: impact.confidence,
    };

    const newsImpactScore = this.computeNewsImpactScore(scoreParams);

    // Build the impact_components JSON for full traceability (Req 10.7)
    const impactComponents: Prisma.InputJsonValue = {
      sentiment: scoreParams.sentiment,
      importance: scoreParams.importance,
      sourceReliability: scoreParams.sourceReliability,
      entityRelevance: scoreParams.entityRelevance,
      historicalImpact: scoreParams.historicalImpact,
      regimeCompatibility: scoreParams.regimeCompatibility,
      confidence: scoreParams.confidence,
      newsImpactScore,
      evidenceType: impact.evidenceType,
      relationshipId: impact.relationshipId ?? null,
    };

    try {
      await upsertMarketImpact({
        articleId: event.articleId,
        eventId: event.id,
        assetId: impact.assetId,
        sectorId: impact.sectorId,
        direction: impact.direction,
        strength: impact.strength,
        confidence: impact.confidence,
        expectedHorizon: impact.expectedHorizon,
        evidenceType: impact.evidenceType,
        impactComputationVersion: IMPACT_COMPUTATION_VERSION,
        newsImpactScore,
        impactComponents,
      });

      logger.debug(
        {
          eventId: event.id,
          assetId: impact.assetId,
          direction: impact.direction,
          newsImpactScore: newsImpactScore.toFixed(2),
          evidenceType: impact.evidenceType,
        },
        'Upserted news_market_impacts row',
      );
    } catch (err) {
      logger.error(
        { eventId: event.id, assetId: impact.assetId, err },
        'Failed to upsert news_market_impacts row',
      );
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Pure helper functions (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Flips a directional prediction to its opposite.
 * POSITIVE ↔ NEGATIVE; NEUTRAL and UNCERTAIN are unchanged.
 */
export function flipDirection(
  direction: AssetImpact['direction'],
): AssetImpact['direction'] {
  if (direction === 'POSITIVE') return 'NEGATIVE';
  if (direction === 'NEGATIVE') return 'POSITIVE';
  return direction;
}

/**
 * Merges two arrays of AssetImpact records, de-duplicating by assetId.
 * Records in `primary` take precedence over `secondary` for the same assetId.
 */
export function mergeImpacts(
  primary: AssetImpact[],
  secondary: AssetImpact[],
): AssetImpact[] {
  const seen = new Set(primary.map((i) => i.assetId));
  const deduped = secondary.filter((i) => !seen.has(i.assetId));
  return [...primary, ...deduped];
}
