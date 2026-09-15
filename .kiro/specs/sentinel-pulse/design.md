# SentinelPulse — Technical Design Document

## Overview

SentinelPulse is a production-grade market intelligence and news impact engine that sits between raw financial news feeds and the AlphaForge signal engine. It does not generate trading decisions; it transforms unstructured news into structured, evidence-backed signals that feed AlphaForge's multi-factor model.

The end-to-end transformation is:

```
Raw News → NormalizedArticle → Deduplicated NewsCluster → Entities
→ NewsEvents → Sentiment → Importance → MarketImpact → HistoricalReaction
→ FeatureVector → TrainingSample → AlphaForge / ml-service
```

### Technology Stack

| Concern | Technology |
|---|---|
| Runtime | Node.js 20 LTS, TypeScript 5 |
| HTTP Framework | Fastify 4 |
| ORM / Migrations | Prisma 5 |
| Primary Database | PostgreSQL 16 + pgvector |
| Cache / Queue Broker | Redis 7 |
| Job Queue | BullMQ 5 |
| HTML Scraping | Scrapling (Python microservice sidecar) |
| Containerisation | Docker + Docker Compose |
| Metrics | Prometheus (prom-client) |
| Logging | pino (structured JSON) |
| Tests | Vitest + fast-check (PBT) |
| CI | GitHub Actions |

SentinelPulse is a **consumer** of the existing `data-service`. It never replicates OHLCV or instrument master data and never writes to `data-service` databases.

---

## Architecture

### High-Level Component Diagram

```mermaid
graph TB
    subgraph External["External Sources"]
        RSS1[Reuters RSS]
        RSS2[Moneycontrol RSS]
        RSS3[EconomicTimes RSS]
        API1[Bloomberg API]
        API2[FT API]
        SCRAPE[Scrapling Sidecar]
    end

    subgraph Adapters["Source Adapters (Tier-1 / Tier-2)"]
        RA[ReutersAdapter]
        MA[MoneycontrolAdapter]
        ETA[EconomicTimesAdapter]
        BA[BloombergAdapter]
        FTA[FinancialTimesAdapter]
        CA[CoinDeskAdapter]
    end

    subgraph IngestionEngine["Ingestion Engine"]
        SCHED[Scheduler / Poll Loop]
        CB[CircuitBreaker Registry]
        RL[RateLimiter Registry]
    end

    subgraph Queues["BullMQ Queues (Redis)"]
        Q_RAW[news.raw]
        Q_NORM[news.normalized]
        Q_DEDUP[news.deduplicated]
        Q_ENT[news.entities]
        Q_EVT[news.events]
        Q_SENT[news.sentiment]
        Q_IMP[news.impact]
        Q_FEAT[news.features]
        Q_BACK[news.backfill]
        Q_EMB[news.embeddings]
        DLQ[news.*.deadletter]
    end

    subgraph Workers["BullMQ Workers"]
        W_FETCH[news-fetch-worker]
        W_NORM[news-normalize-worker]
        W_DEDUP[news-dedup-worker]
        W_ENT[news-entity-worker]
        W_EVT[news-event-worker]
        W_SENT[news-sentiment-worker]
        W_IMP[news-impact-worker]
        W_FEAT[news-feature-worker]
        W_EMB[news-embed-worker]
    end

    subgraph Engines["Processing Engines"]
        NE[NormalizationEngine]
        DE[DeduplicationEngine]
        ERE[EntityResolutionEngine]
        EDE[EventDetectionEngine]
        SE[SentimentEngine]
        IE[ImportanceEngine]
        MIE[MarketImpactEngine]
        HRE[HistoricalReactionEngine]
        FEE[FeatureEngineeringEngine]
        CME[CrossMarketEngine]
        ECE[EventClusteringEngine]
        EE[EmbeddingEngine]
        AE[AlertEngine]
        MLG[MLDatasetGenerator]
        VE[VelocityEngine]
        BE[BreadthEngine]
        MRE[MarketRegimeEngine]
        HAE[HistoricalAnalogueEngine]
        BFILL[BackfillEngine]
    end

    subgraph Storage["Persistence"]
        PG[(PostgreSQL 16\n+ pgvector)]
        RD[(Redis 7)]
    end

    subgraph API["REST API (Fastify)"]
        NEWS_API[/api/v1/news/*]
        AF_API[/api/v1/alphaforge/*]
        ML_API[/api/v1/ml/*]
        ADM_API[/api/v1/admin/*]
    end

    subgraph External2["Upstream Services"]
        DS[data-service\nOHLCV + InstrumentMaster]
        AF[AlphaForge\nSignal Engine]
        MLS[ml-service]
    end

    External --> Adapters
    Adapters --> IngestionEngine
    IngestionEngine --> Q_RAW
    Q_RAW --> W_FETCH --> NE --> Q_NORM
    Q_NORM --> W_NORM --> DE --> Q_DEDUP
    Q_DEDUP --> W_DEDUP --> ERE --> Q_ENT
    Q_ENT --> W_ENT --> EDE --> Q_EVT
    Q_EVT --> W_EVT --> SE --> Q_SENT
    Q_SENT --> W_SENT --> IE
    IE --> MIE --> Q_IMP
    Q_IMP --> W_IMP --> HRE
    HRE --> FEE --> Q_FEAT
    Q_FEAT --> W_FEAT
    EE --> Q_EMB --> W_EMB

    W_FETCH --> PG
    W_NORM --> PG
    W_DEDUP --> PG
    W_ENT --> PG
    W_EVT --> PG
    W_SENT --> PG
    W_IMP --> PG
    W_FEAT --> PG
    W_EMB --> PG

    PG --> API
    RD --> API
    API --> AF
    API --> MLS
    DS --> Engines
```

### Request / Response Data Flow

```mermaid
sequenceDiagram
    participant Sched as Scheduler
    participant Adp as SourceAdapter
    participant Q as BullMQ (news.raw)
    participant NW as normalize-worker
    participant DW as dedup-worker
    participant EW as entity-worker
    participant EVW as event-worker
    participant SW as sentiment-worker
    participant IW as impact-worker
    participant FW as feature-worker
    participant PG as PostgreSQL
    participant AF as AlphaForge

    Sched->>Adp: fetchLatest()
    Adp-->>Sched: RawArticle[]
    Sched->>Q: publish job (raw article)
    Q->>NW: consume
    NW->>PG: upsert NormalizedArticle
    NW->>Q: publish news.normalized
    Q->>DW: consume
    DW->>PG: upsert NewsCluster
    DW->>Q: publish news.deduplicated
    Q->>EW: consume
    EW->>PG: upsert news_entity_mentions
    EW->>Q: publish news.entities
    Q->>EVW: consume
    EVW->>PG: upsert news_events
    EVW->>Q: publish news.events
    Q->>SW: consume
    SW->>PG: upsert news_sentiment
    SW->>Q: publish news.sentiment
    Q->>IW: consume
    IW->>PG: upsert news_importance + news_market_impacts
    IW->>Q: publish news.impact
    Q->>FW: consume
    FW->>PG: upsert news_features
    FW->>Q: publish news.features
    AF->>+AF: GET /api/v1/alphaforge/news-context/:instrument
    AF-->>-AF: news_context bundle (Redis-cached, <100ms)
```

---

## Components and Interfaces

### Service Directory Layout

```
sentinel-pulse/
├── src/
│   ├── adapters/                   # NewsSourceAdapter implementations
│   │   ├── base/
│   │   │   └── NewsSourceAdapter.ts       # Interface + abstract base
│   │   ├── reuters/
│   │   │   └── ReutersAdapter.ts
│   │   ├── moneycontrol/
│   │   │   └── MoneycontrolAdapter.ts
│   │   ├── economic-times/
│   │   │   └── EconomicTimesAdapter.ts
│   │   ├── bloomberg/
│   │   │   └── BloombergAdapter.ts
│   │   ├── financial-times/
│   │   │   └── FinancialTimesAdapter.ts
│   │   └── coindesk/
│   │       └── CoinDeskAdapter.ts
│   ├── engines/
│   │   ├── ingestion/
│   │   │   ├── IngestionEngine.ts
│   │   │   ├── CircuitBreaker.ts
│   │   │   ├── RateLimiter.ts
│   │   │   └── Scheduler.ts
│   │   ├── normalization/
│   │   │   ├── NormalizationEngine.ts
│   │   │   ├── HtmlStripper.ts
│   │   │   └── LanguageDetector.ts
│   │   ├── deduplication/
│   │   │   ├── DeduplicationEngine.ts
│   │   │   ├── JaroWinkler.ts
│   │   │   └── EmbeddingMatcher.ts
│   │   ├── entity/
│   │   │   ├── EntityResolutionEngine.ts
│   │   │   └── InstrumentMasterClient.ts
│   │   ├── event-detection/
│   │   │   ├── EventDetectionEngine.ts
│   │   │   └── SurpriseScoreCalculator.ts
│   │   ├── sentiment/
│   │   │   └── SentimentEngine.ts
│   │   ├── importance/
│   │   │   └── ImportanceEngine.ts
│   │   ├── market-impact/
│   │   │   ├── MarketImpactEngine.ts
│   │   │   └── IndianMarketImpactEngine.ts
│   │   ├── historical-reaction/
│   │   │   └── HistoricalReactionEngine.ts
│   │   ├── feature-engineering/
│   │   │   ├── FeatureEngineeringEngine.ts
│   │   │   └── LookAheadGuard.ts
│   │   ├── cross-market/
│   │   │   └── CrossMarketEngine.ts
│   │   ├── event-clustering/
│   │   │   └── EventClusteringEngine.ts
│   │   ├── embedding/
│   │   │   └── EmbeddingEngine.ts
│   │   ├── alert/
│   │   │   └── AlertEngine.ts
│   │   ├── ml-dataset/
│   │   │   └── MLDatasetGenerator.ts
│   │   ├── velocity/
│   │   │   └── VelocityEngine.ts
│   │   ├── breadth/
│   │   │   └── BreadthEngine.ts
│   │   ├── market-regime/
│   │   │   └── MarketRegimeEngine.ts
│   │   ├── historical-analogue/
│   │   │   └── HistoricalAnalogueEngine.ts
│   │   └── backfill/
│   │       └── BackfillEngine.ts
│   ├── workers/                    # BullMQ worker entrypoints
│   │   ├── fetch.worker.ts
│   │   ├── normalize.worker.ts
│   │   ├── dedup.worker.ts
│   │   ├── entity.worker.ts
│   │   ├── event.worker.ts
│   │   ├── sentiment.worker.ts
│   │   ├── impact.worker.ts
│   │   ├── feature.worker.ts
│   │   └── embed.worker.ts
│   ├── api/                        # Fastify route handlers
│   │   ├── news/
│   │   ├── alphaforge/
│   │   ├── ml/
│   │   └── admin/
│   ├── queue/                      # BullMQ queue definitions
│   │   ├── queues.ts
│   │   └── deadletter.ts
│   ├── cache/                      # Redis cache layer
│   │   ├── RedisClient.ts
│   │   └── CacheKeys.ts
│   ├── db/                         # Prisma client + query helpers
│   │   └── prisma.ts
│   ├── integrations/
│   │   ├── data-service/           # data-service HTTP client
│   │   │   └── DataServiceClient.ts
│   │   └── scrapling/              # Scrapling sidecar client
│   │       └── ScraplingClient.ts
│   ├── observability/
│   │   ├── metrics.ts              # prom-client metric definitions
│   │   └── logger.ts               # pino logger factory
│   ├── security/
│   │   ├── SsrfGuard.ts
│   │   └── ApiKeyAuth.ts
│   ├── config/
│   │   └── env.ts                  # Zod-parsed env schema
│   └── app.ts                      # Fastify app factory
├── prisma/
│   ├── schema.prisma
│   └── migrations/
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── property/                   # fast-check PBT tests
│   └── ci/
│       └── look-ahead-check.ts
├── docs/
│   ├── README.md
│   ├── ARCHITECTURE.md
│   ├── DATA_MODEL.md
│   ├── API.md
│   ├── SOURCE_ADAPTERS.md
│   ├── ML_FEATURES.md
│   ├── ALPHAFORGE_INTEGRATION.md
│   ├── BACKFILL.md
│   ├── OPERATIONS.md
│   └── TROUBLESHOOTING.md
├── docker/
│   ├── Dockerfile
│   ├── Dockerfile.scrapling
│   └── docker-compose.yml
├── .env.example
├── package.json
└── tsconfig.json
```

### NewsSourceAdapter Interface

```typescript
// src/adapters/base/NewsSourceAdapter.ts

export interface HealthStatus {
  healthy: boolean;
  message?: string;
  latencyMs?: number;
}

export interface FetchOptions {
  since?: Date;
  limit?: number;
}

export interface HistoricalFetchOptions extends FetchOptions {
  from: Date;
  to: Date;
}

export interface RateLimitConfig {
  requestsPerMinute: number | null; // null = no limit
}

export interface RawArticle {
  sourceId: string;
  sourceName: string;
  externalId: string;
  url: string;
  title: string;
  summary?: string;
  content?: string;
  author?: string;
  publishedAt?: string;  // raw string from source
  category?: string;
  rawHtml?: string;
  adapterVersion: string;
}

export interface NormalizedArticle {
  id: string;                     // UUID v4
  sourceId: string;
  sourceName: string;
  externalId: string;
  canonicalUrl: string;
  title: string;
  summary: string | null;
  content: string | null;
  author: string | null;
  language: string;               // ISO 639-1
  languageConfidence: number;
  publishedAt: Date;              // UTC
  scrapedAt: Date;                // UTC
  category: string | null;
  contentHash: string;            // SHA-256 hex
  titleHash: string;              // SHA-256 hex
  contentTruncated: boolean;
  timestampInferred: boolean;
}

export interface NewsSourceAdapter {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly adapterVersion: string;
  readonly tier: 1 | 2;

  healthCheck(): Promise<HealthStatus>;
  fetchLatest(options: FetchOptions): Promise<RawArticle[]>;
  fetchHistorical(options: HistoricalFetchOptions): Promise<RawArticle[]>;
  normalize(raw: RawArticle): NormalizedArticle;
  getRateLimit(): RateLimitConfig;
}
```

### CircuitBreaker

Each source has an isolated CircuitBreaker instance. State machine:

```mermaid
stateDiagram-v2
    [*] --> CLOSED
    CLOSED --> OPEN: consecutive failures >= threshold
    OPEN --> HALF_OPEN: recovery timeout elapsed
    HALF_OPEN --> CLOSED: probe fetch succeeds
    HALF_OPEN --> OPEN: probe fetch fails (reset timeout)
```

```typescript
// src/engines/ingestion/CircuitBreaker.ts

export type CBState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CBConfig {
  failureThreshold: number;   // default 5, range 1-100
  recoveryTimeoutMs: number;  // default 60_000, range 1000-3_600_000
}

export class CircuitBreaker {
  private state: CBState = 'CLOSED';
  private consecutiveFailures = 0;
  private openedAt: Date | null = null;

  constructor(
    private readonly sourceId: string,
    private readonly config: CBConfig,
  ) {}

  isAllowed(): boolean { /* CLOSED or HALF_OPEN */ }
  recordSuccess(): void { /* reset failures, close */ }
  recordFailure(): void { /* increment, open if threshold reached */ }
  getState(): CBState { return this.state; }
}
```

### Ingestion Scheduler

The Scheduler runs independent per-source `setInterval` loops, respecting Tier-1 priority within each cycle. Within a single poll cycle, all enabled Tier-1 sources are polled sequentially (in configured order) before any Tier-2 source is started.

```typescript
// src/engines/ingestion/Scheduler.ts

// Execution order within a cycle:
//   1. For each enabled Tier-1 source (Reuters → Moneycontrol → EconomicTimes)
//      a. If CircuitBreaker is OPEN, skip
//      b. healthCheck() — on non-healthy: log, increment failure counter, skip
//      c. fetchLatest() — on exception: log, return []
//      d. For each RawArticle: publish to news.raw queue
//   2. Repeat for enabled Tier-2 sources

// Per-source polling interval is read from:
//   NEWS_SOURCE_{NAME}_POLL_INTERVAL_MS (default: 60_000)
```

---

## Data Models

### Database Schema

All 22 tables are defined in `prisma/schema.prisma`. Key design decisions:

- All timestamp columns are `TIMESTAMPTZ` (UTC). Prisma maps to `DateTime @db.Timestamptz`.
- UUIDs are `@id @default(uuid())`.
- Soft enumeration values (event types, categories) are stored as `TEXT` with application-layer validation to allow future extension without migrations.
- `pgvector` extension is enabled via `CREATE EXTENSION IF NOT EXISTS vector`.

#### Table: `news_sources`

```
news_sources
  id                  TEXT PRIMARY KEY   -- source identifier e.g. "reuters"
  name                TEXT NOT NULL
  tier                INTEGER NOT NULL   -- 1 or 2
  enabled             BOOLEAN NOT NULL DEFAULT true
  base_url            TEXT
  source_reliability  FLOAT NOT NULL DEFAULT 1.0
  failure_counter     INTEGER NOT NULL DEFAULT 0
  disabled_until      TIMESTAMPTZ
  adapter_version     TEXT NOT NULL
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
```

#### Table: `news_articles`

```
news_articles
  id                  UUID PRIMARY KEY
  source_id           TEXT NOT NULL REFERENCES news_sources(id)
  external_id         TEXT NOT NULL
  canonical_url       TEXT NOT NULL
  title               TEXT NOT NULL
  summary             TEXT
  content             TEXT
  author              TEXT
  language            TEXT NOT NULL     -- ISO 639-1
  language_confidence FLOAT NOT NULL
  published_at        TIMESTAMPTZ NOT NULL
  scraped_at          TIMESTAMPTZ NOT NULL
  category            TEXT
  content_hash        TEXT NOT NULL     -- SHA-256 hex, 64 chars
  title_hash          TEXT NOT NULL     -- SHA-256 hex, 64 chars
  content_truncated   BOOLEAN NOT NULL DEFAULT false
  timestamp_inferred  BOOLEAN NOT NULL DEFAULT false
  duplicate_count     INTEGER NOT NULL DEFAULT 0
  cluster_id          UUID REFERENCES news_clusters(id)
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()

  UNIQUE(source_id, external_id)
  UNIQUE(canonical_url)
  UNIQUE(content_hash)
  UNIQUE(title_hash)
  INDEX(published_at DESC)
  INDEX(cluster_id)
```

#### Table: `news_article_versions`

```
news_article_versions
  id            UUID PRIMARY KEY
  article_id    UUID NOT NULL REFERENCES news_articles(id)
  content_hash  TEXT NOT NULL
  title_hash    TEXT NOT NULL
  version       INTEGER NOT NULL
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT now()

  INDEX(article_id)
```

#### Table: `news_clusters`

```
news_clusters
  id               UUID PRIMARY KEY
  canonical_url    TEXT NOT NULL
  headline         TEXT NOT NULL
  source_count     INTEGER NOT NULL DEFAULT 1
  source_diversity INTEGER NOT NULL DEFAULT 1
  consensus_score  NUMERIC(4,2) NOT NULL DEFAULT 0.00
  first_seen_at    TIMESTAMPTZ NOT NULL
  last_updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
```

#### Table: `news_events`

```
news_events
  id                  UUID PRIMARY KEY
  article_id          UUID NOT NULL REFERENCES news_articles(id)
  event_type          TEXT NOT NULL     -- MONETARY_POLICY | EARNINGS | ...
  actor               TEXT
  action              TEXT
  target_entities     TEXT[]
  quantitative_value  FLOAT
  expected_value      FLOAT
  expected_value_src  TEXT
  surprise_direction  TEXT              -- BEAT | MISS | IN_LINE | UNKNOWN
  surprise_score      FLOAT
  surprise_score_err  TEXT
  importance          FLOAT NOT NULL DEFAULT 0
  confidence          FLOAT NOT NULL
  event_timestamp     TIMESTAMPTZ NOT NULL
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()

  INDEX(event_type, published_at DESC)   -- via join on news_articles
  INDEX(event_timestamp DESC)
  UNIQUE(article_id, event_type, actor)  -- idempotency key
```

#### Table: `news_article_event_links`

```
news_article_event_links
  article_id  UUID NOT NULL REFERENCES news_articles(id)
  event_id    UUID NOT NULL REFERENCES news_events(id)
  PRIMARY KEY(article_id, event_id)
```

#### Table: `news_entities`

```
news_entities
  id           UUID PRIMARY KEY
  surface_form TEXT NOT NULL
  entity_type  TEXT NOT NULL   -- Company | Instrument | Index | ...
  instrument_id TEXT           -- FK to InstrumentMaster in data-service (logical)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()

  UNIQUE(surface_form, entity_type)
```

#### Table: `news_entity_mentions`

```
news_entity_mentions
  id               UUID PRIMARY KEY
  article_id       UUID NOT NULL REFERENCES news_articles(id)
  entity_id        UUID REFERENCES news_entities(id)   -- null if unresolved
  surface_form     TEXT NOT NULL
  entity_type      TEXT NOT NULL
  confidence       NUMERIC(4,2) NOT NULL
  sentence_pos     INTEGER NOT NULL   -- non-negative
  char_offset      INTEGER NOT NULL   -- non-negative
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()

  INDEX(article_id)
  INDEX(entity_id, confidence)
```

#### Table: `news_asset_links`

```
news_asset_links
  article_id   UUID NOT NULL REFERENCES news_articles(id)
  asset_id     TEXT NOT NULL         -- instrument_id from InstrumentMaster
  confidence   NUMERIC(4,2) NOT NULL
  published_at TIMESTAMPTZ NOT NULL   -- denormalised for index performance
  PRIMARY KEY(article_id, asset_id)

  INDEX(asset_id, published_at DESC)   -- Req 28.2
```

#### Table: `news_sector_links`

```
news_sector_links
  article_id   UUID NOT NULL REFERENCES news_articles(id)
  sector_id    TEXT NOT NULL
  confidence   NUMERIC(4,2) NOT NULL
  published_at TIMESTAMPTZ NOT NULL
  PRIMARY KEY(article_id, sector_id)

  INDEX(sector_id, published_at DESC)
```

#### Table: `news_event_relationships`

```
news_event_relationships
  id                    UUID PRIMARY KEY
  source_entity_id      TEXT NOT NULL
  target_entity_id      TEXT NOT NULL
  relationship_type     TEXT NOT NULL   -- POSITIVE_CORRELATION | ...
  chain_order           INTEGER NOT NULL DEFAULT 1   -- 1-3
  historical_correlation FLOAT NOT NULL
  confidence            FLOAT NOT NULL
  regime_dependency     TEXT[]          -- MarketRegime values
  sample_size           INTEGER NOT NULL DEFAULT 0
  low_sample            BOOLEAN NOT NULL DEFAULT false
  last_updated          TIMESTAMPTZ NOT NULL DEFAULT now()
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()

  UNIQUE(source_entity_id, target_entity_id, relationship_type)
  INDEX(source_entity_id, confidence)
```

#### Table: `news_sentiment`

```
news_sentiment
  id                 UUID PRIMARY KEY
  article_id         UUID NOT NULL REFERENCES news_articles(id)
  event_id           UUID REFERENCES news_events(id)
  sentiment_score    NUMERIC(6,4) NOT NULL   -- -1 to +1
  market_sentiment   NUMERIC(6,4) NOT NULL
  company_sentiment  NUMERIC(6,4) NOT NULL
  macro_sentiment    NUMERIC(6,4) NOT NULL
  risk_sentiment     NUMERIC(6,4) NOT NULL
  qualitative_signals TEXT[] NOT NULL
  confidence         NUMERIC(4,2) NOT NULL
  model_version      TEXT NOT NULL
  computed_at        TIMESTAMPTZ NOT NULL DEFAULT now()

  UNIQUE(article_id, model_version)
  INDEX(article_id)
```

#### Table: `news_importance`

```
news_importance
  id                       UUID PRIMARY KEY
  event_id                 UUID NOT NULL REFERENCES news_events(id)
  importance_score         FLOAT NOT NULL
  sub_scores               JSONB NOT NULL
  historical_data_available BOOLEAN NOT NULL DEFAULT false
  model_version            TEXT NOT NULL
  computed_at              TIMESTAMPTZ NOT NULL DEFAULT now()

  UNIQUE(event_id)   -- upsert on event_id
  INDEX(importance_score DESC, computed_at DESC)   -- Req 28.2
```

#### Table: `news_market_impacts`

```
news_market_impacts
  id                         UUID PRIMARY KEY
  article_id                 UUID NOT NULL REFERENCES news_articles(id)
  event_id                   UUID NOT NULL REFERENCES news_events(id)
  asset_id                   TEXT
  sector_id                  TEXT
  direction                  TEXT NOT NULL   -- POSITIVE | NEGATIVE | NEUTRAL | UNCERTAIN
  strength                   FLOAT NOT NULL
  confidence                 FLOAT NOT NULL
  expected_horizon           TEXT NOT NULL   -- IMMEDIATE | INTRADAY | ...
  evidence_type              TEXT NOT NULL   -- HISTORICAL | RULE_BASED | MODEL
  relationship_id            UUID REFERENCES news_event_relationships(id)
  news_impact_score          FLOAT           -- -100 to +100
  impact_components          JSONB           -- each multiplicative factor
  impact_computation_version TEXT NOT NULL
  computed_at                TIMESTAMPTZ NOT NULL DEFAULT now()

  UNIQUE(event_id, asset_id)   -- idempotency key
  INDEX(asset_id, computed_at DESC)
```

#### Table: `news_market_reactions`

```
news_market_reactions
  id                      UUID PRIMARY KEY
  event_id                UUID NOT NULL REFERENCES news_events(id)
  asset_id                TEXT NOT NULL
  return_1m               FLOAT
  return_5m               FLOAT
  return_15m              FLOAT
  return_30m              FLOAT
  return_1h               FLOAT
  return_4h               FLOAT
  return_1d               FLOAT
  volume_change_ratio     FLOAT
  volatility_change_ratio FLOAT
  high_impact_flag        BOOLEAN NOT NULL DEFAULT false
  market_open             BOOLEAN NOT NULL DEFAULT true
  data_service_timeout    BOOLEAN NOT NULL DEFAULT false
  data_service_snapshot_version TEXT
  computed_at             TIMESTAMPTZ NOT NULL DEFAULT now()

  UNIQUE(event_id, asset_id)
  INDEX(event_id)
  INDEX(asset_id, computed_at DESC)
```

#### Table: `news_market_regimes`

```
news_market_regimes
  id          UUID PRIMARY KEY
  market_id   TEXT NOT NULL   -- "india" | "us" | "global"
  regime      TEXT NOT NULL
  confidence  FLOAT NOT NULL
  valid_from  TIMESTAMPTZ NOT NULL
  valid_to    TIMESTAMPTZ        -- null = current

  INDEX(market_id, valid_to NULLS FIRST)
```

#### Table: `news_features`

```
news_features
  id              UUID PRIMARY KEY
  event_id        UUID REFERENCES news_events(id)
  asset_id        TEXT
  entity_type     TEXT            -- "article" | "VELOCITY" | "BREADTH" | ...
  entity_id       TEXT
  feature_type    TEXT NOT NULL
  feature_vector  JSONB
  window          TEXT            -- "1m" | "5m" (for velocity)
  value           FLOAT
  baseline        FLOAT
  momentum        FLOAT
  feature_version TEXT NOT NULL
  pipeline_version TEXT NOT NULL
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT now()

  UNIQUE(event_id, asset_id, feature_version)   -- idempotency on FeatureVectors
  INDEX(event_id)
  INDEX(asset_id, computed_at DESC)
  INDEX(feature_type, entity_id, computed_at DESC)
```

#### Table: `news_embeddings`

```
news_embeddings
  id           UUID PRIMARY KEY
  entity_type  TEXT NOT NULL    -- "article" | "event" | "entity"
  entity_id    UUID NOT NULL
  embedding    vector(1536) NOT NULL
  model_version TEXT NOT NULL
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()

  INDEX USING hnsw (embedding vector_cosine_ops)
  INDEX(entity_type, entity_id, model_version)
```

#### Table: `news_training_samples`

```
news_training_samples
  id                           UUID PRIMARY KEY
  event_id                     UUID NOT NULL REFERENCES news_events(id)
  asset_id                     TEXT NOT NULL
  article_ids                  UUID[] NOT NULL
  feature_vector_id            UUID NOT NULL REFERENCES news_features(id)
  future_return_5m             FLOAT
  future_return_15m            FLOAT
  future_return_30m            FLOAT
  future_return_1h             FLOAT
  future_return_4h             FLOAT
  future_return_1d             FLOAT
  label_5m                     TEXT    -- STRONG_BULLISH | BULLISH | ...
  label_15m                    TEXT
  label_30m                    TEXT
  label_1h                     TEXT
  label_4h                     TEXT
  label_1d                     TEXT
  label_cutoff_5m              TIMESTAMPTZ
  label_cutoff_15m             TIMESTAMPTZ
  label_cutoff_30m             TIMESTAMPTZ
  label_cutoff_1h              TIMESTAMPTZ
  label_cutoff_4h              TIMESTAMPTZ
  label_cutoff_1d              TIMESTAMPTZ
  feature_version              TEXT NOT NULL
  pipeline_version             TEXT NOT NULL
  market_data_snapshot_version TEXT NOT NULL
  model_version                TEXT NOT NULL
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now()

  INDEX(event_id, asset_id, feature_version)
  INDEX(asset_id, created_at DESC)
```

#### Table: `news_source_metrics`

```
news_source_metrics
  id              UUID PRIMARY KEY
  source_id       TEXT NOT NULL REFERENCES news_sources(id)
  window_start    TIMESTAMPTZ NOT NULL
  window_end      TIMESTAMPTZ NOT NULL
  articles_fetched INTEGER NOT NULL DEFAULT 0
  articles_failed  INTEGER NOT NULL DEFAULT 0
  avg_latency_ms   FLOAT
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT now()

  INDEX(source_id, window_start DESC)
```

#### Table: `news_ingestion_runs`

```
news_ingestion_runs
  id               UUID PRIMARY KEY
  source_id        TEXT NOT NULL REFERENCES news_sources(id)
  started_at       TIMESTAMPTZ NOT NULL
  completed_at     TIMESTAMPTZ
  articles_fetched INTEGER NOT NULL DEFAULT 0
  articles_failed  INTEGER NOT NULL DEFAULT 0
  status           TEXT NOT NULL   -- success | partial_failure | failed

  INDEX(source_id, started_at DESC)
```

#### Table: `news_processing_errors`

```
news_processing_errors
  id           UUID PRIMARY KEY
  source_id    TEXT
  external_id  TEXT
  stage        TEXT NOT NULL     -- normalization | deduplication | ...
  error_type   TEXT NOT NULL
  error_message TEXT NOT NULL
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()

  INDEX(stage, created_at DESC)
```

#### Table: `news_alerts`

```
news_alerts
  id                UUID PRIMARY KEY
  alert_type        TEXT NOT NULL
  trigger_reason    TEXT NOT NULL
  asset_id          TEXT NOT NULL
  event_id          UUID REFERENCES news_events(id)
  cluster_id        UUID REFERENCES news_clusters(id)
  importance_score  FLOAT NOT NULL
  description       TEXT NOT NULL     -- max 500 chars
  payload           JSONB NOT NULL
  delivery_channels JSONB NOT NULL    -- per-channel delivery_status
  computed_at       TIMESTAMPTZ NOT NULL DEFAULT now()

  INDEX(asset_id, computed_at DESC)
  INDEX(cluster_id, alert_type, computed_at DESC)   -- cooldown/dedup lookups
```

### Worker / Queue Topology

```mermaid
graph LR
    subgraph Tier1["Tier-1 Poll (higher priority)"]
        R[Reuters\n1min]
        MC[Moneycontrol\n1min]
        ET[EconomicTimes\n1min]
    end
    subgraph Tier2["Tier-2 Poll (lower priority)"]
        BL[Bloomberg\n2min]
        FT[FinancialTimes\n2min]
        CD[CoinDesk\n5min]
    end

    Tier1 --> QR[news.raw\nBullMQ]
    Tier2 --> QR

    QR --> WN["news-normalize-worker\n(concurrency: WORKER_NORMALIZE_CONCURRENCY)"]
    WN --> QN[news.normalized]
    QN --> WD["news-dedup-worker\n(concurrency: WORKER_DEDUP_CONCURRENCY)"]
    WD --> QDE[news.deduplicated]
    QDE --> WE["news-entity-worker\n(concurrency: WORKER_ENTITY_CONCURRENCY)"]
    WE --> QEV[news.entities]
    QEV --> WEV["news-event-worker\n(concurrency: WORKER_EVENT_CONCURRENCY)"]
    WEV --> QS[news.events]
    QS --> WS["news-sentiment-worker\n(concurrency: WORKER_SENTIMENT_CONCURRENCY)"]
    WS --> QI[news.sentiment]
    QI --> WI["news-impact-worker\n(concurrency: WORKER_IMPACT_CONCURRENCY)"]
    WI --> QF[news.impact]
    QF --> WF["news-feature-worker\n(concurrency: WORKER_FEATURE_CONCURRENCY)"]
    WF --> QFO[news.features]

    QR --> DLQ_R[news.raw.deadletter]
    QN --> DLQ_N[news.normalized.deadletter]
    QDE --> DLQ_DE[news.deduplicated.deadletter]
    QEV --> DLQ_EV[news.entities.deadletter]
    QS --> DLQ_S[news.events.deadletter]
    QI --> DLQ_I[news.sentiment.deadletter]
    QF --> DLQ_F[news.impact.deadletter]
    QFO --> DLQ_FO[news.features.deadletter]

    EMBS[news.embeddings] --> WEM["news-embed-worker"]
    BACK[news.backfill] --> WBK["backfill-worker\n(max 20% total concurrency)"]
```

### Queue Configuration

```typescript
// src/queue/queues.ts

export const QUEUE_NAMES = {
  RAW: 'news.raw',
  NORMALIZED: 'news.normalized',
  DEDUPLICATED: 'news.deduplicated',
  ENTITIES: 'news.entities',
  EVENTS: 'news.events',
  SENTIMENT: 'news.sentiment',
  IMPACT: 'news.impact',
  FEATURES: 'news.features',
  EMBEDDINGS: 'news.embeddings',
  BACKFILL: 'news.backfill',
} as const;

// Default retry policy for all workers
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { age: 86400 },
  removeOnFail: false,  // preserve in DLQ
};
```

### Data-Service Integration

SentinelPulse communicates with `data-service` exclusively via HTTP. It never queries `data-service` databases directly.

```typescript
// src/integrations/data-service/DataServiceClient.ts

export class DataServiceClient {
  // OHLCV lookup with asOf for point-in-time correctness
  async getOHLCV(params: {
    assetId: string;
    from: Date;
    to: Date;
    asOf: Date;   // MUST be <= event_timestamp
  }): Promise<OHLCVBar[]>;

  // Instrument master lookup
  async resolveInstrument(surfaceForm: string): Promise<InstrumentMasterEntry | null>;
  async getInstrumentById(instrumentId: string): Promise<InstrumentMasterEntry | null>;

  // Market regime signals
  async getRegimeSignals(marketId: string): Promise<RegimeSignal[]>;
}
```

### Scrapling Sidecar

Where HTML scraping is needed (no official RSS/API), SentinelPulse communicates with a Python Scrapling sidecar over HTTP. The sidecar handles robots.txt compliance, rate limits, and ToS constraints.

```typescript
// src/integrations/scrapling/ScraplingClient.ts

export interface ScrapeRequest {
  url: string;
  sourceName: string;
  selectors: {
    title: string;
    content: string;
    author?: string;
    publishedAt?: string;
  };
}

export class ScraplingClient {
  // POST /scrape — returns extracted article fields
  async scrape(req: ScrapeRequest): Promise<ScrapedContent>;
}
```

---

## Pipeline Engine Designs

### NormalizationEngine

Responsibilities: HTML stripping, language detection, hash computation, content truncation.

```
Input: RawArticle (from news.raw queue)
Output: NormalizedArticle → upsert to news_articles → publish to news.normalized

Steps:
1. Strip HTML using HtmlStripper (converts block-level elements to \n before tag removal)
2. Collapse consecutive whitespace → single space; trim
3. Truncate to 50,000 chars at word boundary; set contentTruncated flag
4. Detect language (min 20 chars, confidence >= 0.8; fallback "en")
5. Compute contentHash = SHA-256(stripped + whitespace-normalised content)
6. Compute titleHash = SHA-256(lowercase + punctuation-stripped + whitespace-normalised title)
7. Assign taxonomy category (primary + up to 5 secondary)
8. Publish to news.normalized
```

**Content Hash Algorithm (deterministic):**

```
contentHash = sha256(
  content
    .replace(/\s+/g, ' ')
    .trim()
).toString('hex').toLowerCase()   // 64 chars

titleHash = sha256(
  title
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
).toString('hex').toLowerCase()   // 64 chars
```

### DeduplicationEngine

Responsibilities: exact duplicate detection, near-duplicate clustering.

```
Input: NormalizedArticle (from news.normalized queue)
Output: cluster assignment on news_articles → publish to news.deduplicated

Exact duplicate check (any match → discard):
  1. canonicalUrl in news_articles
  2. externalId + sourceId in news_articles
  3. contentHash in news_articles
  4. titleHash in news_articles

Near-duplicate check (configurable window, default 24h):
  5. Jaro-Winkler(incomingTitle, existingTitle) >= 0.92
  6. cosine(incomingEmbedding, existingEmbedding) >= 0.90

Cluster assignment:
  - If any near-duplicate found: assign to highest-similarity cluster
  - Tie-break: earlier created_at wins
  - Update cluster: source_count, source_diversity, consensus_score
  - If no match: create new NewsCluster

consensus_score = (Σ weights of distinct tiers represented)
                / (Σ weights of all defined tiers)
               where Tier-1 weight = 2, Tier-2 weight = 1
               → normalised to [0.00, 1.00] rounded to 2dp
```

### EventDetectionEngine

Responsibilities: structured event extraction, surprise score computation.

```
Input: news.entities job (article_id)
Output: news_events records → publish to news.events

For each article:
  1. LLM/NLP pipeline extracts: eventType, actor, action, targetEntities,
     quantitativeValue, expectedValue, confidence, eventTimestamp
  2. Compute surpriseScore:
       if expectedValue == 0 → surprise_score = null, error = "division_by_zero"
       if expectedValue == null → surprise_score = null, direction = UNKNOWN
       else → raw = (quantitative - expected) / |expected|
               capped to [-5.0, +5.0], rounded to 4dp
               direction = BEAT if raw > threshold,
                           MISS if raw < -threshold,
                           IN_LINE otherwise
  3. Idempotency: UNIQUE(article_id, event_type, actor) → upsert
```

### SentimentEngine

Computes 5 sentiment dimensions using a fine-tuned FinBERT-style model.

```
Dimensions: sentimentScore, marketSentiment, companySentiment,
            macroSentiment, riskSentiment
Each: FLOAT in [-1.0000, +1.0000] rounded to 4dp

Qualitative signals: UNCERTAINTY | FEAR | HAWKISH | DOVISH | RISK_ON |
                     RISK_OFF | OPTIMISM | PANIC | NEUTRAL
  → NEUTRAL applied when no other signal exceeds confidence threshold

Upsert key: (article_id, model_version)
  → new model_version = new row (historical versions preserved)
```

### ImportanceEngine

Computes a weighted composite score across 9 sub-dimensions.

```
importance_score = Σ(sub_score_i × weight_i) / Σ(weight_i)
                   clamped to [0.0, 1.0]

Sub-scores:
  source_reliability       (from news_sources.source_reliability)
  event_severity           (from EventDetectionEngine confidence)
  affected_asset_weight    (entity count × market-cap weight from data-service)
  affected_sector_count    (distinct sectors from news_sector_links)
  historical_impact_magnitude (from news_market_reactions; prior=0.5 if unavailable)
  novelty                  (1 / similar-event count in past 7 days)
  surprise_factor          (|surprise_score| / 5.0; 0 if null)
  geopolitical_significance (from event_type heuristic)
  macro_significance        (from event_type heuristic)

surprise_score multiplier (Req 14.4):
  if surprise_score is non-null:
    importance_score = min(importance_score × (1 + |surprise_score| / 5.0), 1.0)

Upsert key: event_id
```

### MarketImpactEngine

Computes directional impact per (event, asset) pair.

```
NewsImpactScore = Sentiment × Importance × SourceReliability
                × EntityRelevance × HistoricalImpact
                × MarketRegimeCompatibility × Confidence
normalised to [-100, +100]

Evidence hierarchy:
  1. HISTORICAL — HistoricalReaction records with sample_size >= 10
  2. RULE_BASED — heuristic mapping from event_type to asset type
  3. MODEL       — fallback ML model prediction

Cross-market relationships:
  Only applied if news_event_relationships.confidence >= 0.2
  AND sample_size >= 30 AND low_sample = false
  (unless operator override)

IndianMarketImpactEngine maps events to:
  NIFTY50, BANKNIFTY, NIFTY sectoral indices,
  individual NSE/BSE stocks from InstrumentMaster

Upsert key: (event_id, asset_id)
```

### HistoricalReactionEngine

Measures actual price/volume responses at fixed offsets from event_timestamp.

```
Offsets queried from data-service (all with asOf = offset_timestamp):
  -15min, -5min (baseline), +1min, +5min, +15min, +30min, +1h, +4h, +1d

For each offset:
  - If data-service timeout > 10s: record null, set data_service_timeout=true
  - If market not open: record null, set market_open=false
  - Never interpolate or extrapolate

return_Xm = (close_at_offset - close_at_baseline) / close_at_baseline × 100
high_impact_flag = |return_15m| > configurable threshold (default 0.5%)
```

### FeatureEngineeringEngine

Assembles FeatureVectors for events with importance_score > 0.3.

```
Point-in-time guard:
  LookAheadGuard validates ALL data sources:
    data.recordTimestamp <= event.event_timestamp
  Any violation → LookAheadBiasError, abort, no persist

Feature groups (see Req 20.1 for full list):
  article_features    (sentiment, importance, novelty, surprise, signals)
  event_features      (type, severity, velocity, cluster metrics)
  asset_features      (mention count, momentum, breadth)
  macro_features      (crude_oil, gold, usd_inr, fed_policy, rbi_policy scores)
  cross_market        (relationship count, dominant direction)
  temporal_features   (hour, day_of_week, days_to_rbi, days_to_fed, days_to_earnings)
  market_context      (OHLCV, ATR, VWAP, OI, VIX from data-service at event_timestamp)

Storage: news_features with (event_id, asset_id, feature_version) unique key
Queue publish within 500ms of successful storage
```

### MLDatasetGenerator

Joins FeatureVectors with forward returns from data-service.

```
Label horizons: 5m, 15m, 30m, 1h, 4h, 1d

For each horizon:
  1. Query data-service at event_timestamp + horizon with asOf = exact timestamp
  2. If unavailable → label = null (no interpolation)
  3. If data timestamp <= event_timestamp → LookAheadBiasError, discard record

Label thresholds (configurable, defaults):
  STRONG_BULLISH:  return > +1%
  BULLISH:         return in (0%, +1%]
  NEUTRAL:         |return| <= 0.2%
  BEARISH:         return in [-1%, 0%)
  STRONG_BEARISH:  return < -1%
  Gap between thresholds → assign nearest boundary

TrainingSample includes:
  feature_vector_id, all 6 labels + cutoff timestamps,
  feature_version, pipeline_version, market_data_snapshot_version, model_version

Foreign key validation at creation time:
  All FKs must resolve or record is rejected with ERROR log
```

### EmbeddingEngine

Generates dense embeddings for articles, events, and entities.

```
Embedding model: configurable (default: text-embedding-3-large, dim=1536)
Storage: news_embeddings with pgvector vector(1536)
Index: HNSW with vector_cosine_ops

On model version change:
  1. Mark old embeddings with prior model_version (do not delete)
  2. Enqueue all existing entities on news.embeddings for regeneration
  3. Serve search using latest model_version only

Similarity search (semantic search endpoint):
  SELECT entity_id, 1 - (embedding <=> query_embedding) AS similarity
  FROM news_embeddings
  WHERE model_version = $current
    AND entity_type = $type
  ORDER BY embedding <=> query_embedding
  LIMIT $topK
  → target p95 < 500ms for corpus up to 1M embeddings
```

### VelocityEngine

Computes rolling news velocity per asset/sector.

```
Windows: 1-minute trailing, 5-minute trailing
Recomputation: every 60 seconds

velocity_1m = COUNT(articles) in trailing 60s for entity
velocity_5m = COUNT(articles) in trailing 300s for entity

baseline = rolling 7-day average at same clock-hour:clock-minute
momentum = velocity / baseline  (null if baseline = 0)

Cache: news:velocity:{entity_type}:{entity_id} TTL=90s
Spike alert: velocity_5m > 3 × baseline → AlertEngine.trigger()
```

### MarketRegimeEngine

```
Regime classifications per market (India, US, Global):
  TRENDING_BULL | TRENDING_BEAR | SIDEWAYS | HIGH_VOLATILITY |
  LOW_VOLATILITY | RISK_ON | RISK_OFF | EVENT_DRIVEN | PANIC | RECOVERY

Update schedule: every 15 minutes (configurable)
Source: data-service regime signals

On regime change:
  1. Set prior record valid_to = new record valid_from
  2. Delete Redis cached impact scores for active events with importance > 0.7
  3. Cache new regime: news:regime:{market_id} TTL=20min

Fallback: if data-service unavailable, retain cached regime + WARN log
```

---

## API Design

### Authentication

All endpoints require `Authorization: Bearer {api_key}` header. Keys are validated against a `api_keys` table or configurable static key list. Invalid/missing key → HTTP 401.

### Rate Limiting

Per API key, configurable RPM (default 300). Enforced via Redis sliding window. Exceeded → HTTP 429 with `Retry-After` header.

### News Intelligence Endpoints

```
GET /api/v1/news/latest
  Query: source?, category?, language?, min_importance?, date_from?, date_to?, cursor?, limit=50
  Response: { data: NormalizedArticle[], total_count, next_cursor, truncated? }

GET /api/v1/news/assets/:assetId
  Response: { articles: ArticleSummary[], impact: NewsMarketImpact[], sentiment: SentimentSummary }
  Target: p95 < 100ms (indexed on asset_id, published_at DESC)

GET /api/v1/news/market/india
  Response: { breadth, regime, hot_events, velocity_spikes }

GET /api/v1/news/events/:eventId
  Response: { event, cluster: { member_event_ids, graph_edges }, analogues }
  404 if eventId not found

GET /api/v1/news/events/similar
  Query: query (natural language), topK=20, regime_filter?
  Response: { results: [{ event, similarity, market_reaction, regime_at_time }], aggregate_stats }

GET /api/v1/news/impact/:assetId
  Response: { impacts: NewsMarketImpact[], regime, cross_market_signals }

GET /api/v1/news/regime
  Response: { india, us, global }

GET /api/v1/news/signal/:assetId
  Response: { news_impact_score, sentiment_summary, velocity, breadth, top_events }

GET /api/v1/news/search
  Query: q (natural language), topK=20, type=article|event
  Response: { results: [{ entity, similarity }] }
  Target: p95 < 500ms
```

### AlphaForge Integration Endpoints

```
GET /api/v1/alphaforge/news-context/:instrument
  Response (Redis-cached, TTL=30s, target p95 < 100ms):
  {
    news_impact_score: float,           // 0.0-1.0, NOT a trading signal
    sentiment_summary: { overall, market, company, macro, risk },
    velocity_metrics: { velocity_1m, velocity_5m, momentum },
    regime_context: { regime, confidence },
    top_contributing_events: [          // max 5, by importance_score desc
      { event_id, title, importance_score, sentiment_direction }
    ],
    active_cross_market_signals: [...],
    historical_analogue_summary: { analogue_count, median_return_1h, win_rate },
    explainability: {
      top_events: [{ title, importance_score, sentiment_direction }],  // top 3
      top_cross_market: [...],                                          // top 3
      best_analogue: { event_date, return_1h, regime }
    }
  }
  404 if instrument not in SentinelPulse database

GET /api/v1/alphaforge/context/market
GET /api/v1/alphaforge/context/index/:index
GET /api/v1/alphaforge/context/sector/:sector
GET /api/v1/alphaforge/context/asset/:asset
  Similar structure to news-context, scoped to market/index/sector/asset

GET /api/v1/alphaforge/high-impact-events
  Query: min_importance=0.7, limit=50
  Response: { events: NewsEvent[], sorted by computed_at DESC }
```

> **Signal contract**: `news_impact_score` is an input factor, not a standalone trading signal. The AlphaForge formula is:
> `News Score + Technical + Smart Money + Volume + Open Interest + Market Regime + Macro → ML Probability → Final Signal`
> SentinelPulse never exposes BUY/SELL/HOLD recommendations.

### ML / Data Endpoints

```
GET /api/v1/ml/features/market
GET /api/v1/ml/features/asset/:assetId
GET /api/v1/ml/features/sector/:sector
  Response: { features: FeatureVector[], computed_at }

GET /api/v1/ml/training/events
GET /api/v1/ml/training/samples
  Query: feature_version?, date_from?, date_to?, asset?, event_type?,
         min_importance?, page=1, page_size=1000 (max)
  Response: { data: [], total_count, page, page_size, next_page? }

GET /api/v1/ml/historical-reactions
  Query: event_type?, asset_id?, date_from?, date_to?
  Response: { reactions: NewsMarketReaction[] }

GET /api/v1/ml/training/samples/:sampleId/lineage
  Response (full provenance chain):
  {
    sample: TrainingSample,
    feature_vector: FeatureVector,
    event: NewsEvent,
    normalized_article: NormalizedArticle,
    raw_article_metadata: { source_id, external_id, fetched_at, adapter_version }
  }
  404 if sampleId not found
```

### Admin Endpoints

```
GET /api/v1/admin/sources
  Response: { sources: [{ id, name, tier, enabled, health, failure_counter, cb_state }] }

GET /api/v1/admin/ingestion
  Response: { runs: NewsIngestionRun[], errors: ProcessingError[] }

GET /api/v1/admin/queues
  Response: { queues: [{ name, depth, throughput_rpm, error_rate, dlq_count }] }

GET /api/v1/admin/data-quality
  Response:
  {
    window: "24h",
    articles_with_resolved_entities_pct: float,
    articles_with_sentiment_pct: float,
    events_with_importance_pct: float,
    high_importance_events_with_reactions_pct: float,
    computed_at: ISO 8601
  }

POST /api/v1/admin/backfill
  Body: { startDate, endDate, sources, categories, assets, batchSize }
  Response: { job_id, status: "queued" }

POST /api/v1/admin/backfill/:jobId/pause
POST /api/v1/admin/backfill/:jobId/resume
POST /api/v1/admin/backfill/:jobId/cancel
```

---

## Caching Strategy

### Redis Key Register

| Key Pattern | TTL | Invalidation Trigger |
|---|---|---|
| `news:latest:india` | 60s | New article published in India category |
| `news:latest:global` | 60s | New article published in Global category |
| `news:asset:{assetId}` | 30s | New article/impact linked to assetId |
| `news:signal:{instrument}` | 30s | New sentiment/impact computed for instrument |
| `news:impact:{instrument}` | 30s | New MarketImpact computed for instrument |
| `news:regime:{market_id}` | 20min | Regime change event |
| `news:hot-events` | 60s | New high-importance event |
| `news:velocity:{type}:{id}` | 90s | VelocityEngine 60s recompute cycle |
| `news:breadth:india` | 6min | BreadthEngine 5min recompute cycle |
| `news:breadth:global` | 6min | BreadthEngine 5min recompute cycle |

### Invalidation Rules

- Cache is **never** the write target. All writes go to PostgreSQL first.
- Within 5 seconds of a PostgreSQL write that supersedes a cached key, the key is invalidated.
- On Redis unavailability: fall back to direct PostgreSQL query, log WARN, return result normally.
- On cache miss: serve from PostgreSQL, asynchronously repopulate cache.

### Regime-Triggered Cache Purge

When market regime changes:
```
DEL news:regime:{market_id}
SCAN + DEL news:signal:* for events with importance_score > 0.7 linked to that market
```

---

## Cross-Market Intelligence Design

The `news_event_relationships` table is the core of the EventGraph.

```
Edge record:
  source_entity_id → target_entity_id
  relationship_type: POSITIVE_CORRELATION | NEGATIVE_CORRELATION
                   | CAUSAL_INDICATOR | SECTOR_ROTATION
  chain_order: 1 (direct) | 2 (second-order) | 3 (third-order; max)
  historical_correlation: [-1.0, +1.0]
  confidence: [0.0, 1.0]
  sample_size: >= 0
  low_sample: true if sample_size < 30
  regime_dependency: [MarketRegime...] — regimes where relationship holds

Seeding: loaded from static YAML at startup (configurable path)
Update schedule: daily, joining HistoricalReaction records

Usage gate in MarketImpactEngine:
  confidence >= 0.2 AND sample_size >= 30 AND low_sample = false
  (operator can override low_sample check via config)

EventGraph traversal (EventClusteringEngine):
  Cluster if ≥ 2 of:
    (a) shared resolved entity_id
    (b) same event_type
    (c) embedding cosine similarity >= 0.85
    (d) same primary taxonomy category
  Within configurable time window (default 48h)
  Max chain_order = 3 (no deeper causal chains stored)
```

---

## Security Design

### SSRF Protection

```typescript
// src/security/SsrfGuard.ts

const ALLOWED_DOMAINS = new Set(
  process.env.ALLOWED_SOURCE_DOMAINS?.split(',') ?? []
);

export function validateOutboundUrl(url: string): void {
  const parsed = new URL(url);
  if (!ALLOWED_DOMAINS.has(parsed.hostname)) {
    logger.warn({ domain: parsed.hostname }, 'SSRF guard: rejected outbound URL');
    throw new SsrfBlockedError(parsed.hostname);
  }
}
```

Every `NewsSourceAdapter.fetchLatest()` and `fetchHistorical()` passes URLs through `SsrfGuard.validateOutboundUrl()` before making any HTTP request.

### API Key Authentication

```
Fastify preHandler hook on all routes:
  1. Extract Authorization: Bearer {key}
  2. Hash key with SHA-256
  3. Lookup hashed key in api_keys table (or compare to env var SENTINEL_API_KEY)
  4. On mismatch/absence → return 401 { error: "Unauthorized", message: "Invalid or missing API key" }
  5. Attach api_key_id to request context for rate limiting
```

### Input Validation

All route schemas defined with JSON Schema (Fastify's built-in `ajv`). Invalid parameters → HTTP 400 with structured error body identifying each invalid field. Raw input values are never echoed back.

### SQL Injection Prevention

All database access goes through Prisma ORM query builder. Raw SQL is only used for `pgvector` similarity queries, which use parameterised `$1` placeholders — never string interpolation from user-controlled input.

### Secret Management

All secrets (database URL, Redis URL, API keys, embedding model keys) loaded exclusively from environment variables. Zero secrets in source code or config files. `.env.example` contains only placeholder values.

### Outbound Request Timeout

All outbound HTTP requests to news sources are bounded at 10 seconds. On timeout: log WARN with target domain + elapsed time, treat as failed attempt, apply retry policy.

---

## Observability Design

### Prometheus Metrics

```typescript
// src/observability/metrics.ts

// Counters
sentinel_articles_fetched_total     { source }
sentinel_articles_failed_total      { source, error_type }
sentinel_events_detected_total      { event_type }

// Histograms
sentinel_processing_latency_seconds { stage }
  stages: fetch | normalize | dedup | entity | event | sentiment |
          impact | feature | embed | backfill

// Gauges
sentinel_queue_depth                { queue_name }
sentinel_cache_hit_rate             { cache_key_pattern }
sentinel_source_health              { source_name }  // 0 = down, 1 = up
```

Exposed at `GET /metrics` in Prometheus text/plain format.

### Structured Logging

Every log entry follows:

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

`correlationId` propagates from ingestion through all worker stages via BullMQ job metadata, enabling end-to-end trace reconstruction.

### Health Endpoints

```
GET /health
  Always returns 200 if process is alive.
  { status: "alive", timestamp: ISO8601 }

GET /ready
  Probes PostgreSQL, Redis, and all enabled Tier-1 sources within 2s.
  200 if all three are reachable.
  503 if any probe fails.
  { status: "ready"|"not_ready", checks: { postgres, redis, tier1_sources } }

GET /metrics
  Prometheus text/plain
```

### Source Health Alerting

If `sentinel_source_health{source_name}` transitions 1→0 and remains 0 for > 5 consecutive minutes, a WARN-level structured log entry is emitted identifying the source and duration of unavailability.

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Tier-1 Sources Polled Before Tier-2

*For any* mix of enabled Tier-1 and Tier-2 sources, within a single scheduling cycle the recorded poll order must have every Tier-1 source appearing before any Tier-2 source.

**Validates: Requirements 1.3**

### Property 2: Source Enable-State Parsing

*For any* string value of a `NEWS_SOURCE_*_ENABLED` environment variable, the parsed enabled state is `true` if and only if `value.toLowerCase() === 'true'`, and `false` for all other values.

**Validates: Requirements 1.7**

### Property 3: CircuitBreaker State Transitions

*For any* sequence of consecutive fetch failures of length N ≥ configured threshold, the CircuitBreaker must transition to the OPEN state; for any sequence of length N < threshold, the CircuitBreaker must remain CLOSED.

**Validates: Requirements 2.1, 2.2**

### Property 4: Exponential Backoff Delay Correctness

*For any* retry attempt index N (1-based) with base delay B and multiplier M, the computed delay must equal `min(B × M^(N-1), 300_000ms)`, respecting the per-attempt cap.

**Validates: Requirements 2.3**

### Property 5: NormalizedArticle Field Completeness

*For any* valid `RawArticle`, the produced `NormalizedArticle` contains all required fields with optional fields set to `null` (not `undefined`) when absent from the source.

**Validates: Requirements 3.1**

### Property 6: Content Truncation at Word Boundary

*For any* article content string of length > 50,000 characters, the truncated output has length ≤ 50,000 and does not end mid-word (the last character before the boundary is whitespace or punctuation separating complete words).

**Validates: Requirements 3.5**

### Property 7: Hash Determinism and Format

*For any* content or title string, applying the hash function twice produces the same 64-character lowercase hexadecimal string; the output always matches `/^[0-9a-f]{64}$/`.

**Validates: Requirements 3.7**

### Property 8: HTML Block-Element Newline Preservation

*For any* HTML string containing block-level elements (`<p>`, `<div>`, `<br>`, `<h1>`–`<h6>`, `<li>`), the stripped output contains newline characters at positions corresponding to each block boundary.

**Validates: Requirements 3.4**

### Property 9: Deduplication Idempotence

*For any* article payload, processing it through the DeduplicationEngine N times (N ≥ 1) produces the same cluster state as processing it exactly once — no duplicate cluster records, no change in `source_count` beyond the first processing.

**Validates: Requirements 4.10**

### Property 10: Consensus Score Formula Correctness

*For any* NewsCluster containing a mix of Tier-1 and Tier-2 sources, the computed `consensus_score` equals `(Σ weights of distinct represented tiers) / (Σ weights of all defined tiers)`, is in `[0.00, 1.00]`, and is rounded to exactly 2 decimal places.

**Validates: Requirements 4.8**

### Property 11: Event Detection Idempotence

*For any* article payload, processing it through the EventDetectionEngine N times (N ≥ 1) produces the same set of `news_events` records as processing it once — no duplicate events, no mutation of existing event data.

**Validates: Requirements 6.8**

### Property 12: Sentiment Score Range and Precision

*For any* article or NewsEvent input, all five computed sentiment dimensions (`sentimentScore`, `marketSentiment`, `companySentiment`, `macroSentiment`, `riskSentiment`) are floating-point values in `[-1.0000, +1.0000]` rounded to exactly 4 decimal places.

**Validates: Requirements 8.1**

### Property 13: Importance Score Range

*For any* NewsEvent with any combination of valid sub-score inputs in their defined ranges, the computed `importance_score` (both before and after surprise multiplier application) is in `[0.0, 1.0]`.

**Validates: Requirements 9.1, 14.4**

### Property 14: NewsImpactScore Range

*For any* set of valid factor inputs (`Sentiment`, `Importance`, `SourceReliability`, `EntityRelevance`, `HistoricalImpact`, `MarketRegimeCompatibility`, `Confidence`), the computed `NewsImpactScore` is in `[-100.0, +100.0]`.

**Validates: Requirements 10.6**

### Property 15: Surprise Score Formula and Capping

*For any* `(quantitativeValue, expectedValue)` pair where `expectedValue ≠ 0`, the computed `surprise_score` equals `clamp((quantitativeValue - expectedValue) / |expectedValue|, -5.0, +5.0)` rounded to 4 decimal places; when `expectedValue = 0`, `surprise_score` is `null` with `surprise_score_error = "division_by_zero"`.

**Validates: Requirements 14.1**

### Property 16: Point-in-Time Correctness Enforcement

*For any* FeatureVector computation, every data source used must have `recordTimestamp ≤ event_timestamp`; any feature whose source data has `recordTimestamp > event_timestamp` causes a `LookAheadBiasError` and the entire FeatureVector is aborted and not persisted.

**Validates: Requirements 20.2, 21.1**

### Property 17: ML Label Assignment Determinism

*For any* return value and threshold configuration, the directional label assignment is deterministic — the same return value always maps to the same label bucket; values in a gap between thresholds always map to the nearest threshold boundary label.

**Validates: Requirements 22.2**

### Property 18: News Velocity Momentum Null-Safety

*For any* (current_velocity, baseline_velocity) pair, `momentum = current / baseline` when `baseline > 0`; `momentum = null` when `baseline = 0` or `baseline = null` — never a division-by-zero error or a non-null momentum with zero baseline.

**Validates: Requirements 15.2**

### Property 19: Semver Version String Validation

*For any* string value of `pipeline_version` or `feature_version`, validation passes if and only if the string matches `^\d+\.\d+\.\d+$`; all other formats are rejected at startup with an ERROR log.

**Validates: Requirements 33.4**

---

## Error Handling

### Worker Error Handling Pattern

All workers follow a uniform error handling structure:

```typescript
// Pattern applied in every worker
worker.process(async (job: Job) => {
  const correlationId = job.id;
  try {
    await engine.process(job.data);
  } catch (err) {
    if (err instanceof LookAheadBiasError) {
      // Never retry — abort and log as ERROR
      logger.error({ correlationId, err }, 'Look-ahead bias detected — aborting');
      return; // do not throw — job completes without publishing downstream
    }
    if (err instanceof StorageError && job.attemptsMade < 3) {
      throw err; // BullMQ will retry with exponential backoff
    }
    // Exhausted retries → BullMQ moves to deadletter automatically
    throw err;
  }
});
```

### Dead Letter Queue Handling

Every pipeline queue has a corresponding `news.{stage}.deadletter` queue. DLQ jobs contain:
- Original job payload
- Error message and stack trace
- Full retry history with timestamps
- UTC timestamp of final failure

DLQ contents are exposed via `GET /api/v1/admin/queues` and can be manually replayed via the admin API.

### Normalization Failure

On parse/extraction error during normalization:
1. Write error record to `news_processing_errors` (stage, error_type, error_message, UTC timestamp).
2. If `news_processing_errors` table unavailable: retain in memory up to 60s, retry write up to 3× at 20s intervals, then discard.
3. Do NOT re-enqueue the article.

### news.normalized Queue Unavailability

If the `news.normalized` queue is unavailable after normalization:
1. Retry enqueue up to 3× at 5s intervals.
2. On exhaustion: write error record to `news_processing_errors`, discard article.

### Source Configuration Errors

If a source-specific env var (base URL, poll interval) is absent at startup:
1. Log WARN identifying the missing variable and affected source.
2. Disable that source for the current process lifetime.
3. Application continues running — other sources unaffected.

### data-service Unavailability

- Historical Reaction Engine: record null for all return fields at the timed-out offset, set `data_service_timeout = true`.
- Feature Engineering Engine: if market context data is unavailable, abort FeatureVector computation for that event and log WARN.
- Market Regime Engine: retain existing cached regime, log WARN.

### Scrapling Sidecar Unavailability

Scrapling-dependent adapters catch HTTP errors from the sidecar and treat the fetch as a failed attempt subject to the standard retry policy. CircuitBreaker tracks failures per source, not per sidecar.

---

## Testing Strategy

### Dual Testing Approach

Unit tests cover specific examples, edge cases, and error conditions. Property-based tests (PBT) verify universal properties across generated input spaces. Both are required for comprehensive coverage.

### Property-Based Testing

**Library**: `fast-check` (TypeScript-native, well-maintained, supports complex generators)

**Configuration**: Minimum 100 iterations per property test.

**Tag format**: `// Feature: sentinel-pulse, Property {N}: {property_text}`

Each correctness property maps to a single property-based test. Example:

```typescript
// tests/property/deduplication.property.test.ts
// Feature: sentinel-pulse, Property 9: Deduplication idempotence

import fc from 'fast-check';
import { DeduplicationEngine } from '../../src/engines/deduplication/DeduplicationEngine';

describe('Property 9: Deduplication idempotence', () => {
  it('processing the same article twice produces the same cluster state as once', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbitraryNormalizedArticle(),
        async (article) => {
          const db = createTestDb();
          const engine = new DeduplicationEngine(db);

          await engine.process(article);
          const stateAfterOne = await db.getClusterState(article.id);

          await engine.process(article);
          const stateAfterTwo = await db.getClusterState(article.id);

          expect(stateAfterTwo).toEqual(stateAfterOne);
        }
      ),
      { numRuns: 100 }
    );
  });
});
```

### Unit Test Coverage Requirements

- Minimum 80% line coverage per engine (NormalizationEngine, DeduplicationEngine, EntityResolutionEngine, EventDetectionEngine, SentimentEngine, ImportanceEngine, MarketImpactEngine, HistoricalReactionEngine, FeatureEngineeringEngine).
- CI blocks merges when coverage drops below 80% for any modified engine.

### Integration Tests

Each `NewsSourceAdapter` has integration tests that mock HTTP responses and verify:
- Successful fetch (200) — correct `RawArticle[]` produced
- HTTP 429 rate-limit response — correct backoff/retry behaviour
- HTTP 500 server error — retry, then CircuitBreaker transition
- Malformed response body — graceful error, empty list returned
- Network timeout (simulated) — treated as failed attempt, no propagation

### Failure Simulation Tests

One dedicated test disables all Tier-1 sources and asserts:
- Tier-2 articles continue being processed
- No ERROR-level log entries attributable to Tier-1 outage
- Ingestion runs for Tier-2 sources record `status = "success"`

### Look-Ahead Leakage CI Check

```typescript
// tests/ci/look-ahead-check.ts
// Scans all FeatureVector records in test dataset
// Fails build if any market_context feature has source_timestamp > event_timestamp
// Must complete within 10 minutes for 1,000,000 records
// Reports offending record IDs and feature names in build output
```

### Performance Tests

Pipeline throughput at 10, 100, 500, 1,000 articles/minute:
- Assert p95 latency from `fetchLatest` to `news_features` insert ≤ 30 seconds at 1,000 articles/min.
- Pre-seeded dataset of at least 1,000 articles.

---

## Deployment Topology

### Docker Compose Layout

```yaml
# docker/docker-compose.yml

services:
  # ── Data stores ──────────────────────────────────────────────────────────
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_DB: sentinel_pulse
      POSTGRES_USER: sentinel
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: pg_isready -U sentinel -d sentinel_pulse

  redis:
    image: redis:7-alpine
    command: redis-server --maxmemory 2gb --maxmemory-policy allkeys-lru
    volumes:
      - redisdata:/data

  # ── Scrapling sidecar ────────────────────────────────────────────────────
  scrapling:
    build:
      context: .
      dockerfile: docker/Dockerfile.scrapling
    environment:
      SCRAPLING_PORT: 8001
    ports:
      - "8001:8001"

  # ── Main API server ──────────────────────────────────────────────────────
  api:
    build:
      context: .
      dockerfile: docker/Dockerfile
    command: node dist/app.js
    environment:
      DATABASE_URL: postgresql://sentinel:${POSTGRES_PASSWORD}@postgres:5432/sentinel_pulse
      REDIS_URL: redis://redis:6379
      SCRAPLING_URL: http://scrapling:8001
    ports:
      - "3000:3000"
    depends_on:
      postgres: { condition: service_healthy }
      redis:    { condition: service_started }

  # ── Workers (each independently scalable) ────────────────────────────────
  worker-normalize:
    build: { context: ., dockerfile: docker/Dockerfile }
    command: node dist/workers/normalize.worker.js
    environment:
      WORKER_NORMALIZE_CONCURRENCY: ${WORKER_NORMALIZE_CONCURRENCY:-4}
    deploy:
      replicas: ${NORMALIZE_REPLICAS:-1}

  worker-dedup:
    build: { context: ., dockerfile: docker/Dockerfile }
    command: node dist/workers/dedup.worker.js
    environment:
      WORKER_DEDUP_CONCURRENCY: ${WORKER_DEDUP_CONCURRENCY:-2}

  worker-entity:
    command: node dist/workers/entity.worker.js
    environment:
      WORKER_ENTITY_CONCURRENCY: ${WORKER_ENTITY_CONCURRENCY:-4}

  worker-event:
    command: node dist/workers/event.worker.js
    environment:
      WORKER_EVENT_CONCURRENCY: ${WORKER_EVENT_CONCURRENCY:-4}

  worker-sentiment:
    command: node dist/workers/sentiment.worker.js
    environment:
      WORKER_SENTIMENT_CONCURRENCY: ${WORKER_SENTIMENT_CONCURRENCY:-4}

  worker-impact:
    command: node dist/workers/impact.worker.js
    environment:
      WORKER_IMPACT_CONCURRENCY: ${WORKER_IMPACT_CONCURRENCY:-2}

  worker-feature:
    command: node dist/workers/feature.worker.js
    environment:
      WORKER_FEATURE_CONCURRENCY: ${WORKER_FEATURE_CONCURRENCY:-4}

  worker-embed:
    command: node dist/workers/embed.worker.js
    environment:
      WORKER_EMBED_CONCURRENCY: ${WORKER_EMBED_CONCURRENCY:-2}

  # ── Scheduled jobs ───────────────────────────────────────────────────────
  scheduler:
    command: node dist/engines/ingestion/Scheduler.js
    # Stateless — can be horizontally scaled

  velocity-cron:
    command: node dist/engines/velocity/VelocityEngine.js --cron
    # Runs every 60s

  breadth-cron:
    command: node dist/engines/breadth/BreadthEngine.js --cron
    # Runs every 5min

  regime-cron:
    command: node dist/engines/market-regime/MarketRegimeEngine.js --cron
    # Runs every 15min (configurable)

volumes:
  pgdata:
  redisdata:
```

### Environment Variable Schema

```
# Required
DATABASE_URL
REDIS_URL
SENTINEL_API_KEY                      # master API key
DATA_SERVICE_URL                      # upstream data-service base URL
DATA_SERVICE_API_KEY
SCRAPLING_URL

# Source toggles (all default false except what's configured)
NEWS_SOURCE_REUTERS_ENABLED=true
NEWS_SOURCE_MONEYCONTROL_ENABLED=true
NEWS_SOURCE_ECONOMICTIMES_ENABLED=true
NEWS_SOURCE_BLOOMBERG_ENABLED=false
NEWS_SOURCE_FINANCIALTIMES_ENABLED=false
NEWS_SOURCE_COINDESK_ENABLED=false

# Per-source config (example for Reuters)
NEWS_SOURCE_REUTERS_BASE_URL
NEWS_SOURCE_REUTERS_POLL_INTERVAL_MS=60000

# Circuit breaker defaults (per source, override as needed)
CB_FAILURE_THRESHOLD=5
CB_RECOVERY_TIMEOUT_MS=60000

# Retry config
RETRY_BASE_DELAY_MS=1000
RETRY_MULTIPLIER=2
RETRY_MAX_ATTEMPTS=3

# Feature / pipeline versioning (semver required)
FEATURE_VERSION=1.0.0
PIPELINE_VERSION=1.0.0

# Worker concurrency
WORKER_NORMALIZE_CONCURRENCY=4
WORKER_DEDUP_CONCURRENCY=2
WORKER_ENTITY_CONCURRENCY=4
WORKER_EVENT_CONCURRENCY=4
WORKER_SENTIMENT_CONCURRENCY=4
WORKER_IMPACT_CONCURRENCY=2
WORKER_FEATURE_CONCURRENCY=4
WORKER_EMBED_CONCURRENCY=2

# Backfill
BACKFILL_MAX_CONCURRENCY=2
BACKFILL_MAX_LIVE_QUEUE_SHARE=0.20

# Embedding
EMBEDDING_MODEL=text-embedding-3-large
EMBEDDING_DIMENSION=1536
EMBEDDING_API_KEY

# SSRF allowlist
ALLOWED_SOURCE_DOMAINS=feeds.reuters.com,moneycontrol.com,economictimes.indiatimes.com,...

# Data retention (days; 0 = indefinite)
RETENTION_RAW_ARTICLES_DAYS=90
RETENTION_NORMALIZED_ARTICLES_DAYS=365
RETENTION_EVENTS_DAYS=730
RETENTION_TRAINING_SAMPLES_DAYS=0
```

---

## Integration Points

### data-service

| Operation | Endpoint | Used By |
|---|---|---|
| OHLCV lookup with `asOf` | `GET /ohlcv?assetId&from&to&asOf` | HistoricalReactionEngine, FeatureEngineeringEngine, MLDatasetGenerator |
| Instrument master resolve | `GET /instruments/resolve?q=` | EntityResolutionEngine |
| Instrument by ID | `GET /instruments/:id` | MarketImpactEngine |
| Regime signals | `GET /regime-signals/:marketId` | MarketRegimeEngine |
| Market context snapshot | `GET /market-context/:assetId?asOf=` | FeatureEngineeringEngine |

All calls include `asOf` parameter to ensure point-in-time correctness. Timeout: 10 seconds per call.

### AlphaForge Signal Engine

AlphaForge consumes SentinelPulse exclusively via REST:
- `GET /api/v1/alphaforge/news-context/:instrument` — primary integration point (Redis-served, p95 < 100ms)
- `GET /api/v1/alphaforge/high-impact-events` — event feed for signal computation

SentinelPulse never pushes to AlphaForge. The signal engine polls on its own schedule.

### ml-service

ml-service consumes:
- `GET /api/v1/ml/training/samples` — training dataset download (paginated)
- `GET /api/v1/ml/features/asset/:assetId` — live feature vectors
- `GET /api/v1/ml/training/samples/:sampleId/lineage` — audit trail

### Scrapling Sidecar

Internal HTTP communication only. The sidecar handles:
- Moneycontrol (no official API)
- Economic Times (no official API)
- Any other source without an RSS feed or public API

The sidecar enforces robots.txt compliance and per-source rate limits. SentinelPulse adapters treat it as an opaque extraction service.
