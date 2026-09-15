# SentinelPulse Operations Reference

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string (e.g., `postgresql://sentinel:pass@localhost:5432/sentinel_pulse`) |
| `REDIS_URL` | Redis connection string (e.g., `redis://localhost:6379`) |
| `SENTINEL_API_KEY` | API key for authenticating callers to the REST API |
| `DATA_SERVICE_URL` | Base URL of the AlphaForge data-service |
| `DATA_SERVICE_API_KEY` | API key for data-service requests |
| `SCRAPLING_URL` | URL of the Scrapling sidecar (e.g., `http://localhost:8001`) |
| `FEATURE_VERSION` | Current feature schema version (semver, e.g., `1.0.0`) |
| `PIPELINE_VERSION` | Current pipeline version (semver, e.g., `1.0.0`) |

Both `FEATURE_VERSION` and `PIPELINE_VERSION` must be valid `MAJOR.MINOR.PATCH` semver strings. The application refuses to start if either is malformed.

### Source Toggles

| Variable | Default | Description |
|----------|---------|-------------|
| `NEWS_SOURCE_REUTERS_ENABLED` | `true` | Enable Reuters adapter |
| `NEWS_SOURCE_MONEYCONTROL_ENABLED` | `true` | Enable Moneycontrol adapter |
| `NEWS_SOURCE_ECONOMICTIMES_ENABLED` | `true` | Enable Economic Times adapter |
| `NEWS_SOURCE_BLOOMBERG_ENABLED` | `false` | Enable Bloomberg adapter |
| `NEWS_SOURCE_FINANCIALTIMES_ENABLED` | `false` | Enable Financial Times adapter |
| `NEWS_SOURCE_COINDESK_ENABLED` | `false` | Enable CoinDesk adapter |

Any value other than the string `"true"` (case-insensitive) is treated as disabled.

### Per-Source Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `NEWS_SOURCE_{NAME}_BASE_URL` | Feed or API base URL | (source-specific) |
| `NEWS_SOURCE_{NAME}_POLL_INTERVAL_MS` | Polling interval in milliseconds | 60000 (Tier-1), 120000–300000 (Tier-2) |
| `NEWS_SOURCE_BLOOMBERG_API_KEY` | Bloomberg API key | — |
| `NEWS_SOURCE_FINANCIALTIMES_API_KEY` | FT CAPI key | — |

If a source's base URL or poll interval is absent at startup, the source is automatically disabled for the process lifetime and a WARN is logged.

### Worker Concurrency

Each worker's concurrency is independently configurable. If a variable is absent, the worker defaults to concurrency 1.

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKER_NORMALIZE_CONCURRENCY` | `4` | news-normalize-worker |
| `WORKER_DEDUP_CONCURRENCY` | `2` | news-dedup-worker |
| `WORKER_ENTITY_CONCURRENCY` | `4` | news-entity-worker |
| `WORKER_EVENT_CONCURRENCY` | `4` | news-event-worker |
| `WORKER_SENTIMENT_CONCURRENCY` | `4` | news-sentiment-worker |
| `WORKER_IMPACT_CONCURRENCY` | `2` | news-impact-worker |
| `WORKER_FEATURE_CONCURRENCY` | `4` | news-feature-worker |
| `WORKER_EMBED_CONCURRENCY` | `2` | news-embed-worker |

### Circuit Breaker

| Variable | Default | Range | Description |
|----------|---------|-------|-------------|
| `CB_FAILURE_THRESHOLD` | `5` | 1–100 | Consecutive failures to open circuit |
| `CB_RECOVERY_TIMEOUT_MS` | `60000` | 1000–3600000 | Time before transitioning to HALF_OPEN |

### Retry Configuration

| Variable | Default | Range | Description |
|----------|---------|-------|-------------|
| `RETRY_BASE_DELAY_MS` | `1000` | 100–60000 | Base delay for exponential backoff |
| `RETRY_MULTIPLIER` | `2` | 1–10 | Backoff multiplier |
| `RETRY_MAX_ATTEMPTS` | `3` | 1–10 | Max retry attempts per job |

### Backfill

| Variable | Default | Description |
|----------|---------|-------------|
| `BACKFILL_MAX_CONCURRENCY` | `2` | Max concurrent backfill workers (1–20) |
| `BACKFILL_MAX_LIVE_QUEUE_SHARE` | `0.20` | Max fraction of total worker concurrency for backfill |

### Embedding

| Variable | Default | Description |
|----------|---------|-------------|
| `EMBEDDING_MODEL` | `text-embedding-3-large` | Embedding model identifier |
| `EMBEDDING_DIMENSION` | `1536` | Vector dimension |
| `EMBEDDING_API_KEY` | — | API key for the embedding service |

### Security

| Variable | Default | Description |
|----------|---------|-------------|
| `ALLOWED_SOURCE_DOMAINS` | (source domains) | Comma-separated SSRF allowlist |

### Data Retention (days; 0 = indefinite)

| Variable | Default | Description |
|----------|---------|-------------|
| `RETENTION_RAW_ARTICLES_DAYS` | `90` | Raw article content |
| `RETENTION_NORMALIZED_ARTICLES_DAYS` | `365` | NormalizedArticle records |
| `RETENTION_EVENTS_DAYS` | `730` | NewsEvent and NewsMarketImpact records |
| `RETENTION_TRAINING_SAMPLES_DAYS` | `0` | TrainingSample and FeatureVector records (indefinite) |

### General

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `development` | `development`, `test`, or `production` |
| `PORT` | `3000` | HTTP server port |
| `LOG_LEVEL` | `info` | pino log level: `debug`, `info`, `warn`, `error` |

---

## Worker Scaling

Workers are stateless and can be scaled horizontally. Each worker instance connects to the shared Redis BullMQ queue and pulls jobs.

**Rules of thumb**:
- Scale `normalize` and `entity` workers first — they tend to be CPU-bound.
- Scale `sentiment` and `feature` workers if those queues are backing up (monitor via `GET /api/v1/admin/queues`).
- Keep `dedup` and `impact` concurrency lower — they make more database round trips.
- The embed worker is I/O-bound (external API calls); scale aggressively if embedding throughput is a bottleneck.

To check current queue depths:
```bash
curl -H "Authorization: Bearer $SENTINEL_API_KEY" http://localhost:3000/api/v1/admin/queues
```

---

## Redis Cache TTLs

| Cache Key | TTL | Invalidation Trigger |
|-----------|-----|---------------------|
| `news:latest:india` | 60s | New India-category article published |
| `news:latest:global` | 60s | New global-category article published |
| `news:asset:{assetId}` | 30s | New article/impact linked to asset |
| `news:signal:{instrument}` | 30s | New sentiment/impact for instrument |
| `news:impact:{instrument}` | 30s | New MarketImpact computed |
| `news:regime:{market_id}` | 20min | Regime change event |
| `news:hot-events` | 60s | New high-importance event |
| `news:velocity:{type}:{id}` | 90s | VelocityEngine 60s recompute cycle |
| `news:breadth:india` | 6min | BreadthEngine 5min recompute cycle |
| `news:breadth:global` | 6min | BreadthEngine 5min recompute cycle |

Cache is a read-through layer only — PostgreSQL is always the write target. On Redis unavailability, queries fall back to PostgreSQL and a WARN is logged.

Regime changes trigger an additional cache purge:
```
DEL news:regime:{market_id}
SCAN + DEL news:signal:* for events with importance_score > 0.7 in that market
```

---

## Cron Schedules

| Task | Schedule | Engine |
|------|----------|--------|
| Tier-1 source polling | Every 60s | Scheduler (per-source setInterval) |
| Tier-2 source polling | Every 120s–300s | Scheduler |
| Velocity recomputation | Every 60s | VelocityEngine |
| Breadth recomputation | Every 5min | BreadthEngine |
| Market regime update | Every 15min | MarketRegimeEngine |
| Cross-market relationship update | Daily | CrossMarketEngine |
| Data retention sweep | Daily (at most once per 24h) | RetentionService |

---

## Circuit Breaker Configuration

Each source has an isolated circuit breaker. States:

- **CLOSED** — normal operation
- **OPEN** — source is blocked; opens after `CB_FAILURE_THRESHOLD` consecutive failures
- **HALF_OPEN** — probe fetch attempted after `CB_RECOVERY_TIMEOUT_MS` elapses

To check current circuit breaker states:
```bash
curl -H "Authorization: Bearer $SENTINEL_API_KEY" http://localhost:3000/api/v1/admin/sources
```

Look at the `cb_state` field for each source.

---

## Data Retention Policies

Retention sweeps run at most once every 24 hours. Records are permanently deleted once they exceed their configured retention period.

| Data | Default Retention |
|------|-------------------|
| Raw article content | 90 days |
| NormalizedArticle records | 365 days |
| NewsEvent and NewsMarketImpact | 730 days (2 years) |
| TrainingSample and FeatureVector | Indefinite (until explicit deletion) |
| Embedding vectors | Until model_version is marked deprecated + 90 days |

To change retention periods, update the relevant `RETENTION_*_DAYS` env var and restart the service. A value of `0` means indefinite retention.

---

## Health Monitoring

### Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Liveness — always returns 200 if the process is alive |
| `GET /ready` | Readiness — 200 if Postgres, Redis, and ≥1 Tier-1 source are reachable within 2s; 503 otherwise |
| `GET /metrics` | Prometheus metrics (text/plain) |

### Prometheus Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `sentinel_articles_fetched_total` | Counter | `source` | Total articles successfully fetched |
| `sentinel_articles_failed_total` | Counter | `source`, `error_type` | Total articles that failed to fetch |
| `sentinel_events_detected_total` | Counter | `event_type` | Total structured events extracted |
| `sentinel_processing_latency_seconds` | Histogram | `stage` | Processing latency per pipeline stage |
| `sentinel_queue_depth` | Gauge | `queue_name` | Current BullMQ queue depth |
| `sentinel_cache_hit_rate` | Gauge | `cache_key_pattern` | Redis cache hit rate |
| `sentinel_source_health` | Gauge | `source_name` | 1 = healthy, 0 = down |

### Alerting Recommendation

Set alerts for:
- `sentinel_source_health{source_name=~"reuters|moneycontrol|economictimes"} == 0` for > 5 minutes → page on-call
- `sentinel_queue_depth{queue_name="news.raw"} > 1000` → scale fetch workers
- `sentinel_queue_depth{queue_name=~"news.*.deadletter"} > 50` → investigate DLQ (see TROUBLESHOOTING.md)
- `/ready` returning 503 → investigate Postgres/Redis connectivity

### Source Health Logging

When `sentinel_source_health` for any Tier-1 source transitions from 1 → 0 and remains 0 for more than 5 consecutive minutes, a WARN-level structured log entry is emitted with the source name and duration.

---

## Structured Log Format

Every log entry uses this schema:

```json
{
  "timestamp": "2024-01-15T10:23:45.123Z",
  "level": "INFO",
  "service": "sentinel-pulse",
  "stage": "normalization",
  "correlationId": "job-abc123",
  "message": "Article normalized",
  "metadata": {
    "articleId": "uuid",
    "sourceId": "reuters",
    "contentHash": "abc..."
  }
}
```

`correlationId` propagates through all worker stages for a given job, enabling end-to-end trace reconstruction from a single article fetch through to FeatureVector storage.

---

## Phase 3A Changes (2026-09-15)

### New Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | HTTP server port. **Set to 3001 in local dev** — AlphaForge occupies port 3000. |
| `ML_SERVICE_URL` | `http://localhost:8100` | ml-service base URL for regime prediction |
| `FRESHNESS_FRESH_THRESHOLD_SECONDS` | `300` | Seconds until FRESH→STALE transition |
| `FRESHNESS_STALE_THRESHOLD_SECONDS` | `3600` | Seconds until STALE→EXPIRED transition |

### Corrected Source Feed URLs

The following env vars must point to RSS feed endpoints, **not the website homepages**:

| Variable | Correct Value |
|---|---|
| `NEWS_SOURCE_MONEYCONTROL_BASE_URL` | `https://www.moneycontrol.com/rss/MCtopnews.xml` |
| `NEWS_SOURCE_ECONOMICTIMES_BASE_URL` | `https://economictimes.indiatimes.com/rssfeedsdefault.cms` |
| `NEWS_SOURCE_COINDESK_BASE_URL` | `https://www.coindesk.com/arc/outboundfeeds/rss/` |

Setting these to the homepage URL causes `maxContentLength exceeded` errors in health checks and 0-article fetches.

### Updated SSRF Allowlist

The SSRF guard now supports subdomain matching (www.X.com matches X.com). The allowlist should include both bare domain and www:

```
ALLOWED_SOURCE_DOMAINS=news.google.com,feeds.reuters.com,moneycontrol.com,www.moneycontrol.com,economictimes.indiatimes.com,www.economictimes.indiatimes.com,bloomberg.com,www.bloomberg.com,ft.com,www.ft.com,coindesk.com,www.coindesk.com,localhost
```

### Starting the API Server (local dev)

```bash
# Load .env.local and start on port 3001
set -a && source .env.local && set +a && PORT=3001 npx tsx src/server.ts
```

### Starting the Scheduler (local dev)

```bash
set -a && source .env.local && set +a && \
  NEWS_SOURCE_COINDESK_ENABLED=true npx tsx src/scripts/run-scheduler.ts
```

### Seeding news_sources (required before first run)

```bash
set -a && source .env.local && set +a && \
  NEWS_SOURCE_COINDESK_ENABLED=true npx tsx src/scripts/seed-sources.ts
```

### Embedding Configuration

The `EmbeddingEngine` is now non-blocking. When `EMBEDDING_API_KEY` is absent:
- `generateAndStore()` returns `{ embedding_available: false, embedding_status: "SKIPPED" }`
- Core pipeline stages (event, sentiment, impact, features) are unaffected
- Jobs do not pile up in `news.embeddings` queue

To enable embeddings, add a valid OpenAI API key:
```
EMBEDDING_API_KEY=sk-...
```
