/**
 * HistoricalReactionEngine — measures actual price/volume market reactions
 * following news events by querying the data-service at fixed time offsets.
 *
 * Pipeline position:
 *   news.impact queue → HistoricalReactionEngine → (feeds FeatureEngineeringEngine)
 *
 * Offsets queried (all with asOf = offset_timestamp, Req 12.1):
 *   -15min, -5min (baseline), +1min, +5min, +15min, +30min, +1h, +4h, +1d
 *
 * Return formula (Req 12.2):
 *   return_Xm = (close_at_offset - close_at_baseline) / close_at_baseline × 100
 *
 * Null / missing data rules:
 *   - Market not open → null for that offset, market_open: false (Req 12.3)
 *   - data-service timeout > 10s → null for ALL return fields at that offset,
 *     data_service_timeout: true, NO retry (Req 12.4)
 *   - NEVER interpolate, extrapolate, or substitute adjacent data (Req 12.3)
 *
 * high_impact_flag = |return_15m| > configurable threshold (default 0.5%) (Req 12.2)
 *
 * Storage: news_market_reactions UNIQUE(event_id, asset_id) — upsert (Req 12.5)
 *
 * Requirements: Req 12.1, Req 12.2, Req 12.3, Req 12.4, Req 12.5
 */

import { pino } from 'pino';
import type { AxiosError } from 'axios';
import type { DataServiceClient, OHLCVBar } from '../../integrations/data-service/DataServiceClient.js';
import { prisma } from '../../db/prisma.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger = pino({ name: 'HistoricalReactionEngine' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The event input consumed by the engine.  `assetIds` is sourced from
 * `news_asset_links` rows for the given event.
 */
export interface ReactionEvent {
  /** Canonical news_events.id (UUID). */
  id: string;
  /** The moment the news event occurred — anchor for all offset calculations. */
  eventTimestamp: Date;
  /** Asset IDs linked to this event via news_asset_links. */
  assetIds: string[];
}

/**
 * All nine offset timestamps derived from a single eventTimestamp.
 * Named after their distance from the event anchor.
 */
interface ReactionOffsets {
  minus15m: Date;
  minus5m: Date;  // baseline
  plus1m: Date;
  plus5m: Date;
  plus15m: Date;
  plus30m: Date;
  plus1h: Date;
  plus4h: Date;
  plus1d: Date;
}

/**
 * Raw OHLCV data fetched for a single offset.
 * `null` when market was not open or data-service timed out.
 */
interface OffsetBar {
  bar: OHLCVBar | null;
  /** True when the fetch timed out — no data is available. */
  timedOut: boolean;
  /** True when the data-service returned no bar (market closed / no data). */
  marketClosed: boolean;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/** Window used when querying OHLCV: 1-bar window centred on the offset. */
const BAR_WINDOW_MS = 60_000; // 1 minute window — fetches the bar that covers the offset

// ---------------------------------------------------------------------------
// HistoricalReactionEngine
// ---------------------------------------------------------------------------

export class HistoricalReactionEngine {
  /**
   * High-impact threshold as a percentage (default 0.5 as per Req 12.2).
   * `high_impact_flag = |return_15m| > highImpactThreshold`
   */
  private readonly highImpactThreshold: number;

  constructor(
    private readonly dataServiceClient: DataServiceClient,
    /** High-impact threshold in percent, default 0.5 (Req 12.2). */
    highImpactThreshold = 0.5,
  ) {
    this.highImpactThreshold = highImpactThreshold;
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Process one NewsEvent: fetch OHLCV at all nine offsets for every linked
   * asset, compute returns, and upsert records into `news_market_reactions`.
   *
   * Processing is best-effort per asset — a failure for one asset does NOT
   * abort processing for the remaining assets.
   */
  async process(event: ReactionEvent): Promise<void> {
    if (event.assetIds.length === 0) {
      logger.info({ eventId: event.id }, 'No linked assets — skipping HistoricalReactionEngine');
      return;
    }

    const offsets = this.buildOffsets(event.eventTimestamp);

    logger.info(
      { eventId: event.id, assetCount: event.assetIds.length },
      'HistoricalReactionEngine: processing event',
    );

    await Promise.all(
      event.assetIds.map((assetId) =>
        this.processAsset(event, assetId, offsets).catch((err: unknown) => {
          logger.error(
            { eventId: event.id, assetId, err },
            'HistoricalReactionEngine: unhandled error processing asset',
          );
        }),
      ),
    );
  }

  // --------------------------------------------------------------------------
  // Private: per-asset processing
  // --------------------------------------------------------------------------

  /**
   * Fetch all offset bars for a single asset and persist the reaction record.
   */
  private async processAsset(
    event: ReactionEvent,
    assetId: string,
    offsets: ReactionOffsets,
  ): Promise<void> {
    // Fetch the pre-event baseline (-5 min) first.
    const baselineBar = await this.fetchBar(assetId, offsets.minus5m);

    // Fetch all forward offsets (including -15m for pre-event context).
    const [minus15mBar, plus1mBar, plus5mBar, plus15mBar, plus30mBar, plus1hBar, plus4hBar, plus1dBar] =
      await Promise.all([
        this.fetchBar(assetId, offsets.minus15m),
        this.fetchBar(assetId, offsets.plus1m),
        this.fetchBar(assetId, offsets.plus5m),
        this.fetchBar(assetId, offsets.plus15m),
        this.fetchBar(assetId, offsets.plus30m),
        this.fetchBar(assetId, offsets.plus1h),
        this.fetchBar(assetId, offsets.plus4h),
        this.fetchBar(assetId, offsets.plus1d),
      ]);

    const baselineClose = baselineBar.bar?.close ?? null;

    // Compute returns relative to the -5m close baseline.
    const return1m = this.computeReturn(baselineClose, plus1mBar.bar?.close ?? null);
    const return5m = this.computeReturn(baselineClose, plus5mBar.bar?.close ?? null);
    const return15m = this.computeReturn(baselineClose, plus15mBar.bar?.close ?? null);
    const return30m = this.computeReturn(baselineClose, plus30mBar.bar?.close ?? null);
    const return1h = this.computeReturn(baselineClose, plus1hBar.bar?.close ?? null);
    const return4h = this.computeReturn(baselineClose, plus4hBar.bar?.close ?? null);
    const return1d = this.computeReturn(baselineClose, plus1dBar.bar?.close ?? null);

    // Volume change ratio: plus1m volume / minus5m volume (first meaningful offset).
    const volumeChangeRatio = this.computeRatio(
      baselineBar.bar?.volume ?? null,
      plus1mBar.bar?.volume ?? null,
    );

    // Volatility proxy: (high - low) / close spread, compare +15m vs -5m.
    const baselineVolatility = this.computeVolatilityProxy(baselineBar.bar);
    const offsetVolatility = this.computeVolatilityProxy(plus15mBar.bar);
    const volatilityChangeRatio = this.computeRatio(baselineVolatility, offsetVolatility);

    // high_impact_flag: |return_15m| > threshold (Req 12.2)
    const highImpactFlag =
      return15m !== null && Math.abs(return15m) > this.highImpactThreshold;

    // market_open: false when ANY primary offset has no data and it's not a timeout.
    // Per Req 12.3: when market data is not available, set market_open = false.
    // We set it to false when the baseline itself is unavailable (no trading data).
    const marketOpen =
      !baselineBar.marketClosed &&
      !plus1mBar.marketClosed &&
      !minus15mBar.marketClosed;

    // data_service_timeout: true when any fetch timed out (Req 12.4).
    const dataServiceTimeout =
      baselineBar.timedOut ||
      minus15mBar.timedOut ||
      plus1mBar.timedOut ||
      plus5mBar.timedOut ||
      plus15mBar.timedOut ||
      plus30mBar.timedOut ||
      plus1hBar.timedOut ||
      plus4hBar.timedOut ||
      plus1dBar.timedOut;

    await this.upsertReaction({
      eventId: event.id,
      assetId,
      return1m,
      return5m,
      return15m,
      return30m,
      return1h,
      return4h,
      return1d,
      volumeChangeRatio,
      volatilityChangeRatio,
      highImpactFlag,
      marketOpen,
      dataServiceTimeout,
    });

    logger.debug(
      {
        eventId: event.id,
        assetId,
        return1m,
        return15m,
        highImpactFlag,
        marketOpen,
        dataServiceTimeout,
      },
      'HistoricalReactionEngine: upserted reaction',
    );
  }

  // --------------------------------------------------------------------------
  // Private: data-service fetch with timeout handling
  // --------------------------------------------------------------------------

  /**
   * Fetch the single OHLCV bar that covers the given `offsetTime`.
   *
   * The query window is a 1-minute span ending at `offsetTime`.  An `asOf`
   * parameter equal to `offsetTime` is passed so the data-service returns
   * only data that was available at that exact moment (Req 12.1, Req 20.1).
   *
   * Rules:
   *   - On timeout (AxiosError with code ECONNABORTED / ETIMEDOUT or
   *     "timeout" in message): returns `{ bar: null, timedOut: true, marketClosed: false }`.
   *     The 10-second timeout is enforced by `DataServiceClient` itself (Req 12.4).
   *   - When no bars are returned (market closed / no data): returns
   *     `{ bar: null, timedOut: false, marketClosed: true }` (Req 12.3).
   *   - On any other error: re-throws so the caller can handle / log it.
   */
  private async fetchBar(assetId: string, offsetTime: Date): Promise<OffsetBar> {
    // Query a 1-minute window ending at offsetTime.
    const from = new Date(offsetTime.getTime() - BAR_WINDOW_MS);
    const to = offsetTime;

    try {
      const bars = await this.dataServiceClient.getOHLCV({
        assetId,
        from,
        to,
        // asOf MUST be <= offset timestamp to prevent look-ahead bias (Req 12.1, Req 20.1).
        asOf: offsetTime,
      });

      if (bars.length === 0) {
        // No data — market closed or no bar available at this offset (Req 12.3).
        return { bar: null, timedOut: false, marketClosed: true };
      }

      // Use the last bar in the window (closest to offsetTime).
      const bar = bars[bars.length - 1]!;
      return { bar, timedOut: false, marketClosed: false };
    } catch (err: unknown) {
      if (isTimeoutError(err)) {
        // Req 12.4: on timeout → null for all fields, data_service_timeout = true, no retry.
        logger.warn(
          { assetId, offsetTime: offsetTime.toISOString() },
          'HistoricalReactionEngine: data-service timeout — recording null',
        );
        return { bar: null, timedOut: true, marketClosed: false };
      }
      // Propagate unexpected errors so the caller can log and skip this asset.
      throw err;
    }
  }

  // --------------------------------------------------------------------------
  // Private: return and ratio computation
  // --------------------------------------------------------------------------

  /**
   * Computes: (closeAtOffset - closeAtBaseline) / closeAtBaseline × 100
   *
   * Returns `null` when either input is missing (Req 12.3 — no interpolation).
   */
  private computeReturn(
    closeAtBaseline: number | null,
    closeAtOffset: number | null,
  ): number | null {
    if (closeAtBaseline === null || closeAtOffset === null) return null;
    if (closeAtBaseline === 0) return null; // guard against division by zero
    return ((closeAtOffset - closeAtBaseline) / closeAtBaseline) * 100;
  }

  /**
   * Computes the ratio: numerator / denominator.
   * Returns `null` when either value is missing or denominator is zero.
   */
  private computeRatio(
    denominator: number | null,
    numerator: number | null,
  ): number | null {
    if (denominator === null || numerator === null) return null;
    if (denominator === 0) return null;
    return numerator / denominator;
  }

  /**
   * Computes a volatility proxy as the (high - low) / close spread for a bar.
   * Returns `null` when the bar is absent or close is zero.
   */
  private computeVolatilityProxy(bar: OHLCVBar | null): number | null {
    if (bar === null) return null;
    if (bar.close === 0) return null;
    return (bar.high - bar.low) / bar.close;
  }

  // --------------------------------------------------------------------------
  // Private: offset timestamp builder
  // --------------------------------------------------------------------------

  /**
   * Derives all nine offset timestamps from the event anchor time.
   * All arithmetic is in milliseconds to avoid Date mutation.
   */
  private buildOffsets(eventTimestamp: Date): ReactionOffsets {
    const t = eventTimestamp.getTime();
    return {
      minus15m: new Date(t - 15 * 60_000),
      minus5m: new Date(t - 5 * 60_000),
      plus1m: new Date(t + 1 * 60_000),
      plus5m: new Date(t + 5 * 60_000),
      plus15m: new Date(t + 15 * 60_000),
      plus30m: new Date(t + 30 * 60_000),
      plus1h: new Date(t + 60 * 60_000),
      plus4h: new Date(t + 4 * 60 * 60_000),
      plus1d: new Date(t + 24 * 60 * 60_000),
    };
  }

  // --------------------------------------------------------------------------
  // Private: persistence
  // --------------------------------------------------------------------------

  /**
   * Upserts a `news_market_reactions` row.
   * Idempotency key: UNIQUE(event_id, asset_id) (Req 12.5).
   */
  private async upsertReaction(data: {
    eventId: string;
    assetId: string;
    return1m: number | null;
    return5m: number | null;
    return15m: number | null;
    return30m: number | null;
    return1h: number | null;
    return4h: number | null;
    return1d: number | null;
    volumeChangeRatio: number | null;
    volatilityChangeRatio: number | null;
    highImpactFlag: boolean;
    marketOpen: boolean;
    dataServiceTimeout: boolean;
  }): Promise<void> {
    const now = new Date();

    await prisma.newsMarketReaction.upsert({
      where: {
        eventId_assetId: {
          eventId: data.eventId,
          assetId: data.assetId,
        },
      },
      create: {
        eventId: data.eventId,
        assetId: data.assetId,
        return1m: data.return1m,
        return5m: data.return5m,
        return15m: data.return15m,
        return30m: data.return30m,
        return1h: data.return1h,
        return4h: data.return4h,
        return1d: data.return1d,
        volumeChangeRatio: data.volumeChangeRatio,
        volatilityChangeRatio: data.volatilityChangeRatio,
        highImpactFlag: data.highImpactFlag,
        marketOpen: data.marketOpen,
        dataServiceTimeout: data.dataServiceTimeout,
        computedAt: now,
      },
      update: {
        return1m: data.return1m,
        return5m: data.return5m,
        return15m: data.return15m,
        return30m: data.return30m,
        return1h: data.return1h,
        return4h: data.return4h,
        return1d: data.return1d,
        volumeChangeRatio: data.volumeChangeRatio,
        volatilityChangeRatio: data.volatilityChangeRatio,
        highImpactFlag: data.highImpactFlag,
        marketOpen: data.marketOpen,
        dataServiceTimeout: data.dataServiceTimeout,
        computedAt: now,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the error is an Axios timeout (ECONNABORTED, ETIMEDOUT,
 * or a message containing "timeout").  Used by `fetchBar` to implement
 * Req 12.4: on timeout → null, no retry.
 */
function isTimeoutError(err: unknown): boolean {
  const axiosErr = err as AxiosError | null | undefined;
  if (axiosErr == null || axiosErr.isAxiosError !== true) return false;
  const code = axiosErr.code ?? '';
  const message = axiosErr.message ?? '';
  return (
    code === 'ECONNABORTED' ||
    code === 'ETIMEDOUT' ||
    message.toLowerCase().includes('timeout')
  );
}
