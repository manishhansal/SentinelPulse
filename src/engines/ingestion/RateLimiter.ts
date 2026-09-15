/**
 * Per-source token-bucket style rate limiter.
 *
 * Enforces a minimum interval of floor(60_000 / RPM) milliseconds between
 * consecutive requests to a single source.
 *
 * Rules (Req 2.4):
 * - If getRateLimit() returns null, zero, or a negative value → no rate limiting.
 * - Minimum interval = Math.floor(60_000 / RPM) ms.
 */
export class RateLimiter {
  private lastRequestAt: Date | null = null;
  private readonly minIntervalMs: number;

  /**
   * @param sourceId        Identifier of the news source (used for logging/tracing).
   * @param requestsPerMinute Maximum allowed requests per minute from the adapter's
   *                          getRateLimit(). Null, zero, or any negative value disables
   *                          rate limiting entirely.
   */
  constructor(
    private readonly sourceId: string,
    requestsPerMinute: number | null,
  ) {
    if (
      requestsPerMinute === null ||
      requestsPerMinute <= 0
    ) {
      // No rate limiting requested
      this.minIntervalMs = 0;
    } else {
      this.minIntervalMs = Math.floor(60_000 / requestsPerMinute);
    }
  }

  /**
   * Returns the number of milliseconds to wait before the next request is
   * allowed.  Returns 0 when no rate limiting is configured or when enough
   * time has already elapsed since the last recorded request.
   */
  getWaitMs(): number {
    if (this.minIntervalMs === 0 || this.lastRequestAt === null) {
      return 0;
    }

    const elapsedMs = Date.now() - this.lastRequestAt.getTime();
    const remaining = this.minIntervalMs - elapsedMs;

    return remaining > 0 ? remaining : 0;
  }

  /**
   * Records that a request was just made to this source.
   * Must be called immediately before (or immediately after) issuing each
   * outbound HTTP request so that the next getWaitMs() reflects the correct
   * elapsed time.
   */
  recordRequest(): void {
    this.lastRequestAt = new Date();
  }

  /**
   * Waits for the required interval (if any) and then records the request.
   * Callers should await this method before issuing each outbound request.
   *
   * ```ts
   * await rateLimiter.throttle();
   * const articles = await adapter.fetchLatest(options);
   * ```
   */
  async throttle(): Promise<void> {
    const waitMs = this.getWaitMs();

    if (waitMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    }

    this.recordRequest();
  }

  // ---------------------------------------------------------------------------
  // Accessors (useful for testing and observability)
  // ---------------------------------------------------------------------------

  /** The source identifier this limiter is associated with. */
  get source(): string {
    return this.sourceId;
  }

  /** The calculated minimum interval between requests in milliseconds. */
  get intervalMs(): number {
    return this.minIntervalMs;
  }
}
