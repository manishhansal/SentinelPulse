/**
 * MLDatasetGenerator — generates labelled TrainingSample records for ml-service.
 *
 * Joins FeatureVectors from news_features with forward returns computed from
 * data-service OHLCV at six label horizons: 5m, 15m, 30m, 1h, 4h, 1d.
 *
 * Key invariants:
 *   - If OHLCV is unavailable at a horizon → label = null (no interpolation)
 *   - If forward-return data timestamp <= event_timestamp → LookAheadBiasError,
 *     record is discarded and NOT persisted (Req 22.4)
 *   - Storage failures are retried up to 3× at 1-second intervals (Req 22.3)
 *   - Directional labels are assigned using configurable thresholds (Req 22.2)
 *
 * REST surface: GET /api/v1/ml/training/samples (max 1,000 records/page, Req 22.5)
 *
 * Requirements: Req 22.1, Req 22.2, Req 22.3, Req 22.4, Req 22.5, Req 33.2
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import type { Prisma } from '@prisma/client';
import { LookAheadBiasError } from '../feature-engineering/LookAheadGuard.js';
import { DataServiceClient } from '../../integrations/data-service/DataServiceClient.js';
import { prisma, MAX_QUERY_RESULTS } from '../../db/prisma.js';

// ---------------------------------------------------------------------------
// Constants & types
// ---------------------------------------------------------------------------

/**
 * Default label thresholds (Req 22.2).
 * All values are percentages (e.g. 1.0 means 1%).
 */
export const LABEL_THRESHOLDS = {
  /** return > +1.0% → STRONG_BULLISH */
  STRONG_BULLISH: 1.0,
  /** 0 < return <= +1.0% → BULLISH */
  BULLISH_UPPER: 1.0,
  /** |return| <= 0.2% → NEUTRAL */
  NEUTRAL_BAND: 0.2,
  /** -1.0% <= return < 0 → BEARISH */
  BEARISH_LOWER: -1.0,
  /** return < -1.0% → STRONG_BEARISH */
  STRONG_BEARISH: -1.0,
} as const;

export type DirectionalLabel =
  | 'STRONG_BULLISH'
  | 'BULLISH'
  | 'NEUTRAL'
  | 'BEARISH'
  | 'STRONG_BEARISH';

export const LABEL_HORIZONS = ['5m', '15m', '30m', '1h', '4h', '1d'] as const;
export type LabelHorizon = (typeof LABEL_HORIZONS)[number];

/** Full result of a successful TrainingSample generation. */
export interface TrainingSampleResult {
  id: string;
  eventId: string;
  assetId: string;
  /** Directional label per horizon; null if OHLCV was unavailable. */
  labels: Record<LabelHorizon, DirectionalLabel | null>;
  /** UTC cutoff timestamp per horizon; null if OHLCV was unavailable. */
  labelCutoffs: Record<LabelHorizon, Date | null>;
  featureVectorId: string;
}

/** Configuration for label thresholds; all values are percentages. */
export interface LabelThresholdConfig {
  STRONG_BULLISH: number;
  BULLISH_UPPER: number;
  NEUTRAL_BAND: number;
  BEARISH_LOWER: number;
  STRONG_BEARISH: number;
}

// ---------------------------------------------------------------------------
// MLDatasetGenerator
// ---------------------------------------------------------------------------

/**
 * Core generator class.  Designed to be instantiated once and reused
 * across many `generateSample()` calls (e.g. from a BullMQ worker).
 */
export class MLDatasetGenerator {
  constructor(
    private readonly dataServiceClient: DataServiceClient = new DataServiceClient(),
    private readonly labelThresholds: LabelThresholdConfig = { ...LABEL_THRESHOLDS },
    private readonly featureVersion: string = process.env['FEATURE_VERSION'] ?? '1.0.0',
    private readonly pipelineVersion: string = process.env['PIPELINE_VERSION'] ?? '1.0.0',
    private readonly marketDataSnapshotVersion: string =
      process.env['MARKET_DATA_SNAPSHOT_VERSION'] ?? '1.0.0',
    private readonly modelVersion: string = process.env['MODEL_VERSION'] ?? '1.0.0',
  ) {}

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Generates and persists a TrainingSample for a given event + asset pair.
   *
   * Steps:
   *   1. Resolve the FeatureVector for (eventId, assetId, featureVersion).
   *   2. Fetch the baseline close price at event_timestamp.
   *   3. Compute forward returns at each label horizon via data-service OHLCV.
   *   4. Validate look-ahead bias constraint (Req 22.4).
   *   5. Assign directional labels (Req 22.2).
   *   6. Persist to news_training_samples with provenance (Req 22.3).
   *
   * Phase 3B.1: also persists `predictionTimestamp` (= eventTimestamp under the
   * initial training policy), `featureAsOf` from the FeatureVector, and
   * `labelBarTimestamp_Xm` (the exact bar used for each label).
   *
   * Returns null when:
   *   - No FeatureVector exists for the given (eventId, assetId, featureVersion).
   *   - Baseline OHLCV is unavailable (cannot compute forward returns).
   *
   * Throws LookAheadBiasError when any forward-return data timestamp <=
   * event_timestamp — the record is NOT persisted in that case (Req 22.4).
   *
   * Requirements: Req 22.1–22.4, Req 33.2
   */
  async generateSample(params: {
    eventId: string;
    assetId: string;
    eventTimestamp: Date;
    articleIds: string[];
  }): Promise<TrainingSampleResult | null> {
    const { eventId, assetId, eventTimestamp, articleIds } = params;

    // ------------------------------------------------------------------
    // 1. Validate FK: FeatureVector must exist (Req 33.2)
    // ------------------------------------------------------------------
    const featureVector = await prisma.newsFeature.findFirst({
      where: {
        eventId,
        assetId,
        featureVersion: this.featureVersion,
      },
    });

    if (!featureVector) {
      // FK unresolvable — reject and log (Req 33.2)
      console.error(
        `[MLDatasetGenerator] No FeatureVector found for eventId=${eventId} ` +
          `assetId=${assetId} featureVersion=${this.featureVersion} — record rejected`,
      );
      return null;
    }

    // ------------------------------------------------------------------
    // 2. Validate FK: NewsEvent must exist (Req 33.2)
    // ------------------------------------------------------------------
    const newsEvent = await prisma.newsEvent.findUnique({
      where: { id: eventId },
    });

    if (!newsEvent) {
      console.error(
        `[MLDatasetGenerator] NewsEvent not found for eventId=${eventId} — record rejected`,
      );
      return null;
    }

    // ------------------------------------------------------------------
    // 3. Fetch baseline close price at event_timestamp
    //    Use the 1-minute bar ending at event_timestamp as baseline.
    // ------------------------------------------------------------------
    const baselineClose = await this.fetchBaselineClose(assetId, eventTimestamp);
    if (baselineClose === null) {
      // No baseline OHLCV — cannot compute forward returns
      return null;
    }

    // ------------------------------------------------------------------
    // 4. Compute forward returns; may throw LookAheadBiasError (Req 22.4)
    // ------------------------------------------------------------------
    const forwardReturns = await this.computeForwardReturns(
      assetId,
      eventTimestamp,
      baselineClose,
    );

    // ------------------------------------------------------------------
    // 5. Assign directional labels (Req 22.2)
    // ------------------------------------------------------------------
    const labels: Record<LabelHorizon, DirectionalLabel | null> = {} as Record<
      LabelHorizon,
      DirectionalLabel | null
    >;
    const labelCutoffs: Record<LabelHorizon, Date | null> = {} as Record<
      LabelHorizon,
      Date | null
    >;
    const labelBarTimestamps: Record<LabelHorizon, Date | null> = {} as Record<
      LabelHorizon,
      Date | null
    >;

    for (const horizon of LABEL_HORIZONS) {
      const { returnPct, cutoff, barTimestamp } = forwardReturns[horizon];
      labels[horizon] = this.assignLabel(returnPct);
      labelCutoffs[horizon] = cutoff;
      labelBarTimestamps[horizon] = barTimestamp;
    }

    // ------------------------------------------------------------------
    // 6. Determine prediction_timestamp (Phase 3B.1 Gap PT-G3)
    //    Training policy: prediction_timestamp = event_timestamp.
    //    This is the explicit policy for the initial dataset — AlphaForge
    //    is assumed to generate a signal immediately when the news is published.
    // ------------------------------------------------------------------
    const predictionTimestamp = eventTimestamp;

    // ------------------------------------------------------------------
    // 7. Determine feature_as_of from the FeatureVector record (Phase 3B.1 Gap PT-G2)
    //    Use featureVector.featureAsOf if present, fallback to featureVector.computedAt.
    // ------------------------------------------------------------------
    const featureAsOf = (featureVector as unknown as { featureAsOf: Date | null }).featureAsOf
      ?? featureVector.computedAt;

    // ------------------------------------------------------------------
    // 8. Persist with retry (Req 22.3)
    // ------------------------------------------------------------------
    const sampleId = uuidv4();
    await this.persistWithRetry({
      id: sampleId,
      eventId,
      assetId,
      articleIds,
      featureVectorId: featureVector.id,
      forwardReturns,
      labels,
      labelCutoffs,
      labelBarTimestamps,
      predictionTimestamp,
      featureAsOf,
    });

    return {
      id: sampleId,
      eventId,
      assetId,
      labels,
      labelCutoffs,
      featureVectorId: featureVector.id,
    };
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  /**
   * Fetches the baseline close price for an asset at the event timestamp.
   * Queries a 1-minute OHLCV bar ending at event_timestamp.
   * Returns null when no data is available.
   */
  private async fetchBaselineClose(assetId: string, eventTimestamp: Date): Promise<number | null> {
    const windowStart = new Date(eventTimestamp.getTime() - 60_000); // 1 minute before

    try {
      const response = await this.dataServiceClient.getOHLCV({
        assetId,
        from: windowStart,
        to: eventTimestamp,
        asOf: eventTimestamp,
      });

      if (!response.bars || response.bars.length === 0) return null;

      // Use the last bar's close as the baseline
      const lastBar = response.bars[response.bars.length - 1];
      return lastBar?.close ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Computes forward return percentages at each label horizon by querying
   * data-service OHLCV with asOf = event_timestamp + horizon_ms.
   *
   * For each horizon:
   *   - cutoffTimestamp = event_timestamp + horizon_ms
   *   - Queries a 1-minute window ending at cutoffTimestamp
   *   - Uses the close price of that bar as the forward price
   *   - returnPct = (forwardClose / baselineClose - 1) * 100
   *   - Returns null if OHLCV unavailable (no interpolation, Req 22.1)
   *
   * Throws LookAheadBiasError if asOf <= event_timestamp for any horizon,
   * which would indicate a logic error (Req 22.4).
   *
   * Requirements: Req 22.1, Req 22.4
   */
  private async computeForwardReturns(
    assetId: string,
    eventTimestamp: Date,
    baselineClose: number,
  ): Promise<Record<LabelHorizon, { returnPct: number | null; cutoff: Date | null; barTimestamp: Date | null }>> {
    const result = {} as Record<
      LabelHorizon,
      { returnPct: number | null; cutoff: Date | null; barTimestamp: Date | null }
    >;

    for (const horizon of LABEL_HORIZONS) {
      const horizonMs = this.horizonToMs(horizon);
      const cutoffTimestamp = new Date(eventTimestamp.getTime() + horizonMs);

      // Guard: asOf must be strictly after event_timestamp (Req 22.4)
      // In practice this is always true since horizonMs > 0, but we validate
      // explicitly to surface any clock-skew or misconfiguration immediately.
      if (cutoffTimestamp.getTime() <= eventTimestamp.getTime()) {
        throw new LookAheadBiasError(
          `forward_return_${horizon}`,
          cutoffTimestamp,
          eventTimestamp,
        );
      }

      // Query a 1-minute bar ending exactly at the cutoff timestamp
      const windowStart = new Date(cutoffTimestamp.getTime() - 60_000);

      try {
        const response = await this.dataServiceClient.getOHLCV({
          assetId,
          from: windowStart,
          to: cutoffTimestamp,
          asOf: cutoffTimestamp,
        });

        if (!response.bars || response.bars.length === 0) {
          // OHLCV unavailable at this horizon → label = null (Req 22.1)
          result[horizon] = { returnPct: null, cutoff: null, barTimestamp: null };
          continue;
        }

        const bar = response.bars[response.bars.length - 1];
        if (!bar) {
          result[horizon] = { returnPct: null, cutoff: null, barTimestamp: null };
          continue;
        }

        // Validate point-in-time correctness: bar timestamp must be > event_timestamp
        // A bar timestamped at or before the event would indicate look-ahead bias (Req 22.4).
        if (bar.timestamp.getTime() <= eventTimestamp.getTime()) {
          throw new LookAheadBiasError(
            `forward_return_${horizon}`,
            bar.timestamp,
            eventTimestamp,
          );
        }

        // Compute percentage return: (forward - baseline) / baseline * 100
        const returnPct = ((bar.close - baselineClose) / baselineClose) * 100;
        result[horizon] = { returnPct, cutoff: cutoffTimestamp, barTimestamp: bar.timestamp };
      } catch (err) {
        // Re-throw LookAheadBiasError — must not be swallowed (Req 22.4)
        if (err instanceof LookAheadBiasError) throw err;
        // Any other error (timeout, 5xx, etc.) → treat as unavailable
        result[horizon] = { returnPct: null, cutoff: null, barTimestamp: null };
      }
    }

    return result;
  }

  /**
   * Assigns a directional label based on return percentage.
   *
   * Thresholds (default values from Req 22.2):
   *   return > +1.0%              → STRONG_BULLISH
   *   0 < return <= +1.0%         → BULLISH
   *   -0.2% <= return <= +0.2%    → NEUTRAL
   *   -1.0% <= return < 0         → BEARISH
   *   return < -1.0%              → STRONG_BEARISH
   *
   * Gap handling: a return that falls between BULLISH lower bound (0%) and
   * NEUTRAL upper bound (0.2%) would be 0 < return <= 0.2% — this maps
   * to BULLISH because |return| > 0. Similarly for the bearish gap side.
   *
   * NOTE: NEUTRAL wins when |return| <= NEUTRAL_BAND regardless of sign.
   * That means a return of exactly 0 or within [-0.2%, +0.2%] is NEUTRAL.
   *
   * Requirements: Req 22.2
   */
  assignLabel(returnPct: number | null): DirectionalLabel | null {
    if (returnPct === null) return null;

    const { STRONG_BULLISH, NEUTRAL_BAND, STRONG_BEARISH } = this.labelThresholds;

    if (returnPct > STRONG_BULLISH) return 'STRONG_BULLISH';
    if (returnPct < STRONG_BEARISH) return 'STRONG_BEARISH';
    // NEUTRAL band takes priority over BULLISH/BEARISH for borderline values
    if (returnPct >= -NEUTRAL_BAND && returnPct <= NEUTRAL_BAND) return 'NEUTRAL';
    if (returnPct > 0) return 'BULLISH';
    return 'BEARISH';
  }

  /**
   * Converts a horizon label string to its equivalent duration in milliseconds.
   *
   * '5m'  → 300,000 ms
   * '15m' → 900,000 ms
   * '30m' → 1,800,000 ms
   * '1h'  → 3,600,000 ms
   * '4h'  → 14,400,000 ms
   * '1d'  → 86,400,000 ms
   */
  private horizonToMs(horizon: LabelHorizon): number {
    const map: Record<LabelHorizon, number> = {
      '5m': 300_000,
      '15m': 900_000,
      '30m': 1_800_000,
      '1h': 3_600_000,
      '4h': 14_400_000,
      '1d': 86_400_000,
    };
    return map[horizon];
  }

  /**
   * Persists a TrainingSample to news_training_samples, retrying up to 3×
   * at 1-second intervals on storage failure (Req 22.3).
   *
   * Phase 3B.1: also persists predictionTimestamp, featureAsOf, and
   * labelBarTimestamp_Xm columns added by migration 003.
   *
   * Throws the underlying error if all attempts are exhausted.
   */
  private async persistWithRetry(sample: {
    id: string;
    eventId: string;
    assetId: string;
    articleIds: string[];
    featureVectorId: string;
    forwardReturns: Record<LabelHorizon, { returnPct: number | null; cutoff: Date | null; barTimestamp: Date | null }>;
    labels: Record<LabelHorizon, DirectionalLabel | null>;
    labelCutoffs: Record<LabelHorizon, Date | null>;
    labelBarTimestamps: Record<LabelHorizon, Date | null>;
    predictionTimestamp: Date;
    featureAsOf: Date;
  }): Promise<void> {
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 1_000;

    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await prisma.newsTrainingSample.create({
          data: {
            id: sample.id,
            eventId: sample.eventId,
            assetId: sample.assetId,
            articleIds: sample.articleIds,
            featureVectorId: sample.featureVectorId,

            // Phase 3B.1 (Gap PT-G3): explicit prediction_timestamp
            // NOTE: predictionTimestamp column is new in migration 003.
            // Prisma client types will include it after `prisma generate`.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ...({ predictionTimestamp: sample.predictionTimestamp } as any),

            // Forward return values (raw percentages)
            futureReturn5m: sample.forwardReturns['5m'].returnPct,
            futureReturn15m: sample.forwardReturns['15m'].returnPct,
            futureReturn30m: sample.forwardReturns['30m'].returnPct,
            futureReturn1h: sample.forwardReturns['1h'].returnPct,
            futureReturn4h: sample.forwardReturns['4h'].returnPct,
            futureReturn1d: sample.forwardReturns['1d'].returnPct,

            // Directional labels
            label5m: sample.labels['5m'],
            label15m: sample.labels['15m'],
            label30m: sample.labels['30m'],
            label1h: sample.labels['1h'],
            label4h: sample.labels['4h'],
            label1d: sample.labels['1d'],

            // Label cutoff timestamps
            labelCutoff5m: sample.labelCutoffs['5m'],
            labelCutoff15m: sample.labelCutoffs['15m'],
            labelCutoff30m: sample.labelCutoffs['30m'],
            labelCutoff1h: sample.labelCutoffs['1h'],
            labelCutoff4h: sample.labelCutoffs['4h'],
            labelCutoff1d: sample.labelCutoffs['1d'],

            // Phase 3B.1 (Gap PT-G5): exact bar timestamps used for each label
            // NOTE: labelBarTimestamp_* columns are new in migration 003.
            // Prisma client types will include them after `prisma generate`.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ...({
              labelBarTimestamp5m:  sample.labelBarTimestamps['5m'],
              labelBarTimestamp15m: sample.labelBarTimestamps['15m'],
              labelBarTimestamp30m: sample.labelBarTimestamps['30m'],
              labelBarTimestamp1h:  sample.labelBarTimestamps['1h'],
              labelBarTimestamp4h:  sample.labelBarTimestamps['4h'],
              labelBarTimestamp1d:  sample.labelBarTimestamps['1d'],
            } as any),

            // Provenance fields (Req 22.3)
            featureVersion: this.featureVersion,
            pipelineVersion: this.pipelineVersion,
            marketDataSnapshotVersion: this.marketDataSnapshotVersion,
            modelVersion: this.modelVersion,
          },
        });
        return; // success
      } catch (err) {
        lastError = err;
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAY_MS);
        }
      }
    }

    // All retries exhausted
    throw lastError;
  }
}

// ---------------------------------------------------------------------------
// REST API handler
// ---------------------------------------------------------------------------

/**
 * Query schema for GET /api/v1/ml/training/samples (Req 22.5).
 *
 * Supported filters:
 *   - feature_version: exact match
 *   - date_from / date_to: ISO 8601 UTC range on created_at
 *   - asset: asset_id exact match
 *   - page / page_size: pagination (max 1,000/page)
 */
const samplesQuerySchema = z.object({
  feature_version: z.string().optional(),
  date_from: z.string().datetime({ offset: true }).optional(),
  date_to: z.string().datetime({ offset: true }).optional(),
  asset: z.string().optional(),
  event_type: z.string().optional(),
  min_importance_score: z.coerce.number().min(0).max(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(MAX_QUERY_RESULTS).default(100),
});

/**
 * Registers the ML training samples REST endpoint.
 *
 * GET /api/v1/ml/training/samples
 *   — paginated list of TrainingSample records (max 1,000/page)
 *   — filters: feature_version, date_from, date_to, asset, event_type,
 *              min_importance_score
 *
 * Requirements: Req 22.5, Req 25.3
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function registerMLSamplesRoute(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/ml/training/samples',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            feature_version: { type: 'string' },
            date_from: { type: 'string' },
            date_to: { type: 'string' },
            asset: { type: 'string' },
            event_type: { type: 'string' },
            min_importance_score: { type: 'number' },
            page: { type: 'number' },
            page_size: { type: 'number' },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = samplesQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: 'Invalid query parameters',
          details: parsed.error.errors,
        });
      }

      const {
        feature_version,
        date_from,
        date_to,
        asset,
        event_type,
        min_importance_score,
        page,
        page_size,
      } = parsed.data;

      try {
        // Build base where clause
        const where: Prisma.NewsTrainingSampleWhereInput = {};

        if (feature_version) {
          where.featureVersion = feature_version;
        }
        if (asset) {
          where.assetId = asset;
        }
        if (date_from || date_to) {
          where.createdAt = {
            ...(date_from ? { gte: new Date(date_from) } : {}),
            ...(date_to ? { lte: new Date(date_to) } : {}),
          };
        }

        // event_type filter: join through NewsEvent
        if (event_type) {
          where.event = { eventType: event_type };
        }

        // min_importance_score filter: join through event → importance
        if (min_importance_score !== undefined) {
          where.event = {
            ...((where.event as object) ?? {}),
            importance_: { importanceScore: { gte: min_importance_score } },
          };
        }

        const skip = (page - 1) * page_size;

        const [samples, totalCount] = await Promise.all([
          prisma.newsTrainingSample.findMany({
            where,
            skip,
            take: page_size,
            orderBy: { createdAt: 'desc' },
            include: {
              event: {
                select: {
                  id: true,
                  eventType: true,
                  eventTimestamp: true,
                  confidence: true,
                  importance: true,
                },
              },
            },
          }),
          prisma.newsTrainingSample.count({ where }),
        ]);

        const totalPages = Math.ceil(totalCount / page_size);

        return reply.send({
          success: true,
          data: samples,
          meta: {
            page,
            page_size,
            total_count: totalCount,
            total_pages: totalPages,
            has_next_page: page < totalPages,
            timestamp: new Date().toISOString(),
            version: 'v1',
          },
        });
      } catch (err) {
        request.log.error({ err }, 'Failed to fetch training samples');
        return reply.status(500).send({
          success: false,
          error: 'Failed to retrieve training samples',
        });
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Promisified delay helper used for retry back-off.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
