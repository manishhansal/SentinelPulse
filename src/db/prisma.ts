/**
 * Prisma client singleton for SentinelPulse.
 *
 * Exports:
 *   - `prisma`             — shared PrismaClient instance
 *   - `MAX_QUERY_RESULTS`  — server-side result-count cap (Req 28.6)
 *   - helper functions for common upsert patterns used across pipeline workers
 *
 * Requirements: Req 28.5, Req 28.6, Req 30.3
 */

import { Prisma, PrismaClient } from '@prisma/client';

// ---------------------------------------------------------------------------
// Singleton — reuse across hot-reloads in non-production environments
// ---------------------------------------------------------------------------

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: [
      { level: 'warn', emit: 'event' },
      { level: 'error', emit: 'event' },
    ],
  });

if (process.env['NODE_ENV'] !== 'production') {
  globalForPrisma.prisma = prisma;
}

// ---------------------------------------------------------------------------
// Req 28.6 — Server-side 1,000-row result limit on all list queries
// ---------------------------------------------------------------------------

/** Maximum rows returned by any list query (Req 28.6). */
export const MAX_QUERY_RESULTS = 1000 as const;

// ---------------------------------------------------------------------------
// Type aliases — Prisma-generated payload types used throughout the codebase
// ---------------------------------------------------------------------------

/** Full NewsArticle row as returned from the database. */
export type NewsArticleRow = Prisma.NewsArticleGetPayload<Record<string, never>>;

/** NewsArticle with its related NewsSource and NewsCluster. */
export type NewsArticleWithSourceAndCluster = Prisma.NewsArticleGetPayload<{
  include: { source: true; cluster: true };
}>;

// ---------------------------------------------------------------------------
// Helper: article lookup by content or title hash (used in deduplication)
// ---------------------------------------------------------------------------

/**
 * Returns the first article whose `contentHash` or `titleHash` matches
 * the supplied SHA-256 hex string. Returns `null` when no match exists.
 *
 * Used by DeduplicationEngine to detect exact duplicates (Req 4.1, Req 4.2).
 */
export async function getArticleByHash(hash: string): Promise<NewsArticleRow | null> {
  return prisma.newsArticle.findFirst({
    where: {
      OR: [{ contentHash: hash }, { titleHash: hash }],
    },
  });
}

// ---------------------------------------------------------------------------
// Helper: upsert NewsCluster (used in deduplication)
// ---------------------------------------------------------------------------

/**
 * Creates a new `NewsCluster` row, or touches `lastUpdatedAt` on the
 * existing one.  The full cluster update (sourceCount, sourceDiversity,
 * consensusScore) is performed by DeduplicationEngine after this call.
 */
export async function upsertCluster(data: {
  id: string;
  canonicalUrl: string;
  headline: string;
  firstSeenAt: Date;
}): Promise<Prisma.NewsClusterGetPayload<Record<string, never>>> {
  return prisma.newsCluster.upsert({
    where: { id: data.id },
    create: {
      id: data.id,
      canonicalUrl: data.canonicalUrl,
      headline: data.headline,
      firstSeenAt: data.firstSeenAt,
      lastUpdatedAt: new Date(),
    },
    update: { lastUpdatedAt: new Date() },
  });
}

// ---------------------------------------------------------------------------
// Helper: upsert NewsEvent (idempotency key: article_id + event_type + actor)
// ---------------------------------------------------------------------------

/**
 * Upserts a `news_events` row.  The composite unique key
 * `(article_id, event_type, actor)` ensures idempotency across retries
 * and backfill runs (Req 6.8).
 *
 * `actor` defaults to `''` when absent so the unique constraint is satisfied
 * — Prisma requires non-null values in compound unique keys.
 */
export async function upsertEvent(data: {
  articleId: string;
  eventType: string;
  actor?: string;
  confidence: number;
  eventTimestamp: Date;
  importance: number;
}): Promise<Prisma.NewsEventGetPayload<Record<string, never>>> {
  const actor = data.actor ?? '';
  return prisma.newsEvent.upsert({
    where: {
      articleId_eventType_actor: {
        articleId: data.articleId,
        eventType: data.eventType,
        actor,
      },
    },
    create: {
      articleId: data.articleId,
      eventType: data.eventType,
      actor,
      confidence: data.confidence,
      eventTimestamp: data.eventTimestamp,
      importance: data.importance,
    },
    update: {
      confidence: data.confidence,
      importance: data.importance,
      updatedAt: new Date(),
    },
  });
}

// ---------------------------------------------------------------------------
// Helper: upsert NewsSentiment (idempotency key: article_id + model_version)
// ---------------------------------------------------------------------------

/**
 * Upserts a `news_sentiment` row.  Each `model_version` gets its own row
 * so historical scores are preserved when the model is upgraded (Req 8.5).
 */
export async function upsertSentiment(data: {
  articleId: string;
  modelVersion: string;
  sentimentScore: number;
  marketSentiment: number;
  companySentiment: number;
  macroSentiment: number;
  riskSentiment: number;
  qualitativeSignals: string[];
  confidence: number;
}): Promise<Prisma.NewsSentimentGetPayload<Record<string, never>>> {
  return prisma.newsSentiment.upsert({
    where: {
      articleId_modelVersion: {
        articleId: data.articleId,
        modelVersion: data.modelVersion,
      },
    },
    create: {
      articleId: data.articleId,
      modelVersion: data.modelVersion,
      sentimentScore: data.sentimentScore,
      marketSentiment: data.marketSentiment,
      companySentiment: data.companySentiment,
      macroSentiment: data.macroSentiment,
      riskSentiment: data.riskSentiment,
      qualitativeSignals: data.qualitativeSignals,
      confidence: data.confidence,
    },
    update: {
      sentimentScore: data.sentimentScore,
      marketSentiment: data.marketSentiment,
      companySentiment: data.companySentiment,
      macroSentiment: data.macroSentiment,
      riskSentiment: data.riskSentiment,
      qualitativeSignals: data.qualitativeSignals,
      confidence: data.confidence,
      computedAt: new Date(),
    },
  });
}

// ---------------------------------------------------------------------------
// Helper: upsert NewsImportance (idempotency key: event_id)
// ---------------------------------------------------------------------------

/**
 * Upserts a `news_importance` row keyed on `event_id`.  On conflict the
 * score and sub-scores are refreshed in place (Req 9.5).
 */
export async function upsertImportance(data: {
  eventId: string;
  importanceScore: number;
  subScores: Prisma.InputJsonValue;
  historicalDataAvailable: boolean;
  modelVersion: string;
}): Promise<Prisma.NewsImportanceGetPayload<Record<string, never>>> {
  return prisma.newsImportance.upsert({
    where: { eventId: data.eventId },
    create: {
      eventId: data.eventId,
      importanceScore: data.importanceScore,
      subScores: data.subScores,
      historicalDataAvailable: data.historicalDataAvailable,
      modelVersion: data.modelVersion,
    },
    update: {
      importanceScore: data.importanceScore,
      subScores: data.subScores,
      historicalDataAvailable: data.historicalDataAvailable,
      computedAt: new Date(),
    },
  });
}

// ---------------------------------------------------------------------------
// Helper: upsert NewsMarketImpact (idempotency key: event_id + asset_id)
// ---------------------------------------------------------------------------

/**
 * Upserts a `news_market_impacts` row keyed on `(event_id, asset_id)`.
 *
 * `assetId` is normalised to `''` when absent so the composite unique key
 * is satisfied (sector-level impacts carry no assetId).
 */
export async function upsertMarketImpact(data: {
  articleId: string;
  eventId: string;
  assetId?: string;
  sectorId?: string;
  direction: string;
  strength: number;
  confidence: number;
  expectedHorizon: string;
  evidenceType: string;
  impactComputationVersion: string;
  newsImpactScore?: number;
  impactComponents?: Prisma.InputJsonValue;
}): Promise<Prisma.NewsMarketImpactGetPayload<Record<string, never>>> {
  const assetId = data.assetId ?? '';
  return prisma.newsMarketImpact.upsert({
    where: {
      eventId_assetId: {
        eventId: data.eventId,
        assetId,
      },
    },
    create: {
      articleId: data.articleId,
      eventId: data.eventId,
      assetId,
      sectorId: data.sectorId,
      direction: data.direction,
      strength: data.strength,
      confidence: data.confidence,
      expectedHorizon: data.expectedHorizon,
      evidenceType: data.evidenceType,
      impactComputationVersion: data.impactComputationVersion,
      newsImpactScore: data.newsImpactScore,
      impactComponents: data.impactComponents ?? Prisma.JsonNull,
    },
    update: {
      direction: data.direction,
      strength: data.strength,
      confidence: data.confidence,
      expectedHorizon: data.expectedHorizon,
      evidenceType: data.evidenceType,
      newsImpactScore: data.newsImpactScore,
      impactComponents: data.impactComponents ?? Prisma.JsonNull,
      computedAt: new Date(),
    },
  });
}

export default prisma;
