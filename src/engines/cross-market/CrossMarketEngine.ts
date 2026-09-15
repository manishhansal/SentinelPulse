/**
 * CrossMarketEngine — maintains the cross-market relationship graph.
 *
 * Pipeline role:
 *   - Seeds initial relationships from a static YAML-style config at startup (Req 11.4).
 *   - Updates correlation statistics daily from new HistoricalReaction records (Req 11.2).
 *   - Exposes a low-latency query method (p95 < 200 ms) for MarketImpactEngine (Req 11.5).
 *
 * Relationship confidence rules (Req 11.3):
 *   - sample_size < MIN_SAMPLE_SIZE (default 30) → confidence = 0.2, low_sample = true
 *   - sample_size ≥ MIN_SAMPLE_SIZE            → confidence derived from data, low_sample = false
 *
 * Storage:
 *   All relationships live in news_event_relationships.
 *   Idempotency key: (source_entity_id, target_entity_id, relationship_type).
 *
 * MarketImpactEngine integration (Req 10.4):
 *   Only relationships with confidence >= 0.2 AND sample_size >= 30 should be consumed
 *   by MarketImpactEngine. The query method exposes `excludeLowSample` to enforce this.
 *
 * Requirements: Req 11.1–11.5
 */

import { pino } from 'pino';
import { prisma } from '../../db/prisma.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger = pino({ name: 'CrossMarketEngine' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RelationshipType =
  | 'POSITIVE_CORRELATION'
  | 'NEGATIVE_CORRELATION'
  | 'CAUSAL_INDICATOR'
  | 'SECTOR_ROTATION';

export interface CrossMarketRelationship {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationshipType: RelationshipType;
  historicalCorrelation: number;
  confidence: number;
  regimeDependency: string[];
  sampleSize: number;
  lowSample: boolean;
  lastUpdated: Date;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Minimum sample size before a relationship is considered statistically
 * reliable (Req 11.3). Configurable; default is 30.
 */
const MIN_SAMPLE_SIZE = 30;

/**
 * Confidence floor applied when sample_size < MIN_SAMPLE_SIZE (Req 11.3).
 */
const LOW_SAMPLE_CONFIDENCE = 0.2;

// ---------------------------------------------------------------------------
// Seeded relationships
// Replaces the YAML file at startup (Req 11.4).
// Values are overridden as HistoricalReaction data accumulates (Req 11.2).
// ---------------------------------------------------------------------------

/**
 * Static seed relationships loaded at startup when no DB records exist yet.
 *
 * Covers the primary cross-market linkages relevant to Indian equity markets:
 *   - Crude oil impact on Indian sectors / indices
 *   - USD index impact on NIFTY50
 *   - Gold as a risk-off hedge
 *   - US interest rates on emerging-market equities
 *
 * Requirement: Req 11.4
 */
export const SEEDED_RELATIONSHIPS: Omit<CrossMarketRelationship, 'id' | 'lastUpdated'>[] = [
  // ---- Crude Oil → India ------------------------------------------------
  {
    sourceEntityId: 'CRUDE_OIL',
    targetEntityId: 'NIFTY50',
    relationshipType: 'NEGATIVE_CORRELATION',
    historicalCorrelation: -0.35,
    confidence: 0.70,
    regimeDependency: [],
    sampleSize: 200,
    lowSample: false,
  },
  {
    sourceEntityId: 'CRUDE_OIL',
    targetEntityId: 'AVIATION',
    relationshipType: 'NEGATIVE_CORRELATION',
    historicalCorrelation: -0.65,
    confidence: 0.85,
    regimeDependency: [],
    sampleSize: 200,
    lowSample: false,
  },
  {
    sourceEntityId: 'CRUDE_OIL',
    targetEntityId: 'PAINTS',
    relationshipType: 'NEGATIVE_CORRELATION',
    historicalCorrelation: -0.45,
    confidence: 0.75,
    regimeDependency: [],
    sampleSize: 150,
    lowSample: false,
  },
  {
    sourceEntityId: 'CRUDE_OIL',
    targetEntityId: 'ONGC',
    relationshipType: 'POSITIVE_CORRELATION',
    historicalCorrelation: 0.62,
    confidence: 0.82,
    regimeDependency: [],
    sampleSize: 200,
    lowSample: false,
  },
  // ---- USD/INR ----------------------------------------------------------
  {
    sourceEntityId: 'USD_INDEX',
    targetEntityId: 'NIFTY50',
    relationshipType: 'NEGATIVE_CORRELATION',
    historicalCorrelation: -0.42,
    confidence: 0.72,
    regimeDependency: [],
    sampleSize: 300,
    lowSample: false,
  },
  // ---- Gold → Risk-Off --------------------------------------------------
  {
    sourceEntityId: 'GOLD',
    targetEntityId: 'NIFTY50',
    relationshipType: 'NEGATIVE_CORRELATION',
    historicalCorrelation: -0.28,
    confidence: 0.60,
    regimeDependency: ['RISK_OFF'],
    sampleSize: 200,
    lowSample: false,
  },
  // ---- US Interest Rates → India ----------------------------------------
  {
    sourceEntityId: 'US_INTEREST_RATE',
    targetEntityId: 'NIFTY50',
    relationshipType: 'NEGATIVE_CORRELATION',
    historicalCorrelation: -0.38,
    confidence: 0.68,
    regimeDependency: [],
    sampleSize: 150,
    lowSample: false,
  },
];

// ---------------------------------------------------------------------------
// CrossMarketEngine
// ---------------------------------------------------------------------------

export class CrossMarketEngine {
  // -------------------------------------------------------------------------
  // Startup seeding
  // -------------------------------------------------------------------------

  /**
   * Seeds the news_event_relationships table with SEEDED_RELATIONSHIPS at
   * application startup. Only creates records that do not already exist —
   * idempotent on (source_entity_id, target_entity_id, relationship_type).
   *
   * Empirical updates from HistoricalReaction data will override seeded values
   * as they accumulate (Req 11.2).
   *
   * Requirement: Req 11.4
   */
  async seedRelationships(): Promise<void> {
    logger.info('Seeding cross-market relationships from static config');

    let created = 0;
    let skipped = 0;

    for (const rel of SEEDED_RELATIONSHIPS) {
      try {
        const existing = await prisma.newsEventRelationship.findUnique({
          where: {
            sourceEntityId_targetEntityId_relationshipType: {
              sourceEntityId: rel.sourceEntityId,
              targetEntityId: rel.targetEntityId,
              relationshipType: rel.relationshipType,
            },
          },
          select: { id: true },
        });

        if (existing !== null) {
          skipped += 1;
          continue;
        }

        await prisma.newsEventRelationship.create({
          data: {
            sourceEntityId: rel.sourceEntityId,
            targetEntityId: rel.targetEntityId,
            relationshipType: rel.relationshipType,
            historicalCorrelation: rel.historicalCorrelation,
            confidence: rel.confidence,
            regimeDependency: rel.regimeDependency,
            sampleSize: rel.sampleSize,
            lowSample: rel.lowSample,
            lastUpdated: new Date(),
          },
        });

        created += 1;

        logger.debug(
          {
            sourceEntityId: rel.sourceEntityId,
            targetEntityId: rel.targetEntityId,
            relationshipType: rel.relationshipType,
          },
          'Seeded relationship',
        );
      } catch (err) {
        // Log and continue — one seed failure must not abort the rest
        logger.error(
          {
            sourceEntityId: rel.sourceEntityId,
            targetEntityId: rel.targetEntityId,
            err,
          },
          'Failed to seed relationship',
        );
      }
    }

    logger.info({ created, skipped }, 'Cross-market relationship seeding complete');
  }

  // -------------------------------------------------------------------------
  // Daily correlation update
  // -------------------------------------------------------------------------

  /**
   * Updates historical_correlation, confidence, and sample_size for every
   * existing relationship by joining NewsMarketReaction records whose
   * computed_at > the relationship's last_updated timestamp.
   *
   * Confidence rules after update (Req 11.3):
   *   - sample_size < MIN_SAMPLE_SIZE → confidence = 0.2, low_sample = true
   *   - sample_size ≥ MIN_SAMPLE_SIZE → confidence from Pearson correlation
   *     magnitude (|r|), low_sample = false
   *
   * After the update, last_updated is set to UTC now (Req 11.2).
   *
   * Requirement: Req 11.1, Req 11.2, Req 11.3
   */
  async updateCorrelations(): Promise<void> {
    logger.info('Starting daily cross-market correlation update');

    const relationships = await prisma.newsEventRelationship.findMany({
      select: {
        id: true,
        sourceEntityId: true,
        targetEntityId: true,
        relationshipType: true,
        historicalCorrelation: true,
        sampleSize: true,
        lastUpdated: true,
      },
    });

    logger.info({ count: relationships.length }, 'Relationships to update');

    const updateTimestamp = new Date();
    let updated = 0;

    for (const rel of relationships) {
      try {
        await this.updateSingleRelationship(rel, updateTimestamp);
        updated += 1;
      } catch (err) {
        logger.error(
          { relationshipId: rel.id, err },
          'Failed to update relationship correlation',
        );
      }
    }

    logger.info({ updated, total: relationships.length }, 'Correlation update complete');
  }

  // -------------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------------

  /**
   * Returns relationships for a given source entity, with optional filtering.
   *
   * Performance target: p95 < 200 ms (Req 11.5).
   * The index on (source_entity_id, confidence) in the schema supports this.
   *
   * Requirement: Req 11.5
   */
  async getRelationships(
    sourceEntityId: string,
    options?: {
      /** Filter to a specific relationship type. */
      relationshipType?: RelationshipType;
      /** Exclude relationships below this confidence level. */
      minConfidence?: number;
      /** When true, exclude low_sample = true rows (Req 10.4). */
      excludeLowSample?: boolean;
    },
  ): Promise<CrossMarketRelationship[]> {
    const minConfidence = options?.minConfidence ?? 0;
    const excludeLowSample = options?.excludeLowSample ?? false;

    const rows = await prisma.newsEventRelationship.findMany({
      where: {
        sourceEntityId,
        ...(options?.relationshipType !== undefined && {
          relationshipType: options.relationshipType,
        }),
        confidence: { gte: minConfidence },
        ...(excludeLowSample && { lowSample: false }),
      },
      orderBy: { confidence: 'desc' },
    });

    return rows.map((row) => ({
      id: row.id,
      sourceEntityId: row.sourceEntityId,
      targetEntityId: row.targetEntityId,
      relationshipType: row.relationshipType as RelationshipType,
      historicalCorrelation: row.historicalCorrelation,
      confidence: row.confidence,
      regimeDependency: row.regimeDependency,
      sampleSize: row.sampleSize,
      lowSample: row.lowSample,
      lastUpdated: row.lastUpdated,
    }));
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Updates correlation statistics for a single relationship record by
   * joining new NewsMarketReaction data created after last_updated.
   *
   * The new sample returns for the source and target assets are retrieved and
   * the Pearson correlation is estimated from the rolling mean.  When fewer
   * than MIN_SAMPLE_SIZE total samples exist, low_sample is flagged (Req 11.3).
   */
  private async updateSingleRelationship(
    rel: {
      id: string;
      sourceEntityId: string;
      targetEntityId: string;
      historicalCorrelation: number;
      sampleSize: number;
      lastUpdated: Date;
    },
    updateTimestamp: Date,
  ): Promise<void> {
    // Retrieve new reaction records for source and target assets since last update
    const [sourceReactions, targetReactions] = await Promise.all([
      prisma.newsMarketReaction.findMany({
        where: {
          assetId: rel.sourceEntityId,
          computedAt: { gt: rel.lastUpdated },
        },
        select: { return1d: true },
      }),
      prisma.newsMarketReaction.findMany({
        where: {
          assetId: rel.targetEntityId,
          computedAt: { gt: rel.lastUpdated },
        },
        select: { return1d: true },
      }),
    ]);

    const newPairCount = Math.min(sourceReactions.length, targetReactions.length);

    if (newPairCount === 0) {
      // No new data — only refresh last_updated timestamp
      await prisma.newsEventRelationship.update({
        where: { id: rel.id },
        data: { lastUpdated: updateTimestamp },
      });
      return;
    }

    // Build paired return arrays for new samples
    const sourceReturns = sourceReactions
      .slice(0, newPairCount)
      .map((r) => r.return1d ?? 0);
    const targetReturns = targetReactions
      .slice(0, newPairCount)
      .map((r) => r.return1d ?? 0);

    // Compute Pearson correlation for new samples
    const newCorrelation = computePearsonCorrelation(sourceReturns, targetReturns);

    // Merge with existing correlation using sample-weighted average
    const existingSampleSize = rel.sampleSize;
    const totalSampleSize = existingSampleSize + newPairCount;

    const mergedCorrelation =
      (rel.historicalCorrelation * existingSampleSize + newCorrelation * newPairCount) /
      totalSampleSize;

    // Apply confidence and low_sample rules (Req 11.3)
    const lowSample = totalSampleSize < MIN_SAMPLE_SIZE;
    const confidence = lowSample
      ? LOW_SAMPLE_CONFIDENCE
      : Math.abs(mergedCorrelation); // |r| as a naive confidence proxy

    await prisma.newsEventRelationship.update({
      where: { id: rel.id },
      data: {
        historicalCorrelation: clamp(mergedCorrelation, -1.0, 1.0),
        confidence: clamp(confidence, 0.0, 1.0),
        sampleSize: totalSampleSize,
        lowSample,
        lastUpdated: updateTimestamp,
      },
    });

    logger.debug(
      {
        relationshipId: rel.id,
        newPairCount,
        totalSampleSize,
        mergedCorrelation,
        confidence,
        lowSample,
      },
      'Updated relationship correlation',
    );
  }
}

// ---------------------------------------------------------------------------
// Pure helper functions (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Computes the Pearson correlation coefficient for two equal-length arrays.
 *
 * Returns 0 when the arrays are empty or have zero variance in either series.
 */
export function computePearsonCorrelation(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n === 0) return 0;

  const xSlice = xs.slice(0, n);
  const ySlice = ys.slice(0, n);

  const meanX = xSlice.reduce((s, v) => s + v, 0) / n;
  const meanY = ySlice.reduce((s, v) => s + v, 0) / n;

  let numerator = 0;
  let denomX = 0;
  let denomY = 0;

  for (let i = 0; i < n; i++) {
    const dx = (xSlice[i] ?? 0) - meanX;
    const dy = (ySlice[i] ?? 0) - meanY;
    numerator += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }

  const denominator = Math.sqrt(denomX * denomY);
  if (denominator === 0) return 0;

  return numerator / denominator;
}

/**
 * Clamps a number to the inclusive range [min, max].
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
