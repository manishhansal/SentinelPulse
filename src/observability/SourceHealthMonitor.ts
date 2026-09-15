/**
 * SourceHealthMonitor.ts — monitors source health and emits WARN-level
 * structured log entries when Tier-1 sources remain unavailable.
 *
 * Behaviour (Req 29.5):
 *   - When a Tier-1 source transitions from healthy → unhealthy, the first
 *     call with healthy=false records the downtime start.
 *   - Subsequent calls with healthy=false compare the elapsed duration against
 *     ALERT_THRESHOLD_MS (5 minutes). When exceeded, a WARN log is emitted.
 *   - When a Tier-1 source recovers (healthy=true), the downtime record is
 *     removed and an INFO log is emitted.
 *
 * Requirements: Req 29.5
 */

import { pino } from 'pino';
import { sourceHealth } from './metrics.js';

const logger = pino({ name: 'SourceHealthMonitor' });

export class SourceHealthMonitor {
  /** Canonical lower-cased identifiers for Tier-1 sources (Req 29.5). */
  private readonly tier1Sources = ['reuters', 'moneycontrol', 'economictimes'];

  /**
   * Maps source name → the Date when the source first went down.
   * Entry is absent while the source is healthy.
   */
  private readonly downSince = new Map<string, Date>();

  /** 5-minute alert threshold (Req 29.5). */
  private readonly ALERT_THRESHOLD_MS = 5 * 60 * 1_000;

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Records the current health status for a single source and updates the
   * Prometheus `sentinel_source_health` gauge.
   *
   * For Tier-1 sources that have been continuously unavailable for more than
   * 5 minutes, emits a WARN-level structured log with:
   *   - sourceName
   *   - durationMs
   *   - durationMinutes (truncated)
   *   - downSince (ISO-8601)
   *
   * Requirements: Req 29.5
   */
  recordHealth(sourceName: string, healthy: boolean): void {
    // Update Prometheus gauge (Req 29.1)
    sourceHealth.set({ source_name: sourceName }, healthy ? 1 : 0);

    const isTier1 = this.tier1Sources.includes(sourceName.toLowerCase());

    if (!healthy) {
      // Record the first time this source went down
      if (!this.downSince.has(sourceName)) {
        this.downSince.set(sourceName, new Date());
      }

      if (isTier1) {
        const downSince = this.downSince.get(sourceName)!;
        const durationMs = Date.now() - downSince.getTime();

        if (durationMs > this.ALERT_THRESHOLD_MS) {
          logger.warn(
            {
              sourceName,
              durationMs,
              durationMinutes: Math.floor(durationMs / 60_000),
              downSince: downSince.toISOString(),
            },
            `Tier-1 source "${sourceName}" has been unavailable for ${Math.floor(durationMs / 60_000)} minutes`,
          );
        }
      }
    } else {
      // Source recovered — clear downtime record
      if (this.downSince.has(sourceName)) {
        this.downSince.delete(sourceName);
        if (isTier1) {
          logger.info({ sourceName }, `Tier-1 source "${sourceName}" has recovered`);
        }
      }
    }
  }

  /**
   * Runs a health check cycle over all provided sources.
   * Calls `recordHealth` for each entry in the map.
   *
   * Typically called periodically by the ingestion scheduler.
   *
   * Requirements: Req 29.5
   */
  checkAllSources(sourcesHealth: Record<string, boolean>): void {
    for (const [sourceName, healthy] of Object.entries(sourcesHealth)) {
      this.recordHealth(sourceName, healthy);
    }
  }

  // --------------------------------------------------------------------------
  // Test / introspection helpers (package-private by convention)
  // --------------------------------------------------------------------------

  /**
   * Returns the Date when the given source first went down, or undefined if
   * the source is currently healthy.
   *
   * Exposed for unit-test assertions.
   */
  getDownSince(sourceName: string): Date | undefined {
    return this.downSince.get(sourceName);
  }

  /**
   * Returns true when the source currently has an active downtime record,
   * false otherwise.
   *
   * Exposed for unit-test assertions.
   */
  isDown(sourceName: string): boolean {
    return this.downSince.has(sourceName);
  }
}
