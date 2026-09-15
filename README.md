# SentinelPulse — Market Intelligence & News Impact Engine

## What Is SentinelPulse?

SentinelPulse is a production-grade service that transforms raw financial news into structured, evidence-backed market intelligence for the **AlphaForge signal engine** and **ml-service**. It is not a news aggregator — it is a multi-stage processing pipeline that ingests articles from six financial news sources, enriches them through 18 sequential intelligence engines, and produces calibrated impact scores, sentiment vectors, entity links, historical analogues, and ML-ready feature vectors.

Every output is point-in-time correct (enforced by `LookAheadGuard`), source-isolated (enforced by `CircuitBreaker` per adapter), and fully traceable from `TrainingSample` back to the original raw article.

### Pipeline Overview

```
Raw News (6 Sources)
  ↓
Ingestion Engine  ←  CircuitBreaker + RateLimiter + SSRF Guard
  ↓  news.raw
NormalizationEngine   (HTML strip · language detect · SHA-256 hashes · taxonomy)
  ↓  news.normalized
DeduplicationEngine   (exact hash match · Jaro-Winkler · cosine embeddings · NewsCluster)
  ↓  news.deduplicated
EntityResolutionEngine  (NER · InstrumentMaster lookup · asset/sector links)
  ↓  news.entities
EventDetectionEngine  (14 event types · surprise score · SurpriseScoreCalculator)
  ↓  news.events
SentimentEngine   (5 dimensions · 9 qualitative signals · lexicon model)
  ↓  news.sentiment
ImportanceEngine  (9 sub-scores · historical impact · novelty · surprise multiplier)
  ↓  news.impact
MarketImpactEngine  (IndianMarketImpactEngine · NewsImpactScore · cross-market relationships)
  ↓
HistoricalReactionEngine   (9 time offsets · return_1m…return_1d · data-service)
  ↓
FeatureEngineeringEngine   (7 feature groups · LookAheadGuard · 500ms publish SLA)
  ↓  news.features
MLDatasetGenerator   (forward returns · directional labels · TrainingSample)
  ↓
AlphaForge Signal Engine  /  ml-service
```

---

## Features

- **6 pluggable news source adapters** — Tier-1: Reuters, Moneycontrol, Economic Times; Tier-2: Bloomberg, Financial Times, CoinDesk. Each adapter runs in a circuit-isolated ingestion lane with independent rate limiting and enable/disable flags.
- **18 intelligence engines** forming a sequential BullMQ pipeline — normalization through ML dataset generation, each engine independently scalable and fault-tolerant.
- **Multi-dimensional sentiment** — 5 orthogonal dimensions: `overall`, `market`, `company`, `macro`, `risk`. Driven by a financial-domain lexicon model augmented with 9 qualitative signals (urgency, certainty, temporal proximity, magnitude, credibility, market impact, direction clarity, volatility, systemic risk).
- **9-sub-score importance scoring** with a surprise multiplier — source credibility, event severity, market breadth, time sensitivity, novelty, cross-asset impact, macroeconomic relevance, historical impact correlation, and social amplification.
- **Indian market impact engine** — covers NIFTY50, BANKNIFTY, sectoral indices (NIFTY Bank, IT, Pharma, Auto, Energy, FMCG, Metals, Realty), and individual NSE/BSE-listed stocks. Impact direction (BULLISH/BEARISH/NEUTRAL), strength (0–1), confidence (0–1), and horizon (1m / 5m / 15m / 1h / 1d) per asset.
- **Cross-market relationship graph** — empirically calibrated correlations (CRUDE→AVIATION, USD→NIFTY, FII_FLOWS→BROAD_MARKET, etc.) updated from rolling historical data, not hardcoded rules.
- **Historical reaction engine** — measures actual price/volume responses at 9 time offsets (1m, 5m, 15m, 30m, 1h, 2h, 4h, 8h, 1d) and feeds the reaction data back for ML training labels.
- **LookAheadGuard** — hard enforcement of point-in-time correctness. Throws `LookAheadBiasError` with full diagnostic context if any data source carries a timestamp after `event_timestamp`. The CI pipeline runs an automated scanner against all `FeatureVector` records.
- **Semantic search** via pgvector HNSW index — p95 < 500ms for a 1M-article corpus. Supports similarity threshold, regime filter, and topK pagination.
- **Historical analogue engine** — finds semantically similar past events and returns aggregate statistics: median return, win rate, max adverse excursion, and inter-quartile range for each time horizon.
- **Redis caching** — 10 cache keys with explicit TTLs (30s for real-time context, 5m for regime, 15m for sector aggregates, 60m for training samples).
- **Full REST API** — news intelligence, AlphaForge integration, ML/data, admin. All endpoints behind Bearer auth with 300 RPM rate limiting.
- **Prometheus metrics + pino structured logging** — `/metrics`, `/health`, `/ready` built-in.
- **GitHub Actions CI** — TypeScript type-check, coverage gate (≥80%), look-ahead leakage scan, and documentation presence check on every pull request.

---

## Architecture

SentinelPulse runs as a set of independent Node.js processes that communicate exclusively through **BullMQ queues** backed by Redis. There is no direct inter-process RPC. Each worker subscribes to one input queue, processes a job, and enqueues the enriched payload to the next stage.

This design means any worker can be scaled horizontally without touching the others. The API server is stateless and can run behind a load balancer at any concurrency.

### Worker / Queue Topology

| Worker | Input Queue | Output Queue |
|---|---|---|
| news-normalize-worker | `news.raw` | `news.normalized` |
| news-dedup-worker | `news.normalized` | `news.deduplicated` |
| news-entity-worker | `news.deduplicated` | `news.entities` |
| news-event-worker | `news.entities` | `news.events` |
| news-sentiment-worker | `news.events` | `news.sentiment` |
| news-impact-worker (×2) | `news.sentiment` / `news.impact` | `news.impact` / — |
| news-feature-worker | `news.impact` | `news.features` |
| news-embed-worker | `news.embeddings` | — |

Every queue has a corresponding `news.{stage}.deadletter` DLQ. Failed jobs (after exhausting retries) are moved to the DLQ intact — headers, payload, error context — so they can be inspected via the admin API and manually replayed without data loss.

Three cron processes run on schedule outside the queue topology:

| Cron Process | Schedule | Purpose |
|---|---|---|
| VelocityEngine | Every 60s | Computes rolling news velocity per asset and sector |
| BreadthEngine | Every 5 min | Computes market breadth (advancing/declining article ratio) |
| MarketRegimeEngine | Every 15 min | Updates market regime classification (RISK_ON / RISK_OFF / NEUTRAL / CRISIS) |

---

## Prerequisites

| Dependency | Version | Notes |
|---|---|---|
| Node.js | 20 LTS | Required. Use nvm or volta to pin the version. |
| PostgreSQL | 16 + pgvector | The `vector` extension must be installed before running migrations. |
| Redis | 7 | Used for BullMQ queues and response caching. |
| Docker & Docker Compose | Latest stable | Required for the infrastructure services. |
| Python | 3.11 | Powers the Scrapling sidecar for JavaScript-rendered pages. |

---

## Quick Start (Docker Compose)

The fastest path to a running instance:

```bash
# 1. Enter the project directory
cd sentinel-pulse

# 2. Set up environment variables
cp .env.example .env.local
# Edit .env.local — at minimum set DATABASE_URL, REDIS_URL, and SENTINEL_API_KEY

# 3. Start infrastructure services
docker compose up -d postgres redis scrapling

# 4. Install Node.js dependencies
npm install

# 5. Run database migrations
npx prisma migrate deploy

# 6. Generate the Prisma client
npx prisma generate

# 7. Start the API server with hot reload
npm run dev
```

The API is now available at `http://localhost:3000`.

Swagger/OpenAPI is not bundled — use the [API Reference](API.md) for endpoint documentation.

---

## Running Everything with Docker

To run the full stack (API server, all 8 workers, 3 cron processes, and all infrastructure):

```bash
# Start all 14 services
docker compose up -d

# Tail logs from the most important processes
docker compose logs -f api worker-normalize worker-sentiment

# Scale a worker horizontally (e.g., 3 normalize workers)
docker compose up -d --scale worker-normalize=3

# Stop and remove containers (data volumes are preserved)
docker compose down
```

---

## Manual Worker Startup

For development and debugging, start workers individually in separate terminal windows or via a process manager like `pm2`:

```bash
# Pipeline workers (start in order for the first run; order doesn't matter once queues have data)
node dist/workers/normalize.worker.js
node dist/workers/dedup.worker.js
node dist/workers/entity.worker.js
node dist/workers/event.worker.js
node dist/workers/sentiment.worker.js
node dist/workers/impact.worker.js
node dist/workers/feature.worker.js
node dist/workers/embed.worker.js
```

Cron processes (these run their own internal schedulers):

```bash
# News velocity metrics — fires every 60s
node dist/engines/velocity/VelocityEngine.js --cron

# Market breadth metrics — fires every 5 min
node dist/engines/breadth/BreadthEngine.js --cron

# Market regime update — fires every 15 min
node dist/engines/market-regime/MarketRegimeEngine.js --cron
```

---

## Environment Configuration

SentinelPulse uses three environment files:

| File | Purpose |
|---|---|
| `.env.example` | Committed template with placeholder values. Safe to commit. |
| `.env.local` | Local development overrides. **Never commit.** |
| `.env.production` | Production template. **Never commit with real secrets.** |

Copy the template before first run:

```bash
cp .env.example .env.local
```

### Critical Required Variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (e.g., `postgresql://user:pass@localhost:5432/sentinelpulse`) |
| `REDIS_URL` | Redis connection string (e.g., `redis://localhost:6379`) |
| `SENTINEL_API_KEY` | Bearer token for REST API authentication. Use a cryptographically random 32+ byte value. |
| `DATA_SERVICE_URL` | AlphaForge data-service base URL (e.g., `http://data-service:8080`) |
| `DATA_SERVICE_API_KEY` | API key for the AlphaForge data-service |
| `SCRAPLING_URL` | Scrapling sidecar URL (default: `http://localhost:8001`) |
| `FEATURE_VERSION` | Semver string (e.g., `1.0.0`) — required for ML reproducibility. Bump MINOR on schema changes. |
| `PIPELINE_VERSION` | Semver string (e.g., `1.0.0`) — required for ML reproducibility. Bump MINOR on logic changes. |

See [docs/OPERATIONS.md](docs/OPERATIONS.md) for the complete variable reference including optional tuning parameters.

---

## Available Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start the API server with hot reload (tsx watch mode) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Start the compiled API from `dist/` (production mode) |
| `npm test` | Run the full test suite |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:coverage` | Run tests and generate a coverage report |
| `npm run lint` | ESLint check across all source files |
| `npm run prisma:generate` | Regenerate the Prisma client after schema changes |
| `npm run prisma:migrate` | Run any pending Prisma migrations |

---

## Database

SentinelPulse uses **PostgreSQL 16** with the **pgvector** extension. The schema has 23 tables that collectively model the full intelligence pipeline from raw ingestion through ML training data.

### Tables

`news_sources` · `news_articles` · `news_article_versions` · `news_clusters` · `news_events` · `news_article_event_links` · `news_entities` · `news_entity_mentions` · `news_asset_links` · `news_sector_links` · `news_event_relationships` · `news_sentiment` · `news_importance` · `news_market_impacts` · `news_market_reactions` · `news_market_regimes` · `news_features` · `news_embeddings` · `news_training_samples` · `news_source_metrics` · `news_ingestion_runs` · `news_processing_errors` · `news_alerts`

All timestamps are stored as `TIMESTAMPTZ` (UTC). Embeddings use `vector(1536)` with an HNSW index (`lists=100, probes=10`) for sub-500ms semantic search over 1M+ articles.

### Running Migrations

```bash
npx prisma migrate deploy
```

See [docs/DATA_MODEL.md](docs/DATA_MODEL.md) for the full schema with column-level documentation.

---

## Testing

```bash
# Full test suite (464 tests across 34 files)
npm test

# Property-based tests only (19 correctness properties via fast-check)
npx vitest run tests/property/

# Look-ahead bias CI check (scans all FeatureVector records)
npx tsx tests/ci/look-ahead-check.ts

# Integration tests only
npx vitest run tests/integration/
```

### What's Covered

- **Unit tests** — all 18 engines, pure-function coverage for every transformation step and edge case.
- **Property-based tests** — 19 correctness properties using `fast-check`. Covers Jaro-Winkler similarity bounds, CircuitBreaker state machine invariants, SHA-256 hash determinism, point-in-time correctness (LookAheadGuard), sentiment score bounds, importance normalization, and more.
- **Integration tests** — Tier-1 source outage simulation (circuit trips, DLQ receives failed jobs, healthy sources continue uninterrupted), API authentication and rate limiting.
- **CI look-ahead check** — automated scanner that queries all `news_features` records and asserts no feature timestamp post-dates the corresponding event timestamp. Fails the build if any violation is found.

---

## API Quick Reference

Base URL: `http://localhost:3000/api/v1`  
Authentication: `Authorization: Bearer {SENTINEL_API_KEY}`

| Group | Endpoints |
|---|---|
| News | `GET /news/latest` · `GET /news/assets/:id` · `GET /news/market/india` · `GET /news/events/:id` · `GET /news/impact/:id` · `GET /news/regime` · `GET /news/signal/:id` · `GET /news/search` |
| AlphaForge | `GET /alphaforge/news-context/:instrument` · `GET /alphaforge/context/market` · `GET /alphaforge/high-impact-events` |
| ML | `GET /ml/features/asset/:id` · `GET /ml/training/samples` · `GET /ml/training/samples/:id/lineage` · `GET /ml/historical-reactions` |
| Admin | `GET /admin/sources` · `GET /admin/ingestion` · `GET /admin/queues` · `GET /admin/data-quality` |
| Health | `GET /health` · `GET /ready` · `GET /metrics` |

See the full [API Reference](API.md) for request parameters, response shapes, and curl examples.

---

## Key Design Principles

1. **Not a scraper — a Market Intelligence Platform.** Raw news is the input. The product is structured, calibrated, evidence-backed intelligence. A scraper fetches text; SentinelPulse produces `news_impact_score`, `surprise_score`, `FeatureVector`, and `TrainingSample`.

2. **Evidence-backed, not assumption-based.** Cross-market relationships (e.g., CRUDE→AVIATION, USD→NIFTY) are derived from rolling empirical correlation data, not hardcoded rules. The `MarketRegimeEngine` updates the regime from observed market breadth, not from calendar heuristics.

3. **No look-ahead bias, ever.** The `LookAheadGuard` validates every feature computation at runtime and throws `LookAheadBiasError` with full diagnostic context if any data source — price data, volume, sentiment history — carries a timestamp after the event's `event_timestamp`. This check also runs in CI.

4. **News is one factor, not a trading signal.** SentinelPulse never produces BUY, SELL, or HOLD recommendations. It produces `news_impact_score` as one input to AlphaForge's multi-factor model. The distinction is architectural: AlphaForge decides what to do with the signal; SentinelPulse decides what the news means.

5. **Full traceability.** Every `TrainingSample` links to its `FeatureVector`, which links to its `NewsEvent`, which links to its `NormalizedArticle`, which links to its raw source. No ML artifact exists without a complete provenance chain.

6. **Source isolation.** A failing source (HTTP timeout, auth failure, malformed feed) cannot stall or corrupt the pipeline. Each adapter is wrapped in a `CircuitBreaker` (CLOSED → OPEN → HALF_OPEN state machine) and a per-source `RateLimiter`. Failed jobs go to the DLQ. Healthy sources continue uninterrupted.

---

## Documentation

| Document | Description |
|---|---|
| [API.md](API.md) | Comprehensive REST API reference — all endpoints, parameters, response shapes, curl examples |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Component diagram, worker/queue topology, engine dependency graph |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | All 23 database tables with column-level documentation |
| [docs/ML_FEATURES.md](docs/ML_FEATURES.md) | FeatureVector schema with formulas for all 7 feature groups |
| [docs/ALPHAFORGE_INTEGRATION.md](docs/ALPHAFORGE_INTEGRATION.md) | Integration contract: request/response shapes, SLA, versioning policy |
| [docs/SOURCE_ADAPTERS.md](docs/SOURCE_ADAPTERS.md) | Feed URLs, authentication, rate limits, and parser notes for all 6 sources |
| [docs/BACKFILL.md](docs/BACKFILL.md) | Historical data backfill guide, date range limits, rate limiting behaviour |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Complete env var reference, horizontal scaling guide, cron schedules, data retention |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Failure runbooks for common incidents (DLQ overflow, circuit open, DB lag, look-ahead violations) |

---

## Contributing

- TypeScript strict mode — no `any` without an inline justification comment.
- All engines must have property-based tests covering their correctness properties (see [docs/ML_FEATURES.md](docs/ML_FEATURES.md) for the defined properties list).
- The look-ahead bias CI check must pass on every PR. No exceptions.
- Coverage must remain ≥ 80% per engine directory.
- New source adapters require a corresponding entry in [docs/SOURCE_ADAPTERS.md](docs/SOURCE_ADAPTERS.md) including feed URL, polling interval, rate limits, and authentication method.
- Bump `FEATURE_VERSION` (MINOR) when any `FeatureVector` field changes. Bump `PIPELINE_VERSION` (MINOR) when any engine logic changes that affects output values.

---

## License

Proprietary — AlphaForge internal use only. Unauthorized distribution or use outside the AlphaForge platform is prohibited.
