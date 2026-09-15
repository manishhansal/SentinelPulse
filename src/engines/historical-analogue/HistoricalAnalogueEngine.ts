/**
 * HistoricalAnalogueEngine
 *
 * Finds the top-N most semantically similar historical NewsEvents for a given
 * event using pgvector cosine similarity on news_embeddings, then enriches
 * each match with market reaction and regime data.
 *
 * Pipeline position:
 *   Called by GET /api/v1/news/events/similar and
 *              GET /api/v1/alphaforge/high-impact-events (Req 19.5)
 *
 * Key behaviours:
 *   - findAnalogues: retrieves top-N similar events (default 10, min 1, max 100)
 *     with similarity_score >= 0.5 via pgvector HNSW cosine search (Req 19.1).
 *   - Enriches each analogue with event_date, event_description, market_reaction,
 *     and market_regime_at_time; unavailable fields are null — the analogue is
 *     never excluded (Req 19.2).
 *   - Computes aggregate stats: median/mean per horizon, win rate, max adverse /
 *     favorable excursion; < 2 data points for a horizon → null (Req 19.3).
 *   - regime_filter = true: filters to current regime; if < 2 remain, returns
 *     results with regime_filter_warning: true (Req 19.4).
 *   - Hard 5 000 ms timeout: throws TimeoutError if exceeded (Req 19.5).
 *
 * Requirements: Req 19.1–19.5
 */

import { pino } from 'pino';

import { prisma } from '../../db/prisma.js';

// ---------------------------------------------------------------------------
// Module-level logger
// ---------------------------------------------------------------------------

const logger = pino({ name: 'HistoricalAnalogueEngine' });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default number of analogues to return. */
const DEFAULT_TOP_N = 10 as const;

/** Minimum valid topN value (Req 19.1). */
const MIN_TOP_N = 1 as const;

/** Maximum valid topN value (Req 19.1). */
const MAX_TOP_N = 100 as const;

/** Minimum similarity score — analogues below this threshold are excluded (Req 19.1). */
const MIN_SIMILARITY = 0.5 as const;

/** Hard response timeout in milliseconds before throwing TimeoutError (Req 19.5). */
const HARD_TIMEOUT_MS = 5_000 as const;

/** Minimum analogue count required for regime-filtered results to suppress warning (Req 19.4). */
const MIN_REGIME_MATCH = 2 as const;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when findAnalogues cannot complete within HARD_TIMEOUT_MS (Req 19.5). */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/** Thrown when the requested event has no stored embedding. */
export class EmbeddingNotFoundError extends Error {
  constructor(eventId: string) {
    super(`No embedding found for event: ${eventId}`);
    this.name = 'EmbeddingNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Shape of a single historical analogue enriched with reaction + regime data. */
export interface HistoricalAnalogue {
  eventId: string;
  similarityScore: number;
  eventDate: Date | null;
  eventDescription: string | null;
  eventType: string | null;
  marketReaction: {
    return1m: number | null;
    return5m: number | null;
    return15m: number | null;
    return30m: number | null;
    return1h: number | null;
    return4h: number | null;
    return1d: number | null;
    assetId: string | null;
  } | null;
  marketRegimeAtTime: string | null;
}

/** Aggregate statistics computed across all returned analogues (Req 19.3). */
export interface AggregateStats {
  medianReturn1m: number | null;
  medianReturn5m: number | null;
  medianReturn15m: number | null;
  medianReturn30m: number | null;
  medianReturn1h: number | null;
  medianReturn4h: number | null;
  medianReturn1d: number | null;
  meanReturn1m: number | null;
  meanReturn5m: number | null;
  meanReturn15m: number | null;
  meanReturn30m: number | null;
  meanReturn1h: number | null;
  meanReturn4h: number | null;
  meanReturn1d: number | null;
  /** Fraction of analogues with positive 15m return (0.0–1.0). */
  winRate: number | null;
  maxAdverseExcursion: number | null;
  maxFavorableExcursion: number | null;
}

/** Complete result returned by findAnalogues. */
export interface AnalogueResult {
  analogues: HistoricalAnalogue[];
  aggregateStats: AggregateStats;
  analogueCount: number;
  regimeFilterApplied: boolean;
  regimeFilterWarning?: boolean;
}

// ---------------------------------------------------------------------------
// Raw query result shapes
// ---------------------------------------------------------------------------

interface SimilarityRow {
  entity_id: string;
  similarity: number | string;
}

// ---------------------------------------------------------------------------
// HistoricalAnalogueEngine
// ---------------------------------------------------------------------------

export class HistoricalAnalogueEngine {
  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Finds the top-N most semantically similar historical events for the given
   * eventId, enriches each match, and computes aggregate statistics.
   *
   * Requirements: Req 19.1–19.5
   *
   * @param eventId    - The NewsEvent to find analogues for.
   * @param options.topN        - Number of analogues (default 10, min 1, max 100).
   * @param options.regimeFilter - When true, filter to the current market regime.
   * @param options.assetId     - Prefer market reactions for this asset when available.
   * @param options.marketId    - Market scope for regime lookup (default 'india').
   *
   * @throws {TimeoutError}           when computation exceeds 5 000 ms.
   * @throws {EmbeddingNotFoundError} when no embedding exists for eventId.
   */
  async findAnalogues(
    eventId: string,
    options?: {
      topN?: number;
      regimeFilter?: boolean;
      assetId?: string;
      marketId?: string;
    },
  ): Promise<AnalogueResult> {
    const startMs = Date.now();

    const topN = Math.min(
      MAX_TOP_N,
      Math.max(MIN_TOP_N, options?.topN ?? DEFAULT_TOP_N),
    );
    const regimeFilter = options?.regimeFilter ?? false;
    const assetId = options?.assetId;
    const marketId = options?.marketId ?? 'india';

    // Wrap everything in a hard timeout (Req 19.5).
    return this.withTimeout(
      this.compute(eventId, topN, regimeFilter, assetId, marketId, startMs),
      HARD_TIMEOUT_MS,
    );
  }

  // -------------------------------------------------------------------------
  // Private: orchestration
  // -------------------------------------------------------------------------

  private async compute(
    eventId: string,
    topN: number,
    regimeFilter: boolean,
    assetId: string | undefined,
    marketId: string,
    startMs: number,
  ): Promise<AnalogueResult> {
    // 1. Fetch the event's embedding vector ------------------------------
    const embeddingRow = await prisma.newsEmbedding.findFirst({
      where: { entityType: 'event', entityId: eventId },
      orderBy: { createdAt: 'desc' },
      select: { modelVersion: true },
    });

    if (!embeddingRow) {
      throw new EmbeddingNotFoundError(eventId);
    }

    const { modelVersion } = embeddingRow;

    // 2. pgvector cosine similarity search (Req 19.1) --------------------
    // We fetch topN * 2 candidates to account for the self-match and any
    // similarity < 0.5 that get filtered, then trim to topN afterward.
    const candidateLimit = topN * 2 + 1;

    const rows = await prisma.$queryRawUnsafe<SimilarityRow[]>(
      `SELECT ne2.entity_id,
              1 - (ne2.embedding <=> ne1.embedding) AS similarity
       FROM   news_embeddings ne1
       JOIN   news_embeddings ne2
              ON  ne2.entity_type  = 'event'
              AND ne2.model_version = ne1.model_version
              AND ne2.entity_id    <> $1
       WHERE  ne1.entity_type  = 'event'
         AND  ne1.entity_id    = $1
         AND  ne1.model_version = $2
         AND  1 - (ne2.embedding <=> ne1.embedding) >= $3
       ORDER  BY ne2.embedding <=> ne1.embedding
       LIMIT  $4`,
      eventId,
      modelVersion,
      MIN_SIMILARITY,
      candidateLimit,
    );

    // Trim to requested topN
    const topRows = rows.slice(0, topN);

    if (topRows.length === 0) {
      const emptyStats = this.computeAggregateStats([]);
      return {
        analogues: [],
        aggregateStats: emptyStats,
        analogueCount: 0,
        regimeFilterApplied: regimeFilter,
        ...(regimeFilter ? { regimeFilterWarning: true } : {}),
      };
    }

    // 3. Enrich each analogue -------------------------------------------
    const enriched = await this.enrichAnalogues(topRows, assetId);

    // 4. Regime filter (Req 19.4) ----------------------------------------
    let regimeFilterWarning: boolean | undefined;
    let finalAnalogues = enriched;

    if (regimeFilter) {
      const currentRegime = await this.resolveCurrentRegime(marketId);

      if (currentRegime !== null) {
        const filtered = enriched.filter(
          (a) => a.marketRegimeAtTime === currentRegime,
        );

        finalAnalogues = filtered;

        if (filtered.length < MIN_REGIME_MATCH) {
          regimeFilterWarning = true;
          logger.warn(
            { eventId, marketId, currentRegime, matchCount: filtered.length },
            '[HistoricalAnalogueEngine] Fewer than 2 analogues match current regime (Req 19.4)',
          );
        }
      } else {
        // Cannot resolve current regime — treat as no filter applied
        logger.warn(
          { eventId, marketId },
          '[HistoricalAnalogueEngine] Current regime unavailable; regime filter skipped',
        );
      }
    }

    // 5. Aggregate statistics (Req 19.3) ---------------------------------
    const aggregateStats = this.computeAggregateStats(finalAnalogues);

    logger.debug(
      {
        eventId,
        analogueCount: finalAnalogues.length,
        regimeFilter,
        regimeFilterWarning,
        elapsedMs: Date.now() - startMs,
      },
      '[HistoricalAnalogueEngine] findAnalogues complete',
    );

    const result: AnalogueResult = {
      analogues: finalAnalogues,
      aggregateStats,
      analogueCount: finalAnalogues.length,
      regimeFilterApplied: regimeFilter,
    };

    if (regimeFilterWarning !== undefined) {
      result.regimeFilterWarning = regimeFilterWarning;
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Private: enrichment helpers
  // -------------------------------------------------------------------------

  /**
   * Enriches raw similarity rows with event, market reaction, and regime data.
   * All enrichment fields are nullable — a missing field never excludes the
   * analogue (Req 19.2).
   */
  private async enrichAnalogues(
    rows: SimilarityRow[],
    preferredAssetId?: string,
  ): Promise<HistoricalAnalogue[]> {
    const eventIds = rows.map((r) => r.entity_id);

    // Batch-fetch event rows
    const events = await prisma.newsEvent.findMany({
      where: { id: { in: eventIds } },
      select: {
        id: true,
        eventType: true,
        actor: true,
        action: true,
        eventTimestamp: true,
      },
    });

    const eventMap = new Map(events.map((e) => [e.id, e]));

    // Batch-fetch market reactions
    // If a preferred assetId is given, prioritise that asset's row; otherwise
    // take the first available reaction for the event.
    const reactions = await prisma.newsMarketReaction.findMany({
      where: { eventId: { in: eventIds } },
      select: {
        eventId: true,
        assetId: true,
        return1m: true,
        return5m: true,
        return15m: true,
        return30m: true,
        return1h: true,
        return4h: true,
        return1d: true,
      },
    });

    // Build a map of eventId → best reaction row
    const reactionMap = new Map<string, typeof reactions[number]>();
    for (const r of reactions) {
      const existing = reactionMap.get(r.eventId);
      if (!existing) {
        reactionMap.set(r.eventId, r);
      } else if (preferredAssetId && r.assetId === preferredAssetId) {
        // Upgrade to preferred asset row
        reactionMap.set(r.eventId, r);
      }
    }

    // Batch-fetch regimes at event timestamps
    // For each event we want the regime that was active at eventTimestamp
    // (valid_from <= ts AND (valid_to IS NULL OR valid_to > ts)).
    const eventTimestampMap = new Map(
      events.map((e) => [e.id, e.eventTimestamp]),
    );

    const regimeMap = await this.resolveRegimesAtTimestamps(
      eventIds,
      eventTimestampMap,
    );

    // Assemble final analogues
    return rows.map((row) => {
      const similarity =
        typeof row.similarity === 'string'
          ? parseFloat(row.similarity)
          : row.similarity;

      const event = eventMap.get(row.entity_id);
      const reaction = reactionMap.get(row.entity_id);
      const regime = regimeMap.get(row.entity_id) ?? null;

      // Build event_description from actor + action (best effort)
      let eventDescription: string | null = null;
      if (event) {
        const parts = [event.actor, event.action].filter(Boolean);
        eventDescription = parts.length > 0 ? parts.join(' ') : null;
      }

      return {
        eventId: row.entity_id,
        similarityScore: similarity,
        eventDate: event?.eventTimestamp ?? null,
        eventDescription,
        eventType: event?.eventType ?? null,
        marketReaction: reaction
          ? {
              return1m: reaction.return1m,
              return5m: reaction.return5m,
              return15m: reaction.return15m,
              return30m: reaction.return30m,
              return1h: reaction.return1h,
              return4h: reaction.return4h,
              return1d: reaction.return1d,
              assetId: reaction.assetId,
            }
          : null,
        marketRegimeAtTime: regime,
      } satisfies HistoricalAnalogue;
    });
  }

  /**
   * Resolves the market regime that was active for each event at its
   * eventTimestamp.  Issues one query per event (acceptable for topN ≤ 100).
   *
   * Returns a map of eventId → regime string (or null when unknown).
   */
  private async resolveRegimesAtTimestamps(
    eventIds: string[],
    eventTimestampMap: Map<string, Date>,
  ): Promise<Map<string, string | null>> {
    const result = new Map<string, string | null>();

    // Parallelise lookups — topN is capped at 100 so fan-out is bounded.
    await Promise.all(
      eventIds.map(async (id) => {
        const ts = eventTimestampMap.get(id);
        if (!ts) {
          result.set(id, null);
          return;
        }

        try {
          const regime = await prisma.newsMarketRegime.findFirst({
            where: {
              validFrom: { lte: ts },
              OR: [{ validTo: null }, { validTo: { gt: ts } }],
            },
            orderBy: { validFrom: 'desc' },
            select: { regime: true },
          });
          result.set(id, regime?.regime ?? null);
        } catch {
          result.set(id, null);
        }
      }),
    );

    return result;
  }

  /**
   * Returns the currently-active regime string for the given market, or null
   * when no active regime row exists.  The active row is the one with
   * valid_to IS NULL (Req 13.2 convention used by MarketRegimeEngine).
   */
  private async resolveCurrentRegime(marketId: string): Promise<string | null> {
    try {
      const row = await prisma.newsMarketRegime.findFirst({
        where: { marketId, validTo: null },
        select: { regime: true },
      });
      return row?.regime ?? null;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Private: aggregate statistics (Req 19.3)
  // -------------------------------------------------------------------------

  /**
   * Computes aggregate statistics across all returned analogues.
   * Any horizon with fewer than 2 data points → null (Req 19.3).
   */
  private computeAggregateStats(analogues: HistoricalAnalogue[]): AggregateStats {
    const r1m: number[] = [];
    const r5m: number[] = [];
    const r15m: number[] = [];
    const r30m: number[] = [];
    const r1h: number[] = [];
    const r4h: number[] = [];
    const r1d: number[] = [];

    for (const a of analogues) {
      if (a.marketReaction === null) continue;
      const mr = a.marketReaction;
      if (mr.return1m !== null) r1m.push(mr.return1m);
      if (mr.return5m !== null) r5m.push(mr.return5m);
      if (mr.return15m !== null) r15m.push(mr.return15m);
      if (mr.return30m !== null) r30m.push(mr.return30m);
      if (mr.return1h !== null) r1h.push(mr.return1h);
      if (mr.return4h !== null) r4h.push(mr.return4h);
      if (mr.return1d !== null) r1d.push(mr.return1d);
    }

    // Win rate: fraction with positive 15m return
    const winRate = this.computeWinRate(r15m);

    // Max adverse / favorable excursion — computed across all available
    // horizons per analogue (worst low / best high across all horizons)
    const { maxAdverseExcursion, maxFavorableExcursion } =
      this.computeExcursions(analogues);

    return {
      medianReturn1m: this.computeMedian(r1m),
      medianReturn5m: this.computeMedian(r5m),
      medianReturn15m: this.computeMedian(r15m),
      medianReturn30m: this.computeMedian(r30m),
      medianReturn1h: this.computeMedian(r1h),
      medianReturn4h: this.computeMedian(r4h),
      medianReturn1d: this.computeMedian(r1d),
      meanReturn1m: this.computeMean(r1m),
      meanReturn5m: this.computeMean(r5m),
      meanReturn15m: this.computeMean(r15m),
      meanReturn30m: this.computeMean(r30m),
      meanReturn1h: this.computeMean(r1h),
      meanReturn4h: this.computeMean(r4h),
      meanReturn1d: this.computeMean(r1d),
      winRate,
      maxAdverseExcursion,
      maxFavorableExcursion,
    };
  }

  /**
   * Win rate: fraction of analogues in the sample whose 15m return is > 0.
   * Returns null when < 2 data points exist (Req 19.3).
   */
  private computeWinRate(return15m: number[]): number | null {
    if (return15m.length < 2) return null;
    const wins = return15m.filter((r) => r > 0).length;
    return wins / return15m.length;
  }

  /**
   * Max adverse excursion: most negative single-horizon return across all
   * analogues that have any reaction data (i.e. min of all non-null returns).
   * Max favorable excursion: most positive single-horizon return.
   *
   * Both require at least 2 data points (Req 19.3).
   */
  private computeExcursions(analogues: HistoricalAnalogue[]): {
    maxAdverseExcursion: number | null;
    maxFavorableExcursion: number | null;
  } {
    const allReturns: number[] = [];

    for (const a of analogues) {
      if (!a.marketReaction) continue;
      const mr = a.marketReaction;
      const vals = [
        mr.return1m,
        mr.return5m,
        mr.return15m,
        mr.return30m,
        mr.return1h,
        mr.return4h,
        mr.return1d,
      ].filter((v): v is number => v !== null);
      allReturns.push(...vals);
    }

    if (allReturns.length < 2) {
      return { maxAdverseExcursion: null, maxFavorableExcursion: null };
    }

    return {
      maxAdverseExcursion: Math.min(...allReturns),
      maxFavorableExcursion: Math.max(...allReturns),
    };
  }

  /**
   * Computes the median of a sorted number array.
   * Returns null when fewer than 2 values are present (Req 19.3).
   */
  private computeMedian(values: number[]): number | null {
    if (values.length < 2) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? ((sorted[mid - 1]! + sorted[mid]!) / 2)
      : sorted[mid]!;
  }

  /**
   * Computes the arithmetic mean of a number array.
   * Returns null when fewer than 2 values are present (Req 19.3).
   */
  private computeMean(values: number[]): number | null {
    if (values.length < 2) return null;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  }

  // -------------------------------------------------------------------------
  // Private: timeout guard (Req 19.5)
  // -------------------------------------------------------------------------

  /**
   * Races `computation` against a `limitMs` timeout.
   * Throws TimeoutError if the timeout fires first (Req 19.5).
   * Partial results are never returned — the error is thrown instead.
   */
  private withTimeout<T>(computation: Promise<T>, limitMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new TimeoutError(
            `[HistoricalAnalogueEngine] Computation exceeded ${limitMs} ms timeout (Req 19.5)`,
          ),
        );
      }, limitMs);

      computation.then(
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }
}
