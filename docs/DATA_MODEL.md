# SentinelPulse Data Model

## Design Decisions

- **All timestamps** are stored as `TIMESTAMPTZ` (UTC). Prisma maps these to `DateTime @db.Timestamptz`. Inserts without an explicit timezone are rejected at the database level.
- **Primary keys** are UUID v4 (`@id @default(uuid())`), except `news_sources` which uses a short text identifier (e.g., `"reuters"`).
- **Enumeration-like values** (event types, categories, regimes) are stored as `TEXT` with application-layer validation, enabling future extension without schema migrations.
- **pgvector** extension is enabled via `CREATE EXTENSION IF NOT EXISTS vector`. Embeddings are stored as `vector(1536)` with an HNSW index for approximate nearest-neighbour search.
- **Idempotency keys** are enforced at the database level via `UNIQUE` constraints on natural keys — allowing safe upsert semantics from all pipeline workers.

---

## Tables (22 total)

### 1. `news_sources`

Registry of all configured news sources.

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | Short source identifier (`"reuters"`, `"moneycontrol"`, etc.) |
| `name` | TEXT | Human-readable name |
| `tier` | INTEGER | `1` (Reuters, Moneycontrol, EconomicTimes) or `2` |
| `enabled` | BOOLEAN | Whether the source is active |
| `base_url` | TEXT | Base URL for the source feed or API |
| `source_reliability` | FLOAT | 0–1 reliability weight (Tier-1 default: 1.0, Tier-2: 0.8) |
| `failure_counter` | INTEGER | Consecutive failure count; resets on success |
| `disabled_until` | TIMESTAMPTZ | Auto-disable expiry after 5 failures |
| `adapter_version` | TEXT | Semver of the adapter implementation |
| `created_at` | TIMESTAMPTZ | Row creation time |
| `updated_at` | TIMESTAMPTZ | Last update time |

---

### 2. `news_articles`

Normalised article records — one row per unique article after deduplication.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID PK | |
| `source_id` | TEXT FK → news_sources | |
| `external_id` | TEXT | Source-assigned article ID |
| `canonical_url` | TEXT | Deduplicated canonical URL |
| `title` | TEXT | Cleaned article title |
| `summary` | TEXT? | Lead paragraph or provided summary |
| `content` | TEXT? | Full stripped content (max 50,000 chars) |
| `author` | TEXT? | |
| `language` | TEXT | ISO 639-1 code |
| `language_confidence` | FLOAT | Detection confidence (0–1) |
| `published_at` | TIMESTAMPTZ | UTC publication time |
| `scraped_at` | TIMESTAMPTZ | UTC fetch time |
| `category` | TEXT? | Primary taxonomy category |
| `content_hash` | TEXT | SHA-256 of normalised content (64 hex chars) |
| `title_hash` | TEXT | SHA-256 of normalised title (64 hex chars) |
| `content_truncated` | BOOLEAN | True if content exceeded 50,000 chars |
| `timestamp_inferred` | BOOLEAN | True if `published_at` was inferred from `scraped_at` |
| `duplicate_count` | INTEGER | Times an exact duplicate was received |
| `cluster_id` | UUID FK → news_clusters? | Assigned deduplication cluster |
| `created_at` / `updated_at` | TIMESTAMPTZ | |

**Indexes**: `UNIQUE(source_id, external_id)`, `UNIQUE(canonical_url)`, `UNIQUE(content_hash)`, `UNIQUE(title_hash)`, `INDEX(published_at DESC)`, `INDEX(cluster_id)`

---

### 3. `news_article_versions`

Immutable version history for articles that are later corrected or updated.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID PK | |
| `article_id` | UUID FK → news_articles | |
| `content_hash` | TEXT | Hash at this version |
| `title_hash` | TEXT | Hash at this version |
| `version` | INTEGER | Monotonically increasing version number |
| `captured_at` | TIMESTAMPTZ | When this version was recorded |

**Indexes**: `INDEX(article_id)`

---

### 4. `news_clusters`

Groups of articles from different sources covering the same real-world event.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID PK | |
| `canonical_url` | TEXT | URL of the cluster's canonical article |
| `headline` | TEXT | Cluster headline |
| `source_count` | INTEGER | Total articles in the cluster |
| `source_diversity` | INTEGER | Number of distinct sources |
| `consensus_score` | NUMERIC(4,2) | `(Σ distinct-tier weights) / (Σ all-tier weights)`, 0.00–1.00 |
| `first_seen_at` | TIMESTAMPTZ | Earliest article's `published_at` |
| `last_updated_at` | TIMESTAMPTZ | Most recent cluster update |
| `created_at` | TIMESTAMPTZ | |

---

### 5. `news_events`

Structured machine-readable events extracted from articles.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID PK | |
| `article_id` | UUID FK → news_articles | |
| `event_type` | TEXT | One of: MONETARY_POLICY, EARNINGS, ECONOMIC_DATA, COMMODITY_SHOCK, GEOPOLITICAL, REGULATORY, CORPORATE_ACTION, MACRO_DATA, CREDIT_EVENT, NATURAL_DISASTER, TRADE_POLICY, CURRENCY_EVENT, SECTOR_ROTATION, UNCLASSIFIED |
| `actor` | TEXT? | Entity that performed the action |
| `action` | TEXT? | What happened |
| `target_entities` | TEXT[] | Affected entities |
| `quantitative_value` | FLOAT? | Reported numeric value |
| `expected_value` | FLOAT? | Consensus or expected value |
| `expected_value_src` | TEXT? | Source of expected value |
| `surprise_direction` | TEXT? | BEAT / MISS / IN_LINE / UNKNOWN |
| `surprise_score` | FLOAT? | `(actual - expected) / |expected|`, capped ±5.0, 4dp |
| `surprise_score_err` | TEXT? | `"division_by_zero"` when expectedValue = 0 |
| `importance` | FLOAT | Preliminary importance (0–1) |
| `confidence` | FLOAT | Extraction confidence (0–1) |
| `event_timestamp` | TIMESTAMPTZ | When the event occurred |
| `created_at` / `updated_at` | TIMESTAMPTZ | |

**Indexes**: `INDEX(event_type, event_timestamp DESC)`, `INDEX(event_timestamp DESC)`, `UNIQUE(article_id, event_type, actor)` (idempotency key)

---

### 6. `news_article_event_links`

Many-to-many join between articles and events.

| Column | Type | Description |
|--------|------|-------------|
| `article_id` | UUID FK → news_articles | |
| `event_id` | UUID FK → news_events | |

**Primary key**: `(article_id, event_id)`

---

### 7. `news_entities`

Canonical entity registry with surface-form deduplication.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID PK | |
| `surface_form` | TEXT | Raw text form as it appears in articles |
| `entity_type` | TEXT | Company / Instrument / Index / Commodity / Currency / Country / Institution |
| `instrument_id` | TEXT? | Resolved ID from data-service InstrumentMaster |
| `created_at` | TIMESTAMPTZ | |

**Indexes**: `UNIQUE(surface_form, entity_type)`

---

### 8. `news_entity_mentions`

Per-article entity mention records with position data.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID PK | |
| `article_id` | UUID FK → news_articles | |
| `entity_id` | UUID FK → news_entities? | Null if unresolved |
| `surface_form` | TEXT | As extracted from the article |
| `entity_type` | TEXT | |
| `confidence` | NUMERIC(4,2) | 0.00–1.00 |
| `sentence_pos` | INTEGER | Sentence index (non-negative) |
| `char_offset` | INTEGER | Character offset from field start (non-negative) |
| `created_at` | TIMESTAMPTZ | |

**Indexes**: `INDEX(article_id)`, `INDEX(entity_id, confidence)`

---

### 9. `news_asset_links`

Links articles to specific tradeable assets (confidence ≥ 0.50 only).

| Column | Type | Description |
|--------|------|-------------|
| `article_id` | UUID FK → news_articles | |
| `asset_id` | TEXT | Instrument ID from InstrumentMaster |
| `confidence` | NUMERIC(4,2) | |
| `published_at` | TIMESTAMPTZ | Denormalised from article for index performance |

**Primary key**: `(article_id, asset_id)`
**Indexes**: `INDEX(asset_id, published_at DESC)`

---

### 10. `news_sector_links`

Links articles to market sectors (confidence ≥ 0.50 only).

| Column | Type | Description |
|--------|------|-------------|
| `article_id` | UUID FK → news_articles | |
| `sector_id` | TEXT | Sector identifier |
| `confidence` | NUMERIC(4,2) | |
| `published_at` | TIMESTAMPTZ | Denormalised for index performance |

**Primary key**: `(article_id, sector_id)`
**Indexes**: `INDEX(sector_id, published_at DESC)`

---

### 11. `news_event_relationships`

EventGraph edges encoding cross-market causal relationships.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID PK | |
| `source_entity_id` | TEXT | Causing entity |
| `target_entity_id` | TEXT | Affected entity |
| `relationship_type` | TEXT | POSITIVE_CORRELATION / NEGATIVE_CORRELATION / CAUSAL_INDICATOR / SECTOR_ROTATION |
| `chain_order` | INTEGER | 1 (direct), 2 (second-order), 3 (third-order max) |
| `historical_correlation` | FLOAT | –1.0 to +1.0 |
| `confidence` | FLOAT | 0.0–1.0 |
| `regime_dependency` | TEXT[] | Regimes where this relationship holds |
| `sample_size` | INTEGER | Number of supporting historical reactions |
| `low_sample` | BOOLEAN | True when sample_size < 30 |
| `last_updated` | TIMESTAMPTZ | Last update from HistoricalReaction join |
| `created_at` | TIMESTAMPTZ | |

**Indexes**: `UNIQUE(source_entity_id, target_entity_id, relationship_type)`, `INDEX(source_entity_id, confidence)`

> The MarketImpactEngine only uses relationships where `confidence >= 0.2 AND sample_size >= 30 AND low_sample = false`.

---

### 12. `news_sentiment`

Multi-dimensional sentiment scores per article + model version.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID PK | |
| `article_id` | UUID FK → news_articles | |
| `event_id` | UUID FK → news_events? | Optional event association |
| `sentiment_score` | NUMERIC(6,4) | Overall, –1.0000 to +1.0000 |
| `market_sentiment` | NUMERIC(6,4) | Market dimension |
| `company_sentiment` | NUMERIC(6,4) | Company dimension |
| `macro_sentiment` | NUMERIC(6,4) | Macro dimension |
| `risk_sentiment` | NUMERIC(6,4) | Risk dimension |
| `qualitative_signals` | TEXT[] | Subset of: UNCERTAINTY, FEAR, HAWKISH, DOVISH, RISK_ON, RISK_OFF, OPTIMISM, PANIC, NEUTRAL |
| `confidence` | NUMERIC(4,2) | 0.00–1.00 |
| `model_version` | TEXT | Semver of the sentiment model |
| `computed_at` | TIMESTAMPTZ | |

**Indexes**: `UNIQUE(article_id, model_version)`, `INDEX(article_id)`

---

### 13. `news_importance`

Weighted importance score with full sub-score audit trail.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID PK | |
| `event_id` | UUID FK → news_events | |
| `importance_score` | FLOAT | 0.0–1.0 composite score |
| `sub_scores` | JSONB | Per-sub-score values and weights |
| `historical_data_available` | BOOLEAN | False if prior fallback (0.5) was used |
| `model_version` | TEXT | |
| `computed_at` | TIMESTAMPTZ | |

**Indexes**: `UNIQUE(event_id)`, `INDEX(importance_score DESC, computed_at DESC)`

---

### 14. `news_market_impacts`

Directional impact prediction per (event, asset) pair.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID PK | |
| `article_id` | UUID FK → news_articles | |
| `event_id` | UUID FK → news_events | |
| `asset_id` | TEXT? | Target asset |
| `sector_id` | TEXT? | Target sector |
| `direction` | TEXT | POSITIVE / NEGATIVE / NEUTRAL / UNCERTAIN |
| `strength` | FLOAT | 0.0–1.0 |
| `confidence` | FLOAT | 0.0–1.0 |
| `expected_horizon` | TEXT | IMMEDIATE (≤5m) / INTRADAY (≤1d) / SHORT_TERM (≤5d) / SWING (≤20d) / LONG_TERM (>20d) |
| `evidence_type` | TEXT | HISTORICAL / RULE_BASED / MODEL |
| `relationship_id` | UUID FK → news_event_relationships? | Source relationship if HISTORICAL |
| `news_impact_score` | FLOAT? | Composite –100 to +100 |
| `impact_components` | JSONB? | Each multiplicative factor value |
| `impact_computation_version` | TEXT | |
| `computed_at` | TIMESTAMPTZ | |

**Indexes**: `UNIQUE(event_id, asset_id)`, `INDEX(asset_id, computed_at DESC)`

---

### 15. `news_market_reactions`

Actual measured price/volume reactions at fixed offsets from event_timestamp.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID PK | |
| `event_id` | UUID FK → news_events | |
| `asset_id` | TEXT | |
| `return_1m` … `return_1d` | FLOAT? | Percentage return at each offset; null if market closed or data unavailable |
| `volume_change_ratio` | FLOAT? | |
| `volatility_change_ratio` | FLOAT? | |
| `high_impact_flag` | BOOLEAN | True if `|return_15m| > threshold` (default 0.5%) |
| `market_open` | BOOLEAN | False if market was closed at offset |
| `data_service_timeout` | BOOLEAN | True if data-service timed out |
| `data_service_snapshot_version` | TEXT? | Version tag from data-service response |
| `computed_at` | TIMESTAMPTZ | |

**Indexes**: `UNIQUE(event_id, asset_id)`, `INDEX(event_id)`, `INDEX(asset_id, computed_at DESC)`

---

### 16. `news_market_regimes`

Discrete market regime classifications per market, with valid time ranges.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID PK | |
| `market_id` | TEXT | `"india"` / `"us"` / `"global"` |
| `regime` | TEXT | TRENDING_BULL / TRENDING_BEAR / SIDEWAYS / HIGH_VOLATILITY / LOW_VOLATILITY / RISK_ON / RISK_OFF / EVENT_DRIVEN / PANIC / RECOVERY |
| `confidence` | FLOAT | 0.0–1.0 |
| `valid_from` | TIMESTAMPTZ | Start of this regime period |
| `valid_to` | TIMESTAMPTZ? | Null = current regime |

**Indexes**: `INDEX(market_id, valid_to NULLS FIRST)`

---

### 17. `news_features`

FeatureVectors and velocity/breadth snapshots.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID PK | |
| `event_id` | UUID FK → news_events? | Linked event (for article features) |
| `asset_id` | TEXT? | Target asset |
| `entity_type` | TEXT? | `"article"` / `"VELOCITY"` / `"BREADTH"` |
| `entity_id` | TEXT? | |
| `feature_type` | TEXT | e.g., `"ARTICLE_FEATURES"`, `"VELOCITY"`, `"BREADTH"` |
| `feature_vector` | JSONB? | Full feature vector for ML consumption |
| `window` | TEXT? | `"1m"` / `"5m"` for velocity features |
| `value` | FLOAT? | Scalar value for velocity/breadth |
| `baseline` | FLOAT? | 7-day rolling baseline |
| `momentum` | FLOAT? | `value / baseline`; null if baseline = 0 |
| `feature_version` | TEXT | Semver |
| `pipeline_version` | TEXT | Semver |
| `computed_at` | TIMESTAMPTZ | |

**Indexes**: `UNIQUE(event_id, asset_id, feature_version)`, `INDEX(event_id)`, `INDEX(asset_id, computed_at DESC)`, `INDEX(feature_type, entity_id, computed_at DESC)`

---

### 18. `news_embeddings`

Dense vector embeddings for semantic search and similarity.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID PK | |
| `entity_type` | TEXT | `"article"` / `"event"` / `"entity"` |
| `entity_id` | UUID | ID of the embedded entity |
| `embedding` | vector(1536) | pgvector embedding |
| `model_version` | TEXT | Embedding model identifier |
| `created_at` | TIMESTAMPTZ | |

**Indexes**: `INDEX USING hnsw (embedding vector_cosine_ops)`, `INDEX(entity_type, entity_id, model_version)`

> Semantic search targets p95 < 500ms for corpus up to 1M embeddings using HNSW approximate nearest-neighbour.

---

### 19. `news_training_samples`

Labelled ML training records joining FeatureVectors with forward returns.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID PK | |
| `event_id` | UUID FK → news_events | |
| `asset_id` | TEXT | |
| `article_ids` | UUID[] | Contributing articles |
| `feature_vector_id` | UUID FK → news_features | |
| `future_return_5m` … `future_return_1d` | FLOAT? | Forward returns; null if data unavailable |
| `label_5m` … `label_1d` | TEXT? | STRONG_BULLISH / BULLISH / NEUTRAL / BEARISH / STRONG_BEARISH |
| `label_cutoff_5m` … `label_cutoff_1d` | TIMESTAMPTZ? | Exact data timestamp used for each label |
| `feature_version` | TEXT | Semver |
| `pipeline_version` | TEXT | Semver |
| `market_data_snapshot_version` | TEXT | data-service snapshot tag |
| `model_version` | TEXT | |
| `created_at` | TIMESTAMPTZ | |

**Indexes**: `INDEX(event_id, asset_id, feature_version)`, `INDEX(asset_id, created_at DESC)`

---

### 20. `news_source_metrics`

Aggregated per-source fetch metrics for observability.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID PK | |
| `source_id` | TEXT FK → news_sources | |
| `window_start` | TIMESTAMPTZ | |
| `window_end` | TIMESTAMPTZ | |
| `articles_fetched` | INTEGER | |
| `articles_failed` | INTEGER | |
| `avg_latency_ms` | FLOAT? | |
| `recorded_at` | TIMESTAMPTZ | |

**Indexes**: `INDEX(source_id, window_start DESC)`

---

### 21. `news_ingestion_runs`

Per-source ingestion run audit trail.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID PK | |
| `source_id` | TEXT FK → news_sources | |
| `started_at` | TIMESTAMPTZ | |
| `completed_at` | TIMESTAMPTZ? | |
| `articles_fetched` | INTEGER | |
| `articles_failed` | INTEGER | |
| `status` | TEXT | `"success"` / `"partial_failure"` / `"failed"` |

**Indexes**: `INDEX(source_id, started_at DESC)`

---

### 22. `news_processing_errors`

Pipeline error log for failed normalization/processing attempts.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID PK | |
| `source_id` | TEXT? | |
| `external_id` | TEXT? | Source-assigned article ID |
| `stage` | TEXT | normalization / deduplication / entity / event / sentiment / impact / feature |
| `error_type` | TEXT | |
| `error_message` | TEXT | |
| `created_at` | TIMESTAMPTZ | |

**Indexes**: `INDEX(stage, created_at DESC)`

---

### (Bonus) `news_alerts`

High-importance event alerts with per-channel delivery tracking.

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID PK | |
| `alert_type` | TEXT | |
| `trigger_reason` | TEXT | |
| `asset_id` | TEXT | |
| `event_id` | UUID FK → news_events? | |
| `cluster_id` | UUID FK → news_clusters? | |
| `importance_score` | FLOAT | |
| `description` | TEXT | Max 500 characters |
| `payload` | JSONB | Full alert payload |
| `delivery_channels` | JSONB | Per-channel delivery status |
| `computed_at` | TIMESTAMPTZ | |

**Indexes**: `INDEX(asset_id, computed_at DESC)`, `INDEX(cluster_id, alert_type, computed_at DESC)`
