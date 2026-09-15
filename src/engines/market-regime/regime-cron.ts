/**
 * regime-cron.ts — Standalone cron process for MarketRegimeEngine.
 *
 * Runs MarketRegimeEngine.update() every 15 minutes.
 * Intended to run as a persistent Docker service (cron-regime).
 *
 * Usage:
 *   node dist/engines/market-regime/regime-cron.js
 */

import { pino } from 'pino';
import { Redis } from 'ioredis';
import { MarketRegimeEngine } from './MarketRegimeEngine.js';
import { DataServiceClient } from '../../integrations/data-service/DataServiceClient.js';
import { MlServiceClient } from '../../integrations/ml-service/MlServiceClient.js';

const logger = pino({ name: 'regime-cron' });
const INTERVAL_MS = 15 * 60_000; // 15 minutes
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
redis.on('error', (err) => logger.error({ err }, 'Redis error'));

const engine = new MarketRegimeEngine(
  new DataServiceClient(),
  new MlServiceClient(),
);
engine.setRedisClient(redis);

let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await engine.update();
    logger.info('[regime-cron] Regime update complete');
  } catch (err) {
    logger.error({ err }, '[regime-cron] update failed');
  } finally {
    running = false;
  }
}

logger.info({ intervalMs: INTERVAL_MS }, '[regime-cron] Starting — firing immediately then every 15 minutes');

void tick();
const handle = setInterval(() => { void tick(); }, INTERVAL_MS);

const shutdown = (): void => {
  logger.info('[regime-cron] Shutdown');
  clearInterval(handle);
  redis.disconnect();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
