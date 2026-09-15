/**
 * Unit tests for the env.ts Zod schema.
 *
 * We test `envSchema` directly (not the live `env` export) so these tests
 * work without a real environment and without triggering the module-load parse.
 *
 * Covers:
 *  - Required fields throw on absence (Req 30.1)
 *  - FEATURE_VERSION / PIPELINE_VERSION semver validation (Req 33.4)
 *  - NEWS_SOURCE_*_ENABLED case-insensitive parsing (Req 1.7)
 *  - Numeric coercion and range enforcement
 *  - Default values applied for optional fields
 */

import { describe, it, expect } from 'vitest';
// Import the schema directly to avoid triggering the module-load parse in env.ts
import { envSchema } from './env.schema.js';

// ---------------------------------------------------------------------------
// Baseline valid input — all required fields present, sensible values
// ---------------------------------------------------------------------------
const VALID_BASE = {
  DATABASE_URL: 'postgresql://sentinel:pass@localhost:5432/sentinel_pulse',
  REDIS_URL: 'redis://localhost:6379',
  SENTINEL_API_KEY: 'test-api-key',
  DATA_SERVICE_URL: 'http://localhost:4000',
  DATA_SERVICE_API_KEY: 'data-service-key',
  SCRAPLING_URL: 'http://localhost:8001',
  FEATURE_VERSION: '1.0.0',
  PIPELINE_VERSION: '2.3.4',
};

// ---------------------------------------------------------------------------
// Required field validation
// ---------------------------------------------------------------------------
describe('required fields', () => {
  it('parses successfully with all required fields present', () => {
    const result = envSchema.safeParse(VALID_BASE);
    expect(result.success).toBe(true);
  });

  it.each([
    'DATABASE_URL',
    'REDIS_URL',
    'SENTINEL_API_KEY',
    'DATA_SERVICE_URL',
    'DATA_SERVICE_API_KEY',
    'SCRAPLING_URL',
    'FEATURE_VERSION',
    'PIPELINE_VERSION',
  ] as const)('fails when %s is absent', (field) => {
    const input = { ...VALID_BASE };
    delete (input as Record<string, string>)[field];
    const result = envSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Semver validation — Req 33.4
// ---------------------------------------------------------------------------
describe('semver validation (Req 33.4)', () => {
  it('accepts valid semver strings', () => {
    for (const version of ['1.0.0', '0.0.1', '10.20.30', '1.2.3']) {
      const result = envSchema.safeParse({
        ...VALID_BASE,
        FEATURE_VERSION: version,
        PIPELINE_VERSION: version,
      });
      expect(result.success, `${version} should be valid`).toBe(true);
    }
  });

  it.each(['1.2', '1', 'v1.0.0', '1.0.0-alpha', '1.0', '', 'latest', '1.2.3.4'])(
    'rejects non-semver string "%s" for FEATURE_VERSION',
    (bad) => {
      const result = envSchema.safeParse({ ...VALID_BASE, FEATURE_VERSION: bad });
      expect(result.success).toBe(false);
      if (!result.success) {
        const fieldErrors = result.error.errors.filter((e) =>
          e.path.includes('FEATURE_VERSION'),
        );
        expect(fieldErrors.length).toBeGreaterThan(0);
      }
    },
  );

  it('rejects non-semver string for PIPELINE_VERSION', () => {
    const result = envSchema.safeParse({ ...VALID_BASE, PIPELINE_VERSION: '1.0' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NEWS_SOURCE_*_ENABLED parsing — Req 1.7
// ---------------------------------------------------------------------------
describe('source enabled state parsing (Req 1.7)', () => {
  it('parses "true" (lowercase) as enabled', () => {
    const result = envSchema.safeParse({
      ...VALID_BASE,
      NEWS_SOURCE_REUTERS_ENABLED: 'true',
    });
    expect(result.success).toBe(true);
    expect(result.data?.NEWS_SOURCE_REUTERS_ENABLED).toBe(true);
  });

  it('parses "TRUE" (uppercase) as enabled', () => {
    const result = envSchema.safeParse({
      ...VALID_BASE,
      NEWS_SOURCE_REUTERS_ENABLED: 'TRUE',
    });
    expect(result.data?.NEWS_SOURCE_REUTERS_ENABLED).toBe(true);
  });

  it('parses "True" (mixed case) as enabled', () => {
    const result = envSchema.safeParse({
      ...VALID_BASE,
      NEWS_SOURCE_REUTERS_ENABLED: 'True',
    });
    expect(result.data?.NEWS_SOURCE_REUTERS_ENABLED).toBe(true);
  });

  it.each(['false', 'FALSE', '1', 'yes', 'on', '', 'enabled'])(
    'treats "%s" as disabled (not "true")',
    (val) => {
      const result = envSchema.safeParse({
        ...VALID_BASE,
        NEWS_SOURCE_REUTERS_ENABLED: val,
      });
      expect(result.success).toBe(true);
      expect(result.data?.NEWS_SOURCE_REUTERS_ENABLED).toBe(false);
    },
  );

  it('treats absent NEWS_SOURCE_*_ENABLED as disabled', () => {
    const result = envSchema.safeParse(VALID_BASE);
    expect(result.data?.NEWS_SOURCE_REUTERS_ENABLED).toBe(false);
    expect(result.data?.NEWS_SOURCE_BLOOMBERG_ENABLED).toBe(false);
    expect(result.data?.NEWS_SOURCE_COINDESK_ENABLED).toBe(false);
  });

  it('independently enables each source', () => {
    const result = envSchema.safeParse({
      ...VALID_BASE,
      NEWS_SOURCE_REUTERS_ENABLED: 'true',
      NEWS_SOURCE_MONEYCONTROL_ENABLED: 'true',
      NEWS_SOURCE_ECONOMICTIMES_ENABLED: 'false',
      NEWS_SOURCE_BLOOMBERG_ENABLED: 'true',
      NEWS_SOURCE_FINANCIALTIMES_ENABLED: 'false',
      NEWS_SOURCE_COINDESK_ENABLED: 'true',
    });
    expect(result.data?.NEWS_SOURCE_REUTERS_ENABLED).toBe(true);
    expect(result.data?.NEWS_SOURCE_MONEYCONTROL_ENABLED).toBe(true);
    expect(result.data?.NEWS_SOURCE_ECONOMICTIMES_ENABLED).toBe(false);
    expect(result.data?.NEWS_SOURCE_BLOOMBERG_ENABLED).toBe(true);
    expect(result.data?.NEWS_SOURCE_FINANCIALTIMES_ENABLED).toBe(false);
    expect(result.data?.NEWS_SOURCE_COINDESK_ENABLED).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Numeric coercion and range validation
// ---------------------------------------------------------------------------
describe('numeric coercion and range validation', () => {
  it('coerces string numbers to integers', () => {
    const result = envSchema.safeParse({
      ...VALID_BASE,
      CB_FAILURE_THRESHOLD: '5',
      CB_RECOVERY_TIMEOUT_MS: '60000',
      RETRY_BASE_DELAY_MS: '1000',
      RETRY_MULTIPLIER: '2',
      RETRY_MAX_ATTEMPTS: '3',
      PORT: '3000',
    });
    expect(result.success).toBe(true);
    expect(result.data?.CB_FAILURE_THRESHOLD).toBe(5);
    expect(result.data?.CB_RECOVERY_TIMEOUT_MS).toBe(60_000);
    expect(result.data?.RETRY_BASE_DELAY_MS).toBe(1_000);
    expect(result.data?.RETRY_MULTIPLIER).toBe(2);
    expect(result.data?.RETRY_MAX_ATTEMPTS).toBe(3);
    expect(result.data?.PORT).toBe(3000);
  });

  it('rejects CB_FAILURE_THRESHOLD = 0 (below min 1)', () => {
    const result = envSchema.safeParse({ ...VALID_BASE, CB_FAILURE_THRESHOLD: '0' });
    expect(result.success).toBe(false);
  });

  it('rejects CB_FAILURE_THRESHOLD = 101 (above max 100)', () => {
    const result = envSchema.safeParse({ ...VALID_BASE, CB_FAILURE_THRESHOLD: '101' });
    expect(result.success).toBe(false);
  });

  it('accepts CB_FAILURE_THRESHOLD at boundary values (1 and 100)', () => {
    const r1 = envSchema.safeParse({ ...VALID_BASE, CB_FAILURE_THRESHOLD: '1' });
    expect(r1.success).toBe(true);
    expect(r1.data?.CB_FAILURE_THRESHOLD).toBe(1);

    const r2 = envSchema.safeParse({ ...VALID_BASE, CB_FAILURE_THRESHOLD: '100' });
    expect(r2.success).toBe(true);
    expect(r2.data?.CB_FAILURE_THRESHOLD).toBe(100);
  });

  it('rejects CB_RECOVERY_TIMEOUT_MS = 999 (below min 1000)', () => {
    const result = envSchema.safeParse({ ...VALID_BASE, CB_RECOVERY_TIMEOUT_MS: '999' });
    expect(result.success).toBe(false);
  });

  it('rejects CB_RECOVERY_TIMEOUT_MS = 3600001 (above max 3600000)', () => {
    const result = envSchema.safeParse({ ...VALID_BASE, CB_RECOVERY_TIMEOUT_MS: '3600001' });
    expect(result.success).toBe(false);
  });

  it('rejects RETRY_MULTIPLIER = 0 (below min 1)', () => {
    const result = envSchema.safeParse({ ...VALID_BASE, RETRY_MULTIPLIER: '0' });
    expect(result.success).toBe(false);
  });

  it('rejects RETRY_MULTIPLIER = 11 (above max 10)', () => {
    const result = envSchema.safeParse({ ...VALID_BASE, RETRY_MULTIPLIER: '11' });
    expect(result.success).toBe(false);
  });

  it('rejects BACKFILL_MAX_CONCURRENCY = 21 (above max 20)', () => {
    const result = envSchema.safeParse({ ...VALID_BASE, BACKFILL_MAX_CONCURRENCY: '21' });
    expect(result.success).toBe(false);
  });

  it('coerces worker concurrency fields', () => {
    const result = envSchema.safeParse({
      ...VALID_BASE,
      WORKER_NORMALIZE_CONCURRENCY: '4',
      WORKER_DEDUP_CONCURRENCY: '2',
      WORKER_ENTITY_CONCURRENCY: '4',
    });
    expect(result.data?.WORKER_NORMALIZE_CONCURRENCY).toBe(4);
    expect(result.data?.WORKER_DEDUP_CONCURRENCY).toBe(2);
  });

  it('treats absent optional numeric fields as undefined (pre-default)', () => {
    const result = envSchema.safeParse(VALID_BASE);
    expect(result.success).toBe(true);
    // Before buildEnv() defaults are applied, schema returns undefined for absent optionals
    expect(result.data?.CB_FAILURE_THRESHOLD).toBeUndefined();
    expect(result.data?.PORT).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// NODE_ENV and LOG_LEVEL defaults
// ---------------------------------------------------------------------------
describe('NODE_ENV and LOG_LEVEL defaults', () => {
  it('defaults NODE_ENV to "development"', () => {
    const result = envSchema.safeParse(VALID_BASE);
    expect(result.data?.NODE_ENV).toBe('development');
  });

  it('defaults LOG_LEVEL to "info"', () => {
    const result = envSchema.safeParse(VALID_BASE);
    expect(result.data?.LOG_LEVEL).toBe('info');
  });

  it('accepts valid NODE_ENV values', () => {
    for (const env of ['development', 'production', 'test'] as const) {
      const result = envSchema.safeParse({ ...VALID_BASE, NODE_ENV: env });
      expect(result.data?.NODE_ENV).toBe(env);
    }
  });

  it('rejects invalid NODE_ENV', () => {
    const result = envSchema.safeParse({ ...VALID_BASE, NODE_ENV: 'staging' });
    expect(result.success).toBe(false);
  });

  it('accepts valid LOG_LEVEL values', () => {
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
      const result = envSchema.safeParse({ ...VALID_BASE, LOG_LEVEL: level });
      expect(result.data?.LOG_LEVEL).toBe(level);
    }
  });
});

// ---------------------------------------------------------------------------
// Source-specific optional fields
// ---------------------------------------------------------------------------
describe('source-specific optional fields', () => {
  it('accepts optional API key for Bloomberg', () => {
    const result = envSchema.safeParse({
      ...VALID_BASE,
      NEWS_SOURCE_BLOOMBERG_ENABLED: 'true',
      NEWS_SOURCE_BLOOMBERG_BASE_URL: 'https://www.bloomberg.com',
      NEWS_SOURCE_BLOOMBERG_POLL_INTERVAL_MS: '120000',
      NEWS_SOURCE_BLOOMBERG_API_KEY: 'bloomberg-secret',
    });
    expect(result.success).toBe(true);
    expect(result.data?.NEWS_SOURCE_BLOOMBERG_API_KEY).toBe('bloomberg-secret');
  });

  it('accepts absent API key for Bloomberg', () => {
    const result = envSchema.safeParse({
      ...VALID_BASE,
      NEWS_SOURCE_BLOOMBERG_ENABLED: 'true',
      NEWS_SOURCE_BLOOMBERG_BASE_URL: 'https://www.bloomberg.com',
      NEWS_SOURCE_BLOOMBERG_POLL_INTERVAL_MS: '120000',
    });
    expect(result.success).toBe(true);
    expect(result.data?.NEWS_SOURCE_BLOOMBERG_API_KEY).toBeUndefined();
  });

  it('coerces poll interval to number', () => {
    const result = envSchema.safeParse({
      ...VALID_BASE,
      NEWS_SOURCE_REUTERS_POLL_INTERVAL_MS: '60000',
    });
    expect(result.data?.NEWS_SOURCE_REUTERS_POLL_INTERVAL_MS).toBe(60_000);
  });
});

// ---------------------------------------------------------------------------
// ALLOWED_SOURCE_DOMAINS passthrough
// ---------------------------------------------------------------------------
describe('ALLOWED_SOURCE_DOMAINS', () => {
  it('stores the raw comma-separated string', () => {
    const domains = 'feeds.reuters.com,moneycontrol.com,bloomberg.com';
    const result = envSchema.safeParse({ ...VALID_BASE, ALLOWED_SOURCE_DOMAINS: domains });
    expect(result.data?.ALLOWED_SOURCE_DOMAINS).toBe(domains);
  });

  it('allows absent ALLOWED_SOURCE_DOMAINS', () => {
    const result = envSchema.safeParse(VALID_BASE);
    expect(result.data?.ALLOWED_SOURCE_DOMAINS).toBeUndefined();
  });
});
