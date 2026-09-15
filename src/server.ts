/**
 * SentinelPulse server entry point.
 *
 * Bootstraps the Fastify application from buildApp() and starts listening.
 * Handles graceful shutdown on SIGTERM / SIGINT.
 *
 * Usage:
 *   npx tsx src/server.ts
 *   node dist/server.js
 */

import { buildApp } from './app.js';
import { pino } from 'pino';

const logger = pino({ name: 'server' });
const PORT = parseInt(process.env['PORT'] ?? '3001', 10);
const HOST = process.env['HOST'] ?? '0.0.0.0';

// eslint-disable-next-line @typescript-eslint/require-await
async function main(): Promise<void> {
  const app = await buildApp();

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutdown signal received — closing server');
    try {
      await app.close();
      logger.info('Server closed cleanly');
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });

  try {
    const address = await app.listen({ port: PORT, host: HOST });
    logger.info({ address, port: PORT }, 'SentinelPulse API listening');
  } catch (err) {
    logger.error({ err }, 'Failed to start server');
    process.exit(1);
  }
}

void main();
