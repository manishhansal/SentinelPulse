/**
 * run-scheduler.ts — Standalone scheduler entry point for dev/testing.
 *
 * Instantiates the Scheduler with all enabled adapters and the news.raw
 * BullMQ queue, then starts it.  Runs until SIGTERM/SIGINT.
 *
 * Usage:
 *   set -a && source .env.local && set +a && npx tsx src/scripts/run-scheduler.ts
 */

import { pino } from 'pino';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { Scheduler } from '../engines/ingestion/Scheduler.js';
import { ReutersAdapter } from '../adapters/reuters/ReutersAdapter.js';
import { MoneycontrolAdapter } from '../adapters/moneycontrol/MoneycontrolAdapter.js';
import { EconomicTimesAdapter } from '../adapters/economic-times/EconomicTimesAdapter.js';
import { CoinDeskAdapter } from '../adapters/coindesk/CoinDeskAdapter.js';
import { BloombergAdapter } from '../adapters/bloomberg/BloombergAdapter.js';
import { FinancialTimesAdapter } from '../adapters/financial-times/FinancialTimesAdapter.js';
import { QUEUE_NAMES } from '../queue/queues.js';

const logger = pino({ name: 'scheduler-runner' });

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

// eslint-disable-next-line @typescript-eslint/require-await
async function main(): Promise<void> {
  logger.info({ REDIS_URL }, 'Starting SentinelPulse Scheduler');

  const redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    lazyConnect: false,
  });

  redis.on('error', (err) => logger.error({ err }, 'Redis error'));
  redis.on('connect', () => logger.info('Redis connected'));

  const rawQueue = new Queue(QUEUE_NAMES.RAW, { connection: redis });

  // Instantiate all adapters — Scheduler will filter by enabled state
  const adapters = [
    new ReutersAdapter(),
    new MoneycontrolAdapter(),
    new EconomicTimesAdapter(),
    new CoinDeskAdapter(),
    new BloombergAdapter(),
    new FinancialTimesAdapter(),
  ];

  const scheduler = new Scheduler({ adapters, rawQueue });

  const shutdown = async (): Promise<void> => {
    logger.info('Shutdown signal — stopping scheduler');
    scheduler.stop();
    await rawQueue.close();
    redis.disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });

  logger.info('Starting scheduler — will immediately run first cycle for all enabled sources');
  scheduler.start();

  logger.info('Scheduler running. Press Ctrl+C to stop.');
}

void main().catch((err) => {
  console.error('Scheduler fatal error:', err);
  process.exit(1);
});
