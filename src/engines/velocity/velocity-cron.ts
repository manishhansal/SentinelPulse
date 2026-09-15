/**
 * velocity-cron.ts — Standalone cron process for VelocityEngine.
 *
 * Runs VelocityEngine.computeAll() every 60 seconds.
 * Intended to run as a persistent Docker service (cron-velocity).
 *
 * Usage:
 *   node dist/engines/velocity/velocity-cron.js
 */

import { pino } from 'pino';
import { Redis } from 'ioredis';
import { VelocityEngine } from './VelocityEngine.js';

const logger = pino({ name: 'velocity-cron' });
const INTERVAL_MS = 60_000;
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
redis.on('error', (err) => logger.error({ err }, 'Redis error'));

const engine = new VelocityEngine();
engine.setRedisClient(redis);

let running = false;

async function tick(): Promise<void> {
  if (running) return; // skip if previous run is still in progress
  running = true;
  try {
    await engine.compute();
  } catch (err) {
    logger.error({ err }, '[velocity-cron] compute failed');
  } finally {
    running = false;
  }
}

logger.info({ intervalMs: INTERVAL_MS }, '[velocity-cron] Starting — firing immediately then every 60s');

void tick();
const handle = setInterval(() => { void tick(); }, INTERVAL_MS);

const shutdown = (): void => {
  logger.info('[velocity-cron] Shutdown');
  clearInterval(handle);
  redis.disconnect();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
