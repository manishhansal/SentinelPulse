/**
 * Zod schema definitions for all SentinelPulse environment variables.
 *
 * This module is intentionally side-effect-free — it only defines and exports
 * the schema so it can be imported by tests without triggering a process.env
 * parse. The live parse and validation happens exclusively in env.ts.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Reusable primitives
// ---------------------------------------------------------------------------

/** Semver string: MAJOR.MINOR.PATCH (Req 33.4) */
export const semverSchema = z.string().regex(/^\d+\.\d+\.\d+$/, {
  message: 'Must be a semantic version string (MAJOR.MINOR.PATCH)',
});

/**
 * Coerce a raw env-var string to an integer with optional min/max range.
 * Absent or empty strings become `undefined` so callers can apply defaults.
 */
export function coerceInt(min?: number, max?: number) {
  return z
    .string()
    .optional()
    .transform((v) => (v !== undefined && v !== '' ? parseInt(v, 10) : undefined))
    .pipe(
      z
        .number()
        .int()
        .min(min ?? -Infinity)
        .max(max ?? Infinity)
        .optional(),
    );
}

/**
 * Parse NEWS_SOURCE_*_ENABLED (Req 1.7).
 * Only the string "true" (case-insensitive) evaluates to `true`.
 * Absent, empty, or any other value evaluates to `false`.
 */
export const sourceEnabledSchema = z
  .string()
  .optional()
  .transform((v) => (v ?? '').toLowerCase() === 'true');

// ---------------------------------------------------------------------------
// Full environment variable schema
// ---------------------------------------------------------------------------

export const envSchema = z.object({
  // ── Required infrastructure ────────────────────────────────────────────────
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  SENTINEL_API_KEY: z.string().min(1, 'SENTINEL_API_KEY is required'),
  DATA_SERVICE_URL: z.string().url('DATA_SERVICE_URL must be a valid URL'),
  DATA_SERVICE_API_KEY: z.string().min(1, 'DATA_SERVICE_API_KEY is required'),
  SCRAPLING_URL: z.string().url('SCRAPLING_URL must be a valid URL'),

  // ── Version strings — semver required (Req 33.4) ──────────────────────────
  FEATURE_VERSION: semverSchema,
  PIPELINE_VERSION: semverSchema,

  // ── Reuters (Tier-1) ──────────────────────────────────────────────────────
  NEWS_SOURCE_REUTERS_ENABLED: sourceEnabledSchema,
  NEWS_SOURCE_REUTERS_BASE_URL: z.string().optional(),
  NEWS_SOURCE_REUTERS_POLL_INTERVAL_MS: coerceInt(1000),

  // ── Moneycontrol (Tier-1) ─────────────────────────────────────────────────
  NEWS_SOURCE_MONEYCONTROL_ENABLED: sourceEnabledSchema,
  NEWS_SOURCE_MONEYCONTROL_BASE_URL: z.string().optional(),
  NEWS_SOURCE_MONEYCONTROL_POLL_INTERVAL_MS: coerceInt(1000),

  // ── Economic Times (Tier-1) ───────────────────────────────────────────────
  NEWS_SOURCE_ECONOMICTIMES_ENABLED: sourceEnabledSchema,
  NEWS_SOURCE_ECONOMICTIMES_BASE_URL: z.string().optional(),
  NEWS_SOURCE_ECONOMICTIMES_POLL_INTERVAL_MS: coerceInt(1000),

  // ── Bloomberg (Tier-2) ────────────────────────────────────────────────────
  NEWS_SOURCE_BLOOMBERG_ENABLED: sourceEnabledSchema,
  NEWS_SOURCE_BLOOMBERG_BASE_URL: z.string().optional(),
  NEWS_SOURCE_BLOOMBERG_POLL_INTERVAL_MS: coerceInt(1000),
  NEWS_SOURCE_BLOOMBERG_API_KEY: z.string().optional(),

  // ── Financial Times (Tier-2) ──────────────────────────────────────────────
  NEWS_SOURCE_FINANCIALTIMES_ENABLED: sourceEnabledSchema,
  NEWS_SOURCE_FINANCIALTIMES_BASE_URL: z.string().optional(),
  NEWS_SOURCE_FINANCIALTIMES_POLL_INTERVAL_MS: coerceInt(1000),
  NEWS_SOURCE_FINANCIALTIMES_API_KEY: z.string().optional(),

  // ── CoinDesk (Tier-2) ─────────────────────────────────────────────────────
  NEWS_SOURCE_COINDESK_ENABLED: sourceEnabledSchema,
  NEWS_SOURCE_COINDESK_BASE_URL: z.string().optional(),
  NEWS_SOURCE_COINDESK_POLL_INTERVAL_MS: coerceInt(1000),

  // ── Circuit breaker defaults (Req 2.1) ────────────────────────────────────
  CB_FAILURE_THRESHOLD: coerceInt(1, 100),
  CB_RECOVERY_TIMEOUT_MS: coerceInt(1000, 3_600_000),

  // ── Retry config (Req 2.3) ────────────────────────────────────────────────
  RETRY_BASE_DELAY_MS: coerceInt(100, 60_000),
  RETRY_MULTIPLIER: coerceInt(1, 10),
  RETRY_MAX_ATTEMPTS: coerceInt(1, 10),

  // ── Worker concurrency ────────────────────────────────────────────────────
  WORKER_NORMALIZE_CONCURRENCY: coerceInt(1),
  WORKER_DEDUP_CONCURRENCY: coerceInt(1),
  WORKER_ENTITY_CONCURRENCY: coerceInt(1),
  WORKER_EVENT_CONCURRENCY: coerceInt(1),
  WORKER_SENTIMENT_CONCURRENCY: coerceInt(1),
  WORKER_IMPACT_CONCURRENCY: coerceInt(1),
  WORKER_FEATURE_CONCURRENCY: coerceInt(1),
  WORKER_EMBED_CONCURRENCY: coerceInt(1),

  // ── Backfill ──────────────────────────────────────────────────────────────
  BACKFILL_MAX_CONCURRENCY: coerceInt(1, 20),
  BACKFILL_MAX_LIVE_QUEUE_SHARE: z
    .string()
    .optional()
    .transform((v) => (v !== undefined && v !== '' ? parseFloat(v) : undefined))
    .pipe(z.number().min(0).max(1).optional()),

  // ── Embedding ─────────────────────────────────────────────────────────────
  EMBEDDING_MODEL: z.string().optional(),
  EMBEDDING_DIMENSION: coerceInt(1),
  EMBEDDING_API_KEY: z.string().optional(),

  // ── SSRF allowlist (Req 30.4) ─────────────────────────────────────────────
  ALLOWED_SOURCE_DOMAINS: z.string().optional(),

  // ── Data retention in days (Req 33.1) ────────────────────────────────────
  RETENTION_RAW_ARTICLES_DAYS: coerceInt(0),
  RETENTION_NORMALIZED_ARTICLES_DAYS: coerceInt(0),
  RETENTION_EVENTS_DAYS: coerceInt(0),
  RETENTION_TRAINING_SAMPLES_DAYS: coerceInt(0),

  // ── Node / server ─────────────────────────────────────────────────────────
  NODE_ENV: z.enum(['development', 'production', 'test']).optional().default('development'),
  PORT: coerceInt(1, 65535),
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .optional()
    .default('info'),
});

/** Inferred TypeScript type from the Zod schema (pre-defaults). */
export type EnvSchema = z.infer<typeof envSchema>;
