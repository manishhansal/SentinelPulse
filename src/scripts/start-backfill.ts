/**
 * start-backfill.ts — CLI trigger for historical news backfill (2021-01-01 → now).
 *
 * Connects directly to Redis, creates the news.backfill queue, and calls
 * BackfillEngine.startJob() with the configured date range.  The actual
 * batch processing is handled by the backfill.worker.ts process.
 *
 * Usage (from SentinelPulse directory):
 *   set -a && source .env.local && set +a
 *   npx tsx src/scripts/start-backfill.ts [--start 2021-01-01] [--end 2026-09-25] [--batch 200]
 *
 * Or via make:
 *   make backfill              # full 2021-01-01 → today
 *   make backfill-status       # show active job states
 *
 * The worker MUST be running separately for the batch to process:
 *   npx tsx src/workers/backfill.worker.ts
 * Or via docker compose:
 *   make up  (if worker-backfill service is defined in docker-compose)
 *
 * PIT safety: each article is processed by BackfillEngine.processBatch() which
 * enforces LookAheadGuard per article. Articles that violate PIT are skipped
 * and logged (Req 23.5). The jobId is printed on stdout for status checks.
 */

import { pino } from 'pino';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { BackfillEngine } from '../engines/backfill/BackfillEngine.js';
import { QUEUE_NAMES } from '../queue/queues.js';

const logger = pino({ name: 'start-backfill', level: 'info' });

// ---------------------------------------------------------------------------
// CLI argument parsing (minimal — no heavy deps)
// ---------------------------------------------------------------------------

function parseArgs(): { startDate: Date; endDate: Date; batchSize: number; sources?: string[] } {
  const args = process.argv.slice(2);
  const get = (flag: string, defaultVal: string): string => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1]! : defaultVal;
  };

  const startStr = get('--start', '2021-01-01');
  const endStr = get('--end', new Date().toISOString().slice(0, 10));
  const batchSize = parseInt(get('--batch', '200'), 10);
  const sourcesStr = get('--sources', '');
  const sources = sourcesStr ? sourcesStr.split(',').map((s) => s.trim()) : undefined;

  const startDate = new Date(startStr + 'T00:00:00.000Z');
  const endDate = new Date(endStr + 'T23:59:59.999Z');

  if (isNaN(startDate.getTime())) {
    console.error(`Invalid --start date: ${startStr}`);
    process.exit(1);
  }
  if (isNaN(endDate.getTime())) {
    console.error(`Invalid --end date: ${endStr}`);
    process.exit(1);
  }
  if (startDate >= endDate) {
    console.error(`--start must be before --end`);
    process.exit(1);
  }

  return { startDate, endDate, batchSize, sources };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { startDate, endDate, batchSize, sources } = parseArgs();

  const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
  logger.info({ REDIS_URL, startDate, endDate, batchSize, sources }, 'Connecting to Redis...');

  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });

  redis.on('error', (err) => {
    logger.error({ err }, 'Redis connection error');
  });

  const backfillQueue = new Queue(QUEUE_NAMES.BACKFILL, { connection: redis });
  const engine = new BackfillEngine(backfillQueue);

  console.log('');
  console.log('SentinelPulse Historical News Backfill');
  console.log('═══════════════════════════════════════');
  console.log(`  Start date:  ${startDate.toISOString().slice(0, 10)}`);
  console.log(`  End date:    ${endDate.toISOString().slice(0, 10)}`);
  console.log(`  Batch size:  ${batchSize}`);
  console.log(`  Sources:     ${sources?.join(', ') ?? 'all enabled'}`);
  console.log(`  Queue:       ${QUEUE_NAMES.BACKFILL}`);
  console.log('');

  let jobId: string;
  try {
    jobId = await engine.startJob({
      startDate,
      endDate,
      batchSize,
      ...(sources?.length ? { sources } : {}),
    });
  } catch (err) {
    logger.error({ err }, 'Failed to start backfill job');
    await backfillQueue.close();
    redis.disconnect();
    process.exit(1);
  }

  console.log(`✓ Backfill job started`);
  console.log(`  Job ID:      ${jobId}`);
  console.log('');
  console.log('The job has been enqueued on news.backfill.');
  console.log('Start the backfill worker to process it:');
  console.log('');
  console.log('  # In another terminal:');
  console.log('  npx tsx src/workers/backfill.worker.ts');
  console.log('');
  console.log('  # Or via docker compose (if worker-backfill service is configured):');
  console.log('  make up');
  console.log('');
  console.log('Monitor progress:');
  console.log(`  make backfill-status JOB_ID=${jobId}`);
  console.log('');

  await backfillQueue.close();
  redis.disconnect();
}

void main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
