/**
 * Prometheus metric definitions for SentinelPulse.
 *
 * All metrics are registered on a shared Registry so the /metrics endpoint
 * can call `metricsRegistry.metrics()` to produce the Prometheus text/plain
 * scrape payload.
 *
 * Metric catalogue (Req 29.1):
 *  - sentinel_articles_fetched_total  (counter, labels: source)
 *  - sentinel_articles_failed_total   (counter, labels: source, error_type)
 *  - sentinel_events_detected_total   (counter, labels: event_type)
 *  - sentinel_processing_latency_seconds (histogram, labels: stage)
 *  - sentinel_queue_depth             (gauge, labels: queue_name)
 *  - sentinel_cache_hit_rate          (gauge, labels: cache_key_pattern)
 *  - sentinel_source_health           (gauge 0/1, labels: source_name)
 *
 * Requirements: Req 29.1
 */

import { Registry, Counter, Histogram, Gauge } from 'prom-client';

/** Shared Prometheus registry — import this from any module that records metrics. */
export const metricsRegistry = new Registry();

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

/** Total articles successfully fetched, labelled by source. */
export const articlesFetchedTotal = new Counter({
  name: 'sentinel_articles_fetched_total',
  help: 'Total number of articles successfully fetched from a news source',
  labelNames: ['source'] as const,
  registers: [metricsRegistry],
});

/** Total articles that failed during fetching or processing, labelled by source and error type. */
export const articlesFailedTotal = new Counter({
  name: 'sentinel_articles_failed_total',
  help: 'Total number of articles that failed processing',
  labelNames: ['source', 'error_type'] as const,
  registers: [metricsRegistry],
});

/** Total news events detected by the EventDetectionEngine, labelled by event type. */
export const eventsDetectedTotal = new Counter({
  name: 'sentinel_events_detected_total',
  help: 'Total number of news events detected by the event detection engine',
  labelNames: ['event_type'] as const,
  registers: [metricsRegistry],
});

// ---------------------------------------------------------------------------
// Histograms
// ---------------------------------------------------------------------------

/** Per-stage processing latency in seconds. */
export const processingLatencySeconds = new Histogram({
  name: 'sentinel_processing_latency_seconds',
  help: 'Processing latency per pipeline stage in seconds',
  labelNames: ['stage'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [metricsRegistry],
});

// ---------------------------------------------------------------------------
// Gauges
// ---------------------------------------------------------------------------

/** Current depth of each BullMQ queue. */
export const queueDepth = new Gauge({
  name: 'sentinel_queue_depth',
  help: 'Current number of jobs waiting in each BullMQ queue',
  labelNames: ['queue_name'] as const,
  registers: [metricsRegistry],
});

/** Cache hit rate per Redis cache key pattern (0.0 – 1.0). */
export const cacheHitRate = new Gauge({
  name: 'sentinel_cache_hit_rate',
  help: 'Cache hit rate per Redis cache key pattern (0.0 to 1.0)',
  labelNames: ['cache_key_pattern'] as const,
  registers: [metricsRegistry],
});

/** Binary health indicator per source (1 = healthy, 0 = unhealthy). */
export const sourceHealth = new Gauge({
  name: 'sentinel_source_health',
  help: 'Binary health status of each news source (1 = healthy, 0 = unhealthy)',
  labelNames: ['source_name'] as const,
  registers: [metricsRegistry],
});
