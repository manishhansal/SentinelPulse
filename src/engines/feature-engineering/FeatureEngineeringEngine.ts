/**
 * FeatureEngineeringEngine — assembles point-in-time correct FeatureVectors
 * for every NewsEvent whose importance_score exceeds 0.3.
 *
 * Key responsibilities (Req 20.1–20.6, Req 21.1):
 *   • Build a FeatureVector from 7 feature groups (article, event, asset,
 *     macro, cross-market, temporal, market-context).
 *   • Enforce strict point-in-time correctness via LookAheadGuard — any data
 *     source with recordTimestamp > event_timestamp raises LookAheadBiasError
 *     and aborts computation without persisting a partial vector.
 *   • Store in news_features with (event_id, asset_id, feature_version) as the
 *     idempotency key; retry up to 3× at 1-second intervals on storage failure.
 *   • Publish to news.features queue within 500 ms of successful storage;
 *     raise an error (never silently drop) if the queue is unavailable.
 *   • On feature schema change: increment feature_version, enqueue a backfill
 *     job, and preserve all records stored under prior versions (Req 20.4).
 *
 * Requirements: Req 20.1–20.6, Req 21.1
 */

import { LookAheadBiasError, LookAheadGuard } from './LookAheadGuard.js';
import { prisma } from '../../db/prisma.js';
import { DataServiceClient } from '../../integrations/data-service/DataServiceClient.js';
import type { Queue } from 'bullmq';

// ---------------------------------------------------------------------------
// Constants — one-hot encoding vocabularies (Req 20.1)
// ---------------------------------------------------------------------------

/** Ordered list of qualitative sentiment signal labels for one-hot encoding. */
export const QUALITATIVE_SIGNALS = [
  'UNCERTAINTY',
  'FEAR',
  'HAWKISH',
  'DOVISH',
  'RISK_ON',
  'RISK_OFF',
  'OPTIMISM',
  'PANIC',
  'NEUTRAL',
] as const;

export type QualitativeSignal = (typeof QUALITATIVE_SIGNALS)[number];

/** Ordered list of event type labels for one-hot encoding. */
export const EVENT_TYPE_VALUES = [
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

export type EventTypeValue = (typeof EVENT_TYPE_VALUES)[number];

/** Ordered list of surprise direction values for ordinal encoding. */
const SURPRISE_DIRECTION_VALUES = ['MISS', 'IN_LINE', 'BEAT', 'UNKNOWN'] as const;
type SurpriseDirection = (typeof SURPRISE_DIRECTION_VALUES)[number];

/** Ordinal encoding for dominant cross-market direction. */
const CROSS_MARKET_DIRECTION_VALUES = [
  'NEGATIVE_CORRELATION',
  'NEUTRAL',
  'POSITIVE_CORRELATION',
  'CAUSAL_INDICATOR',
  'SECTOR_ROTATION',
] as const;

// ---------------------------------------------------------------------------
// Taxonomy categories used to derive macro feature scores (Req 7.1)
// ---------------------------------------------------------------------------

const CRUDE_OIL_CATEGORIES = ['CRUDE_OIL'] as const;
const GOLD_CATEGORIES = ['GOLD', 'SILVER', 'METALS'] as const;
const USD_INR_CATEGORIES = ['INDIA_MACRO', 'GLOBAL_MACRO'] as const;
const FED_POLICY_CATEGORIES = ['FED_POLICY', 'US_MARKET'] as const;
const RBI_POLICY_CATEGORIES = ['RBI', 'INDIA_MACRO'] as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A flat map of feature name → numeric value (or null when unavailable).
 * All values are point-in-time correct with respect to event_timestamp.
 */
export type FeatureVector = Record<string, number | null>;

/** Input payload for FeatureEngineeringEngine.process(). */
export interface FeatureEventInput {
  /** UUID of the NewsEvent record. */
  id: string;
  /** UUID of the source NewsArticle. */
  articleId: string;
  /** Event type string (see EVENT_TYPE_VALUES). */
  eventType: string;
  /** Point-in-time anchor — all features must use data <= this timestamp. */
  eventTimestamp: Date;
  /** Primary asset for market-context features (optional). */
  assetId?: string;
}

// ---------------------------------------------------------------------------
// FeatureEngineeringEngine
// ---------------------------------------------------------------------------

export class FeatureEngineeringEngine {
  private readonly guard = new LookAheadGuard();

  constructor(
    /** BullMQ queue for publishing completed FeatureVectors (news.features). */
    private readonly featuresQueue: Queue,
    /** HTTP client for the AlphaForge data-service. */
    private readonly dataServiceClient: DataServiceClient = new DataServiceClient(),
    /**
     * Identifies the current feature schema version.
     * Increment this string when the feature schema changes to trigger
     * automatic backfill job enqueueing (Req 20.4).
     */
    private readonly featureVersion: string = process.env['FEATURE_VERSION'] ?? '1.0.0',
    /** Pipeline version for full audit-trail traceability. */
    private readonly pipelineVersion: string = process.env['PIPELINE_VERSION'] ?? '1.0.0',
  ) {}

  // --------------------------------------------------------------------------
  // process() — public entry point
  // --------------------------------------------------------------------------

  /**
   * Generates, validates, stores, and publishes a FeatureVector for the given
   * NewsEvent. Skips silently when importance_score <= 0.3 (Req 20.1).
   *
   * Storage is retried up to 3 times at 1-second intervals (Req 20.3).
   * Queue publish happens within 500 ms of successful storage (Req 20.6).
   *
   * @throws {LookAheadBiasError} — if any data source violates point-in-time
   *   correctness (Req 20.2, Req 21.1). The FeatureVector is NOT persisted.
   * @throws {Error} — on storage failure after 3 retries (Req 20.3) or on
   *   queue publish failure (Req 20.6).
   *
   * Requirements: Req 20.1–20.6, Req 21.1
   */
  async process(event: FeatureEventInput): Promise<void> {
    // -----------------------------------------------------------------------
    // Req 20.1 — gate: only process events with importance_score > 0.3
    // -----------------------------------------------------------------------
    const importance = await this.fetchImportanceScore(event.id);
    if (importance === null || importance <= 0.3) {
      // importance not available or below threshold — skip silently
      return;
    }

    // -----------------------------------------------------------------------
    // Req 20.2 — build feature vector (LookAheadGuard applied inside)
    // Any LookAheadBiasError propagates up and prevents persistence.
    // -----------------------------------------------------------------------
    const featureVector = await this.buildFeatureVector(event);

    // -----------------------------------------------------------------------
    // Req 20.3 — persist to news_features, retry up to 3× at 1s
    // Req 20.5 — idempotent: upsert on (event_id, asset_id, feature_version)
    // -----------------------------------------------------------------------
    const storedFeature = await this.storeWithRetry(event, featureVector);

    // -----------------------------------------------------------------------
    // Req 20.6 — publish to news.features within 500 ms of storage
    // -----------------------------------------------------------------------
    await this.publishToQueue(storedFeature.id, event, featureVector);
  }

  // --------------------------------------------------------------------------
  // buildFeatureVector() — assembles all 7 feature groups
  // --------------------------------------------------------------------------

  /**
   * Assembles the full FeatureVector from all 7 feature groups.
   * Returns null for each feature whose underlying data is unavailable.
   * Throws LookAheadBiasError on any point-in-time violation (Req 20.2).
   *
   * Requirements: Req 20.1, Req 20.2, Req 21.1
   */
  private async buildFeatureVector(event: FeatureEventInput): Promise<FeatureVector> {
    // Run all independent data fetches in parallel for performance
    const [
      sentimentRow,
      importanceRow,
      eventRow,
      velocityRow,
      clusterRow,
      crossMarketRows,
      assetMentionCount,
      assetBreadthRow,
      macroScores,
      marketContext,
    ] = await Promise.all([
      // 1. Sentiment dimensions from news_sentiment (latest record for articleId)
      this.fetchLatestSentiment(event.articleId),
      // 2. Importance sub-scores from news_importance (keyed by eventId)
      this.fetchImportanceRow(event.id),
      // 3. Event details (surprise_score, event_type) from news_events
      this.fetchEventRow(event.id),
      // 4. Velocity feature from news_features (feature_type='VELOCITY') for asset
      event.assetId ? this.fetchVelocityFeature(event.assetId, event.eventTimestamp) : Promise.resolve(null),
      // 5. Cluster details for cluster_size and cluster_importance
      this.fetchClusterDetails(event.articleId),
      // 6. Cross-market relationship count from news_event_relationships
      event.assetId ? this.fetchCrossMarketRelationships(event.assetId) : Promise.resolve([]),
      // 7. Asset mention count in the source article
      event.assetId ? this.fetchAssetMentionCount(event.articleId, event.assetId) : Promise.resolve(null),
      // 8. Breadth metrics for asset (positive / negative)
      event.assetId ? this.fetchAssetBreadth(event.assetId, event.eventTimestamp) : Promise.resolve(null),
      // 9. Macro scores from recent sentiment of relevant taxonomy categories
      this.fetchMacroScores(event.eventTimestamp),
      // 10. Market context from data-service at event_timestamp
      event.assetId
        ? this.fetchMarketContext(event.assetId, event.eventTimestamp)
        : Promise.resolve(null),
    ]);

    // -----------------------------------------------------------------------
    // Point-in-time validation for all database-sourced records (Req 20.2)
    // Records stored in the DB have computedAt <= event_timestamp by design,
    // but we validate the ones that carry an explicit timestamp field.
    // -----------------------------------------------------------------------
    if (sentimentRow) {
      this.guard.validateOne(
        'sentiment.computedAt',
        sentimentRow.computedAt,
        event.eventTimestamp,
      );
    }
    if (importanceRow) {
      this.guard.validateOne(
        'importance.computedAt',
        importanceRow.computedAt,
        event.eventTimestamp,
      );
    }
    if (velocityRow) {
      this.guard.validateOne(
        'velocity.computedAt',
        velocityRow.computedAt,
        event.eventTimestamp,
      );
    }

    // Market context asOf validation is performed inside fetchMarketContext().

    // -----------------------------------------------------------------------
    // Temporal features — derived directly from event_timestamp (no I/O)
    // -----------------------------------------------------------------------
    const ts = event.eventTimestamp;
    const hourOfDay = ts.getUTCHours();
    const dayOfWeek = ts.getUTCDay();

    // -----------------------------------------------------------------------
    // One-hot encode event_type (index in EVENT_TYPE_VALUES array)
    // -----------------------------------------------------------------------
    const eventTypeOneHot = encodeOneHot(
      event.eventType as EventTypeValue,
      EVENT_TYPE_VALUES as unknown as string[],
    );

    // -----------------------------------------------------------------------
    // One-hot encode qualitative signals
    // -----------------------------------------------------------------------
    const qualSignals: string[] = sentimentRow?.qualitativeSignals ?? [];
    const qualOneHot = encodeOneHotSet(
      qualSignals,
      QUALITATIVE_SIGNALS as unknown as string[],
    );

    // -----------------------------------------------------------------------
    // Encode surprise_direction as ordinal int
    // -----------------------------------------------------------------------
    const surpriseDir = (eventRow?.surpriseDirection ?? 'UNKNOWN') as SurpriseDirection;
    const surpriseDirEncoded = SURPRISE_DIRECTION_VALUES.indexOf(surpriseDir as (typeof SURPRISE_DIRECTION_VALUES)[number]);

    // -----------------------------------------------------------------------
    // Cross-market: count active relationships and encode dominant direction
    // -----------------------------------------------------------------------
    const activeCrossMarketRelationships = crossMarketRows.length;
    const dominantCrossMarketDirection = deriveDominantCrossMarketDirection(crossMarketRows);

    // -----------------------------------------------------------------------
    // Asset mention count (from news_entity_mentions)
    // -----------------------------------------------------------------------
    const assetMomentum = velocityRow?.momentum ?? null;

    // -----------------------------------------------------------------------
    // Assemble FeatureVector — all 7 feature groups (Req 20.1)
    // -----------------------------------------------------------------------
    const fv: FeatureVector = {
      // -- Group 1: Article features ------------------------------------------
      sentiment_score: toNum(sentimentRow?.sentimentScore),
      market_sentiment: toNum(sentimentRow?.marketSentiment),
      company_sentiment: toNum(sentimentRow?.companySentiment),
      macro_sentiment: toNum(sentimentRow?.macroSentiment),
      risk_sentiment: toNum(sentimentRow?.riskSentiment),
      importance_score: importanceRow?.importanceScore ?? null,
      novelty_score: extractSubScore(importanceRow?.subScores, 'novelty'),
      surprise_score: eventRow?.surpriseScore ?? null,
      // One-hot flags for each qualitative signal (e.g. signal_FEAR: 0|1)
      ...buildOneHotFeatures(
        'signal',
        qualOneHot,
        QUALITATIVE_SIGNALS as unknown as string[],
      ),

      // -- Group 2: Event features --------------------------------------------
      // One-hot flags for each event type (e.g. event_type_EARNINGS: 0|1)
      ...buildOneHotFeatures(
        'event_type',
        eventTypeOneHot,
        EVENT_TYPE_VALUES as unknown as string[],
      ),
      event_severity: importanceRow
        ? extractSubScore(importanceRow.subScores, 'event_severity')
        : null,
      velocity_at_event_time: velocityRow?.value ?? null,
      cluster_size: clusterRow?.sourceCount ?? null,
      cluster_importance: clusterRow ? toNum(clusterRow.consensusScore) : null,
      surprise_direction: surpriseDirEncoded >= 0 ? surpriseDirEncoded : null,

      // -- Group 3: Asset features --------------------------------------------
      asset_mention_count: assetMentionCount,
      asset_news_momentum: assetMomentum,
      asset_news_breadth_positive: assetBreadthRow?.positiveCount ?? null,
      asset_news_breadth_negative: assetBreadthRow?.negativeCount ?? null,

      // -- Group 4: Macro features --------------------------------------------
      crude_oil_news_score: macroScores.crudeOil,
      gold_news_score: macroScores.gold,
      usd_inr_news_score: macroScores.usdInr,
      fed_policy_score: macroScores.fedPolicy,
      rbi_policy_score: macroScores.rbiPolicy,

      // -- Group 5: Cross-market features -------------------------------------
      active_cross_market_relationships: activeCrossMarketRelationships,
      dominant_cross_market_direction: dominantCrossMarketDirection,

      // -- Group 6: Temporal features -----------------------------------------
      hour_of_day: hourOfDay,
      day_of_week: dayOfWeek,
      days_to_rbi_meeting: null,   // populated by caller if known
      days_to_fed_meeting: null,   // populated by caller if known
      days_to_earnings: null,      // populated by caller if known

      // -- Group 7: Market context features -----------------------------------
      market_price: marketContext?.price ?? null,
      market_open: marketContext?.open ?? null,
      market_high: marketContext?.high ?? null,
      market_low: marketContext?.low ?? null,
      market_close: marketContext?.close ?? null,
      market_volume: marketContext?.volume ?? null,
      market_atr: marketContext?.atr ?? null,
      market_vwap: marketContext?.vwap ?? null,
      market_open_interest: marketContext?.openInterest ?? null,
      market_vix: marketContext?.vix ?? null,
    };

    return fv;
  }

  // --------------------------------------------------------------------------
  // Data-fetching helpers
  // --------------------------------------------------------------------------

  /** Returns the importance_score for the event (null when not found). */
  private async fetchImportanceScore(eventId: string): Promise<number | null> {
    const row = await prisma.newsImportance.findUnique({
      where: { eventId },
      select: { importanceScore: true },
    });
    return row?.importanceScore ?? null;
  }

  /**
   * Returns the latest (most recently computed) news_sentiment record for
   * the given articleId. "Latest" is determined by computedAt DESC.
   */
  private async fetchLatestSentiment(articleId: string) {
    return prisma.newsSentiment.findFirst({
      where: { articleId },
      orderBy: { computedAt: 'desc' },
    });
  }

  /** Returns the news_importance row for the event. */
  private async fetchImportanceRow(eventId: string) {
    return prisma.newsImportance.findUnique({ where: { eventId } });
  }

  /** Returns the news_events row for the event (for surpriseScore / eventType). */
  private async fetchEventRow(eventId: string) {
    return prisma.newsEvent.findUnique({
      where: { id: eventId },
      select: {
        surpriseScore: true,
        surpriseDirection: true,
        importance: true,
        confidence: true,
        eventTimestamp: true,
        articleId: true,
      },
    });
  }

  /**
   * Returns the most recent VELOCITY feature record for the asset that was
   * computed at or before eventTimestamp (point-in-time correct).
   */
  private async fetchVelocityFeature(assetId: string, eventTimestamp: Date) {
    return prisma.newsFeature.findFirst({
      where: {
        assetId,
        featureType: 'VELOCITY',
        computedAt: { lte: eventTimestamp },
      },
      orderBy: { computedAt: 'desc' },
    });
  }

  /**
   * Returns cluster details (sourceCount, consensusScore) from the cluster
   * associated with the source article. Returns null when unclusterable.
   */
  private async fetchClusterDetails(articleId: string) {
    const article = await prisma.newsArticle.findUnique({
      where: { id: articleId },
      select: {
        cluster: {
          select: {
            sourceCount: true,
            consensusScore: true,
          },
        },
      },
    });
    return article?.cluster ?? null;
  }

  /**
   * Returns all active cross-market relationship records for the given asset
   * that meet the MarketImpactEngine quality threshold (confidence >= 0.2,
   * sample_size >= 30, low_sample = false — Req 10.4).
   */
  private async fetchCrossMarketRelationships(assetId: string) {
    return prisma.newsEventRelationship.findMany({
      where: {
        sourceEntityId: assetId,
        confidence: { gte: 0.2 },
        sampleSize: { gte: 30 },
        lowSample: false,
      },
      select: { relationshipType: true, confidence: true, historicalCorrelation: true },
    });
  }

  /**
   * Returns the count of news_entity_mentions for the given asset in the
   * source article. Used as the asset_mention_count feature.
   */
  private async fetchAssetMentionCount(
    articleId: string,
    assetId: string,
  ): Promise<number | null> {
    // We look up the NewsEntity that corresponds to this asset and count
    // the mentions in the article.
    const entity = await prisma.newsEntity.findFirst({
      where: { instrumentId: assetId },
      select: { id: true },
    });
    if (!entity) return null;

    const count = await prisma.newsEntityMention.count({
      where: { articleId, entityId: entity.id },
    });
    return count;
  }

  /**
   * Returns positive/negative breadth counts for the asset, based on the
   * most recent BREADTH feature record computed at or before eventTimestamp.
   */
  private async fetchAssetBreadth(
    assetId: string,
    eventTimestamp: Date,
  ): Promise<{ positiveCount: number | null; negativeCount: number | null } | null> {
    const breadthRow = await prisma.newsFeature.findFirst({
      where: {
        assetId,
        featureType: 'BREADTH',
        computedAt: { lte: eventTimestamp },
      },
      orderBy: { computedAt: 'desc' },
      select: { featureVector: true, computedAt: true },
    });

    if (!breadthRow) return null;

    // Validate point-in-time correctness
    this.guard.validateOne('breadth.computedAt', breadthRow.computedAt, eventTimestamp);

    const fv = breadthRow.featureVector as Record<string, number> | null;
    return {
      positiveCount: fv?.['positive_asset_count'] ?? null,
      negativeCount: fv?.['negative_asset_count'] ?? null,
    };
  }

  /**
   * Fetches macro scores by averaging recent market_sentiment values for
   * articles in each relevant taxonomy category, using only articles published
   * at or before eventTimestamp (point-in-time correct).
   *
   * Returns a best-effort score (null when no data is available for a
   * category rather than throwing).
   */
  private async fetchMacroScores(eventTimestamp: Date): Promise<{
    crudeOil: number | null;
    gold: number | null;
    usdInr: number | null;
    fedPolicy: number | null;
    rbiPolicy: number | null;
  }> {
    const windowStart = new Date(eventTimestamp.getTime() - 24 * 60 * 60 * 1000); // 24h window

    const computeMacroScore = async (
      categories: readonly string[],
    ): Promise<number | null> => {
      const rows = await prisma.newsSentiment.findMany({
        where: {
          article: {
            publishedAt: { lte: eventTimestamp, gte: windowStart },
            category: { in: categories as string[] },
          },
          computedAt: { lte: eventTimestamp },
        },
        select: { marketSentiment: true },
        take: 100, // bounded query
      });

      if (rows.length === 0) return null;
      const sum = rows.reduce((acc, r) => acc + Number(r.marketSentiment), 0);
      return sum / rows.length;
    };

    const [crudeOil, gold, usdInr, fedPolicy, rbiPolicy] = await Promise.all([
      computeMacroScore(CRUDE_OIL_CATEGORIES),
      computeMacroScore(GOLD_CATEGORIES),
      computeMacroScore(USD_INR_CATEGORIES),
      computeMacroScore(FED_POLICY_CATEGORIES),
      computeMacroScore(RBI_POLICY_CATEGORIES),
    ]);

    return { crudeOil, gold, usdInr, fedPolicy, rbiPolicy };
  }

  /**
   * Fetches a point-in-time market context snapshot from the data-service.
   * The asOf parameter is set to exactly eventTimestamp (Req 21.1).
   * After receiving the response, validates the returned asOf field against
   * eventTimestamp using LookAheadGuard.validateOne().
   *
   * Returns null when the asset or data is unavailable at that timestamp.
   *
   * @throws {LookAheadBiasError} if the returned snapshot.asOf > eventTimestamp.
   *
   * Requirements: Req 20.1, Req 21.1
   */
  private async fetchMarketContext(assetId: string, eventTimestamp: Date) {
    let snapshot;
    try {
      snapshot = await this.dataServiceClient.getMarketContextSnapshot(
        assetId,
        eventTimestamp, // asOf MUST be exactly eventTimestamp (Req 21.1)
      );
    } catch {
      // Non-critical — feature will be null for all market context fields
      return null;
    }

    if (!snapshot) return null;

    // Validate asOf against eventTimestamp — LookAheadBiasError if future data
    // was returned (Req 20.2, Req 21.1)
    this.guard.validateOne('marketContext.asOf', snapshot.asOf, eventTimestamp);

    return snapshot;
  }

  // --------------------------------------------------------------------------
  // Storage helpers
  // --------------------------------------------------------------------------

  /**
   * Persists the FeatureVector to news_features, retrying up to 3 times at
   * 1-second intervals on transient storage failures (Req 20.3).
   * Uses upsert semantics on (event_id, asset_id, feature_version) for
   * idempotency (Req 20.5).
   *
   * @throws {Error} after 3 failed attempts.
   */
  private async storeWithRetry(
    event: FeatureEventInput,
    featureVector: FeatureVector,
  ) {
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 1000;

    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.upsertFeature(event, featureVector);
      } catch (err) {
        lastError = err;
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAY_MS);
        }
      }
    }

    throw new Error(
      `FeatureEngineeringEngine: storage failed after ${MAX_RETRIES} attempts ` +
        `for event ${event.id}: ${String(lastError)}`,
    );
  }

  /**
   * Upserts the FeatureVector record.  Prisma's upsert on the unique
   * (event_id, asset_id, feature_version) key provides idempotency (Req 20.5).
   */
  private async upsertFeature(event: FeatureEventInput, featureVector: FeatureVector) {
    const assetId = event.assetId ?? null;

    // The prisma schema uses a composite unique on (eventId, assetId, featureVersion)
    // but Prisma requires all three to be non-null in the where clause for a
    // composite unique key.  assetId is nullable, so we use findFirst + create/update.
    const existing = await prisma.newsFeature.findFirst({
      where: {
        eventId: event.id,
        assetId: assetId,
        featureVersion: this.featureVersion,
      },
    });

    if (existing) {
      return prisma.newsFeature.update({
        where: { id: existing.id },
        data: {
          featureVector: featureVector as object,
          pipelineVersion: this.pipelineVersion,
          computedAt: new Date(),
        },
      });
    }

    return prisma.newsFeature.create({
      data: {
        eventId: event.id,
        assetId: assetId,
        featureType: 'EVENT_FEATURE_VECTOR',
        featureVector: featureVector as object,
        featureVersion: this.featureVersion,
        pipelineVersion: this.pipelineVersion,
        computedAt: new Date(),
      },
    });
  }

  // --------------------------------------------------------------------------
  // Queue publish
  // --------------------------------------------------------------------------

  /**
   * Publishes the completed FeatureVector job to the news.features BullMQ
   * queue within 500 ms of successful storage (Req 20.6).
   * Raises an error rather than silently dropping the job if the queue is
   * unavailable (Req 20.6).
   */
  private async publishToQueue(
    featureId: string,
    event: FeatureEventInput,
    featureVector: FeatureVector,
  ): Promise<void> {
    const publishDeadline = new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `FeatureEngineeringEngine: queue publish exceeded 500 ms deadline ` +
                `for event ${event.id}`,
            ),
          ),
        500,
      ),
    );

    const publishJob = this.featuresQueue.add(
      'feature-vector',
      {
        featureId,
        eventId: event.id,
        articleId: event.articleId,
        assetId: event.assetId ?? null,
        featureVersion: this.featureVersion,
        pipelineVersion: this.pipelineVersion,
        featureVector,
        computedAt: new Date().toISOString(),
      },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { age: 86400 },
        removeOnFail: false,
      },
    );

    // Race the publish against the 500ms deadline
    await Promise.race([publishJob, publishDeadline]);
  }

  // --------------------------------------------------------------------------
  // Schema-change / backfill support (Req 20.4)
  // --------------------------------------------------------------------------

  /**
   * Enqueues a backfill job to recompute all historical FeatureVectors under
   * the new feature_version when the schema changes (Req 20.4).
   *
   * Prior-version records are NEVER modified or deleted — they are preserved
   * for training dataset reproducibility.
   *
   * @param backfillQueue  The BullMQ queue for backfill jobs (news.backfill).
   * @param reason         Human-readable description of the schema change.
   */
  async enqueueBackfillForSchemaChange(
    backfillQueue: Queue,
    reason: string,
  ): Promise<void> {
    await backfillQueue.add(
      'feature-backfill',
      {
        targetFeatureVersion: this.featureVersion,
        reason,
        enqueuedAt: new Date().toISOString(),
      },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { age: 86400 },
        removeOnFail: false,
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Pure utility functions (module-private)
// ---------------------------------------------------------------------------

/**
 * Coerces a Prisma Decimal/number/null/undefined field to number | null.
 */
function toNum(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return isFinite(n) ? n : null;
}

/**
 * Builds a one-hot encoded integer array for the given value.
 * Position of the matching label receives 1; all others receive 0.
 * Returns an all-zero array when the value is not found in vocabulary.
 */
function encodeOneHot(value: string, vocabulary: string[]): number[] {
  return vocabulary.map((label) => (label === value ? 1 : 0));
}

/**
 * Builds a multi-hot encoded array for a set of string values.
 * Position of each matching label receives 1; all others receive 0.
 */
function encodeOneHotSet(values: string[], vocabulary: string[]): number[] {
  const set = new Set(values);
  return vocabulary.map((label) => (set.has(label) ? 1 : 0));
}

/**
 * Converts a one-hot / multi-hot array into named feature keys.
 *
 * Example: prefix='event_type', vocabulary=['EARNINGS','REGULATORY']
 *   → { 'event_type_EARNINGS': 0|1, 'event_type_REGULATORY': 0|1 }
 */
function buildOneHotFeatures(
  prefix: string,
  encoded: number[],
  vocabulary: string[],
): FeatureVector {
  const result: FeatureVector = {};
  vocabulary.forEach((label, idx) => {
    result[`${prefix}_${label}`] = encoded[idx] ?? 0;
  });
  return result;
}

/**
 * Extracts a named numeric sub-score from the JSONB sub_scores column.
 * Returns null when the key is absent or the value is non-numeric.
 */
function extractSubScore(subScores: unknown, key: string): number | null {
  if (subScores == null || typeof subScores !== 'object') return null;
  const record = subScores as Record<string, unknown>;
  const val = record[key];
  if (val == null) return null;
  const n = Number(val);
  return isFinite(n) ? n : null;
}

/**
 * Derives the dominant cross-market direction from the highest-confidence
 * relationship record for the asset. Encodes it as an ordinal integer
 * in CROSS_MARKET_DIRECTION_VALUES order. Returns null when no relationships
 * exist.
 */
function deriveDominantCrossMarketDirection(
  relationships: { relationshipType: string; confidence: number }[],
): number | null {
  if (relationships.length === 0) return null;

  // Pick the relationship with highest confidence
  const dominant = relationships.reduce((best, current) =>
    current.confidence > best.confidence ? current : best,
  );

  const idx = CROSS_MARKET_DIRECTION_VALUES.indexOf(
    dominant.relationshipType as (typeof CROSS_MARKET_DIRECTION_VALUES)[number],
  );
  return idx >= 0 ? idx : null;
}

/** Returns a Promise that resolves after `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Re-export for consumers that need to access the error type without
// importing LookAheadGuard directly.
export { LookAheadBiasError };
