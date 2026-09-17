/**
 * pilot-reaction-test.ts — Phase 3B.1 Phase 9
 *
 * Controlled real-data reaction test for the 2024-01-08 to 2024-01-14 pilot window.
 *
 * PURPOSE
 * -------
 * This script exercises the full pipeline:
 *   data-service → HistoricalReactionEngine → news_market_reactions
 *
 * using only real provider data for the confirmed pilot window.
 * It does NOT fabricate prices, interpolate missing bars, or mark unavailable
 * data as successful.
 *
 * SCOPE
 * -----
 * Instruments: RELIANCE, HDFCBANK, INFY, BANKNIFTY
 *   (only these 4 have confirmed daily OHLCV in the pilot window)
 *
 * Date window: 2024-01-08 (Mon) to 2024-01-14 (Sun)
 *   NSE trading sessions: 5 days (Mon–Fri)
 *   Test event times: NSE session open + 30min (09:45 IST = 04:15 UTC)
 *
 * Horizons tested:
 *   return_1d — expected non-null (daily data available)
 *   return_5m/15m/30m/1h — expected null (intraday unavailable)
 *
 * HOW TO RUN
 * ----------
 *   npx tsx src/scripts/pilot-reaction-test.ts
 *
 * Requires:
 *   - data-service running on DATA_SERVICE_URL (default http://localhost:8200)
 *   - DATABASE_URL pointing to live sentinel_pulse DB (for persistence)
 *   - DATA_SERVICE_API_KEY set
 *
 * OUTPUT
 * ------
 * A JSON results file at: ./pilot-reaction-results.json
 * Console summary with per-event, per-instrument, per-horizon coverage.
 *
 * Phase 3B.1 Phase 9 compliance:
 *   - Does NOT pretend missing instruments have data
 *   - Does NOT synthesize OHLCV
 *   - Reports exact provider, fallback_used, bar_count per fetch
 *   - Measures return_1d / return_5m / return_15m / return_30m / return_1h coverage
 *   - Reports missing_market_data_rate
 *   - Reports provider distribution
 */

import { DataServiceClient } from '../integrations/data-service/DataServiceClient.js';
import { HistoricalReactionEngine } from '../engines/historical-reaction/HistoricalReactionEngine.js';
import { prisma } from '../db/prisma.js';
import { writeFileSync } from 'fs';

// ---------------------------------------------------------------------------
// Pilot configuration
// ---------------------------------------------------------------------------

/** Confirmed instruments with daily OHLCV in the Jan 2024 pilot window. */
const PILOT_INSTRUMENTS = ['RELIANCE', 'HDFCBANK', 'INFY', 'BANKNIFTY'] as const;

/** Additional instruments to test (expected to fail — documents gaps). */
const COVERAGE_INSTRUMENTS = ['TCS', 'ICICIBANK', 'SBIN', 'NIFTY'] as const;

const ALL_INSTRUMENTS = [...PILOT_INSTRUMENTS, ...COVERAGE_INSTRUMENTS] as const;

/**
 * Synthetic pilot events — one per NSE trading session in the pilot window,
 * anchored at 04:15 UTC (09:45 IST) which is 30 minutes after NSE open.
 *
 * These are SYNTHETIC event anchors used to probe historical market reactions.
 * They do NOT represent real news events.  In the actual pilot, real news events
 * from the DB with event_timestamp in this window would be used instead.
 */
const PILOT_SESSIONS: Array<{ date: string; eventTimestamp: Date }> = [
  { date: '2024-01-08', eventTimestamp: new Date('2024-01-08T04:15:00.000Z') },
  { date: '2024-01-09', eventTimestamp: new Date('2024-01-09T04:15:00.000Z') },
  { date: '2024-01-10', eventTimestamp: new Date('2024-01-10T04:15:00.000Z') },
  { date: '2024-01-11', eventTimestamp: new Date('2024-01-11T04:15:00.000Z') },
  { date: '2024-01-12', eventTimestamp: new Date('2024-01-12T04:15:00.000Z') },
];

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

interface ProviderFetchResult {
  assetId: string;
  offsetName: string;
  interval: string;
  asOf: string;
  provider: string | null;
  fallbackUsed: boolean;
  barCount: number;
  dataAvailable: boolean;
  close: number | null;
  timestamp: string | null;
}

interface ReactionRecord {
  sessionDate: string;
  eventTimestamp: string;
  assetId: string;
  return1m: number | null;
  return5m: number | null;
  return15m: number | null;
  return30m: number | null;
  return1h: number | null;
  return4h: number | null;
  return1d: number | null;
  marketOpen: boolean;
  dataServiceTimeout: boolean;
  provider: string | null;
  fallbackUsed: boolean;
  reactionWindowStart: string;
  reactionWindowEnd: string;
}

interface PilotResults {
  runAt: string;
  pilotWindow: { from: string; to: string };
  instruments: string[];
  sessions: string[];
  providerFetches: ProviderFetchResult[];
  reactions: ReactionRecord[];
  coverage: {
    totalEvents: number;
    totalAssetEventPairs: number;
    return1mNonNull: number;
    return5mNonNull: number;
    return15mNonNull: number;
    return30mNonNull: number;
    return1hNonNull: number;
    return1dNonNull: number;
    marketOpenTrue: number;
    missingMarketDataRate: number;
    providerDistribution: Record<string, number>;
    fallbackCount: number;
  };
  errors: Array<{ context: string; error: string }>;
}

// ---------------------------------------------------------------------------
// Direct OHLCV probe (bypasses HistoricalReactionEngine — raw provider test)
// ---------------------------------------------------------------------------

/**
 * Directly probe the data-service for OHLCV data at each offset for each
 * instrument.  This produces raw evidence of what data is actually available
 * before any reaction engine logic runs.
 *
 * This implements the "independently test each provider" requirement of Phase 4.
 */
async function probeProviderOHLCV(
  client: DataServiceClient,
  results: PilotResults,
): Promise<void> {
  console.log('\n=== Phase 4: Direct Provider OHLCV Probe ===\n');

  const intervals = ['1d', '5m', '15m', '1h'] as const;

  for (const instrument of ALL_INSTRUMENTS) {
    for (const session of PILOT_SESSIONS) {
      for (const interval of intervals) {
        const from = new Date(session.date + 'T03:30:00.000Z'); // 09:00 IST
        const to   = new Date(session.date + 'T10:15:00.000Z'); // 15:45 IST
        const asOf = to;

        try {
          const response = await client.getOHLCV({
            assetId: instrument,
            from,
            to,
            asOf,
            interval,
          });

          const lastBar = response.bars[response.bars.length - 1] ?? null;

          const result: ProviderFetchResult = {
            assetId: instrument,
            offsetName: `session_${session.date}`,
            interval,
            asOf: asOf.toISOString(),
            provider: response.provider,
            fallbackUsed: response.fallbackUsed,
            barCount: response.barCount,
            dataAvailable: response.dataAvailable,
            close: lastBar?.close ?? null,
            timestamp: lastBar?.timestamp.toISOString() ?? null,
          };

          results.providerFetches.push(result);

          const status = response.dataAvailable
            ? `✓ ${response.barCount} bars  provider=${response.provider}${response.fallbackUsed ? ' (fallback)' : ''}`
            : '✗ no data';

          console.log(`  ${instrument} ${session.date} ${interval}: ${status}`);
        } catch (err: unknown) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          results.errors.push({
            context: `probe ${instrument} ${session.date} ${interval}`,
            error: errorMsg,
          });
          console.log(`  ${instrument} ${session.date} ${interval}: ERROR — ${errorMsg}`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Synthetic event generation for pilot reactions
// ---------------------------------------------------------------------------

/**
 * Creates synthetic NewsEvent stubs in the DB for the pilot window if they
 * don't already exist. Uses a dedicated "pilot_test" article stub.
 *
 * Returns an array of { eventId, eventTimestamp, assetId } pairs.
 */
async function ensurePilotEvents(): Promise<Array<{
  eventId: string;
  eventTimestamp: Date;
  assetId: string;
  sessionDate: string;
}>> {
  const pairs: Array<{ eventId: string; eventTimestamp: Date; assetId: string; sessionDate: string }> = [];

  for (const session of PILOT_SESSIONS) {
    for (const instrument of PILOT_INSTRUMENTS) {
      // Find existing real events with asset links in this window
      const existingLinks = await prisma.newsAssetLink.findMany({
        where: {
          assetId: instrument,
          publishedAt: {
            gte: new Date(session.date + 'T00:00:00.000Z'),
            lt:  new Date(session.date + 'T23:59:59.000Z'),
          },
        },
        include: {
          article: {
            include: {
              events: { take: 1 },
            },
          },
        },
        take: 1,
      });

      if (existingLinks.length > 0) {
        const link = existingLinks[0]!;
        const event = link.article.events[0];
        if (event) {
          pairs.push({
            eventId: event.id,
            eventTimestamp: event.eventTimestamp,
            assetId: instrument,
            sessionDate: session.date,
          });
          console.log(`  Found real event for ${instrument} on ${session.date}: ${event.id}`);
          continue;
        }
      }

      // No real event found — record as gap (do NOT fabricate)
      console.log(`  No real event found for ${instrument} on ${session.date} — skipping (no fabrication)`);
    }
  }

  return pairs;
}

// ---------------------------------------------------------------------------
// Main pilot run
// ---------------------------------------------------------------------------

async function runPilot(): Promise<void> {
  const results: PilotResults = {
    runAt: new Date().toISOString(),
    pilotWindow: { from: '2024-01-08', to: '2024-01-14' },
    instruments: [...ALL_INSTRUMENTS],
    sessions: PILOT_SESSIONS.map((s) => s.date),
    providerFetches: [],
    reactions: [],
    coverage: {
      totalEvents: 0,
      totalAssetEventPairs: 0,
      return1mNonNull: 0,
      return5mNonNull: 0,
      return15mNonNull: 0,
      return30mNonNull: 0,
      return1hNonNull: 0,
      return1dNonNull: 0,
      marketOpenTrue: 0,
      missingMarketDataRate: 0,
      providerDistribution: {},
      fallbackCount: 0,
    },
    errors: [],
  };

  const client = new DataServiceClient();
  const engine = new HistoricalReactionEngine(client);

  console.log('=== SentinelPulse Phase 3B.1 Pilot Reaction Test ===');
  console.log(`Run at: ${results.runAt}`);
  console.log(`Window: ${results.pilotWindow.from} → ${results.pilotWindow.to}`);
  console.log(`Instruments: ${results.instruments.join(', ')}`);
  console.log(`Sessions: ${results.sessions.join(', ')}`);

  // Step 1: Phase 4 direct provider probe
  await probeProviderOHLCV(client, results);

  // Step 2: Find real events in the pilot window
  console.log('\n=== Phase 9: Real Event Reaction Generation ===\n');

  const eventPairs = await ensurePilotEvents();

  results.coverage.totalEvents = new Set(eventPairs.map((p) => p.eventId)).size;
  results.coverage.totalAssetEventPairs = eventPairs.length;

  if (eventPairs.length === 0) {
    console.log('\n  ⚠ No real events found in pilot window with asset links.');
    console.log('  Reactions cannot be generated without real events.');
    console.log('  This is the expected state before the 7-day pilot news ingestion.');
    console.log('  To generate reactions: run the news ingestion pipeline for 2024-01-08–14,');
    console.log('  then re-run this script.\n');
  } else {
    // Step 3: Run HistoricalReactionEngine for each event+asset pair
    for (const pair of eventPairs) {
      try {
        await engine.process({
          id: pair.eventId,
          eventTimestamp: pair.eventTimestamp,
          assetIds: [pair.assetId],
        });

        // Fetch the persisted reaction to measure coverage
        const reaction = await prisma.newsMarketReaction.findUnique({
          where: {
            eventId_assetId: {
              eventId: pair.eventId,
              assetId: pair.assetId,
            },
          },
        });

        if (reaction) {
          const rec: ReactionRecord = {
            sessionDate: pair.sessionDate,
            eventTimestamp: pair.eventTimestamp.toISOString(),
            assetId: pair.assetId,
            return1m:  reaction.return1m,
            return5m:  reaction.return5m,
            return15m: reaction.return15m,
            return30m: reaction.return30m,
            return1h:  reaction.return1h,
            return4h:  reaction.return4h,
            return1d:  reaction.return1d,
            marketOpen: reaction.marketOpen,
            dataServiceTimeout: reaction.dataServiceTimeout,
            provider: reaction.dataServiceSnapshotVersion ?? null,
            fallbackUsed: (reaction.dataServiceSnapshotVersion ?? '').includes('fallback'),
            reactionWindowStart: (reaction as unknown as { reactionWindowStart: Date | null }).reactionWindowStart?.toISOString() ?? '',
            reactionWindowEnd:   (reaction as unknown as { reactionWindowEnd: Date | null }).reactionWindowEnd?.toISOString() ?? '',
          };

          results.reactions.push(rec);

          // Update coverage counters
          if (rec.return1m  !== null) results.coverage.return1mNonNull++;
          if (rec.return5m  !== null) results.coverage.return5mNonNull++;
          if (rec.return15m !== null) results.coverage.return15mNonNull++;
          if (rec.return30m !== null) results.coverage.return30mNonNull++;
          if (rec.return1h  !== null) results.coverage.return1hNonNull++;
          if (rec.return1d  !== null) results.coverage.return1dNonNull++;
          if (rec.marketOpen) results.coverage.marketOpenTrue++;
          if (rec.fallbackUsed) results.coverage.fallbackCount++;

          if (rec.provider) {
            const p = rec.provider.replace('+fallback', '');
            results.coverage.providerDistribution[p] =
              (results.coverage.providerDistribution[p] ?? 0) + 1;
          }

          console.log(
            `  ${pair.assetId} ${pair.sessionDate}: ` +
            `return_1d=${rec.return1d?.toFixed(4) ?? 'null'} ` +
            `return_5m=${rec.return5m?.toFixed(4) ?? 'null'} ` +
            `provider=${rec.provider ?? 'null'} ` +
            `market_open=${rec.marketOpen}`,
          );
        }
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        results.errors.push({
          context: `reaction ${pair.eventId} ${pair.assetId}`,
          error: errorMsg,
        });
        console.log(`  ERROR generating reaction for ${pair.assetId} ${pair.sessionDate}: ${errorMsg}`);
      }
    }
  }

  // Step 4: Compute final coverage metrics
  const total = results.reactions.length;
  const missingData = results.reactions.filter((r) => !r.marketOpen || r.dataServiceTimeout).length;
  results.coverage.missingMarketDataRate = total > 0 ? missingData / total : 1.0;

  // Step 5: Print summary
  console.log('\n=== PILOT RESULTS SUMMARY ===');
  console.log(`Total events found:         ${results.coverage.totalEvents}`);
  console.log(`Total event+asset pairs:    ${results.coverage.totalAssetEventPairs}`);
  console.log(`Reactions generated:        ${results.reactions.length}`);
  console.log(`return_1m non-null:         ${results.coverage.return1mNonNull} / ${total}`);
  console.log(`return_5m non-null:         ${results.coverage.return5mNonNull} / ${total}`);
  console.log(`return_15m non-null:        ${results.coverage.return15mNonNull} / ${total}`);
  console.log(`return_30m non-null:        ${results.coverage.return30mNonNull} / ${total}`);
  console.log(`return_1h non-null:         ${results.coverage.return1hNonNull} / ${total}`);
  console.log(`return_1d non-null:         ${results.coverage.return1dNonNull} / ${total}`);
  console.log(`Market open:                ${results.coverage.marketOpenTrue} / ${total}`);
  console.log(`Missing market data rate:   ${(results.coverage.missingMarketDataRate * 100).toFixed(1)}%`);
  console.log(`Fallback provider used:     ${results.coverage.fallbackCount}`);
  console.log(`Provider distribution:      ${JSON.stringify(results.coverage.providerDistribution)}`);
  console.log(`Errors:                     ${results.errors.length}`);

  // Coverage gate
  const return1dRate = total > 0 ? results.coverage.return1dNonNull / total : 0;
  if (return1dRate >= 0.20) {
    console.log('\n  ✓ COVERAGE GATE PASSED: return_1d rate >= 20%');
  } else if (total === 0) {
    console.log('\n  ⚠ COVERAGE GATE: No reactions generated — pilot data not yet available.');
    console.log('    Run news ingestion for 2024-01-08 to 2024-01-14 first.');
  } else {
    console.log(`\n  ✗ COVERAGE GATE FAILED: return_1d rate ${(return1dRate * 100).toFixed(1)}% < 20%`);
    console.log('    Do NOT proceed to full backfill until coverage gate passes.');
  }

  // Direct provider probe summary
  const dailyAvailable = results.providerFetches.filter(
    (f) => f.interval === '1d' && f.dataAvailable,
  );
  const intradayAvailable = results.providerFetches.filter(
    (f) => f.interval !== '1d' && f.dataAvailable,
  );
  console.log(`\nDirect probe — daily bars:   ${dailyAvailable.length} / ${results.providerFetches.filter((f) => f.interval === '1d').length} instrument-sessions`);
  console.log(`Direct probe — intraday:     ${intradayAvailable.length} / ${results.providerFetches.filter((f) => f.interval !== '1d').length} instrument-sessions`);

  // Step 6: Write results file
  const outputPath = './pilot-reaction-results.json';
  writeFileSync(outputPath, JSON.stringify(results, null, 2), 'utf-8');
  console.log(`\nResults written to: ${outputPath}`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

runPilot()
  .then(() => {
    console.log('\nPilot reaction test complete.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('\nFatal error in pilot reaction test:', err);
    process.exit(1);
  });
