/**
 * EmbeddingMatcher — cosine-similarity-based near-duplicate content detection.
 *
 * Uses pgvector's `<=>` cosine-distance operator stored in `news_embeddings`
 * to find articles whose content embeddings are similar to an incoming article.
 *
 * Security: ALL parameters are passed as tagged-template placeholders to
 * `prisma.$queryRaw` — no string interpolation is used, preventing SQL injection.
 *
 * Requirements: Req 4.4, Req 30.3
 */

import { prisma } from '../../db/prisma.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface EmbeddingMatcherConfig {
  /**
   * Cosine similarity threshold for near-duplicate detection.
   * Default: 0.90, range [0.80, 1.00]
   * Requirements: Req 4.4
   */
  threshold: number;
  /**
   * Time window in hours (same as JaroWinkler for consistency).
   * Default: 24
   */
  windowHours: number;
}

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export interface EmbeddingMatch {
  articleId: string;
  similarity: number;
  entityId: string;
}

// ---------------------------------------------------------------------------
// Raw row returned by $queryRaw (snake_case from pg, camelCase aliases used)
// ---------------------------------------------------------------------------

interface RawEmbeddingRow {
  entityId: string;
  similarity: number;
}

// ---------------------------------------------------------------------------
// EmbeddingMatcher
// ---------------------------------------------------------------------------

export class EmbeddingMatcher {
  constructor(private readonly config: EmbeddingMatcherConfig) {}

  /**
   * Finds articles with embeddings similar to the given embedding vector,
   * published within the configured time window.
   *
   * Uses pgvector's `<=>` cosine-distance operator:
   *   similarity = 1 - (embedding <=> queryVector)
   *
   * Returns matches above the configured threshold.
   * Requirements: Req 4.4
   */
  async findSimilar(
    embedding: number[],
    publishedAfter: Date,
    modelVersion: string,
  ): Promise<EmbeddingMatch[]> {
    // Serialize embedding as a pgvector literal, e.g. "[0.1,0.2,...]"
    const embeddingLiteral = `[${embedding.join(',')}]`;

    // All substitutions use parameterised placeholders — never string interpolation
    const rows = await prisma.$queryRaw<RawEmbeddingRow[]>`
      SELECT
        e."entity_id"  AS "entityId",
        1 - (e.embedding <=> ${embeddingLiteral}::vector) AS similarity
      FROM news_embeddings e
      JOIN news_articles a ON a.id = e.entity_id
      WHERE e.entity_type = 'article'
        AND e.model_version = ${modelVersion}
        AND a.published_at  >= ${publishedAfter}
        AND 1 - (e.embedding <=> ${embeddingLiteral}::vector) >= ${this.config.threshold}
      ORDER BY similarity DESC
      LIMIT 20
    `;

    return rows.map((row) => ({
      articleId: row.entityId,
      entityId: row.entityId,
      similarity: Number(row.similarity),
    }));
  }

  /**
   * Returns the cosine similarity between two embedding vectors.
   * Values in [0, 1] where 1 = identical direction.
   *
   * cosine_similarity(a, b) = (a · b) / (|a| * |b|)
   *
   * Returns 0 when either vector has zero magnitude to avoid division by zero.
   */
  static cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error(
        `Vector length mismatch: a.length=${a.length}, b.length=${b.length}`,
      );
    }

    let dot = 0;
    let magA = 0;
    let magB = 0;

    for (let i = 0; i < a.length; i++) {
      dot += (a[i] as number) * (b[i] as number);
      magA += (a[i] as number) ** 2;
      magB += (b[i] as number) ** 2;
    }

    const magnitude = Math.sqrt(magA) * Math.sqrt(magB);
    if (magnitude === 0) return 0;

    // Clamp to [0, 1] — floating point arithmetic can occasionally exceed bounds
    return Math.min(1, Math.max(0, dot / magnitude));
  }
}
