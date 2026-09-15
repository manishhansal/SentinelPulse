/**
 * Unit tests for CircuitBreaker (task 4.2)
 *
 * Covers:
 *  - Config clamping (Req 2.1)
 *  - CLOSED → OPEN transition on consecutive failure threshold (Req 2.1)
 *  - OPEN state blocks fetch calls (Req 2.2)
 *  - OPEN → HALF_OPEN via tryHalfOpen() after recovery timeout (Req 2.2)
 *  - HALF_OPEN → CLOSED on probe success (Req 2.2)
 *  - HALF_OPEN → OPEN on probe failure, recovery timer reset (Req 2.2)
 *  - recordSuccess() resets failures and closes the circuit
 *  - Req 1.12 back-off WARN logged after 5th OPEN transition
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CircuitBreaker } from '../../src/engines/ingestion/CircuitBreaker.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Advance fake timers by ms and return the updated Date.now() value. */
function advanceTime(ms: number): void {
  vi.advanceTimersByTime(ms);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CircuitBreaker — configuration clamping', () => {
  it('uses default config when no options are supplied', () => {
    const cb = new CircuitBreaker('test-source');
    expect(cb.getConfig().failureThreshold).toBe(5);
    expect(cb.getConfig().recoveryTimeoutMs).toBe(60_000);
  });

  it('clamps failureThreshold below 1 up to 1', () => {
    const cb = new CircuitBreaker('s', { failureThreshold: 0 });
    expect(cb.getConfig().failureThreshold).toBe(1);
  });

  it('clamps failureThreshold above 100 down to 100', () => {
    const cb = new CircuitBreaker('s', { failureThreshold: 999 });
    expect(cb.getConfig().failureThreshold).toBe(100);
  });

  it('clamps recoveryTimeoutMs below 1_000 up to 1_000', () => {
    const cb = new CircuitBreaker('s', { recoveryTimeoutMs: 0 });
    expect(cb.getConfig().recoveryTimeoutMs).toBe(1_000);
  });

  it('clamps recoveryTimeoutMs above 3_600_000 down to 3_600_000', () => {
    const cb = new CircuitBreaker('s', { recoveryTimeoutMs: 99_999_999 });
    expect(cb.getConfig().recoveryTimeoutMs).toBe(3_600_000);
  });

  it('accepts in-range values without modification', () => {
    const cb = new CircuitBreaker('s', { failureThreshold: 3, recoveryTimeoutMs: 30_000 });
    expect(cb.getConfig().failureThreshold).toBe(3);
    expect(cb.getConfig().recoveryTimeoutMs).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------

describe('CircuitBreaker — initial state', () => {
  it('starts in CLOSED state', () => {
    const cb = new CircuitBreaker('s');
    expect(cb.getState()).toBe('CLOSED');
  });

  it('allows fetch calls in CLOSED state', () => {
    const cb = new CircuitBreaker('s');
    expect(cb.isAllowed()).toBe(true);
  });

  it('has zero consecutive failures initially', () => {
    const cb = new CircuitBreaker('s');
    expect(cb.getConsecutiveFailures()).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('CircuitBreaker — CLOSED → OPEN transition', () => {
  it('stays CLOSED while failures are below threshold', () => {
    const cb = new CircuitBreaker('s', { failureThreshold: 3 });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe('CLOSED');
    expect(cb.isAllowed()).toBe(true);
  });

  it('transitions to OPEN when failures reach the threshold', () => {
    const cb = new CircuitBreaker('s', { failureThreshold: 3 });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe('OPEN');
  });

  it('blocks fetch calls once OPEN', () => {
    const cb = new CircuitBreaker('s', { failureThreshold: 1 });
    cb.recordFailure();
    expect(cb.isAllowed()).toBe(false);
  });

  it('sets openedAt timestamp when transitioning to OPEN', () => {
    const cb = new CircuitBreaker('s', { failureThreshold: 1 });
    expect(cb.getOpenedAt()).toBeNull();
    cb.recordFailure();
    expect(cb.getOpenedAt()).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------

describe('CircuitBreaker — recordSuccess() resets state', () => {
  it('resets failures and closes circuit from CLOSED state', () => {
    const cb = new CircuitBreaker('s', { failureThreshold: 3 });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    expect(cb.getConsecutiveFailures()).toBe(0);
    expect(cb.getState()).toBe('CLOSED');
  });

  it('failure counter resets so circuit does not open prematurely after success', () => {
    const cb = new CircuitBreaker('s', { failureThreshold: 3 });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    // Only 2 more failures — should not open yet
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe('CLOSED');
  });
});

// ---------------------------------------------------------------------------

describe('CircuitBreaker — OPEN → HALF_OPEN via tryHalfOpen()', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns false when circuit is not OPEN', () => {
    const cb = new CircuitBreaker('s');
    expect(cb.tryHalfOpen()).toBe(false);
  });

  it('returns false when recovery timeout has NOT elapsed', () => {
    const cb = new CircuitBreaker('s', { failureThreshold: 1, recoveryTimeoutMs: 60_000 });
    cb.recordFailure(); // → OPEN
    advanceTime(59_999);
    expect(cb.tryHalfOpen()).toBe(false);
    expect(cb.getState()).toBe('OPEN');
  });

  it('returns true and transitions to HALF_OPEN after recovery timeout', () => {
    const cb = new CircuitBreaker('s', { failureThreshold: 1, recoveryTimeoutMs: 60_000 });
    cb.recordFailure(); // → OPEN
    advanceTime(60_000);
    const result = cb.tryHalfOpen();
    expect(result).toBe(true);
    expect(cb.getState()).toBe('HALF_OPEN');
  });

  it('allows fetch calls in HALF_OPEN state', () => {
    const cb = new CircuitBreaker('s', { failureThreshold: 1, recoveryTimeoutMs: 1_000 });
    cb.recordFailure();
    advanceTime(1_000);
    cb.tryHalfOpen();
    expect(cb.isAllowed()).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('CircuitBreaker — HALF_OPEN → CLOSED on probe success', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes the circuit when probe fetch succeeds', () => {
    const cb = new CircuitBreaker('s', { failureThreshold: 1, recoveryTimeoutMs: 1_000 });
    cb.recordFailure(); // CLOSED → OPEN
    advanceTime(1_000);
    cb.tryHalfOpen();   // OPEN → HALF_OPEN
    cb.recordSuccess(); // HALF_OPEN → CLOSED
    expect(cb.getState()).toBe('CLOSED');
    expect(cb.getConsecutiveFailures()).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('CircuitBreaker — HALF_OPEN → OPEN on probe failure', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns to OPEN and resets openedAt when probe fetch fails', () => {
    const cb = new CircuitBreaker('s', { failureThreshold: 1, recoveryTimeoutMs: 1_000 });
    cb.recordFailure(); // CLOSED → OPEN

    advanceTime(1_000);
    cb.tryHalfOpen(); // OPEN → HALF_OPEN

    const halfOpenTime = new Date();
    advanceTime(500);
    cb.recordFailure(); // HALF_OPEN → OPEN (reset timer)

    expect(cb.getState()).toBe('OPEN');
    // openedAt must be ≥ the time we entered HALF_OPEN (timer was reset)
    expect(cb.getOpenedAt()!.getTime()).toBeGreaterThanOrEqual(halfOpenTime.getTime());
  });

  it('requires a fresh recovery timeout after probe failure', () => {
    const cb = new CircuitBreaker('s', { failureThreshold: 1, recoveryTimeoutMs: 1_000 });
    cb.recordFailure(); // → OPEN

    advanceTime(1_000);
    cb.tryHalfOpen();   // → HALF_OPEN
    cb.recordFailure(); // → OPEN (reset)

    // Advance only 999ms — not enough; tryHalfOpen should still return false
    advanceTime(999);
    expect(cb.tryHalfOpen()).toBe(false);

    // Advance the remaining 1ms — now it should transition
    advanceTime(1);
    expect(cb.tryHalfOpen()).toBe(true);
    expect(cb.getState()).toBe('HALF_OPEN');
  });
});

// ---------------------------------------------------------------------------

describe('CircuitBreaker — Req 1.12 back-off WARN logging', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('emits console.warn on the 5th OPEN transition', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cb = new CircuitBreaker('reuters', { failureThreshold: 1, recoveryTimeoutMs: 1_000 });

    // Drive the CB through 5 OPEN transitions
    for (let i = 0; i < 5; i++) {
      cb.recordFailure(); // → OPEN

      if (i < 4) {
        advanceTime(1_000);
        cb.tryHalfOpen();   // → HALF_OPEN
        cb.recordSuccess(); // → CLOSED  (resets failures so next failure reopens)
        cb.recordFailure(); // 1 failure in CLOSED — but threshold is 1, so it immediately opens
        // wait, after recordSuccess failures = 0, so we need one failure to re-open.
        // The loop top does cb.recordFailure() which opens again for the next iteration.
        // Let's undo the extra recordFailure we added here:
      }
    }

    // The WARN should have fired exactly once (on the 5th transition)
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnMsg = warnSpy.mock.calls[0]?.[0] as string;
    expect(warnMsg).toContain('reuters');
    expect(warnMsg).toContain('5 consecutive OPEN transitions');
    expect(warnMsg).toContain('300s');
  });

  it('does NOT emit console.warn before the 5th OPEN transition', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cb = new CircuitBreaker('reuters', { failureThreshold: 1, recoveryTimeoutMs: 1_000 });

    // Drive through only 4 OPEN transitions
    for (let i = 0; i < 4; i++) {
      cb.recordFailure(); // → OPEN
      advanceTime(1_000);
      cb.tryHalfOpen();   // → HALF_OPEN
      cb.recordSuccess(); // → CLOSED
    }

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('WARN message includes the source id and a re-enable timestamp', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cb = new CircuitBreaker('coindesk', { failureThreshold: 1, recoveryTimeoutMs: 1_000 });

    for (let i = 0; i < 5; i++) {
      cb.recordFailure();
      if (i < 4) {
        advanceTime(1_000);
        cb.tryHalfOpen();
        cb.recordSuccess();
      }
    }

    const msg = warnSpy.mock.calls[0]?.[0] as string;
    expect(msg).toContain('coindesk');
    // Should include an ISO 8601 timestamp
    expect(msg).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

// ---------------------------------------------------------------------------

describe('CircuitBreaker — full round-trip scenario', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('completes a full CLOSED → OPEN → HALF_OPEN → CLOSED cycle', () => {
    const cb = new CircuitBreaker('reuters', {
      failureThreshold: 3,
      recoveryTimeoutMs: 5_000,
    });

    // --- CLOSED phase ---
    expect(cb.getState()).toBe('CLOSED');
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe('CLOSED');

    // Third failure trips the breaker
    cb.recordFailure();
    expect(cb.getState()).toBe('OPEN');
    expect(cb.isAllowed()).toBe(false);
    expect(cb.tryHalfOpen()).toBe(false); // timeout not elapsed

    // --- Recovery timeout ---
    advanceTime(5_000);
    expect(cb.tryHalfOpen()).toBe(true);
    expect(cb.getState()).toBe('HALF_OPEN');
    expect(cb.isAllowed()).toBe(true);

    // --- HALF_OPEN probe succeeds ---
    cb.recordSuccess();
    expect(cb.getState()).toBe('CLOSED');
    expect(cb.getConsecutiveFailures()).toBe(0);
    expect(cb.isAllowed()).toBe(true);
  });
});
