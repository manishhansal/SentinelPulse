/**
 * Environment variable validation and typed configuration singleton.
 *
 * Parses and validates ALL environment variables at module load time.
 * - FEATURE_VERSION and PIPELINE_VERSION must match semver (Req 33.4).
 *   Validation failure throws immediately, preventing startup.
 * - Per-source enabled state is parsed from NEWS_SOURCE_{NAME}_ENABLED (Req 1.7):
 *   only "true" (case-insensitive) enables a source; any other value → disabled.
 * - If a source's base URL or poll interval is absent/empty at startup, the source
 *   is disabled for the process lifetime and a WARN is logged (Req 1.11).
 * - All other required vars (DATABASE_URL, REDIS_URL, etc.) throw if absent.
 *
 * Import `env` for the live, validated config.
 * Import `envSchema` (from ./env.schema.ts) for schema-only usage in tests.
 */

import { z } from 'zod';
import pinoLib from 'pino';
import { envSchema, type EnvSchema } from './env.schema.js';

// Re-export the schema so other modules only need one import path
export { envSchema } from './env.schema.js';
export type { EnvSchema } from './env.schema.js';

// ---------------------------------------------------------------------------
// Internal bootstrap logger (used before the app-level pino instance exists)
// ---------------------------------------------------------------------------

// pino ships a CommonJS default export; handle both CJS interop shapes
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pinoFactory = (pinoLib as any).default ?? pinoLib;
const bootstrapLogger = pinoFactory({ level: 'warn', name: 'env-bootstrap' });

// ---------------------------------------------------------------------------
// Typed `Env` — schema output enriched with guaranteed-numeric defaults
// ---------------------------------------------------------------------------

/**
 * Fully-resolved environment configuration.
 * All optional numeric fields have their defaults applied, so callers never
 * need to null-check them.
 */
export interface Env extends EnvSchema {
  CB_FAILURE_THRESHOLD: number;
  CB_RECOVERY_TIMEOUT_MS: number;
  RETRY_BASE_DELAY_MS: number;
  RETRY_MULTIPLIER: number;
  RETRY_MAX_ATTEMPTS: number;
  WORKER_NORMALIZE_CONCURRENCY: number;
  WORKER_DEDUP_CONCURRENCY: number;
  WORKER_ENTITY_CONCURRENCY: number;
  WORKER_EVENT_CONCURRENCY: number;
  WORKER_SENTIMENT_CONCURRENCY: number;
  WORKER_IMPACT_CONCURRENCY: number;
  WORKER_FEATURE_CONCURRENCY: number;
  WORKER_EMBED_CONCURRENCY: number;
  BACKFILL_MAX_CONCURRENCY: number;
  BACKFILL_MAX_LIVE_QUEUE_SHARE: number;
  EMBEDDING_DIMENSION: number;
  RETENTION_RAW_ARTICLES_DAYS: number;
  RETENTION_NORMALIZED_ARTICLES_DAYS: number;
  RETENTION_EVENTS_DAYS: number;
  RETENTION_TRAINING_SAMPLES_DAYS: number;
  PORT: number;
}

// ---------------------------------------------------------------------------
// Source-disable rules (Req 1.11)
// ---------------------------------------------------------------------------

type SourceName =
  | 'REUTERS'
  | 'MONEYCONTROL'
  | 'ECONOMICTIMES'
  | 'BLOOMBERG'
  | 'FINANCIALTIMES'
  | 'COINDESK';

const SOURCES: SourceName[] = [
  'REUTERS',
  'MONEYCONTROL',
  'ECONOMICTIMES',
  'BLOOMBERG',
  'FINANCIALTIMES',
  'COINDESK',
];

/**
 * Applies Req 1.11: if a source is enabled but its base URL or poll interval
 * is absent/empty, disable it for the process lifetime and emit a WARN.
 */
function applySourceDisableRules(parsed: EnvSchema): EnvSchema {
  const result = { ...parsed } as Record<string, unknown>;

  for (const source of SOURCES) {
    const enabledKey = `NEWS_SOURCE_${source}_ENABLED` as keyof EnvSchema;
    const baseUrlKey = `NEWS_SOURCE_${source}_BASE_URL` as keyof EnvSchema;
    const pollKey = `NEWS_SOURCE_${source}_POLL_INTERVAL_MS` as keyof EnvSchema;

    if (!result[enabledKey]) continue;

    const baseUrl = result[baseUrlKey] as string | undefined;
    const pollInterval = result[pollKey] as number | undefined;

    const missingVars: string[] = [];
    if (!baseUrl || baseUrl.trim() === '') {
      missingVars.push(String(baseUrlKey));
    }
    if (pollInterval === undefined || pollInterval === null) {
      missingVars.push(String(pollKey));
    }

    if (missingVars.length > 0) {
      bootstrapLogger.warn(
        { source, missingVariables: missingVars },
        `[env] Source ${source} is enabled but required variable(s) are absent or empty: ` +
          `${missingVars.join(', ')}. ` +
          `Disabling ${source} for the current process lifetime.`,
      );
      result[enabledKey] = false;
    }
  }

  return result as EnvSchema;
}

// ---------------------------------------------------------------------------
// Parse and validate — throws at module load if validation fails (Req 33.4)
// ---------------------------------------------------------------------------

function buildEnv(): Env {
  let parsed: EnvSchema;

  try {
    parsed = envSchema.parse(process.env);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const messages = err.errors
        .map((e) => `  • ${e.path.join('.')}: ${e.message}`)
        .join('\n');
      throw new Error(
        `[SentinelPulse] Environment validation failed — refusing to start.\n${messages}`,
      );
    }
    throw err;
  }

  // Apply source-disable rules (Req 1.7, Req 1.11)
  parsed = applySourceDisableRules(parsed);

  // Apply numeric defaults after coercion (matches .env.example defaults)
  const withDefaults: Env = {
    ...parsed,
    CB_FAILURE_THRESHOLD: parsed.CB_FAILURE_THRESHOLD ?? 5,
    CB_RECOVERY_TIMEOUT_MS: parsed.CB_RECOVERY_TIMEOUT_MS ?? 60_000,
    RETRY_BASE_DELAY_MS: parsed.RETRY_BASE_DELAY_MS ?? 1_000,
    RETRY_MULTIPLIER: parsed.RETRY_MULTIPLIER ?? 2,
    RETRY_MAX_ATTEMPTS: parsed.RETRY_MAX_ATTEMPTS ?? 3,
    WORKER_NORMALIZE_CONCURRENCY: parsed.WORKER_NORMALIZE_CONCURRENCY ?? 4,
    WORKER_DEDUP_CONCURRENCY: parsed.WORKER_DEDUP_CONCURRENCY ?? 2,
    WORKER_ENTITY_CONCURRENCY: parsed.WORKER_ENTITY_CONCURRENCY ?? 4,
    WORKER_EVENT_CONCURRENCY: parsed.WORKER_EVENT_CONCURRENCY ?? 4,
    WORKER_SENTIMENT_CONCURRENCY: parsed.WORKER_SENTIMENT_CONCURRENCY ?? 4,
    WORKER_IMPACT_CONCURRENCY: parsed.WORKER_IMPACT_CONCURRENCY ?? 2,
    WORKER_FEATURE_CONCURRENCY: parsed.WORKER_FEATURE_CONCURRENCY ?? 4,
    WORKER_EMBED_CONCURRENCY: parsed.WORKER_EMBED_CONCURRENCY ?? 2,
    BACKFILL_MAX_CONCURRENCY: parsed.BACKFILL_MAX_CONCURRENCY ?? 2,
    BACKFILL_MAX_LIVE_QUEUE_SHARE: parsed.BACKFILL_MAX_LIVE_QUEUE_SHARE ?? 0.2,
    EMBEDDING_DIMENSION: parsed.EMBEDDING_DIMENSION ?? 1536,
    RETENTION_RAW_ARTICLES_DAYS: parsed.RETENTION_RAW_ARTICLES_DAYS ?? 90,
    RETENTION_NORMALIZED_ARTICLES_DAYS: parsed.RETENTION_NORMALIZED_ARTICLES_DAYS ?? 365,
    RETENTION_EVENTS_DAYS: parsed.RETENTION_EVENTS_DAYS ?? 730,
    RETENTION_TRAINING_SAMPLES_DAYS: parsed.RETENTION_TRAINING_SAMPLES_DAYS ?? 0,
    PORT: parsed.PORT ?? 3000,
  };

  return withDefaults;
}

/**
 * Parsed and validated environment configuration.
 *
 * - All required variables are guaranteed present (throws otherwise).
 * - FEATURE_VERSION and PIPELINE_VERSION conform to semver (Req 33.4).
 * - Per-source enabled flags account for missing base URL / poll interval (Req 1.11).
 * - Numeric config fields carry sensible defaults matching .env.example values.
 */
export const env: Env = buildEnv();
