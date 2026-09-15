/**
 * CircuitBreaker — fault-tolerance pattern for NewsSourceAdapter fetch calls.
 *
 * State machine:
 *   CLOSED    → OPEN      when consecutiveFailures >= failureThreshold
 *   OPEN      → HALF_OPEN when recovery timeout elapses (via tryHalfOpen())
 *   HALF_OPEN → CLOSED    on probe fetch success  (via recordSuccess())
 *   HALF_OPEN → OPEN      on probe fetch failure  (via recordFailure())
 *
 * Requirements: Req 2.1, Req 2.2, Req 1.12
 */

export type CBState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CBConfig {
  /** Number of consecutive failures before opening the circuit. Default 5, range [1, 100]. */
  failureThreshold: number;
  /** Milliseconds to wait in OPEN state before probing. Default 60_000, range [1_000, 3_600_000]. */
  recoveryTimeoutMs: number;
}

/** Default configuration values (Req 2.1). */
const DEFAULT_CONFIG: CBConfig = {
  failureThreshold: 5,
  recoveryTimeoutMs: 60_000,
};

/** Clamp a number to an inclusive [min, max] range. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Resolve and clamp a partial CBConfig to a fully-valid CBConfig. */
function resolveConfig(partial: Partial<CBConfig>): CBConfig {
  return {
    failureThreshold: clamp(
      partial.failureThreshold ?? DEFAULT_CONFIG.failureThreshold,
      1,
      100,
    ),
    recoveryTimeoutMs: clamp(
      partial.recoveryTimeoutMs ?? DEFAULT_CONFIG.recoveryTimeoutMs,
      1_000,
      3_600_000,
    ),
  };
}

export class CircuitBreaker {
  private state: CBState = 'CLOSED';
  private consecutiveFailures = 0;
  private openedAt: Date | null = null;

  /**
   * Tracks how many times this circuit has transitioned to OPEN within the
   * current process lifetime.  Used to implement the Req 1.12 back-off
   * warning after 5 consecutive OPEN transitions.
   */
  private openTransitions = 0;

  /** Resolved (clamped) configuration. */
  private readonly cfg: CBConfig;

  constructor(
    private readonly sourceId: string,
    config: Partial<CBConfig> = {},
  ) {
    this.cfg = resolveConfig(config);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Returns `true` when a fetch call is permitted.
   * Calls are allowed in CLOSED and HALF_OPEN states.
   * In OPEN state, callers should invoke tryHalfOpen() first.
   */
  isAllowed(): boolean {
    return this.state === 'CLOSED' || this.state === 'HALF_OPEN';
  }

  /**
   * Record a successful fetch.
   * Resets the consecutive failure counter and closes the circuit regardless
   * of the prior state.
   */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.state = 'CLOSED';
  }

  /**
   * Record a failed fetch.
   *
   * Behaviour by prior state:
   *   - CLOSED:    increment counter; transition to OPEN when threshold is reached
   *   - HALF_OPEN: transition back to OPEN, reset recovery timer
   *   - OPEN:      increment counter (no-op on state — already open)
   *
   * When transitioning to OPEN the Req 1.12 back-off counter is checked and a
   * WARN is emitted after the 5th consecutive OPEN event.
   */
  recordFailure(): void {
    this.consecutiveFailures += 1;

    if (this.state === 'HALF_OPEN') {
      // Probe failed — return to OPEN and restart recovery timeout.
      this.transitionToOpen();
      return;
    }

    if (
      this.state === 'CLOSED' &&
      this.consecutiveFailures >= this.cfg.failureThreshold
    ) {
      this.transitionToOpen();
    }
  }

  /** Returns the current circuit state. */
  getState(): CBState {
    return this.state;
  }

  /**
   * Attempt to move from OPEN → HALF_OPEN if the recovery timeout has elapsed.
   *
   * @returns `true`  if the state transitioned to HALF_OPEN (caller should
   *                  execute a single probe fetch).
   * @returns `false` if the timeout has not elapsed, or the circuit is not OPEN.
   */
  tryHalfOpen(): boolean {
    if (this.state !== 'OPEN' || this.openedAt === null) {
      return false;
    }

    const elapsed = Date.now() - this.openedAt.getTime();
    if (elapsed >= this.cfg.recoveryTimeoutMs) {
      this.state = 'HALF_OPEN';
      return true;
    }

    return false;
  }

  // ---------------------------------------------------------------------------
  // Accessors (useful for tests and observability)
  // ---------------------------------------------------------------------------

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  getOpenedAt(): Date | null {
    return this.openedAt;
  }

  getConfig(): Readonly<CBConfig> {
    return this.cfg;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Perform the OPEN transition and handle Req 1.12 back-off WARN logging.
   *
   * Req 1.12: If a source's failure counter reaches 5 consecutive non-healthy
   * responses within a single process lifetime, the IngestionEngine SHALL
   * automatically disable that source for a back-off period of 300 seconds and
   * SHALL log the automatic disable event.
   *
   * Here we track process-lifetime OPEN transitions.  When the 5th transition
   * occurs we emit a console.warn (logger will be wired in the observability
   * phase).
   */
  private transitionToOpen(): void {
    this.state = 'OPEN';
    this.openedAt = new Date();
    this.openTransitions += 1;

    // Req 1.12 — warn after 5th consecutive OPEN event in this process lifetime.
    if (this.openTransitions === 5) {
      const reEnableAt = new Date(
        this.openedAt.getTime() + 300_000,
      ).toISOString();
      console.warn(
        `[CircuitBreaker][${this.sourceId}] Source automatically disabled after ` +
          `${this.openTransitions} consecutive OPEN transitions. ` +
          `Back-off period: 300s. Scheduled re-enable at: ${reEnableAt}`,
      );
    }
  }
}
