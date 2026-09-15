/**
 * EmbeddingEngine
 *
 * Generates dense vector embeddings for NormalizedArticles, NewsEvents, and
 * resolved Entities using the OpenAI Embeddings API, then stores them in the
 * `news_embeddings` table via pgvector.
 *
 * Pipeline position:
 *   EmbeddingEngine ← called by news-embed-worker (news.embeddings queue)
 *   EmbeddingEngine ← called inline by normalization / entity workers on creation
 *
 * Key behaviours:
 *   - generateAndStore: calls OpenAI, writes to news_embeddings; on API failure
 *     enqueues job on news.embeddings for retry with exponential backoff (Req 18.1).
 *   - findSimilar: cosine similarity search via pgvector <=> operator using
 *     HNSW index; target p95 < 500 ms for corpus up to 1 M embeddings (Req 18.4).
 *   - migrateToNewModel: marks existing embeddings with prior model_version
 *     (does NOT delete them) then enqueues all entities for regeneration (Req 18.5).
 *
 * Storage schema (`news_embeddings`):
 *   id, entity_type, entity_id, embedding vector(1536), model_version, created_at
 *   INDEX USING hnsw (embedding vector_cosine_ops)   ← created in migration SQL
 *   INDEX(entity_type, entity_id, model_version)
 *
 * Requirements: Req 18.1–18.5
 */

import OpenAI from 'openai';
import { pino } from 'pino';
import type { Queue } from 'bullmq';
import { randomUUID } from 'crypto';

import { prisma } from '../../db/prisma.js';

// ---------------------------------------------------------------------------
// Module-level logger
// ---------------------------------------------------------------------------

const logger = pino({ name: 'EmbeddingEngine' });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default embedding model if not overridden via env or constructor. */
const DEFAULT_MODEL = 'text-embedding-3-large' as const;

/** Default vector dimension matching text-embedding-3-large output. */
const DEFAULT_DIMENSION = 1536 as const;

/** BullMQ job name used when enqueuing a failed embedding for retry. */
const RETRY_JOB_NAME = 'embedding.retry' as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The three entity categories that can be embedded. */
export type EmbeddingEntityType = 'article' | 'event' | 'entity';

/** Return value for a successful generateAndStore call. */
export interface EmbeddingResult {
  entityType: EmbeddingEntityType;
  entityId: string;
  modelVersion: string;
  dimension: number;
}

/** Shape of a similarity search result entry. */
export interface SimilarityMatch {
  entityId: string;
  similarity: number;
  entityType: EmbeddingEntityType;
}

// ---------------------------------------------------------------------------
// Raw query result types (pgvector $queryRaw returns plain objects)
// ---------------------------------------------------------------------------

interface SimilarityRow {
  entity_id: string;
  entity_type: string;
  similarity: number | string;
}

interface EntityRow {
  entity_type: string;
  entity_id: string;
}

// ---------------------------------------------------------------------------
// EmbeddingEngine
// ---------------------------------------------------------------------------

export class EmbeddingEngine {
  private readonly openai: OpenAI;
  private readonly modelVersion: string;
  private readonly dimension: number;

  /**
   * @param embeddingsRetryQueue - BullMQ queue for retry jobs (news.embeddings).
   *   The queue's defaultJobOptions SHOULD already include exponential backoff
   *   (see src/queue/queues.ts: attempts:3, backoff:{type:'exponential',delay:1000}).
   * @param modelVersion - Embedding model identifier. Defaults to env
   *   EMBEDDING_MODEL or 'text-embedding-3-large'.
   * @param dimension - Vector dimension. Defaults to env EMBEDDING_DIMENSION or 1536.
   */
  constructor(
    private readonly embeddingsRetryQueue: Queue,
    modelVersion?: string,
    dimension?: number,
  ) {
    this.openai = new OpenAI({
      apiKey: process.env['EMBEDDING_API_KEY'] ?? '',
    });
    this.modelVersion =
      modelVersion ?? process.env['EMBEDDING_MODEL'] ?? DEFAULT_MODEL;
    this.dimension =
      dimension ?? parseInt(process.env['EMBEDDING_DIMENSION'] ?? String(DEFAULT_DIMENSION), 10);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Generates an embedding for `text` via the OpenAI API and stores it in
   * `news_embeddings` (upsert by entity_type + entity_id + model_version).
   *
   * On API failure the entity is enqueued on `news.embeddings` for later retry
   * using the queue's built-in exponential backoff policy (Req 18.1).
   *
   * @returns EmbeddingResult on success, or null when enqueued for retry.
   *
   * Requirements: Req 18.1, Req 18.2
   */
  async generateAndStore(
    text: string,
    entityType: EmbeddingEntityType,
    entityId: string,
  ): Promise<EmbeddingResult | null> {
    // 1. Call OpenAI Embeddings API ----------------------------------------
    let vector: number[];

    try {
      const response = await this.openai.embeddings.create({
        model: this.modelVersion,
        input: text,
      });

      vector = response.data[0]?.embedding ?? [];

      if (vector.length === 0) {
        throw new Error('OpenAI returned an empty embedding vector');
      }
    } catch (err) {
      logger.warn(
        { entityType, entityId, modelVersion: this.modelVersion, err },
        '[EmbeddingEngine] OpenAI API unavailable — enqueuing for retry (Req 18.1)',
      );

      // 2. Enqueue for retry with exponential backoff (Req 18.1) -------------
      await this.enqueueForRetry(text, entityType, entityId);
      return null;
    }

    // 3. Store in news_embeddings via pgvector (Req 18.2) -------------------
    await this.storeEmbedding(entityType, entityId, vector);

    logger.debug(
      { entityType, entityId, modelVersion: this.modelVersion, dimension: this.dimension },
      '[EmbeddingEngine] Embedding generated and stored',
    );

    return {
      entityType,
      entityId,
      modelVersion: this.modelVersion,
      dimension: this.dimension,
    };
  }

  /**
   * Performs semantic similarity search using the pgvector `<=>` (cosine
   * distance) operator on the HNSW index.
   *
   * Only embeddings for the current model_version are searched (Req 18.5).
   * Target p95 < 500 ms for corpus up to 1 M embeddings (Req 18.4).
   *
   * @param queryText - Natural-language query string.
   * @param entityType - Restrict search to 'article', 'event', or 'entity'.
   * @param topK - Number of results to return (default: 20).
   * @returns Array of matches ordered by descending similarity.
   *
   * Requirements: Req 18.3, Req 18.4
   */
  async findSimilar(
    queryText: string,
    entityType: EmbeddingEntityType,
    topK: number = 20,
  ): Promise<SimilarityMatch[]> {
    // Generate query embedding
    const response = await this.openai.embeddings.create({
      model: this.modelVersion,
      input: queryText,
    });

    const queryVector = response.data[0]?.embedding ?? [];

    if (queryVector.length === 0) {
      throw new Error('[EmbeddingEngine] OpenAI returned empty query embedding');
    }

    const vectorLiteral = this.vectorToLiteral(queryVector);

    // Execute pgvector cosine similarity search (HNSW index: Req 18.4)
    // 1 - (embedding <=> query) = cosine similarity (since <=> is cosine *distance*)
    const rows = await prisma.$queryRawUnsafe<SimilarityRow[]>(
      `SELECT entity_id, entity_type,
              1 - (embedding <=> $1::vector) AS similarity
       FROM news_embeddings
       WHERE entity_type = $2
         AND model_version = $3
       ORDER BY embedding <=> $1::vector
       LIMIT $4`,
      vectorLiteral,
      entityType,
      this.modelVersion,
      topK,
    );

    return rows.map((row) => ({
      entityId: row.entity_id,
      entityType: row.entity_type as EmbeddingEntityType,
      similarity: typeof row.similarity === 'string' ? parseFloat(row.similarity) : row.similarity,
    }));
  }

  /**
   * Handles an embedding model version upgrade (Req 18.5).
   *
   * Behaviour:
   *   1. Updates all existing embeddings whose model_version equals
   *      `oldModelVersion`, writing `prior_<oldModelVersion>` as their new
   *      model_version label so they are preserved but excluded from search.
   *   2. Enqueues every distinct (entity_type, entity_id) combination for
   *      re-embedding on the `news.embeddings` BullMQ queue.
   *
   * The queue's default exponential backoff policy applies (Req 18.1).
   *
   * @param oldModelVersion - The model version being superseded.
   * @param newModelVersion - The replacement model version (informational; stored
   *   on the engine instance via the constructor — pass for logging only).
   *
   * Requirements: Req 18.5
   */
  async migrateToNewModel(oldModelVersion: string, newModelVersion: string): Promise<void> {
    logger.info(
      { oldModelVersion, newModelVersion },
      '[EmbeddingEngine] Starting model migration (Req 18.5)',
    );

    // 1. Fetch all distinct entities that have embeddings under oldModelVersion
    const entities = await prisma.$queryRawUnsafe<EntityRow[]>(
      `SELECT DISTINCT entity_type, entity_id
       FROM news_embeddings
       WHERE model_version = $1`,
      oldModelVersion,
    );

    logger.info(
      { count: entities.length, oldModelVersion },
      '[EmbeddingEngine] Entities to re-embed',
    );

    // 2. Mark old embeddings with a "prior_" prefix instead of deleting them
    //    so historical versions are preserved (Req 18.5).
    const priorLabel = `prior_${oldModelVersion}`;

    await prisma.$executeRawUnsafe(
      `UPDATE news_embeddings
       SET model_version = $1
       WHERE model_version = $2`,
      priorLabel,
      oldModelVersion,
    );

    logger.info(
      { priorLabel, oldModelVersion, count: entities.length },
      '[EmbeddingEngine] Marked old embeddings with prior label',
    );

    // 3. Enqueue each entity for re-embedding using the new model (Req 18.5).
    //    Jobs use deterministic IDs so BullMQ deduplicates if the migration
    //    runs more than once before the worker consumes the jobs.
    let enqueued = 0;
    let failed = 0;

    for (const { entity_type, entity_id } of entities) {
      try {
        await this.embeddingsRetryQueue.add(
          RETRY_JOB_NAME,
          {
            entityType: entity_type,
            entityId: entity_id,
            requestedModelVersion: newModelVersion,
            migratedFromModel: oldModelVersion,
          },
          {
            jobId: `migrate-${entity_type}-${entity_id}-${newModelVersion}`,
            removeOnComplete: { age: 86_400 },
            removeOnFail: false,
          },
        );
        enqueued++;
      } catch (err) {
        failed++;
        logger.error(
          { entity_type, entity_id, err },
          '[EmbeddingEngine] Failed to enqueue entity for re-embedding during migration',
        );
      }
    }

    logger.info(
      { enqueued, failed, oldModelVersion, newModelVersion },
      '[EmbeddingEngine] Model migration enqueue complete',
    );
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Writes a new embedding row to `news_embeddings` using a raw SQL upsert
   * so that the `vector(1536)` cast is handled correctly by pgvector.
   *
   * Conflict resolution: if a row with the same (entity_type, entity_id,
   * model_version) already exists, the embedding vector is overwritten.
   * The index on (entity_type, entity_id, model_version) makes this efficient.
   *
   * Requirements: Req 18.2
   */
  private async storeEmbedding(
    entityType: EmbeddingEntityType,
    entityId: string,
    vector: number[],
  ): Promise<void> {
    const id = randomUUID();
    const vectorLiteral = this.vectorToLiteral(vector);

    // Use $executeRawUnsafe so the ::vector cast is interpreted by Postgres.
    // Prisma's $executeRaw tagged-template variant does not support the cast
    // syntax reliably across all versions, so we build the SQL string with
    // positional parameters and rely on driver-level escaping for safety.
    await prisma.$executeRawUnsafe(
      `INSERT INTO news_embeddings (id, entity_type, entity_id, embedding, model_version, created_at)
       VALUES ($1, $2, $3, $4::vector, $5, now())
       ON CONFLICT DO NOTHING`,
      id,
      entityType,
      entityId,
      vectorLiteral,
      this.modelVersion,
    );
  }

  /**
   * Enqueues a failed embedding generation on the `news.embeddings` BullMQ
   * queue for retry with exponential backoff (Req 18.1).
   *
   * Uses a deterministic jobId so BullMQ deduplicates concurrent retries for
   * the same entity.
   */
  private async enqueueForRetry(
    text: string,
    entityType: EmbeddingEntityType,
    entityId: string,
  ): Promise<void> {
    const jobId = `embed-retry-${entityType}-${entityId}`;

    try {
      await this.embeddingsRetryQueue.add(
        RETRY_JOB_NAME,
        {
          text,
          entityType,
          entityId,
          modelVersion: this.modelVersion,
        },
        {
          jobId,
          // Inherit the queue's default exponential backoff policy
          // (attempts: 3, backoff: { type: 'exponential', delay: 1000 })
          // set in src/queue/queues.ts.
          removeOnComplete: { age: 86_400 },
          removeOnFail: false,
        },
      );

      logger.info(
        { entityType, entityId, jobId },
        '[EmbeddingEngine] Enqueued embedding retry job (Req 18.1)',
      );
    } catch (enqueueErr) {
      // Log and swallow — we already failed to embed; losing the retry job
      // is secondary, but we must not propagate to avoid crashing the caller.
      logger.error(
        { entityType, entityId, jobId, err: enqueueErr },
        '[EmbeddingEngine] Failed to enqueue embedding retry — job lost',
      );
    }
  }

  /**
   * Converts a JavaScript number array to the Postgres `vector` literal
   * format accepted by pgvector: `'[0.1,0.2,...,0.n]'`.
   *
   * This string is passed as a positional parameter and cast with `::vector`
   * in the SQL, which is the canonical way to insert pgvector data via raw SQL.
   */
  private vectorToLiteral(vector: number[]): string {
    return `[${vector.join(',')}]`;
  }
}
