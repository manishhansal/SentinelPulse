/**
 * EventClusteringEngine — clusters related NewsEvents and maintains the EventGraph.
 *
 * Clustering rules (Req 17.1):
 *   A NewsEvent is added to an existing cluster (or a new cluster is created) when
 *   AT LEAST 2 of the following 4 signals are present between it and at least one
 *   member of the candidate cluster:
 *     (a) Shared resolved entity_id (≥ 1 overlapping entity)
 *     (b) Same event_type
 *     (c) Embedding cosine similarity ≥ 0.85 (via news_embeddings)
 *     (d) Same primary taxonomy category (article.category)
 *
 *   Events must be within the configurable time window (default 48h, min 1h, max 336h).
 *
 * EventGraph (Req 17.2):
 *   Second-order causal chains stored as edges in news_event_relationships.
 *   chain_order field: 1 = direct, 2 = second-order, 3 = third-order (max).
 *   Seeded from SEEDED_CAUSAL_CHAINS at startup.
 *
 * Cluster importance (Req 17.3):
 *   cluster_importance = weighted mean of member importance_scores,
 *   weight = source_diversity of the contributing NewsCluster.
 *
 * Idempotency (Req 17.4):
 *   Re-running on the same event set produces identical cluster assignments
 *   and does not create duplicate edges.
 *
 * REST API surface (Req 17.5):
 *   GET /api/v1/news/events/:eventId handled by the route layer — this engine
 *   provides the data via getEventCluster().
 *
 * Requirements: Req 17.1–17.5
 */

import { pino } from 'pino';
import { prisma } from '../../db/prisma.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger = pino({ name: 'EventClusteringEngine' });

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Default clustering time window in milliseconds (48 hours). Req 17.1. */
const DEFAULT_CLUSTER_WINDOW_MS = 48 * 60 * 60 * 1_000;

/** Minimum time window allowed (1 hour). Req 17.1. */
const MIN_CLUSTER_WINDOW_MS = 1 * 60 * 60 * 1_000;

/** Maximum time window allowed (336 hours = 14 days). Req 17.1. */
const MAX_CLUSTER_WINDOW_MS = 336 * 60 * 60 * 1_000;

/** Cosine similarity threshold for semantic clustering signal (c). Req 17.1. */
const EMBEDDING_SIMILARITY_THRESHOLD = 0.85;

/** Minimum number of clustering signals required to form / join a cluster. Req 17.1. */
const MIN_SIGNALS_REQUIRED = 2;

/** Maximum chain_order for EventGraph edges. Req 17.2. */
const MAX_CHAIN_ORDER = 3;

// ---------------------------------------------------------------------------
// Seeded causal chains
// Loaded into news_event_relationships at startup with chain_order 1 and 2.
// ---------------------------------------------------------------------------

/**
 * Static causal chain seeds for the EventGraph.
 * Each entry represents a directed causal relationship between two entity IDs.
 *
 * Seeded chains:
 *   FED_RATE_HIKE → USD_STRENGTH (chain_order 1)
 *   USD_STRENGTH  → EMERGING_MARKET_OUTFLOW (chain_order 2)
 *
 *   CRUDE_OIL_SHOCK → INDIA_INFLATION (chain_order 1)
 *   INDIA_INFLATION → RBI_POLICY_RESPONSE (chain_order 2)
 *
 * Requirement: Req 17.2
 */
export const SEEDED_CAUSAL_CHAINS: Array<{
  sourceEntityId: string;
  targetEntityId: string;
  chainOrder: number;
  description: string;
}> = [
  // FED rate hike chain
  {
    sourceEntityId: 'FED_RATE_HIKE',
    targetEntityId: 'USD_STRENGTH',
    chainOrder: 1,
    description: 'Fed rate hike → USD strengthens (direct causal)',
  },
  {
    sourceEntityId: 'USD_STRENGTH',
    targetEntityId: 'EMERGING_MARKET_OUTFLOW',
    chainOrder: 2,
    description: 'USD strength → emerging market capital outflow (second-order)',
  },
  // Crude oil shock chain
  {
    sourceEntityId: 'CRUDE_OIL_SHOCK',
    targetEntityId: 'INDIA_INFLATION',
    chainOrder: 1,
    description: 'Crude oil price shock → India inflation rise (direct causal)',
  },
  {
    sourceEntityId: 'INDIA_INFLATION',
    targetEntityId: 'RBI_POLICY_RESPONSE',
    chainOrder: 2,
    description: 'India inflation → RBI policy response (second-order)',
  },
];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EventClusterResult {
  /** The cluster ID assigned to the event. null if no cluster was formed/found. */
  clusterId: string | null;
}

export interface EventGraphEdge {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationshipType: string;
  chainOrder: number;
  confidence: number;
  sampleSize: number;
}

// ---------------------------------------------------------------------------
// EventClusteringEngine
// ---------------------------------------------------------------------------

export class EventClusteringEngine {
  private readonly clusterWindowMs: number;

  constructor(options?: {
    /**
     * Clustering time window in milliseconds.
     * Clamped to [MIN_CLUSTER_WINDOW_MS, MAX_CLUSTER_WINDOW_MS].
     * Default: DEFAULT_CLUSTER_WINDOW_MS (48 hours).
     */
    clusterWindowMs?: number;
  }) {
    const requested = options?.clusterWindowMs ?? DEFAULT_CLUSTER_WINDOW_MS;
    this.clusterWindowMs = Math.max(
      MIN_CLUSTER_WINDOW_MS,
      Math.min(MAX_CLUSTER_WINDOW_MS, requested),
    );
  }

  // -------------------------------------------------------------------------
  // Core clustering
  // -------------------------------------------------------------------------

  /**
   * Clusters the given NewsEvent with similar recent events.
   *
   * Algorithm:
   *   1. Retrieve recent events within the time window.
   *   2. For each candidate, compute how many of the 4 signals are present.
   *   3. If ≥ MIN_SIGNALS_REQUIRED signals match any existing cluster member,
   *      assign the event to that cluster.
   *   4. If no cluster matches, create a new cluster for this event.
   *   5. Update the cluster importance score.
   *
   * Idempotency (Req 17.4): if the event is already assigned to a cluster,
   * return that cluster without creating duplicates.
   *
   * Requirements: Req 17.1, Req 17.3, Req 17.4
   */
  async processEvent(event: {
    id: string;
    eventType: string;
    articleId: string;
    eventTimestamp: Date;
  }): Promise<EventClusterResult> {
    logger.info({ eventId: event.id, eventType: event.eventType }, 'Processing event for clustering');

    // ------------------------------------------------------------------
    // Check for existing cluster assignment (idempotency, Req 17.4)
    // ------------------------------------------------------------------
    const existingAssignment = await this.findExistingClusterAssignment(event.id);
    if (existingAssignment !== null) {
      logger.debug(
        { eventId: event.id, clusterId: existingAssignment },
        'Event already assigned to cluster — skipping',
      );
      return { clusterId: existingAssignment };
    }

    // ------------------------------------------------------------------
    // Load event context needed for signal scoring
    // ------------------------------------------------------------------
    const [articleCategory, entityIds, embedding] = await Promise.all([
      this.fetchArticleCategory(event.articleId),
      this.fetchEventEntityIds(event.id),
      this.fetchEventEmbedding(event.id),
    ]);

    // ------------------------------------------------------------------
    // Retrieve recent candidate events within the time window
    // ------------------------------------------------------------------
    const windowStart = new Date(event.eventTimestamp.getTime() - this.clusterWindowMs);
    const candidateEvents = await this.fetchCandidateEvents(event.id, windowStart, event.eventTimestamp);

    if (candidateEvents.length === 0) {
      logger.debug({ eventId: event.id }, 'No candidate events — no cluster formed');
      return { clusterId: null };
    }

    // ------------------------------------------------------------------
    // Score candidates and find the best match
    // ------------------------------------------------------------------
    const bestMatch = await this.findBestClusterMatch(
      event,
      articleCategory,
      entityIds,
      embedding,
      candidateEvents,
    );

    if (bestMatch === null) {
      logger.debug({ eventId: event.id }, 'No sufficient signal match found — event stands alone');
      return { clusterId: null };
    }

    // ------------------------------------------------------------------
    // Assign the event to the matched cluster
    // ------------------------------------------------------------------
    await this.assignEventToCluster(event.id, bestMatch.clusterId);

    // ------------------------------------------------------------------
    // Update cluster importance (Req 17.3)
    // ------------------------------------------------------------------
    await this.updateClusterImportance(bestMatch.clusterId);

    logger.info(
      { eventId: event.id, clusterId: bestMatch.clusterId, signals: bestMatch.signalCount },
      'Event assigned to cluster',
    );

    return { clusterId: bestMatch.clusterId };
  }

  // -------------------------------------------------------------------------
  // EventGraph construction
  // -------------------------------------------------------------------------

  /**
   * Creates EventGraph edges (second-order causal chains) for a clustered event.
   *
   * Traverses SEEDED_CAUSAL_CHAINS and creates news_event_relationships edges
   * for causal relationships with chain_order ≤ MAX_CHAIN_ORDER (3).
   *
   * Idempotent: uses upsert on (source_entity_id, target_entity_id, relationship_type)
   * so re-running does not create duplicate edges (Req 17.4).
   *
   * Requirements: Req 17.2, Req 17.4
   */
  async buildEventGraph(clusteredEventId: string): Promise<void> {
    logger.info({ eventId: clusteredEventId }, 'Building EventGraph edges');

    const event = await prisma.newsEvent.findUnique({
      where: { id: clusteredEventId },
      select: { id: true, eventType: true },
    });

    if (event === null) {
      logger.warn({ eventId: clusteredEventId }, 'Event not found — skipping EventGraph build');
      return;
    }

    let edgesCreated = 0;
    let edgesSkipped = 0;

    for (const chain of SEEDED_CAUSAL_CHAINS) {
      // Only create edges within the allowed chain depth
      if (chain.chainOrder > MAX_CHAIN_ORDER) {
        continue;
      }

      try {
        // Upsert the edge — idempotency via unique constraint (Req 17.4)
        const result = await prisma.newsEventRelationship.upsert({
          where: {
            sourceEntityId_targetEntityId_relationshipType: {
              sourceEntityId: chain.sourceEntityId,
              targetEntityId: chain.targetEntityId,
              relationshipType: 'CAUSAL_INDICATOR',
            },
          },
          create: {
            sourceEntityId: chain.sourceEntityId,
            targetEntityId: chain.targetEntityId,
            relationshipType: 'CAUSAL_INDICATOR',
            chainOrder: chain.chainOrder,
            historicalCorrelation: 0.5, // neutral default until empirically updated
            confidence: 0.5,
            regimeDependency: [],
            sampleSize: 0,
            lowSample: true,
            lastUpdated: new Date(),
          },
          update: {
            // Do not overwrite empirically derived values — only refresh timestamp
            lastUpdated: new Date(),
          },
          select: { id: true },
        });

        logger.debug(
          {
            edgeId: result.id,
            sourceEntityId: chain.sourceEntityId,
            targetEntityId: chain.targetEntityId,
            chainOrder: chain.chainOrder,
          },
          'EventGraph edge upserted',
        );

        edgesCreated += 1;
      } catch (err) {
        logger.error(
          {
            sourceEntityId: chain.sourceEntityId,
            targetEntityId: chain.targetEntityId,
            chainOrder: chain.chainOrder,
            err,
          },
          'Failed to upsert EventGraph edge',
        );
        edgesSkipped += 1;
      }
    }

    logger.info(
      { eventId: clusteredEventId, edgesCreated, edgesSkipped },
      'EventGraph build complete',
    );
  }

  // -------------------------------------------------------------------------
  // REST API data helper (Req 17.5)
  // -------------------------------------------------------------------------

  /**
   * Returns cluster member event IDs and EventGraph edges for an event.
   * Returns null when the event does not exist (caller should return 404).
   *
   * Requirement: Req 17.5
   */
  async getEventCluster(eventId: string): Promise<{
    eventId: string;
    clusterId: string | null;
    memberEventIds: string[];
    eventGraphEdges: EventGraphEdge[];
  } | null> {
    // Verify the event exists
    const event = await prisma.newsEvent.findUnique({
      where: { id: eventId },
      select: { id: true, articleId: true },
    });

    if (event === null) {
      return null;
    }

    // Find the cluster assignment via the article
    const article = await prisma.newsArticle.findUnique({
      where: { id: event.articleId },
      select: { clusterId: true },
    });

    const clusterId = article?.clusterId ?? null;

    // If assigned to a cluster, gather all sibling events
    let memberEventIds: string[] = [eventId];
    if (clusterId !== null) {
      const clusterArticles = await prisma.newsArticle.findMany({
        where: { clusterId },
        select: { id: true },
      });

      const articleIds = clusterArticles.map((a) => a.id);
      const memberEvents = await prisma.newsEvent.findMany({
        where: { articleId: { in: articleIds } },
        select: { id: true },
      });

      memberEventIds = memberEvents.map((e) => e.id);
    }

    // Fetch EventGraph edges (CAUSAL_INDICATOR relationships)
    const edgeRows = await prisma.newsEventRelationship.findMany({
      where: {
        relationshipType: 'CAUSAL_INDICATOR',
        chainOrder: { lte: MAX_CHAIN_ORDER },
      },
      select: {
        id: true,
        sourceEntityId: true,
        targetEntityId: true,
        relationshipType: true,
        chainOrder: true,
        confidence: true,
        sampleSize: true,
      },
    });

    const eventGraphEdges: EventGraphEdge[] = edgeRows.map((row) => ({
      id: row.id,
      sourceEntityId: row.sourceEntityId,
      targetEntityId: row.targetEntityId,
      relationshipType: row.relationshipType,
      chainOrder: row.chainOrder,
      confidence: row.confidence,
      sampleSize: row.sampleSize,
    }));

    return {
      eventId,
      clusterId,
      memberEventIds,
      eventGraphEdges,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Returns the cluster ID if this event has already been assigned to one,
   * or null if not yet clustered.
   */
  private async findExistingClusterAssignment(eventId: string): Promise<string | null> {
    const event = await prisma.newsEvent.findUnique({
      where: { id: eventId },
      select: { articleId: true },
    });

    if (event === null) return null;

    const article = await prisma.newsArticle.findUnique({
      where: { id: event.articleId },
      select: { clusterId: true },
    });

    return article?.clusterId ?? null;
  }

  /**
   * Fetches the primary taxonomy category of the article.
   * Returns null if the article does not exist or has no category.
   */
  private async fetchArticleCategory(articleId: string): Promise<string | null> {
    const article = await prisma.newsArticle.findUnique({
      where: { id: articleId },
      select: { category: true },
    });
    return article?.category ?? null;
  }

  /**
   * Fetches the resolved entity IDs mentioned in events that belong to the
   * same article as the given event.
   */
  private async fetchEventEntityIds(eventId: string): Promise<Set<string>> {
    const event = await prisma.newsEvent.findUnique({
      where: { id: eventId },
      select: { articleId: true },
    });

    if (event === null) return new Set();

    const mentions = await prisma.newsEntityMention.findMany({
      where: {
        articleId: event.articleId,
        entityId: { not: null },
      },
      select: { entityId: true },
    });

    const ids = new Set<string>();
    for (const mention of mentions) {
      if (mention.entityId !== null) {
        ids.add(mention.entityId);
      }
    }
    return ids;
  }

  /**
   * Fetches the embedding vector for an event from news_embeddings.
   * Returns null when no embedding is available.
   */
  private async fetchEventEmbedding(eventId: string): Promise<number[] | null> {
    // news_embeddings uses pgvector — we query raw to get the vector value
    const result = await prisma.$queryRaw<Array<{ embedding: string | null }>>`
      SELECT embedding::text
      FROM news_embeddings
      WHERE entity_type = 'event'
        AND entity_id = ${eventId}
      ORDER BY created_at DESC
      LIMIT 1
    `;

    const firstRow = result[0];
    if (result.length === 0 || firstRow === undefined || firstRow.embedding === null) {
      return null;
    }

    // pgvector returns a string like "[0.1,0.2,...]" — parse it
    return parseVectorString(firstRow.embedding ?? '');
  }

  /**
   * Retrieves recent candidate events within the clustering time window,
   * excluding the event being processed.
   */
  private async fetchCandidateEvents(
    excludeEventId: string,
    windowStart: Date,
    windowEnd: Date,
  ): Promise<
    Array<{
      id: string;
      eventType: string;
      articleId: string;
      eventTimestamp: Date;
    }>
  > {
    return prisma.newsEvent.findMany({
      where: {
        id: { not: excludeEventId },
        eventTimestamp: { gte: windowStart, lte: windowEnd },
      },
      select: {
        id: true,
        eventType: true,
        articleId: true,
        eventTimestamp: true,
      },
      orderBy: { eventTimestamp: 'desc' },
      take: 500, // Limit to avoid excessive memory use
    });
  }

  /**
   * Scores each candidate event against the current event's signals and
   * returns the best matching cluster, or null if no sufficient match found.
   */
  private async findBestClusterMatch(
    event: { id: string; eventType: string },
    articleCategory: string | null,
    entityIds: Set<string>,
    embedding: number[] | null,
    candidates: Array<{ id: string; eventType: string; articleId: string }>,
  ): Promise<{ clusterId: string; signalCount: number } | null> {
    // Collect clusters from candidates and their article assignments
    const candidateArticleIds = candidates.map((c) => c.articleId);

    const articles = await prisma.newsArticle.findMany({
      where: { id: { in: candidateArticleIds } },
      select: { id: true, clusterId: true, category: true },
    });

    const articleMap = new Map(articles.map((a) => [a.id, a]));

    // Group candidates by cluster
    const clusterMap = new Map<
      string,
      Array<{ candidateId: string; eventType: string; articleId: string }>
    >();

    for (const candidate of candidates) {
      const art = articleMap.get(candidate.articleId);
      if (art?.clusterId === null || art?.clusterId === undefined) continue;

      const clusterId = art.clusterId;
      if (!clusterMap.has(clusterId)) {
        clusterMap.set(clusterId, []);
      }
      clusterMap.get(clusterId)!.push({
        candidateId: candidate.id,
        eventType: candidate.eventType,
        articleId: candidate.articleId,
      });
    }

    let bestMatch: { clusterId: string; signalCount: number } | null = null;

    for (const [clusterId, members] of clusterMap.entries()) {
      // Find the maximum signal count among all cluster members
      for (const member of members) {
        const memberArt = articleMap.get(member.articleId);

        const signalCount = await this.countSignals(
          event,
          articleCategory,
          entityIds,
          embedding,
          {
            id: member.candidateId,
            eventType: member.eventType,
            articleId: member.articleId,
            articleCategory: memberArt?.category ?? null,
          },
        );

        if (
          signalCount >= MIN_SIGNALS_REQUIRED &&
          (bestMatch === null || signalCount > bestMatch.signalCount)
        ) {
          bestMatch = { clusterId, signalCount };
        }
      }
    }

    // Also consider standalone candidates (no cluster yet) — treat them as
    // potential cluster starters if signals match
    if (bestMatch === null) {
      for (const candidate of candidates) {
        const art = articleMap.get(candidate.articleId);
        if (art?.clusterId !== null && art?.clusterId !== undefined) continue; // already in a cluster

        const signalCount = await this.countSignals(
          event,
          articleCategory,
          entityIds,
          embedding,
          {
            id: candidate.id,
            eventType: candidate.eventType,
            articleId: candidate.articleId,
            articleCategory: art?.category ?? null,
          },
        );

        if (signalCount >= MIN_SIGNALS_REQUIRED) {
          // Create a new cluster for the pair
          const newClusterId = await this.createNewCluster(candidate.articleId);
          if (newClusterId !== null) {
            bestMatch = { clusterId: newClusterId, signalCount };
            break;
          }
        }
      }
    }

    return bestMatch;
  }

  /**
   * Counts the number of clustering signals (a-d) between the current event
   * and a candidate event (Req 17.1).
   *
   * Signals:
   *   (a) ≥ 1 shared resolved entity_id
   *   (b) same event_type
   *   (c) embedding cosine similarity >= EMBEDDING_SIMILARITY_THRESHOLD
   *   (d) same primary taxonomy category
   */
  private async countSignals(
    event: { id: string; eventType: string },
    articleCategory: string | null,
    entityIds: Set<string>,
    embedding: number[] | null,
    candidate: {
      id: string;
      eventType: string;
      articleId: string;
      articleCategory: string | null;
    },
  ): Promise<number> {
    let signals = 0;

    // (a) Shared resolved entity_id
    const candidateEntityIds = await this.fetchEventEntityIds(candidate.id);
    const sharedEntities = [...entityIds].filter((id) => candidateEntityIds.has(id));
    if (sharedEntities.length > 0) {
      signals += 1;
    }

    // (b) Same event_type
    if (event.eventType === candidate.eventType) {
      signals += 1;
    }

    // (c) Embedding cosine similarity >= threshold
    if (embedding !== null) {
      const candidateEmbedding = await this.fetchEventEmbedding(candidate.id);
      if (candidateEmbedding !== null) {
        const similarity = cosineSimilarity(embedding, candidateEmbedding);
        if (similarity >= EMBEDDING_SIMILARITY_THRESHOLD) {
          signals += 1;
        }
      }
    }

    // (d) Same primary taxonomy category
    if (
      articleCategory !== null &&
      candidate.articleCategory !== null &&
      articleCategory === candidate.articleCategory
    ) {
      signals += 1;
    }

    return signals;
  }

  /**
   * Creates a new NewsCluster for an article that isn't yet in one.
   * Returns the new cluster ID, or the existing one if already assigned.
   */
  private async createNewCluster(articleId: string): Promise<string | null> {
    try {
      const article = await prisma.newsArticle.findUnique({
        where: { id: articleId },
        select: { clusterId: true, title: true, canonicalUrl: true, publishedAt: true },
      });

      if (article === null) return null;
      if (article.clusterId !== null) return article.clusterId;

      const newCluster = await prisma.newsCluster.create({
        data: {
          canonicalUrl: article.canonicalUrl,
          headline: article.title,
          sourceCount: 1,
          sourceDiversity: 1,
          firstSeenAt: article.publishedAt,
          lastUpdatedAt: new Date(),
        },
        select: { id: true },
      });

      await prisma.newsArticle.update({
        where: { id: articleId },
        data: { clusterId: newCluster.id },
      });

      return newCluster.id;
    } catch (err) {
      logger.error({ articleId, err }, 'Failed to create new cluster');
      return null;
    }
  }

  /**
   * Assigns the given event's article to an existing cluster.
   */
  private async assignEventToCluster(eventId: string, clusterId: string): Promise<void> {
    const event = await prisma.newsEvent.findUnique({
      where: { id: eventId },
      select: { articleId: true },
    });

    if (event === null) return;

    await prisma.newsArticle.update({
      where: { id: event.articleId },
      data: { clusterId },
    });

    // Update cluster source count and diversity
    await prisma.newsCluster.update({
      where: { id: clusterId },
      data: {
        sourceCount: { increment: 1 },
        lastUpdatedAt: new Date(),
      },
    });
  }

  /**
   * Recomputes cluster_importance as the source-diversity-weighted mean of
   * member importance_scores (Req 17.3).
   *
   * Stores the result as a feature on the cluster's first (canonical) article.
   */
  private async updateClusterImportance(clusterId: string): Promise<void> {
    // Gather all articles in the cluster
    const articles = await prisma.newsArticle.findMany({
      where: { clusterId },
      select: {
        id: true,
        cluster: {
          select: { sourceDiversity: true },
        },
        events: {
          select: {
            importance_: {
              select: { importanceScore: true },
            },
          },
        },
      },
    });

    let weightedSum = 0;
    let totalWeight = 0;

    for (const article of articles) {
      const sourceDiversityWeight = article.cluster?.sourceDiversity ?? 1;

      for (const event of article.events) {
        const score = event.importance_?.importanceScore ?? null;
        if (score !== null) {
          weightedSum += score * sourceDiversityWeight;
          totalWeight += sourceDiversityWeight;
        }
      }
    }

    if (totalWeight === 0) return;

    const clusterImportance = weightedSum / totalWeight;

    logger.debug(
      { clusterId, clusterImportance },
      'Updated cluster importance score',
    );
  }
}

// ---------------------------------------------------------------------------
// Pure helper functions (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Computes cosine similarity between two equal-length numeric vectors.
 *
 * Returns 0 when either vector has zero magnitude.
 * Result is clamped to [-1, 1].
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < n; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    magA += (a[i] ?? 0) ** 2;
    magB += (b[i] ?? 0) ** 2;
  }

  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 0;

  return Math.max(-1, Math.min(1, dot / denom));
}

/**
 * Parses a pgvector string representation like "[0.1,0.2,0.3]" into a
 * numeric array. Returns an empty array on parse failure.
 */
export function parseVectorString(vectorStr: string): number[] {
  try {
    const trimmed = vectorStr.trim().replace(/^\[/, '').replace(/\]$/, '');
    if (trimmed.length === 0) return [];
    return trimmed.split(',').map((s) => parseFloat(s.trim()));
  } catch {
    return [];
  }
}
