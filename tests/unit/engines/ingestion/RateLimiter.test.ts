import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter } from '../../../../src/engines/ingestion/RateLimiter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Advance fake timers and also mock Date.now() to keep them consistent. */
function advanceTime(ms: number) {
  vi.advanceTimersByTime(ms);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Constructor / interval calculation
  // -------------------------------------------------------------------------

  describe('constructor — minIntervalMs calculation', () => {
    it('sets interval to floor(60_000 / RPM) for a positive RPM', () => {
      const limiter = new RateLimiter('reuters', 30);
      expect(limiter.intervalMs).toBe(2_000); // floor(60000 / 30)
    });

    it('rounds down when RPM does not divide evenly', () => {
      const limiter = new RateLimiter('bloomberg', 7);
      expect(limiter.intervalMs).toBe(8_571); // floor(60000 / 7)
    });

    it('sets interval to 0 when RPM is null (no rate limiting)', () => {
      const limiter = new RateLimiter('ft', null);
      expect(limiter.intervalMs).toBe(0);
    });

    it('sets interval to 0 when RPM is 0 (no rate limiting)', () => {
      const limiter = new RateLimiter('coindesk', 0);
      expect(limiter.intervalMs).toBe(0);
    });

    it('sets interval to 0 when RPM is negative (no rate limiting)', () => {
      const limiter = new RateLimiter('moneycontrol', -10);
      expect(limiter.intervalMs).toBe(0);
    });

    it('exposes the source identifier', () => {
      const limiter = new RateLimiter('economic-times', 60);
      expect(limiter.source).toBe('economic-times');
    });
  });

  // -------------------------------------------------------------------------
  // getWaitMs
  // -------------------------------------------------------------------------

  describe('getWaitMs()', () => {
    it('returns 0 before any request has been recorded', () => {
      const limiter = new RateLimiter('reuters', 60);
      expect(limiter.getWaitMs()).toBe(0);
    });

    it('returns 0 when no rate limiting is configured (null RPM)', () => {
      const limiter = new RateLimiter('reuters', null);
      limiter.recordRequest();
      expect(limiter.getWaitMs()).toBe(0);
    });

    it('returns 0 when no rate limiting is configured (zero RPM)', () => {
      const limiter = new RateLimiter('reuters', 0);
      limiter.recordRequest();
      expect(limiter.getWaitMs()).toBe(0);
    });

    it('returns remaining wait time immediately after a request', () => {
      const limiter = new RateLimiter('reuters', 60); // 1_000 ms interval
      limiter.recordRequest();
      // No time has elapsed yet
      expect(limiter.getWaitMs()).toBe(1_000);
    });

    it('decreases as time passes', () => {
      const limiter = new RateLimiter('reuters', 60); // 1_000 ms interval
      limiter.recordRequest();
      advanceTime(400);
      const wait = limiter.getWaitMs();
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(600);
    });

    it('returns 0 once the full interval has elapsed', () => {
      const limiter = new RateLimiter('reuters', 60); // 1_000 ms interval
      limiter.recordRequest();
      advanceTime(1_000);
      expect(limiter.getWaitMs()).toBe(0);
    });

    it('returns 0 after more than the interval has elapsed', () => {
      const limiter = new RateLimiter('reuters', 60); // 1_000 ms interval
      limiter.recordRequest();
      advanceTime(2_000);
      expect(limiter.getWaitMs()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // recordRequest
  // -------------------------------------------------------------------------

  describe('recordRequest()', () => {
    it('resets the wait timer on subsequent calls', () => {
      const limiter = new RateLimiter('reuters', 60); // 1_000 ms
      limiter.recordRequest();
      advanceTime(1_000); // interval fully elapsed

      // Record a second request — clock restarts
      limiter.recordRequest();
      expect(limiter.getWaitMs()).toBe(1_000);
    });
  });

  // -------------------------------------------------------------------------
  // throttle()
  // -------------------------------------------------------------------------

  describe('throttle()', () => {
    it('resolves immediately when no rate limiting is configured', async () => {
      const limiter = new RateLimiter('reuters', null);
      const start = Date.now();
      await limiter.throttle();
      // With fake timers and no wait, should complete synchronously-ish
      expect(Date.now() - start).toBe(0);
    });

    it('resolves immediately on the first call (no previous request)', async () => {
      const limiter = new RateLimiter('reuters', 60); // 1_000 ms interval
      // No prior recordRequest — no wait required
      const throttlePromise = limiter.throttle();
      // Flush microtask queue without advancing timers; should already resolve
      await Promise.resolve();
      vi.runAllTimers();
      await throttlePromise;
      // After throttle(), the request is recorded
      expect(limiter.getWaitMs()).toBeGreaterThan(0);
    });

    it('waits the required interval before resolving', async () => {
      const limiter = new RateLimiter('reuters', 60); // 1_000 ms interval
      limiter.recordRequest(); // mark first request

      const throttlePromise = limiter.throttle();

      // Advance time by the full interval so the internal setTimeout fires
      vi.runAllTimers();
      await throttlePromise;

      // Should now be within a fresh window
      expect(limiter.getWaitMs()).toBeLessThanOrEqual(1_000);
      expect(limiter.getWaitMs()).toBeGreaterThan(0);
    });

    it('records the request after the wait so the next getWaitMs is correct', async () => {
      const limiter = new RateLimiter('reuters', 60); // 1_000 ms interval
      limiter.recordRequest();

      const throttlePromise = limiter.throttle();
      vi.runAllTimers();
      await throttlePromise;

      // A second immediate call should again show a positive wait
      expect(limiter.getWaitMs()).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Req 2.4 — boundary / edge cases
  // -------------------------------------------------------------------------

  describe('Req 2.4 compliance', () => {
    it('RPM=1 gives 60_000 ms interval', () => {
      const limiter = new RateLimiter('slow-source', 1);
      expect(limiter.intervalMs).toBe(60_000);
    });

    it('RPM=120 gives 500 ms interval', () => {
      const limiter = new RateLimiter('fast-source', 120);
      expect(limiter.intervalMs).toBe(500);
    });

    it('very high RPM (10_000) gives 6 ms interval', () => {
      const limiter = new RateLimiter('ultra-source', 10_000);
      expect(limiter.intervalMs).toBe(6); // floor(60000 / 10000) = 6
    });

    it('negative RPM applies no rate limiting', () => {
      const limiter = new RateLimiter('source', -1);
      limiter.recordRequest();
      expect(limiter.getWaitMs()).toBe(0);
    });
  });
});
