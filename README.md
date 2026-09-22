# SentinelPulse — Market Intelligence & News Impact Engine

## What Is SentinelPulse?

SentinelPulse is a production-grade service that transforms raw financial news into structured, evidence-backed market intelligence for the **AlphaForge signal engine** and **ml-service**. It is not a news aggregator — it is a multi-stage processing pipeline that ingests articles from financial news sources, enriches them through sequential intelligence engines, and produces calibrated impact scores, sentiment vectors, entity links, and ML-ready feature vectors.

Every output is point-in-time correct (enforced by `LookAheadGuard`), source-isolated (enforced by `CircuitBreaker` per adapter), and fully traceable from `TrainingSample` back to the original raw article.

> **Current status — Phase 3B.2 (2026-09-18):** All 578 unit tests passing. Three data-service root causes fixed (Upstox key mismatch, Redis checkpoint blocking backfill, missing Docker env vars). Historical intraday OHLCV fully operational for all 8 instruments × 4 intervals. Training dataset idempotency enforced via DB-level unique constraint (migration 004). Market data provider waterfall certified (5/5 tests). 13/13 Phase 3B.2 Go/No-Go decisions evaluated.  
> See `PHASE3B2_CERTIFICATION_REPORT.md` for the complete audit.  
> Previous phase reports: `docs/PHASE3A_RUNTIME_CERTIFICATION_REPORT.md` (Phase 3A), `PHASE3B_PREFLIGHT_REPORT.md` (Phase 3B preflight).

### Pipeline Overview

```
Raw News (4 active sources)
  ↓
Ingestion Scheduler  ←  CircuitBreaker + RateLimiter + SSRF Guard
  ↓  news.raw (BullMQ)
normalize.worker    → HTML strip · language detect · SHA-256 hash · taxonomy · content_depth
  ↓  news.normalized
dedup.worker        → exact hash · near-duplicate · NewsCluster assignment
  ↓  news.deduplicated
entity.worker       → NER · InstrumentIndex (34K instruments) · asset/sector links
  ↓  news.entities
event.worker        → 14 event types · surprise score
  ↓  news.events
sentiment.worker    → 5 sentiment dimensions · 9 qualitative signals
  ↓  news.sentiment
impact.worker       → ImportanceEngine (9 sub-scores) · MarketImpactEngine
  ↓  news.impact
feature.worker      → HistoricalReactionEngine · FeatureEngineeringEngine · LookAheadGuard
  ↓  news.features
embed.worker        → OpenAI embeddings (non-blocking; SKIPPED if no API key)
  ↓
AlphaForge API  /  ml-service  /  Admin API
```

---

## Phase History

| Phase | Date | Status | Summary |
|---|---|---|---|
| Phase 2 | 2026-09-15 | ✅ Complete | Validation report — core pipeline functional |
| Phase 3A | 2026-09-15 | ✅ Certified | Runtime cert; 4 live sources; InstrumentIndex; MlServiceClient; DataFreshness; 464 tests |
| Phase 3B Preflight | 2026-09-16 | ✅ Complete | LookAheadGuard redesign (BUG-LAG-1 fixed); DataServiceClient timestamp fix; 2 critical bugs resolved |
| Phase 3B.1 | 2026-09-17 | ✅ Certified | RXN-G1 interval fix; OHLCVResponse envelope; prediction_timestamp + feature_as_of + label_bar_timestamps persisted; provider metadata; 578 tests |
| Phase 3B.2 | 2026-09-18 | ✅ Certified | 3 data-service root causes fixed (RC-1/RC-2/RC-3); full intraday OHLCV for 8 instruments × 4 intervals; training idempotency (migration 004 + upsert); pilot probe 37/40 daily sessions |
| Phase 3B.3 | TBD | 🔜 Pending | Rebuild data-service Docker image; Jan 2024 news ingestion; historical reactions; 7-day pilot |

---

## Prerequisites

| Dependency | Version | Notes |
|---|---|---|
| Node.js | ≥ 20 LTS | Use nvm: `nvm use 20` |
| PostgreSQL | 16 + pgvector | Must have `vector` extension; shared with AlphaForge stack |
| Redis | 7 | Shared with AlphaForge in the local dev stack |
| Docker & Docker Compose | Latest stable | For the full containerised stack |
| Python | 3.11+ | Powers the Scrapling sidecar |
| data-service | v2.0.0+ | Provides OHLCV + InstrumentMaster; Angel One & Upstox credentials required for intraday |

---

## Running with Docker (Recommended)

The Docker stack manages the API, all 8 workers, 3 cron processes, and the Scrapling sidecar as named `sentinel-pulse-*` containers. PostgreSQL and Redis are provided by the existing AlphaForge stack — no separate infra containers needed.

### One-time setup

```bash
# 1. Clone and install
git clone https://github.com/manishhansal/SentinelPulse.git
cd SentinelPulse
npm install

# 2. Configure environment (copy template then fill in secrets)
cp .env.example .env.local
# Edit .env.local — the defaults work for the AlphaForge local dev stack

# 3. Build all images
npm run docker:build
```

### Start the stack

```bash
# Start everything (migrations run automatically inside the api container)
npm run docker:up

# Seed news sources (first time only — idempotent, safe to re-run)
docker compose -f docker/docker-compose.yml --env-file .env.local \
  run --rm scheduler node dist/scripts/seed-sources.js
```

### Verify

```bash
# Show all running containers
npm run docker:ps

# API health checks
curl http://localhost:3001/health
# → {"status":"alive","timestamp":"..."}

curl http://localhost:3001/ready
# → {"status":"ready","checks":{"postgres":"ok","redis":"ok","tier1_sources":"ok"}}

# Scrapling sidecar
curl http://localhost:8001/health
# → {"status":"healthy"}
```

### Logs

```bash
# All services, live tail
npm run docker:logs

# Single service
docker compose -f docker/docker-compose.yml --env-file .env.local logs -f api
docker compose -f docker/docker-compose.yml --env-file .env.local logs -f scheduler
docker compose -f docker/docker-compose.yml --env-file .env.local logs -f worker-normalize

# Multiple services at once
docker compose -f docker/docker-compose.yml --env-file .env.local \
  logs -f api worker-normalize worker-dedup worker-entity

# All workers
docker compose -f docker/docker-compose.yml --env-file .env.local \
  logs -f worker-normalize worker-dedup worker-entity worker-event \
         worker-sentiment worker-impact worker-feature worker-embed

# Last N lines (snapshot, no follow)
docker compose -f docker/docker-compose.yml --env-file .env.local logs --tail=100 api

# With timestamps
docker compose -f docker/docker-compose.yml --env-file .env.local logs -f -t api

# Since a point in time
docker compose -f docker/docker-compose.yml --env-file .env.local logs --since=30m api

# Raw docker logs by container name
docker logs sentinel-pulse-api-1 -f
docker logs sentinel-pulse-scheduler-1 --tail=50
docker logs sentinel-pulse-worker-normalize-1 -f
```

> **Tip:** Add this alias to `~/.zshrc` to avoid typing the full path each time:
> ```bash
> alias sp="docker compose -f $(pwd)/docker/docker-compose.yml --env-file $(pwd)/.env.local"
> # Then: sp logs -f api   /   sp ps   /   sp down
> ```

### Stop / restart

```bash
# Stop all containers (data is preserved in external postgres/redis)
npm run docker:down

# Restart a single service
docker compose -f docker/docker-compose.yml --env-file .env.local restart api
docker compose -f docker/docker-compose.yml --env-file .env.local restart worker-normalize

# Rebuild and restart after code changes
npm run docker:build && npm run docker:up

# Scale a worker horizontally
docker compose -f docker/docker-compose.yml --env-file .env.local \
  up -d --scale worker-normalize=3
```

---

## Local Development (without Docker)

Use this when you want hot-reload and fast iteration without rebuilding images.

### 1. Clone and install

```bash
git clone https://github.com/manishhansal/SentinelPulse.git
cd SentinelPulse
npm install
```

### 2. Set up environment

```bash
cp .env.example .env.local
# Edit .env.local — use localhost URLs for local dev (not host.docker.internal)
# DATABASE_URL=postgresql://sentinel:sentinel_dev@localhost:5444/sentinel_pulse
# REDIS_URL=redis://localhost:6379
```

### 3. Verify infrastructure is running

```bash
# PostgreSQL on 5444 and Redis on 6379 must be up (from AlphaForge stack)
docker ps | grep -E "postgres|redis"
```

### 4. Run migrations and seed

```bash
set -a && source .env.local && set +a

npm run prisma:migrate   # applies pending migrations
npm run prisma:generate  # regenerates Prisma client
npm run seed             # idempotent — inserts news_sources rows
```

### 5. Start the Scrapling sidecar

```bash
cd docker
pip3 install fastapi uvicorn scrapling httpx
python3 -m uvicorn scrapling_service:app --host 0.0.0.0 --port 8001
# Verify: curl http://localhost:8001/health → {"status":"healthy"}
```

### 6. Start the API server

```bash
set -a && source .env.local && set +a
npm run dev
# API running at http://localhost:3001
```

### 7. Start workers (each in its own terminal)

```bash
set -a && source .env.local && set +a

npm run worker:normalize
npm run worker:dedup
npm run worker:entity
npm run worker:event
npm run worker:sentiment
npm run worker:impact
npm run worker:feature
npm run worker:embed
```

### 8. Start the scheduler

```bash
set -a && source .env.local && set +a
NEWS_SOURCE_COINDESK_ENABLED=true npm run scheduler
# Fetches articles every 60s and publishes to news.raw queue
```

### 9. Start crons (optional — run in background or separate terminals)

```bash
set -a && source .env.local && set +a

npm run cron:velocity  # recalculates news velocity every 60s
npm run cron:breadth   # recalculates market breadth every 5 min
npm run cron:regime    # updates market regime classification every 15 min
```

---

## Quick Start with PM2

PM2 manages all processes in one command with automatic restarts.

```bash
npm install -g pm2
```

Create `ecosystem.config.cjs` in the project root:

```js
module.exports = {
  apps: [
    { name: 'sentinel-api',       script: 'npx', args: 'tsx src/server.ts',
      env_file: '.env.local', env: { PORT: '3001' } },
    { name: 'worker-normalize',   script: 'npx', args: 'tsx src/workers/normalize.worker.ts',   env_file: '.env.local' },
    { name: 'worker-dedup',       script: 'npx', args: 'tsx src/workers/dedup.worker.ts',       env_file: '.env.local' },
    { name: 'worker-entity',      script: 'npx', args: 'tsx src/workers/entity.worker.ts',      env_file: '.env.local' },
    { name: 'worker-event',       script: 'npx', args: 'tsx src/workers/event.worker.ts',       env_file: '.env.local' },
    { name: 'worker-sentiment',   script: 'npx', args: 'tsx src/workers/sentiment.worker.ts',   env_file: '.env.local' },
    { name: 'worker-impact',      script: 'npx', args: 'tsx src/workers/impact.worker.ts',      env_file: '.env.local' },
    { name: 'worker-feature',     script: 'npx', args: 'tsx src/workers/feature.worker.ts',     env_file: '.env.local' },
    { name: 'worker-embed',       script: 'npx', args: 'tsx src/workers/embed.worker.ts',       env_file: '.env.local' },
    { name: 'scheduler',          script: 'npx', args: 'tsx src/scripts/run-scheduler.ts',
      env_file: '.env.local', env: { NEWS_SOURCE_COINDESK_ENABLED: 'true' } },
    { name: 'cron-velocity',      script: 'npx', args: 'tsx src/engines/velocity/velocity-cron.ts',         env_file: '.env.local' },
    { name: 'cron-breadth',       script: 'npx', args: 'tsx src/engines/breadth/breadth-cron.ts',           env_file: '.env.local' },
    { name: 'cron-regime',        script: 'npx', args: 'tsx src/engines/market-regime/regime-cron.ts',      env_file: '.env.local' },
  ]
};
```

```bash
pm2 start ecosystem.config.cjs   # start everything
pm2 status                        # show process table
pm2 logs                          # tail all logs
pm2 logs sentinel-api             # API logs only
pm2 logs worker-normalize         # single worker
pm2 restart all                   # restart everything
pm2 stop all                      # stop everything
pm2 delete all                    # remove from pm2 list
```

---

## Available Scripts

### Application

| Script | Command | Description |
|---|---|---|
| `npm run dev` | `tsx watch src/server.ts` | API with hot reload (port 3001) |
| `npm start` | `node dist/server.js` | API from compiled dist (production) |
| `npm run build` | `tsc` | Compile TypeScript → `dist/` |

### Workers

| Script | Description |
|---|---|
| `npm run worker:normalize` | normalize.worker — raw → normalized |
| `npm run worker:dedup` | dedup.worker — normalized → deduplicated |
| `npm run worker:entity` | entity.worker — deduplicated → entities |
| `npm run worker:event` | event.worker — entities → events |
| `npm run worker:sentiment` | sentiment.worker — events → sentiment |
| `npm run worker:impact` | impact.worker — sentiment → impact |
| `npm run worker:feature` | feature.worker — impact → features |
| `npm run worker:embed` | embed.worker — features → embeddings |

### Background processes

| Script | Description |
|---|---|
| `npm run scheduler` | Ingestion scheduler — polls sources every 60s |
| `npm run cron:velocity` | News velocity recalculation — every 60s |
| `npm run cron:breadth` | Market breadth recalculation — every 5 min |
| `npm run cron:regime` | Market regime classification — every 15 min |

### Docker

| Script | Description |
|---|---|
| `npm run docker:build` | Build all Docker images |
| `npm run docker:up` | Start all containers in background |
| `npm run docker:down` | Stop and remove all containers |
| `npm run docker:ps` | Show container status |
| `npm run docker:logs` | Tail all container logs |

### Database

| Script | Description |
|---|---|
| `npm run prisma:migrate` | Apply pending migrations |
| `npm run prisma:generate` | Regenerate Prisma client after schema changes |
| `npm run prisma:studio` | Open Prisma Studio GUI at localhost:5555 |
| `npm run seed` | Seed `news_sources` table (idempotent) |

### Testing & quality

| Script | Description |
|---|---|
| `npm test` | Full test suite (578 tests) |
| `npm run test:watch` | Tests in watch mode |
| `npm run test:coverage` | Tests with coverage report |
| `npm run test:lookahead` | Look-ahead bias scan (requires DB) |
| `npm run lint` | ESLint check |
| `npm run lint:fix` | ESLint auto-fix |

---

## Verifying the Stack is Healthy

```bash
# API liveness
curl http://localhost:3001/health
# → {"status":"alive","timestamp":"..."}

# Full readiness (postgres + redis + tier-1 sources reachable)
curl http://localhost:3001/ready
# → {"status":"ready","checks":{"postgres":"ok","redis":"ok","tier1_sources":"ok"}}

# Prometheus metrics
curl http://localhost:3001/metrics | head -20

# Scrapling sidecar
curl http://localhost:8001/health
# → {"status":"healthy"}

# Source health and circuit breaker states
KEY="dev-local-api-key-change-before-sharing"
curl -s -H "Authorization: Bearer $KEY" \
  http://localhost:3001/api/v1/admin/sources | python3 -m json.tool

# Data quality metrics (trailing 24h)
curl -s -H "Authorization: Bearer $KEY" \
  http://localhost:3001/api/v1/admin/data-quality | python3 -m json.tool
```

---

## Debugging

### Pipeline smoke test (inline — no queues)

```bash
KEY="dev-local-api-key-change-before-sharing"
curl -s -X POST http://localhost:3001/api/v1/admin/test/pipeline \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"source_id":"reuters"}' | python3 -m json.tool
# Returns per-stage results + complete lineage in ~200ms
```

### Trace an article's lineage

```bash
KEY="dev-local-api-key-change-before-sharing"
ARTICLE_ID="<uuid from news_articles>"
curl -s -H "Authorization: Bearer $KEY" \
  http://localhost:3001/api/v1/admin/lineage/$ARTICLE_ID | python3 -m json.tool
```

### Check queue depths in Redis

```bash
docker exec alpha-forge-redis redis-cli

# Queue depths
LLEN bull:news.raw:wait
LLEN bull:news.normalized:wait
ZCARD bull:news.deduplicated:active
ZCARD bull:news.sentiment:failed     # non-zero = worker issue
ZCARD bull:news.features:failed
```

### Look-ahead bias check

```bash
set -a && source .env.local && set +a
npm run test:lookahead
# → PASSED: N FeatureVector(s) checked, 0 violations.
```

---

## Database Access

### Direct psql (via Docker)

```bash
docker exec -it data-service-postgres psql -U sentinel -d sentinel_pulse

# Useful queries once connected:
\dt                           -- list all tables
\d news_articles              -- describe a table

SELECT
  (SELECT COUNT(*) FROM news_articles)        AS articles,
  (SELECT COUNT(*) FROM news_events)           AS events,
  (SELECT COUNT(*) FROM news_sentiment)        AS sentiment,
  (SELECT COUNT(*) FROM news_importance)       AS importance,
  (SELECT COUNT(*) FROM news_entity_mentions)  AS entity_mentions,
  (SELECT COUNT(*) FROM news_asset_links)      AS asset_links,
  (SELECT COUNT(*) FROM news_market_impacts)   AS market_impacts,
  (SELECT COUNT(*) FROM news_features)         AS features;

SELECT source_id, COUNT(*) AS cnt
FROM news_articles GROUP BY source_id ORDER BY cnt DESC;

SELECT e.event_type, e.actor, i.importance_score
FROM news_events e JOIN news_importance i ON i.event_id = e.id
WHERE i.importance_score > 0.5
ORDER BY i.importance_score DESC LIMIT 10;

SELECT COUNT(*) AS violations FROM news_features f
JOIN news_events e ON e.id = f.event_id
WHERE f.computed_at > e.event_timestamp;
```

### Prisma Studio (GUI)

```bash
set -a && source .env.local && set +a
npm run prisma:studio
# Opens at http://localhost:5555
```

### Migrations

```bash
set -a && source .env.local && set +a
npm run prisma:migrate    # apply pending (4 migrations: 001 initial, 002 content_depth, 003 pit_auditability, 004 training_sample_uniqueness)
npm run prisma:generate   # regenerate client after schema change
```

---

## Environment Configuration

| File | Purpose |
|---|---|
| `.env.example` | Committed template — safe to commit |
| `.env.local` | Local dev values — **never commit** |
| `.env.production` | Production template — **never commit with real secrets** |

### Critical variables

| Variable | Local dev value | Notes |
|---|---|---|
| `DATABASE_URL` | `postgresql://sentinel:sentinel_dev@localhost:5444/sentinel_pulse` | Use `host.docker.internal` instead of `localhost` when running in Docker |
| `REDIS_URL` | `redis://localhost:6379` | Same — use `host.docker.internal` in Docker |
| `SENTINEL_API_KEY` | `dev-local-api-key-change-before-sharing` | Any value works locally |
| `DATA_SERVICE_URL` | `http://localhost:8200` | Use `host.docker.internal` in Docker |
| `ML_SERVICE_URL` | `http://localhost:8100` | Use `host.docker.internal` in Docker |
| `SCRAPLING_URL` | `http://localhost:8001` | Use `http://scrapling:8001` in Docker |
| `PORT` | `3001` | AlphaForge owns port 3000 |

See `docs/OPERATIONS.md` for the full variable reference.

---

## Testing

```bash
npm test                        # full suite (578 tests)
npm run test:watch              # watch mode
npm run test:coverage           # coverage report
npm run test:lookahead          # look-ahead bias scan against live DB
npx vitest run tests/property/  # property-based tests only
npx vitest run tests/integration/
```

---

## API Quick Reference

Base URL: `http://localhost:3001/api/v1`  
Auth: `Authorization: Bearer {SENTINEL_API_KEY}`

| Group | Key Endpoints |
|---|---|
| News | `GET /news/latest` · `GET /news/assets/:id` · `GET /news/events/:id` · `GET /news/regime` · `GET /news/search` |
| AlphaForge | `GET /alphaforge/news-context/:instrument` · `GET /alphaforge/high-impact-events` |
| ML | `GET /ml/features/asset/:id` · `GET /ml/training/samples` · `GET /ml/training/samples/:id/lineage` |
| Admin | `GET /admin/sources` · `GET /admin/ingestion` · `GET /admin/data-quality` |
| Phase 3A | `POST /admin/test/pipeline` · `GET /admin/lineage/:articleId` |
| Health | `GET /health` · `GET /ready` · `GET /metrics` |

See `API.md` for the full reference.

---

## Key Design Principles

1. **Not a scraper.** Raw news is input. The product is structured, calibrated intelligence.
2. **No look-ahead bias, ever.** `LookAheadGuard` validates `information_as_of` (not `computed_at`) against `event_timestamp` at runtime and in CI. Historical backfill is safe.
3. **News is one factor, not a trading signal.** SentinelPulse never produces BUY/SELL/HOLD.
4. **Full traceability.** Every TrainingSample links back to its raw article via `GET /ml/training/samples/:id/lineage`.
5. **Source isolation.** One failing source cannot stall the pipeline (CircuitBreaker per adapter).
6. **Content depth matters.** Reuters (HEADLINE_ONLY, quality 0.25) vs ET (SUMMARY, quality 0.5) — source confidence is weighted: `source_reliability × 0.6 + content_quality_score × 0.4`.
7. **Idempotent dataset generation.** `MLDatasetGenerator` uses upsert keyed on `(event_id, asset_id, prediction_timestamp, feature_version)` — calling `generate()` twice produces exactly one row (enforced at the DB level via `uq_training_sample_identity`).
8. **Point-in-time correct labels.** `prediction_timestamp`, `feature_as_of`, and `label_bar_timestamps` are persisted with every training sample so PIT audits are fully reproducible.

---

## Documentation

### Core References

| Document | Description |
|---|---|
| `API.md` | REST API reference — all endpoints, parameters, curl examples |
| `DEPLOYMENT.md` | Deployment guide — GitHub Actions CD, self-hosted git hook, Makefile targets |
| `docs/ARCHITECTURE.md` | Component diagram, worker/queue topology, data flow |
| `docs/DATA_MODEL.md` | All DB tables with column documentation (includes migration 001–004) |
| `docs/ML_FEATURES.md` | FeatureVector schema, 7 feature groups, formulas, PIT guarantees |
| `docs/OPERATIONS.md` | Env var reference, scaling guide, cron schedules, retention |
| `docs/BACKFILL.md` | Historical data backfill guide |
| `docs/SOURCE_ADAPTERS.md` | Per-source adapter configuration and content depth |
| `docs/TROUBLESHOOTING.md` | Failure runbooks |

### Integration Contracts

| Document | Description |
|---|---|
| `docs/ALPHAFORGE_SENTINELPULSE_CONTRACT.md` | Phase 3A — definitive AlphaForge integration contract |
| `docs/ALPHAFORGE_INTEGRATION.md` | AlphaForge integration guide |
| `docs/SENTINELPULSE_ML_FEATURE_CONTRACT.md` | Phase 3A — ML feature contract v1.0.0 |
| `docs/TEMPORAL_DATA_CONTRACT.md` | Phase 3B preflight — temporal/PIT data contract |

### Certification Reports (latest first)

| Document | Description |
|---|---|
| `PHASE3B2_CERTIFICATION_REPORT.md` | **Phase 3B.2** — Data-service intraday recovery; training idempotency; 3 root causes fixed; 13/13 Go/No-Go decisions; 578/578 tests |
| `RUNTIME_60MIN_CERTIFICATION.md` | Phase 3B.1 — 60-minute runtime certification template (preconditions met; test pending) |
| `PHASE3B_PREFLIGHT_REPORT.md` | Phase 3B preflight — 14 pre-ML checks; LookAheadGuard redesign; 2 critical bugs fixed |
| `docs/MARKET_DATA_FINAL_CERTIFICATION.md` | Phase 3B.1 — Provider waterfall, OHLCVResponse contract, timestamp semantics |
| `docs/HISTORICAL_REACTION_FINAL_CERTIFICATION.md` | Phase 3B.1 — RXN-G1 fix, 27 reaction tests, provider metadata |
| `docs/TRAINING_DATASET_CERTIFICATION.md` | Phase 3B.1 — PIT dataset, prediction_timestamp, feature_as_of |
| `docs/POINT_IN_TIME_DATASET_CERTIFICATION.md` | Phase 3B preflight — PIT SQL audit |
| `docs/PHASE3A_RUNTIME_CERTIFICATION_REPORT.md` | Phase 3A — full runtime certification (2026-09-15) |
| `docs/PHASE3A_SMOKE_TEST.md` | Phase 3A — smoke test results |
| `docs/PHASE3A_PIPELINE_METRICS.md` | Phase 3A — stage dropoff metrics |
| `docs/PHASE3A_IMPLEMENTATION_MATRIX.md` | Phase 3A — component classification |
| `docs/PHASE2_VALIDATION_REPORT.md` | Phase 2 — validation report (2026-09-15) |

### Phase 3B Preflight Audit Documents

| Document | Description |
|---|---|
| `docs/ENTITY_RESOLUTION_CERTIFICATION.md` | Entity resolution coverage audit |
| `docs/EVENT_CLASSIFICATION_AUDIT.md` | Event classification false-negative analysis |
| `docs/NEWS_CONTENT_QUALITY_AUDIT.md` | Content depth and quality score audit |
| `docs/HISTORICAL_REACTION_CERTIFICATION.md` | Historical reaction engine audit (preflight version) |
| `docs/MARKET_DATA_CERTIFICATION.md` | Market data availability audit (preflight version) |

---

## License

Proprietary — AlphaForge internal use only.
