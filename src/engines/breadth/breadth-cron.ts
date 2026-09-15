/**
 * breadth-cron.ts — Standalone cron process for BreadthEngine.
 *
 * Runs BreadthEngine.computeAll() every 5 minutes.
 * Intended to run as a persistent Docker service (cron-breadth).
 *
 * Usage:
 *   node dist/engines/breadth/breadth-cron.js
 */

import { pino } from 'pino';
import { Redis } from 'ioredis';
import { BreadthEngine } from './BreadthEngine.js';

const logger = pino({ name: 'breadth-cron' });
const INTERVAL_MS = 5 * 60_000; // 5 minutes
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
redis.on('error', (err) => logger.error({ err }, 'Redis error'));

const engine = new BreadthEngine();
engine.setRedisClient(redis);

let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await engine.compute();
  } catch (err) {
    logger.error({ err }, '[breadth-cron] compute failed');
  } finally {
    running = false;
  }
}

logger.info({ intervalMs: INTERVAL_MS }, '[breadth-cron] Starting — firing immediately then every 5 minutes');

void tick();
const handle = setInterval(() => { void tick(); }, INTERVAL_MS);

const shutdown = (): void => {
  logger.info('[breadth-cron] Shutdown');
  clearInterval(handle);
  redis.disconnect();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
