/**
 * Pino logger factory for SentinelPulse.
 *
 * Provides structured JSON logging in production and pretty-printed
 * output in development. Every logger carries a `stage` label and an
 * optional `correlationId` for end-to-end request tracing (Req 29.2).
 *
 * Usage:
 *   import { createLogger, rootLogger } from './observability/logger.js';
 *   const log = createLogger('ingestion', requestCorrelationId);
 *   log.info('article fetched', { sourceId, articleId });
 *
 * Requirements: Req 29.2
 */

import { pino, type Logger } from 'pino';

// ---------------------------------------------------------------------------
// Base logger — shared transport configuration
// ---------------------------------------------------------------------------

/**
 * Creates a named, child logger for a specific pipeline stage.
 *
 * @param name          - The pipeline stage name (e.g. 'ingestion', 'normalization').
 *                        Attached as `stage` in every log record.
 * @param correlationId - Optional request / job correlation ID for tracing.
 *                        When provided, attached as `correlationId` in every record.
 * @returns A pino Logger pre-configured for the stage.
 *
 * Requirements: Req 29.2
 */
export function createLogger(name: string, correlationId?: string): Logger {
  const base = pino({
    level: process.env['LOG_LEVEL'] ?? 'info',
    name: 'sentinel-pulse',
    // Pretty-print in non-production environments for developer ergonomics.
    // pino-pretty is a dev dependency — the conditional ensures it is never
    // required in production images.
    transport:
      process.env['NODE_ENV'] !== 'production'
        ? { target: 'pino-pretty' }
        : undefined,
  });

  return correlationId
    ? base.child({ stage: name, correlationId })
    : base.child({ stage: name });
}

// ---------------------------------------------------------------------------
// Root logger — use for top-level process lifecycle events
// ---------------------------------------------------------------------------

/** Root logger for application startup / shutdown events. */
export const rootLogger = createLogger('root');
