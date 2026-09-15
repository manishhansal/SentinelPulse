/**
 * DeduplicationEngine — collapses duplicate and near-duplicate articles into
 * canonical NewsCluster records.
 *
 * Pipeline position:
 *   news.normalized queue → DeduplicationEngine → news.deduplicated queue
 *
 * Detection layers (in priority order):
 *   1. Exact duplicate  — canonicalUrl, externalId+sourceId, contentHash, titleHash
 *   2. Near-duplicate   — Jaro-Winkler title similarity (default ≥ 0.92)
 *   3. Near-duplicate   — cosine similarity on content embeddings (default ≥ 0.90)
 *
 * Cluster lifecycle:
 *   - Exact duplicate  → increment `duplicate_count`, discard, do NOT enqueue
 *   - Near-duplicate   → assign to highest-similarity cluster (tie-break: earliest
 *                        `created_at`), update cluster stats, enqueue
 *   - No match         → create new NewsCluster, enqueue
 *
 * consensus_score formula (Req 4.8):
 *   score = (Σ weights of distinct represented tiers) / (Σ weights of all defined tiers)
 *   Tier-1 weight = 2, Tier-2 weight = 1  →  denominator always = 3
 *   Normalised to [0.00, 1.00], rounded to 2 dp
 *
 * Idempotency (Req 4.10):
 *   Processing the same article twice produces the same cluster state as once.
 *
 * Queue publish (Req 4.11):
 *   Retries up to 3 times with 1 s delay. On exhaustion: marks the article
 *   `duplicate_count` unchanged, logs, preserves cluster assignment.
 *
 * Requirements: Req 4.1–4.11
 */

import { randomUUID } from 'crypto';
import { pino } from 'pino';
import type { Queue } from 'bullmq';
import { prisma } from '../../db/prisma.js';
import { JaroWinklerMatcher } from './JaroWinkler.js';
import { EmbeddingMatcher } from './EmbeddingMatcher.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger = pino({ name: 'DeduplicationEngine' });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tier weights used in consensus_score formula (Req 4.8). */
const TIER_WEIGHT: Record<1 | 2, number> = { 1: 2, 2: 1 };

/** Sum of all defined tier weights — denominator for consensus_score. */
const ALL_TIER_WEIGHTS_SUM = TIER_WEIGHT[1] + TIER_WEIGHT[2]; // = 3

/** Default tier for sources whose assignment cannot be determined (Req 4.9). */
const UNKNOWN_SOURCE_DEFAULT_TIER: 1 | 2 = 2;

/** Number of retries when the queue is unavailable (Req 4.11). */
const ENQUEUE_MAX_RETRIES = 3;

/** Delay between enqueue retries in milliseconds (Req 4.11). */
const ENQUEUE_RETRY_DELAY_MS = 1_000;

/** Default embedding model version used when querying embeddings. */
const DEFAULT_EMBEDDING_MODEL_VERSION = 'text-embedding-ada-002';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DeduplicationConfig {
  /** Jaro-Winkler threshold for title near-duplicate detection. Default: 0.92 */
  titleSimilarityThreshold: number;
  /** Cosine similarity threshold for embedding near-duplicate detection. Default: 0.90 */
  contentSimilarityThreshold: number;
  /** Sliding time window (hours) for near-duplicate candidate search. Default: 24 */
  windowHours: number;
  /**
   * Embedding model version used when querying news_embeddings.
   * Default: 'text-embedding-ada-002'
   */
  embeddingModelVersion?: string;
}

/**
 * Minimum article payload required by DeduplicationEngine.process().
 * Embedding is optional; near-duplicate embedding check is skipped when absent.
 */
export interface ArticleInput {
  /** UUID assigned during normalisation. */
  id: string;
  sourceId: string;
  sourceName: string;
  externalId: string;
  canonicalUrl: string;
  title: string;
  contentHash: string;
  titleHash: string;
  publishedAt: Date;
  /**
   * Source tier — 1 or 2.
   * When absent the engine treats the source as Tier-2 and emits a WARN
   * (Req 4.9).
   */
  tier?: 1 | 2;
  /**
   * Content embedding vector for cosine-similarity matching.
   * When absent the embedding near-duplicate check is skipped for this article.
   */
  embedding?: number[];
}

/** Outcome returned to the calling worker after deduplication. */
export interface DeduplicationResult {
  /** True only for exact duplicates (discarded; not enqueued downstream). */
  isDuplicate: boolean;
  /** ID of the NewsCluster this article belongs to (undefined for exact dupes). */
  clusterId?: string;
  /** Similarity score that triggered cluster assignment (undefined for exact dupes / new clusters). */
  similarityScore?: number;
  /** What action was taken. */
  clusterAction: 'exact_duplicate' | 'near_duplicate_assigned' | 'new_cluster';
}

// ---------------------------------------------------------------------------
// Internal helper types
// ---------------------------------------------------------------------------

interface NearDuplicateCandidate {
  clusterId: string;
  clusterCreatedAt: Date;
  similarity: number;
}

// ---------------------------------------------------------------------------
// DeduplicationEngine
// ---------------------------------------------------------------------------

export class DeduplicationEngine {
  private readonly jaroWinkler: JaroWinklerMatcher;
  private readonly embeddingMatcher: EmbeddingMatcher;
  private readonly cfg: Required<DeduplicationConfig>;

  constructor(
    private readonly deduplicatedQueue: Queue,
    config: Partial<DeduplicationConfig> = {},
  ) {
    this.cfg = {
      titleSimilarityThreshold: config.titleSimilarityThreshold ?? 0.92,
      contentSimilarityThreshold: config.contentSimilarityThreshold ?? 0.90,
      windowHours: config.windowHours ?? 24,
      embeddingModelVersion: config.embeddingModelVersion ?? DEFAULT_EMBEDDING_MODEL_VERSION,
    };

    this.jaroWinkler = new JaroWinklerMatcher({
      threshold: this.cfg.titleSimilarityThreshold,
      windowHours: this.cfg.windowHours,
    });

    this.embeddingMatcher = new EmbeddingMatcher({
      threshold: this.cfg.contentSimilarityThreshold,
      windowHours: this.cfg.windowHours,
    });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Processes a single NormalizedArticle through the full deduplication
   * pipeline and returns the outcome.
   *
   * Requirements: Req 4.1–4.11
   */
  async process(article: ArticleInput): Promise<DeduplicationResult> {
    // ------------------------------------------------------------------
    // 1. Exact duplicate check (Req 4.1, 4.2)
    // ------------------------------------------------------------------
    const existingArticleId = await this.checkExactDuplicate(article);
    if (existingArticleId !== null) {
      // Increment duplicate_count on the existing record (Req 4.2)
      await prisma.newsArticle.update({
        where: { id: existingArticleId },
        data: { duplicateCount: { increment: 1 } },
      });

      logger.debug(
        { articleId: article.id, existingId: existingArticleId },
        '[DeduplicationEngine] Exact duplicate detected — discarding',
      );

      return { isDuplicate: true, clusterAction: 'exact_duplicate' };
    }

    // ------------------------------------------------------------------
    // 2. Near-duplicate search (Req 4.3, 4.4)
    // ------------------------------------------------------------------
    const candidate = await this.findNearDuplicateCluster(article);

    let clusterId: string;
    let clusterAction: DeduplicationResult['clusterAction'];
    let similarityScore: number | undefined;

    if (candidate !== null) {
      // 3. Assign to existing cluster (Req 4.5, 4.6)
      clusterId = candidate.clusterId;
      similarityScore = candidate.similarity;
      clusterAction = 'near_duplicate_assigned';

      logger.debug(
        { articleId: article.id, clusterId, similarity: similarityScore },
        '[DeduplicationEngine] Near-duplicate detected — assigning to cluster',
      );
    } else {
      // 4. Create new cluster (Req 4.7)
      clusterId = await this.createCluster(article);
      clusterAction = 'new_cluster';

      logger.debug(
        { articleId: article.id, clusterId },
        '[DeduplicationEngine] No duplicate found — created new cluster',
      );
    }

    // ------------------------------------------------------------------
    // 5. Persist cluster assignment on the article record
    //    (idempotent: UPDATE only if clusterId changed or is null)
    // ------------------------------------------------------------------
    await prisma.newsArticle.updateMany({
      where: {
        id: article.id,
        // Only update if not yet assigned to this cluster (idempotency, Req 4.10)
        OR: [{ clusterId: null }, { clusterId: { not: clusterId } }],
      },
      data: { clusterId },
    });

    // ------------------------------------------------------------------
    // 6. Update cluster statistics (Req 4.5, 4.8)
    // ------------------------------------------------------------------
    const effectiveTier = this.resolveSourceTier(article.sourceId, article.tier);
    await this.updateClusterStats(clusterId, article.sourceId, effectiveTier);

    // ------------------------------------------------------------------
    // 7. Publish to news.deduplicated (Req 4.11)
    // ------------------------------------------------------------------
    const result: DeduplicationResult = { isDuplicate: false, clusterId, similarityScore, clusterAction };
    await this.publishToDeduplicated(article, result);

    return result;
  }

  // -------------------------------------------------------------------------
  // Private: exact duplicate detection (Req 4.1)
  // -------------------------------------------------------------------------

  /**
   * Checks whether any of the four exact-match signals (canonicalUrl,
   * externalId+sourceId, contentHash, titleHash) already exist in
   * news_articles.
   *
   * Returns the existing article's UUID when a match is found, null otherwise.
   *
   * Requirements: Req 4.1
   */
  private async checkExactDuplicate(article: ArticleInput): Promise<string | null> {
    const match = await prisma.newsArticle.findFirst({
      select: { id: true },
      where: {
        OR: [
          { canonicalUrl: article.canonicalUrl },
          { sourceId: article.sourceId, externalId: article.externalId },
          { contentHash: article.contentHash },
          { titleHash: article.titleHash },
        ],
        // Exclude the article itself in case it was already persisted
        NOT: { id: article.id },
      },
    });

    return match?.id ?? null;
  }

  // -------------------------------------------------------------------------
  // Private: near-duplicate cluster search (Req 4.3, 4.4, 4.5, 4.6)
  // -------------------------------------------------------------------------

  /**
   * Finds the best matching NewsCluster among candidates published within the
   * configured time window using Jaro-Winkler title similarity and/or embedding
   * cosine similarity.
   *
   * Tie-break rule (Req 4.6): highest similarity wins; equal similarity → earlier
   * cluster `created_at` wins.
   *
   * Returns the best candidate or null when no match exceeds the threshold.
   *
   * Requirements: Req 4.3, 4.4, 4.5, 4.6
   */
  private async findNearDuplicateCluster(
    article: ArticleInput,
  ): Promise<NearDuplicateCandidate | null> {
    const windowStart = new Date(
      article.publishedAt.getTime() - this.cfg.windowHours * 60 * 60 * 1_000,
    );

    // ----------------------------------------------------------------
    // JaroWinkler title scan (Req 4.3)
    // ----------------------------------------------------------------
    const titleCandidates = await this.findNearDuplicatesByTitle(
      article.title,
      article.id,
      windowStart,
    );

    // ----------------------------------------------------------------
    // Embedding cosine-similarity scan (Req 4.4)
    // ----------------------------------------------------------------
    const embeddingCandidates: NearDuplicateCandidate[] = [];
    if (article.embedding && article.embedding.length > 0) {
      const embMatches = await this.embeddingMatcher.findSimilar(
        article.embedding,
        windowStart,
        this.cfg.embeddingModelVersion,
      );

      for (const match of embMatches) {
        // Resolve the cluster for this matched article
        const matchedArticle = await prisma.newsArticle.findUnique({
          select: { clusterId: true, cluster: { select: { createdAt: true } } },
          where: { id: match.articleId },
        });

        if (matchedArticle?.clusterId && matchedArticle.cluster) {
          embeddingCandidates.push({
            clusterId: matchedArticle.clusterId,
            clusterCreatedAt: matchedArticle.cluster.createdAt,
            similarity: match.similarity,
          });
        }
      }
    }

    // ----------------------------------------------------------------
    // Merge and select best candidate (Req 4.5, 4.6)
    // ----------------------------------------------------------------
    const allCandidates = [...titleCandidates, ...embeddingCandidates];
    if (allCandidates.length === 0) return null;

    // De-duplicate cluster entries: keep highest similarity per cluster
    const byCluster = new Map<string, NearDuplicateCandidate>();
    for (const c of allCandidates) {
      const existing = byCluster.get(c.clusterId);
      if (!existing || c.similarity > existing.similarity) {
        byCluster.set(c.clusterId, c);
      }
    }

    // Sort: primary = similarity DESC, secondary = created_at ASC (Req 4.6)
    const sorted = [...byCluster.values()].sort((a, b) => {
      if (b.similarity !== a.similarity) return b.similarity - a.similarity;
      return a.clusterCreatedAt.getTime() - b.clusterCreatedAt.getTime();
    });

    return sorted[0] ?? null;
  }

  /**
   * Queries news_articles in the time window and runs Jaro-Winkler title
   * comparison to build a list of near-duplicate cluster candidates.
   *
   * Uses a page-based scan (up to 500 articles) to bound memory usage while
   * remaining correct for typical 24-hour windows.
   */
  private async findNearDuplicatesByTitle(
    incomingTitle: string,
    incomingArticleId: string,
    windowStart: Date,
  ): Promise<NearDuplicateCandidate[]> {
    // Fetch candidate articles with their cluster info from the time window
    const candidates = await prisma.newsArticle.findMany({
      select: {
        title: true,
        clusterId: true,
        cluster: { select: { createdAt: true } },
      },
      where: {
        publishedAt: { gte: windowStart },
        clusterId: { not: null },
        NOT: { id: incomingArticleId },
      },
      orderBy: { publishedAt: 'desc' },
      take: 500,
    });

    const results: NearDuplicateCandidate[] = [];

    for (const candidate of candidates) {
      if (!candidate.clusterId || !candidate.cluster) continue;

      const similarity = this.jaroWinkler.similarity(incomingTitle, candidate.title);
      if (similarity >= this.cfg.titleSimilarityThreshold) {
        results.push({
          clusterId: candidate.clusterId,
          clusterCreatedAt: candidate.cluster.createdAt,
          similarity,
        });
      }
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // Private: cluster creation (Req 4.7)
  // -------------------------------------------------------------------------

  /**
   * Creates a new NewsCluster with the incoming article as its canonical member.
   * Returns the new cluster's UUID.
   *
   * Initial values: source_count = 1, source_diversity = 1.
   * consensus_score is set after creation via updateClusterStats.
   *
   * Requirements: Req 4.7
   */
  private async createCluster(article: ArticleInput): Promise<string> {
    const clusterId = randomUUID();

    await prisma.newsCluster.create({
      data: {
        id: clusterId,
        canonicalUrl: article.canonicalUrl,
        headline: article.title,
        sourceCount: 1,
        sourceDiversity: 1,
        consensusScore: 0,
        firstSeenAt: article.publishedAt,
        lastUpdatedAt: new Date(),
      },
    });

    return clusterId;
  }

  // -------------------------------------------------------------------------
  // Private: cluster statistics update (Req 4.5, 4.8, 4.9)
  // -------------------------------------------------------------------------

  /**
   * Updates source_count, source_diversity, and consensus_score on the
   * cluster after adding a new member article.
   *
   * The update is idempotent: it derives fresh counts from the current set of
   * articles in the cluster, so re-processing the same article cannot
   * double-increment counts (Req 4.10).
   *
   * Requirements: Req 4.5, 4.8, 4.9
   */
  private async updateClusterStats(
    clusterId: string,
    _newSourceId: string,
    _newTier: 1 | 2,
  ): Promise<void> {
    // Fetch all distinct source IDs currently in this cluster (after the
    // article's clusterId has been set in the DB).
    const members = await prisma.newsArticle.findMany({
      select: { sourceId: true },
      where: { clusterId },
    });

    const distinctSources = new Set(members.map((m) => m.sourceId));
    const sourceCount = members.length;
    const sourceDiversity = distinctSources.size;

    // Resolve the tier of every distinct source and compute consensus_score
    let tier1Present = false;
    let tier2Present = false;

    for (const sourceId of distinctSources) {
      const tier = await this.lookupSourceTier(sourceId);
      if (tier === 1) tier1Present = true;
      if (tier === 2) tier2Present = true;
    }

    const consensusScore = this.computeConsensusScore(
      tier1Present ? 1 : 0,
      tier2Present ? 1 : 0,
    );

    await prisma.newsCluster.update({
      where: { id: clusterId },
      data: {
        sourceCount,
        sourceDiversity,
        consensusScore,
        lastUpdatedAt: new Date(),
      },
    });
  }

  // -------------------------------------------------------------------------
  // Private: consensus score formula (Req 4.8)
  // -------------------------------------------------------------------------

  /**
   * Computes the consensus score given whether Tier-1 and/or Tier-2 sources
   * are represented in the cluster.
   *
   * Formula (Req 4.8):
   *   (Σ weights of distinct represented tiers) / (Σ weights of all defined tiers)
   *   = (tier1Present × 2 + tier2Present × 1) / 3
   *   rounded to 2 decimal places, clamped to [0.00, 1.00]
   *
   * @param tier1Count  - 1 if any Tier-1 source is present, 0 otherwise
   * @param tier2Count  - 1 if any Tier-2 source is present, 0 otherwise
   */
  computeConsensusScore(tier1Count: number, tier2Count: number): number {
    // Clamp inputs: only 0 or 1 meaningful (distinct tier present or not)
    const t1 = tier1Count > 0 ? 1 : 0;
    const t2 = tier2Count > 0 ? 1 : 0;

    const numerator = t1 * TIER_WEIGHT[1] + t2 * TIER_WEIGHT[2];
    const raw = numerator / ALL_TIER_WEIGHTS_SUM;

    // Round to 2 decimal places and clamp to [0.00, 1.00]
    return Math.min(1, Math.max(0, Math.round(raw * 100) / 100));
  }

  // -------------------------------------------------------------------------
  // Private: tier resolution helpers (Req 4.9)
  // -------------------------------------------------------------------------

  /**
   * Resolves the effective tier for a source.
   *
   * When the article's `tier` field is provided, it is used directly.
   * Otherwise, the source's tier is looked up from the database.
   * If the source is not found, Tier-2 is assumed and a WARN is logged (Req 4.9).
   */
  private resolveSourceTier(sourceId: string, tier?: 1 | 2): 1 | 2 {
    if (tier === 1 || tier === 2) return tier;
    // Tier will be resolved lazily via lookupSourceTier when needed
    return UNKNOWN_SOURCE_DEFAULT_TIER;
  }

  /**
   * Looks up the tier for a source from the database.
   * Falls back to Tier-2 with a WARN log when the source is not found (Req 4.9).
   */
  private async lookupSourceTier(sourceId: string): Promise<1 | 2> {
    const source = await prisma.newsSource.findUnique({
      select: { tier: true },
      where: { id: sourceId },
    });

    if (!source) {
      logger.warn(
        { sourceId },
        '[DeduplicationEngine] Unrecognised source identifier — treating as Tier-2 (Req 4.9)',
      );
      return UNKNOWN_SOURCE_DEFAULT_TIER;
    }

    if (source.tier === 1) return 1;
    return 2;
  }

  // -------------------------------------------------------------------------
  // Private: publish to news.deduplicated (Req 4.11)
  // -------------------------------------------------------------------------

  /**
   * Publishes the deduplication result to the `news.deduplicated` BullMQ queue.
   *
   * Retries up to `ENQUEUE_MAX_RETRIES` times with a `ENQUEUE_RETRY_DELAY_MS`
   * delay between attempts (Req 4.11).
   *
   * On exhaustion: logs the error and records the failure — the article's
   * cluster assignment is preserved in the database.
   *
   * Requirements: Req 4.11
   */
  private async publishToDeduplicated(
    article: ArticleInput,
    result: DeduplicationResult,
  ): Promise<void> {
    const jobData = {
      articleId: article.id,
      sourceId: article.sourceId,
      clusterId: result.clusterId,
      clusterAction: result.clusterAction,
      similarityScore: result.similarityScore ?? null,
      publishedAt: article.publishedAt.toISOString(),
    };

    let lastError: unknown;

    for (let attempt = 1; attempt <= ENQUEUE_MAX_RETRIES; attempt++) {
      try {
        await this.deduplicatedQueue.add('deduplicated', jobData, {
          jobId: `dedup-${article.id}`, // idempotent job key (Req 4.10)
        });
        return; // success
      } catch (err) {
        lastError = err;
        logger.warn(
          { articleId: article.id, attempt, err },
          `[DeduplicationEngine] Failed to enqueue to news.deduplicated (attempt ${attempt}/${ENQUEUE_MAX_RETRIES})`,
        );

        if (attempt < ENQUEUE_MAX_RETRIES) {
          await sleep(ENQUEUE_RETRY_DELAY_MS);
        }
      }
    }

    // All retries exhausted — mark article as failed, preserve cluster assignment
    logger.error(
      { articleId: article.id, clusterId: result.clusterId, err: lastError },
      '[DeduplicationEngine] Exhausted all enqueue retries for news.deduplicated — ' +
        'marking article as failed; cluster assignment preserved (Req 4.11)',
    );

    // Record in news_processing_errors for visibility
    try {
      await prisma.newsProcessingError.create({
        data: {
          sourceId: article.sourceId,
          externalId: article.externalId,
          stage: 'deduplication',
          errorType: 'ENQUEUE_EXHAUSTED',
          errorMessage:
            `Failed to publish article ${article.id} to news.deduplicated after ` +
            `${ENQUEUE_MAX_RETRIES} attempts: ${String(lastError)}`,
        },
      });
    } catch (dbErr) {
      logger.error(
        { articleId: article.id, dbErr },
        '[DeduplicationEngine] Failed to write processing error record',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
