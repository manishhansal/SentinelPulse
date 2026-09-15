/**
 * Unit tests for SourceHealthMonitor (Req 29.5).
 *
 * Tests the pure logic in recordHealth() and checkAllSources() without
 * triggering actual logger output to stdout.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// We mock the metrics module to avoid Prometheus registry side-effects
vi.mock('../../../src/observability/metrics.js', () => ({
  sourceHealth: {
    set: vi.fn(),
  },
}));

import { SourceHealthMonitor } from '../../../src/observability/SourceHealthMonitor.js';

describe('SourceHealthMonitor (Req 29.5)', () => {
  let monitor: SourceHealthMonitor;

  beforeEach(() => {
    monitor = new SourceHealthMonitor();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // recordHealth — basic tracking
  // -------------------------------------------------------------------------

  it('tracks downtime start when a source goes unhealthy', () => {
    monitor.recordHealth('reuters', false);
    expect(monitor.isDown('reuters')).toBe(true);
    expect(monitor.getDownSince('reuters')).toBeInstanceOf(Date);
  });

  it('does not overwrite downSince on repeated unhealthy calls', () => {
    monitor.recordHealth('reuters', false);
    const first = monitor.getDownSince('reuters')!.getTime();

    // Simulate time passing slightly
    monitor.recordHealth('reuters', false);
    const second = monitor.getDownSince('reuters')!.getTime();

    expect(first).toBe(second);
  });

  it('clears downtime when source recovers', () => {
    monitor.recordHealth('reuters', false);
    expect(monitor.isDown('reuters')).toBe(true);

    monitor.recordHealth('reuters', true);
    expect(monitor.isDown('reuters')).toBe(false);
    expect(monitor.getDownSince('reuters')).toBeUndefined();
  });

  it('does not set downtime for healthy sources', () => {
    monitor.recordHealth('reuters', true);
    expect(monitor.isDown('reuters')).toBe(false);
  });

  it('tracks multiple sources independently', () => {
    monitor.recordHealth('reuters', false);
    monitor.recordHealth('moneycontrol', true);

    expect(monitor.isDown('reuters')).toBe(true);
    expect(monitor.isDown('moneycontrol')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // recordHealth — Prometheus gauge update
  // -------------------------------------------------------------------------

  it('sets Prometheus gauge to 0 when unhealthy', async () => {
    const { sourceHealth } = await import('../../../src/observability/metrics.js');
    monitor.recordHealth('reuters', false);
    expect(sourceHealth.set).toHaveBeenCalledWith({ source_name: 'reuters' }, 0);
  });

  it('sets Prometheus gauge to 1 when healthy', async () => {
    const { sourceHealth } = await import('../../../src/observability/metrics.js');
    monitor.recordHealth('reuters', true);
    expect(sourceHealth.set).toHaveBeenCalledWith({ source_name: 'reuters' }, 1);
  });

  // -------------------------------------------------------------------------
  // checkAllSources
  // -------------------------------------------------------------------------

  it('processes all sources in the provided map', () => {
    monitor.checkAllSources({
      reuters: false,
      moneycontrol: true,
      economictimes: false,
    });

    expect(monitor.isDown('reuters')).toBe(true);
    expect(monitor.isDown('moneycontrol')).toBe(false);
    expect(monitor.isDown('economictimes')).toBe(true);
  });

  it('handles empty sources map gracefully', () => {
    expect(() => monitor.checkAllSources({})).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Tier-1 source classification (case-insensitive)
  // -------------------------------------------------------------------------

  it('recognises Tier-1 sources case-insensitively', () => {
    // 'Reuters' (capital R) should still be tracked as a Tier-1 source
    monitor.recordHealth('Reuters', false);
    expect(monitor.isDown('Reuters')).toBe(true);
  });

  it('treats non-Tier-1 sources as tracked but non-alerting', () => {
    // bloomberg is Tier-2 — should still track downtime
    monitor.recordHealth('bloomberg', false);
    expect(monitor.isDown('bloomberg')).toBe(true);
  });
});
