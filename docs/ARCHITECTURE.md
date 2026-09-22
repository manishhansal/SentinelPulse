# SentinelPulse Architecture

## Transformation Pipeline

SentinelPulse sits between raw financial news feeds and the AlphaForge signal engine. Its role is strictly transformation — it does not generate trading signals.

The pipeline is a linear sequence of enrichment stages, each publishing to the next via BullMQ:

```
Raw News
  │
  ▼  news.raw
[NormalizationEngine]     — strip HTML, detect language, compute hashes, assign taxonomy
  │
  ▼  news.normalized
[DeduplicationEngine]     — exact-match (URL/hash) + near-duplicate (Jaro-Winkler / cosine)
  │                         collapse into NewsCluster records
  ▼  news.deduplicated
[EntityResolutionEngine]  — extract Company/Instrument/Index/Commodity/Currency/Country/Institution
  │                         resolve to AlphaForge InstrumentMaster IDs
  ▼  news.entities
[EventDetectionEngine]    — extract structured NewsEvents with type, actor, surprise score
  │
  ▼  news.events
[SentimentEngine]         — 5-dimensional sentiment (overall, market, company, macro, risk)
  │
  ▼  news.sentiment
[ImportanceEngine]        — 9-sub-score weighted importance_score (0–1)
  │
  ▼ (inline)
[MarketImpactEngine]      — directional impact per (event, asset), NewsImpactScore –100…+100
  │
  ▼  news.impact
[HistoricalReactionEngine]— actual price/volume responses at –15m…+1d offsets via data-service
  │
  ▼ (inline)
[FeatureEngineeringEngine]— point-in-time correct FeatureVector (importance > 0.3 events only)
  │
  ▼  news.features
[MLDatasetGenerator]      — join FeatureVectors with forward returns → TrainingSample records
```

Simultaneously, the `EmbeddingEngine` generates `vector(1536)` embeddings for articles, events, and entities, stored in `news_embeddings` via pgvector.

---

## Component Diagram

```mermaid
graph TB
    subgraph External["External Sources"]
        RSS1[Reuters RSS]
        RSS2[Moneycontrol RSS]
        RSS3[EconomicTimes RSS]
        API1[Bloomberg API]
        API2[FT CAPI]
        RSS4[CoinDesk RSS]
    end

    subgraph Adapters["Source Adapters"]
        RA[ReutersAdapter Tier-1]
        MA[MoneycontrolAdapter Tier-1]
        ETA[EconomicTimesAdapter Tier-1]
        BA[BloombergAdapter Tier-2]
        FTA[FinancialTimesAdapter Tier-2]
        CA[CoinDeskAdapter Tier-2]
    end

    subgraph Ingestion["Ingestion Engine"]
        SCHED[Scheduler]
        CB[CircuitBreaker Registry]
        RL[RateLimiter Registry]
    end

    subgraph Pipeline["Processing Pipeline"]
        W_NORM[normalize-worker]
        W_DEDUP[dedup-worker]
        W_ENT[entity-worker]
        W_EVT[event-worker]
        W_SENT[sentiment-worker]
        W_IMP[impact-worker]
        W_FEAT[feature-worker]
        W_EMB[embed-worker]
    end

    subgraph Storage["Persistence"]
        PG[(PostgreSQL 16\n+ pgvector)]
        RD[(Redis 7)]
    end

    subgraph API["REST API Fastify"]
        N[/api/v1/news]
        AF[/api/v1/alphaforge]
        ML[/api/v1/ml]
        ADM[/api/v1/admin]
    end

    subgraph Upstream["Upstream Services"]
        DS[data-service\nOHLCV + InstrumentMaster]
        AlphaForge[AlphaForge Signal Engine]
        MLS[ml-service]
    end

    External --> Adapters --> Ingestion
    Ingestion --> W_NORM --> W_DEDUP --> W_ENT --> W_EVT
    W_EVT --> W_SENT --> W_IMP --> W_FEAT
    W_FEAT --> PG
    W_EMB --> PG
    Pipeline --> PG
    Pipeline --> DS
    PG --> API
    RD --> API
    API --> AlphaForge
    API --> MLS
```

---

## Worker / Queue Topology

Every pipeline stage is an independently scalable BullMQ worker. Concurrency is tuned via `WORKER_{NAME}_CONCURRENCY` env vars.

```
Tier-1 sources (Reuters, Moneycontrol, EconomicTimes)  ─┐
Tier-2 sources (Bloomberg, FT, CoinDesk)               ─┤──► news.raw
                                                          │
                                              news-normalize-worker (WORKER_NORMALIZE_CONCURRENCY)
                                                          │
                                                    news.normalized
                                                          │
                                              news-dedup-worker (WORKER_DEDUP_CONCURRENCY)
                                                          │
                                                  news.deduplicated
                                                          │
                                              news-entity-worker (WORKER_ENTITY_CONCURRENCY)
                                                          │
                                                    news.entities
                                                          │
                                              news-event-worker (WORKER_EVENT_CONCURRENCY)
                                                          │
                                                    news.events
                                                          │
                                             news-sentiment-worker (WORKER_SENTIMENT_CONCURRENCY)
                                                          │
                                                   news.sentiment
                                                          │
                                              news-impact-worker (WORKER_IMPACT_CONCURRENCY)
                                                          │
                                                    news.impact
                                                          │
                                             news-feature-worker (WORKER_FEATURE_CONCURRENCY)
                                                          │
                                                   news.features
```

**Dead-letter queues**: Each stage has a `news.{stage}.deadletter` queue. Jobs move there after exhausting 3 retry attempts (exponential backoff starting at 1 s).

**Special queues**:
- `news.embeddings` — fed by EmbeddingEngine; consumed by `news-embed-worker` (WORKER_EMBED_CONCURRENCY)
- `news.backfill` — fed by BackfillEngine; max 20% of total live-pipeline worker concurrency

---

## Service Dependencies

| Dependency | Protocol | Purpose | Fallback |
|-----------|----------|---------|---------|
| PostgreSQL 16 + pgvector | Prisma ORM | Primary state store for all pipeline outputs | None — service marks not-ready |
| Redis 7 | ioredis | BullMQ queues + response cache | Direct PG queries; log WARN |
| data-service | HTTP REST | OHLCV, InstrumentMaster, RegimeSignals | Nulls in reaction/feature records; log WARN |
| Scrapling sidecar | HTTP REST (POST /scrape) | HTML extraction for sources without official feeds | Fetch treated as failed; CircuitBreaker tracks |
| Embedding model API | HTTP REST | Vector generation for articles/events/entities | Enqueue retry in news.embeddings with exponential backoff |

SentinelPulse is a **read-only consumer** of `data-service`. It never writes to data-service databases.

---

## Deployment Topology

```
┌─────────────────────────────────────────────────────────┐
│  Docker Host / Kubernetes Namespace                      │
│                                                           │
│  ┌──────────────┐   ┌──────────────┐   ┌─────────────┐  │
│  │  API Server   │   │  Workers (N)  │   │  Scrapling  │  │
│  │  (Fastify)    │   │  (BullMQ)     │   │  Sidecar    │  │
│  │  Port 3000    │   │               │   │  Port 8001  │  │
│  └──────┬───────┘   └──────┬────────┘   └─────────────┘  │
│         │                   │                              │
│  ┌──────▼───────────────────▼──────┐                      │
│  │        Redis 7 (Port 6379)       │                      │
│  │  Queues + Cache                  │                      │
│  └──────────────────────────────────┘                      │
│                                                           │
│  ┌─────────────────────────────────┐                      │
│  │   PostgreSQL 16 + pgvector       │                      │
│  │   Port 5432                       │                      │
│  └─────────────────────────────────┘                      │
└─────────────────────────────────────────────────────────┘
         │                        │
         ▼                        ▼
   data-service             AlphaForge / ml-service
   (external)               (external)
```

The API server and workers are stateless — they hold no in-process state beyond per-request lifecycle. All job state is stored in Redis (BullMQ) and all persistent state is stored in PostgreSQL. This enables horizontal scaling of both the API tier and individual workers independently.

---

## Ingestion Scheduling

The Scheduler runs an independent `setInterval` loop per source. Within each cycle:

1. All enabled **Tier-1** sources are polled sequentially (Reuters → Moneycontrol → EconomicTimes). Tier-2 sources do not start until all Tier-1 polling is complete or has returned non-healthy.
2. Before each fetch: check CircuitBreaker state (skip if OPEN), run `healthCheck()` (skip + increment failure counter on non-healthy).
3. Successful articles are published to `news.raw`.

Each source's poll interval is configurable via `NEWS_SOURCE_{NAME}_POLL_INTERVAL_MS`.

---

## CircuitBreaker State Machine

```mermaid
stateDiagram-v2
    [*] --> CLOSED
    CLOSED --> OPEN: consecutive failures >= threshold (default 5)
    OPEN --> HALF_OPEN: recovery timeout elapsed (default 60s)
    HALF_OPEN --> CLOSED: probe fetch succeeds
    HALF_OPEN --> OPEN: probe fetch fails (reset timeout)
```

Each source has its own isolated CircuitBreaker instance. Configuration is set via `CB_FAILURE_THRESHOLD` and `CB_RECOVERY_TIMEOUT_MS`.

---

## Phase 3A Architecture Changes

### New Components

| Component | File | Purpose |
|---|---|---|
| `InstrumentIndex` | `src/engines/entity/InstrumentIndex.ts` | Singleton O(1) lookup index over 34K data-service instruments. Built-in alias map (~120 entries) + periodic sync from `GET /v1/instruments`. Used by EntityResolutionEngine before falling back to DataServiceClient HTTP calls. |
| `MlServiceClient` | `src/integrations/ml-service/MlServiceClient.ts` | Typed HTTP client for `ml-service POST /predict/regime`. Replaces the broken `DataServiceClient.getRegimeSignals()` (which always returned `[]`). |
| `DataFreshness` | `src/engines/feature-engineering/DataFreshness.ts` | Stateless utility for computing FRESH/STALE/EXPIRED/UNAVAILABLE freshness states. Attached to every feature vector via `FreshnessMetadata`. |
| `src/server.ts` | `src/server.ts` | Entry point that calls `buildApp()` and starts the Fastify server. Handles graceful shutdown on SIGTERM/SIGINT. |
| `src/scripts/run-scheduler.ts` | `src/scripts/run-scheduler.ts` | Standalone scheduler process. Instantiates adapters + Scheduler + rawQueue and starts ingestion. |
| `src/scripts/seed-sources.ts` | `src/scripts/seed-sources.ts` | Idempotent seeder for `news_sources` table. |

### Modified Components

| Component | Change |
|---|---|
| `SsrfGuard` | Added subdomain matching — `www.X.com` now matches parent domain `X.com` in the allowlist. |
| `EmbeddingEngine` | Returns `EmbeddingOutcome` with `embedding_available` and `embedding_status` (COMPLETED/PENDING/SKIPPED/FAILED). Non-blocking — short-circuits immediately when `EMBEDDING_API_KEY` is absent. |
| `NormalizationEngine` | Added `content_depth` (FULL_ARTICLE/SUMMARY/HEADLINE_ONLY) and `content_quality_score` classification. Per-source overrides: Reuters always → HEADLINE_ONLY. |
| `ImportanceEngine` | `fetchSourceReliability()` upgraded to `computeSourceConfidence()` — multi-factor formula: `source_reliability × 0.6 + content_quality_score × 0.4`. |
| `MarketRegimeEngine` | `updateMarket()` now calls `MlServiceClient.predictRegime()` instead of the broken `getRegimeSignals()`. Falls back gracefully when ml-service is unavailable. |
| `EntityResolutionEngine` | 2-layer resolution: InstrumentIndex (O(1), no network) first, then DataServiceClient HTTP lookup for misses. |
| All BullMQ workers | Added explicit Date coercion for `publishedAt` fields (BullMQ JSON-serializes Date→string). Entity/event/sentiment workers now fetch full article from DB using `articleId` (upstream queues publish only `articleId`, not the full article). |
| Admin API | Added `POST /admin/test/pipeline` (inline smoke test) and `GET /admin/lineage/:articleId` (full lineage trace). |

### Content Depth Classification

```
Source                      Content Depth     Quality Score   Source Confidence (example)
Reuters (Google News RSS)   HEADLINE_ONLY     0.25            0.9 × 0.6 + 0.25 × 0.4 = 0.64
Moneycontrol RSS            SUMMARY           0.50            0.85 × 0.6 + 0.5 × 0.4 = 0.71
Economic Times RSS          SUMMARY           0.50            0.85 × 0.6 + 0.5 × 0.4 = 0.71
CoinDesk RSS                SUMMARY           0.50            0.80 × 0.6 + 0.5 × 0.4 = 0.68
Bloomberg API               FULL_ARTICLE      0.90            0.95 × 0.6 + 0.9 × 0.4 = 0.93
Financial Times API         FULL_ARTICLE      0.90            0.95 × 0.6 + 0.9 × 0.4 = 0.93
```

### Regime Integration Architecture

```
BEFORE (broken):
MarketRegimeEngine.updateMarket()
  → DataServiceClient.getRegimeSignals()  [always returned []]
  → classifyRegime([])                     [always returned SIDEWAYS/0.5]

AFTER (Phase 3A):
MarketRegimeEngine.updateMarket()
  → DataServiceClient.getMarketContextSnapshot("NIFTY")   [live quote]
  → DataServiceClient.getMarketContextSnapshot("BANKNIFTY")
  → MlServiceClient.predictRegime(request)                [real ML model]
  → normaliseRegime(prediction.regime)
  → persist + cache
  OR (if unavailable)
  → log WARN, retain cached regime, set regime_data_available=false
```

*Updated: Phase 3A Runtime Certification — 2026-09-15*

---

## Phase 3B.1 Architecture Changes

*Updated: Phase 3B.1 Certification — 2026-09-17*

### Fixes Applied

| Component | Fix | Commit |
|---|---|---|
| `HistoricalReactionEngine.ts` | **RXN-G1**: `intervalForOffset()` now returns `'5m'` for all intraday offsets and `'1d'` for `plus1d`. Previously the engine passed `'1d'` for every offset, producing 0 intraday reactions. | `e651240` |
| `DataServiceClient.ts` | **MKT-BUG-1**: `candle.time * 1000` (epoch ms) replaces `candle.datetime` (undefined string). `OHLCVResponse` envelope now surfaced with `metadata.provider`, `metadata.dataAsOf`, `metadata.quality`. | `41edb0a` |
| `LookAheadGuard.ts` (preflight) | Redesigned to validate `information_as_of` not `computed_at`. | `b82bea2` |
| `DataServiceClient.ts` (preflight) | OHLCV bar timestamp field: `candle.time` (epoch seconds) replaces `candle.datetime`. | `c25eae5` |

### New Schema Fields (Migration 003)

Migration `003_pit_auditability` adds three columns to `news_features` and `news_training_samples`:

| Table | Column | Type | Purpose |
|---|---|---|---|
| `news_features` | `feature_as_of` | `TIMESTAMPTZ` | Latest information timestamp across all data sources for this vector (PIT audit) |
| `news_training_samples` | `prediction_timestamp` | `TIMESTAMPTZ` | Moment at which AlphaForge would generate a signal using these features |
| `news_training_samples` | `label_bar_timestamp_5m` | `TIMESTAMPTZ` | Open time of the 5m bar used for the `return_5m` label |
| `news_training_samples` | `label_bar_timestamp_15m` | `TIMESTAMPTZ` | Open time of the 15m bar used for the `return_15m` label |
| `news_training_samples` | `label_bar_timestamp_1h` | `TIMESTAMPTZ` | Open time of the 1h bar used for the `return_1h` label |
| `news_training_samples` | `label_bar_timestamp_1d` | `TIMESTAMPTZ` | Open time of the 1d bar used for the `return_1d` label |

**PIT invariant enforced in code:**
```
feature_as_of  <=  prediction_timestamp  <  label_cutoff_Xm  <=  label_bar_timestamp_Xm
```

### `MLDatasetGenerator` Changes

`MLDatasetGenerator.persistWithRetry()` now persists:
- `predictionTimestamp` — set to `eventTimestamp` (initial policy)
- `featureAsOf` — passed from `FeatureEngineeringEngine`
- `labelBarTimestamp5m/15m/1h/1d` — the `bar.open_time` of the candle used for each forward-return label

---

## Phase 3B.2 Architecture Changes

*Updated: Phase 3B.2 Certification — 2026-09-18*

### Root Causes Fixed (data-service side)

Three independent root causes were identified and fixed in `data-service2.0`:

| ID | Root Cause | Fix Location |
|---|---|---|
| RC-1 | Upstox candle key mismatch: adapter returns `"timestamp"`, engine reads `"time"` → all IDX bars silently discarded | `data-service2.0/src/engines/historical_engine.py` — key normalisation in `_fetch_candles()` |
| RC-2 | Redis checkpoint blocked historical backfill: checkpoint at 2026-09-16 advanced `from_ts` past Jan 2024 `to_ts` → 0 bars | `data-service2.0/src/api/india.py` — added `force: bool` + `clear_checkpoint()` method |
| RC-3 | Upstox tokens missing from Docker container env → `upstox_adapter = None` for all workers | `data-service2.0/docker-compose.yml` — added `UPSTOX_ACCESS_TOKEN` + `UPSTOX_ANALYTICS_KEY` to all service definitions |

### `pilot-reaction-test.ts` Date Truncation Fix

`DataServiceClient.getOHLCV()` truncates both `from` and `to` to `YYYY-MM-DD`. When `from = to = "2024-01-08"`, data-service returns HTTP 400. Fix: `to = next calendar day`, `asOf = next day +10:15 UTC`.

### New Schema: Migration 004 — Training Sample Uniqueness

Migration `004_training_sample_uniqueness` adds a database-level unique constraint:

```sql
ALTER TABLE news_training_samples
    ADD CONSTRAINT uq_training_sample_identity
    UNIQUE (event_id, asset_id, prediction_timestamp, feature_version);
```

A deduplication `DELETE` runs before `ADD CONSTRAINT` so it applies cleanly to existing rows.

**Prisma model change:**
```prisma
@@unique([eventId, assetId, predictionTimestamp, featureVersion], name: "uq_training_sample_identity")
```

### `MLDatasetGenerator` — Idempotent Upsert

`prisma.newsTrainingSample.create()` replaced with `.upsert()` keyed on `uq_training_sample_identity`:

```typescript
await (prisma.newsTrainingSample as any).upsert({
  where: { uq_training_sample_identity: { eventId, assetId, predictionTimestamp, featureVersion } },
  create: { id: sample.id, eventId, assetId, ...sampleData },
  update: { ...sampleData },  // identity fields immutable once written
});
```

Calling `generate()` twice for the same (event, asset) pair now produces exactly one row.

### Schema Migrations Summary

| Migration | Description | Phase |
|---|---|---|
| `001_initial_schema` | Full initial schema (23 tables, pgvector HNSW index) | Initial |
| `002_content_depth_freshness` | `content_depth`, `content_quality_score`, `freshness_state` columns | Phase 3A |
| `003_pit_auditability` | `feature_as_of`, `prediction_timestamp`, `label_bar_timestamps` | Phase 3B.1 |
| `004_training_sample_uniqueness` | `uq_training_sample_identity` unique constraint + dedup | Phase 3B.2 |

### Provider Waterfall (Certified Phase 3B.2)

```
Angel One SmartAPI (EQ primary)  → RELIANCE/TCS/HDFCBANK/ICICIBANK/SBIN/INFY  all intervals
Upstox V3 (IDX primary)          → NIFTY/BANKNIFTY  all intervals (was broken until RC-1/RC-3 fix)
Yahoo Finance (1d fallback)       → EQ/IDX 1d when Angel One/Upstox return empty
null / empty                      → no synthetic data (guaranteed)
```

`force_provider` parameter on `BackfillRequest` enables explicit provider selection for testing and backfill operations.
