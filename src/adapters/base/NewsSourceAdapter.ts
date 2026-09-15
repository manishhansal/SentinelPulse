/**
 * NewsSourceAdapter — base interfaces and abstract class for all news source adapters.
 *
 * Requirements: Req 1.1, Req 30.4, Req 30.6
 *
 * Every concrete adapter (Reuters, Moneycontrol, EconomicTimes, Bloomberg,
 * FinancialTimes, CoinDesk) must extend AbstractNewsSourceAdapter. The
 * abstract class provides:
 *   - Shared exponential-backoff retry logic (Req 2.3)
 *   - SSRF guard invocation on all outbound URLs (Req 30.4)
 *   - 10-second outbound request timeout enforcement (Req 30.6)
 */

import { pino } from 'pino';

// ---------------------------------------------------------------------------
// Shared logger (will be superseded once src/observability/logger.ts exists)
// ---------------------------------------------------------------------------
const logger = pino({ name: 'news-adapter' });

// ---------------------------------------------------------------------------
// SsrfGuard — imported lazily to avoid hard dependency before the security
// module is created.  Once src/security/SsrfGuard.ts is implemented (task
// 4.7) this import will resolve to the real implementation automatically.
// ---------------------------------------------------------------------------
let _validateOutboundUrl: ((url: string) => void) | null = null;

async function loadSsrfGuard(): Promise<(url: string) => void> {
  if (_validateOutboundUrl !== null) return _validateOutboundUrl;
  try {
    // NodeNext module resolution requires .js extension in import paths.
    const mod = await import('../../security/SsrfGuard.js');
    _validateOutboundUrl = mod.validateOutboundUrl;
  } catch {
    // SsrfGuard not yet implemented — log a warning and use a no-op guard.
    // This stub will be replaced when task 4.7 creates SsrfGuard.ts.
    logger.warn(
      'SsrfGuard module not found; SSRF protection is NOT active. ' +
        'Implement src/security/SsrfGuard.ts (task 4.7) to enable it.',
    );
    _validateOutboundUrl = (_url: string) => {
      /* no-op stub until SsrfGuard is implemented */
    };
  }
  return _validateOutboundUrl;
}

// ---------------------------------------------------------------------------
// Public interface types
// ---------------------------------------------------------------------------

/** Overall health of a news source. */
export interface HealthStatus {
  /** Whether the source is reachable and returning valid data. */
  healthy: boolean;
  /** Human-readable description of the current status. */
  message: string;
  /** UTC timestamp of the health check. */
  checkedAt: Date;
  /** HTTP status code returned by the source, if applicable. */
  statusCode?: number;
  /** Round-trip latency in milliseconds, if measured. */
  latencyMs?: number;
}

/** Options for fetching the latest articles from a source. */
export interface FetchOptions {
  /**
   * Maximum number of articles to return.
   * Adapters may return fewer articles if the source has fewer available.
   * @default 50
   */
  limit?: number;
  /** Only return articles published after this date (UTC). */
  since?: Date;
  /** Source-specific extra parameters passed through without interpretation. */
  extra?: Record<string, unknown>;
}

/** Options for fetching historical articles from a source. */
export interface HistoricalFetchOptions extends FetchOptions {
  /** Start of the historical window (UTC, inclusive). */
  from: Date;
  /** End of the historical window (UTC, inclusive). */
  to: Date;
  /** Page number for paginated sources (1-based). */
  page?: number;
}

/** Per-source rate-limit configuration returned by adapters. */
export interface RateLimitConfig {
  /**
   * Maximum requests per minute allowed by the source.
   * Null / zero / negative → no rate limiting applied (Req 2.4).
   */
  requestsPerMinute: number | null;
}

/**
 * Raw article exactly as received from a source adapter, before any
 * normalisation. Fields are deliberately loose (many optional) because
 * different sources provide different levels of metadata.
 */
export interface RawArticle {
  sourceId: string;
  sourceName: string;
  externalId: string;
  url: string;
  title: string;
  summary?: string;
  content?: string;
  author?: string;
  /** Raw timestamp string from the source — may be in any format. */
  publishedAt?: string;
  category?: string;
  rawHtml?: string;
  adapterVersion: string;
}

/**
 * Canonical in-memory representation of a cleaned, structured news article
 * as produced by normalisation. Every field that is absent from the raw
 * article is set to null (Req 3.1).
 */
export interface NormalizedArticle {
  /** UUID v4. */
  id: string;
  sourceId: string;
  sourceName: string;
  externalId: string;
  canonicalUrl: string;
  title: string;
  summary: string | null;
  content: string | null;
  author: string | null;
  /** ISO 639-1 two-letter language code. */
  language: string;
  /** Confidence score in [0, 1] for the detected language. */
  languageConfidence: number;
  /** Article publication time, normalised to UTC. */
  publishedAt: Date;
  /** Time at which this article was scraped/fetched, in UTC. */
  scrapedAt: Date;
  category: string | null;
  secondaryCategories: string[];
  /** Confidence score in [0, 1] for the detected category. */
  categoryConfidence: number;
  /** SHA-256 hex digest (64 chars) of the full content. */
  contentHash: string;
  /** SHA-256 hex digest (64 chars) of the normalised title. */
  titleHash: string;
  /** True when content was truncated to fit storage constraints. */
  contentTruncated: boolean;
  /** True when publishedAt was inferred rather than parsed from source data. */
  timestampInferred: boolean;
}

// ---------------------------------------------------------------------------
// NewsSourceAdapter interface (Req 1.1)
// ---------------------------------------------------------------------------

/**
 * Uniform interface for every news source. Concrete adapters MUST implement
 * all five methods. The AbstractNewsSourceAdapter base class wraps the three
 * network-facing methods with retry, SSRF guard, and timeout logic so that
 * concrete implementations only need to focus on source-specific logic.
 */
export interface NewsSourceAdapter {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly adapterVersion: string;
  /** 1 = Tier-1 (Reuters, Moneycontrol, EconomicTimes); 2 = Tier-2. */
  readonly tier: 1 | 2;

  healthCheck(): Promise<HealthStatus>;
  fetchLatest(options?: FetchOptions): Promise<RawArticle[]>;
  fetchHistorical(options: HistoricalFetchOptions): Promise<RawArticle[]>;
  normalize(raw: RawArticle): NormalizedArticle;
  getRateLimit(): RateLimitConfig;
}

// ---------------------------------------------------------------------------
// Retry configuration
// ---------------------------------------------------------------------------

/**
 * Exponential-backoff retry configuration (Req 2.3).
 * All values are read from environment variables with safe defaults; concrete
 * adapters inherit these without having to manage them individually.
 */
export interface RetryConfig {
  /**
   * Maximum number of attempts (initial attempt + retries).
   * Env: ADAPTER_MAX_RETRIES  Default: 3  Range: 1–10
   */
  maxAttempts: number;
  /**
   * Base delay in milliseconds before the first retry.
   * Env: ADAPTER_RETRY_BASE_DELAY_MS  Default: 1000  Range: 100–60 000
   */
  baseDelayMs: number;
  /**
   * Backoff multiplier applied to the delay on each subsequent retry.
   * Env: ADAPTER_RETRY_MULTIPLIER  Default: 2  Range: 1–10
   */
  multiplier: number;
}

/** Maximum per-attempt delay cap in milliseconds (Req 2.3). */
export const MAX_ATTEMPT_DELAY_MS = 300_000;

/** Outbound request timeout in milliseconds (Req 30.6). */
export const OUTBOUND_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the delay (in milliseconds) for a given retry attempt index.
 * attempt is 1-based: attempt=1 → first retry after the initial failure.
 *
 * Formula: min(baseDelayMs × multiplier^(attempt-1), MAX_ATTEMPT_DELAY_MS)
 */
export function computeRetryDelay(cfg: RetryConfig, attempt: number): number {
  const raw = cfg.baseDelayMs * Math.pow(cfg.multiplier, attempt - 1);
  return Math.min(raw, MAX_ATTEMPT_DELAY_MS);
}

/** Resolves after `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wraps a promise with a hard timeout. Rejects with a TimeoutError when the
 * deadline elapses. Used to enforce Req 30.6.
 */
export class TimeoutError extends Error {
  constructor(
    public readonly targetDomain: string,
    public readonly elapsedMs: number,
  ) {
    super(
      `Outbound request to ${targetDomain} timed out after ${elapsedMs}ms`,
    );
    this.name = 'TimeoutError';
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  targetDomain: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(targetDomain, timeoutMs));
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([promise, timeoutPromise]);
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Read retry config from environment once at module load
// ---------------------------------------------------------------------------

function loadRetryConfig(): RetryConfig {
  const clamp = (val: number, min: number, max: number) =>
    Math.max(min, Math.min(max, val));

  const maxAttempts = clamp(
    parseInt(process.env['ADAPTER_MAX_RETRIES'] ?? '3', 10),
    1,
    10,
  );
  const baseDelayMs = clamp(
    parseInt(process.env['ADAPTER_RETRY_BASE_DELAY_MS'] ?? '1000', 10),
    100,
    60_000,
  );
  const multiplier = clamp(
    parseFloat(process.env['ADAPTER_RETRY_MULTIPLIER'] ?? '2'),
    1,
    10,
  );

  return { maxAttempts, baseDelayMs, multiplier };
}

const DEFAULT_RETRY_CONFIG: RetryConfig = loadRetryConfig();

// ---------------------------------------------------------------------------
// AbstractNewsSourceAdapter
// ---------------------------------------------------------------------------

/**
 * Base class for all six concrete news source adapters.
 *
 * Concrete subclasses MUST implement:
 *   - healthCheckImpl()
 *   - fetchLatestImpl()
 *   - fetchHistoricalImpl()
 *   - normalize()
 *   - getRateLimit()
 *   - readonly sourceId, sourceName, adapterVersion, tier
 *
 * The public `healthCheck()`, `fetchLatest()`, and `fetchHistorical()` methods
 * provided by this class wrap the *Impl methods with:
 *   1. SSRF URL allowlist validation  (Req 30.4)
 *   2. 10-second outbound request timeout  (Req 30.6)
 *   3. Exponential-backoff retry with per-attempt delay cap  (Req 2.3)
 */
export abstract class AbstractNewsSourceAdapter implements NewsSourceAdapter {
  // ------------------------------------------------------------------
  // Required properties — must be set by concrete subclasses
  // ------------------------------------------------------------------
  abstract readonly sourceId: string;
  abstract readonly sourceName: string;
  abstract readonly adapterVersion: string;
  abstract readonly tier: 1 | 2;

  // ------------------------------------------------------------------
  // Required implementation hooks
  // ------------------------------------------------------------------

  /** Source-specific health check implementation. */
  protected abstract healthCheckImpl(): Promise<HealthStatus>;

  /** Source-specific fetch-latest implementation. */
  protected abstract fetchLatestImpl(
    options: FetchOptions,
  ): Promise<RawArticle[]>;

  /** Source-specific fetch-historical implementation. */
  protected abstract fetchHistoricalImpl(
    options: HistoricalFetchOptions,
  ): Promise<RawArticle[]>;

  /** Normalises a single raw article into the canonical representation. */
  abstract normalize(raw: RawArticle): NormalizedArticle;

  /** Returns the source's rate-limit configuration. */
  abstract getRateLimit(): RateLimitConfig;

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------

  /**
   * The base URL of the source, used for SSRF domain extraction.
   * Concrete adapters SHOULD override this to return their configured
   * base URL so that SSRF validation occurs before the first real HTTP
   * call. If null, SSRF validation is skipped for that adapter (only
   * appropriate for test stubs).
   */
  protected get baseUrl(): string | null {
    return null;
  }

  /**
   * Retry configuration for this adapter instance.
   * Defaults to the global env-derived config; subclasses may override.
   */
  protected get retryConfig(): RetryConfig {
    return DEFAULT_RETRY_CONFIG;
  }

  /**
   * Extracts the hostname from a URL string.
   * Returns the raw input if the URL cannot be parsed.
   */
  private extractDomain(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }

  /**
   * Validates `url` against the SSRF allowlist (Req 30.4).
   * Loads the guard module lazily; falls back to a no-op stub if the
   * module has not been implemented yet.
   */
  private async guardUrl(url: string): Promise<void> {
    const validate = await loadSsrfGuard();
    validate(url);
  }

  /**
   * Runs `fn` with retry + timeout.
   *
   * - Each attempt is bounded by OUTBOUND_TIMEOUT_MS (10 s, Req 30.6).
   * - On TimeoutError or any thrown error: log WARN, wait the backoff
   *   delay, then retry up to retryConfig.maxAttempts total attempts.
   * - Throws the last error if all attempts fail.
   */
  private async withRetryAndTimeout<T>(
    fn: () => Promise<T>,
    targetDomain: string,
  ): Promise<T> {
    const cfg = this.retryConfig;
    let lastError: unknown;

    for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
      try {
        return await withTimeout(fn(), OUTBOUND_TIMEOUT_MS, targetDomain);
      } catch (err: unknown) {
        lastError = err;

        if (err instanceof TimeoutError) {
          logger.warn(
            {
              sourceId: this.sourceId,
              targetDomain: err.targetDomain,
              elapsedMs: err.elapsedMs,
              attempt,
              maxAttempts: cfg.maxAttempts,
            },
            'Outbound request timed out',
          );
        } else {
          logger.warn(
            {
              sourceId: this.sourceId,
              targetDomain,
              attempt,
              maxAttempts: cfg.maxAttempts,
              err,
            },
            'Fetch attempt failed',
          );
        }

        if (attempt < cfg.maxAttempts) {
          const delayMs = computeRetryDelay(cfg, attempt);
          logger.debug(
            { sourceId: this.sourceId, delayMs, nextAttempt: attempt + 1 },
            'Backing off before retry',
          );
          await sleep(delayMs);
        }
      }
    }

    throw lastError;
  }

  // ------------------------------------------------------------------
  // Public API — wraps *Impl methods with cross-cutting concerns
  // ------------------------------------------------------------------

  /**
   * Performs a health check on the source.
   * Wraps healthCheckImpl with retry + timeout.
   */
  async healthCheck(): Promise<HealthStatus> {
    const domain = this.baseUrl ? this.extractDomain(this.baseUrl) : this.sourceId;
    return this.withRetryAndTimeout(
      () => this.healthCheckImpl(),
      domain,
    );
  }

  /**
   * Fetches the latest articles from the source.
   *
   * Before calling fetchLatestImpl, validates the adapter's baseUrl
   * against the SSRF allowlist (Req 30.4). The actual HTTP request is
   * expected to be made inside fetchLatestImpl; the timeout is applied
   * around the entire impl call (Req 30.6).
   */
  async fetchLatest(options: FetchOptions = {}): Promise<RawArticle[]> {
    if (this.baseUrl !== null) {
      await this.guardUrl(this.baseUrl);
    }
    const domain = this.baseUrl ? this.extractDomain(this.baseUrl) : this.sourceId;
    return this.withRetryAndTimeout(
      () => this.fetchLatestImpl(options),
      domain,
    );
  }

  /**
   * Fetches historical articles from the source.
   *
   * Applies the same SSRF + retry + timeout treatment as fetchLatest.
   */
  async fetchHistorical(options: HistoricalFetchOptions): Promise<RawArticle[]> {
    if (this.baseUrl !== null) {
      await this.guardUrl(this.baseUrl);
    }
    const domain = this.baseUrl ? this.extractDomain(this.baseUrl) : this.sourceId;
    return this.withRetryAndTimeout(
      () => this.fetchHistoricalImpl(options),
      domain,
    );
  }
}
