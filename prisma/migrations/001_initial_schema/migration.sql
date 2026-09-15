-- =============================================================================
-- SentinelPulse — Initial Schema Migration
-- Migration 001: All 23 tables, composite indexes (Req 28.2),
--                HNSW pgvector index (Req 18.2), TIMESTAMPTZ enforcement (Req 28.4)
-- =============================================================================

-- Enable pgvector extension (must precede any vector column usage)
CREATE EXTENSION IF NOT EXISTS "vector";

-- =============================================================================
-- 1. news_sources
--    Canonical registry of all configured news sources.
-- =============================================================================
CREATE TABLE "news_sources" (
    "id"                 TEXT NOT NULL,
    "name"               TEXT NOT NULL,
    "tier"               INTEGER NOT NULL,
    "enabled"            BOOLEAN NOT NULL DEFAULT true,
    "base_url"           TEXT,
    "source_reliability" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "failure_counter"    INTEGER NOT NULL DEFAULT 0,
    "disabled_until"     TIMESTAMPTZ,
    "adapter_version"    TEXT NOT NULL,
    "created_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "news_sources_pkey" PRIMARY KEY ("id")
);

-- =============================================================================
-- 2. news_clusters
--    Group of articles from multiple sources covering the same real-world event.
--    Defined before news_articles because news_articles has a FK to it.
-- =============================================================================
CREATE TABLE "news_clusters" (
    "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
    "canonical_url"    TEXT NOT NULL,
    "headline"         TEXT NOT NULL,
    "source_count"     INTEGER NOT NULL DEFAULT 1,
    "source_diversity" INTEGER NOT NULL DEFAULT 1,
    "consensus_score"  DECIMAL(4,2) NOT NULL DEFAULT 0.00,
    "first_seen_at"    TIMESTAMPTZ NOT NULL,
    "last_updated_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
    "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "news_clusters_pkey" PRIMARY KEY ("id")
);

-- =============================================================================
-- 3. news_articles
--    Canonical normalised article records — one per unique piece of content.
-- =============================================================================
CREATE TABLE "news_articles" (
    "id"                  UUID NOT NULL DEFAULT gen_random_uuid(),
    "source_id"           TEXT NOT NULL,
    "external_id"         TEXT NOT NULL,
    "canonical_url"       TEXT NOT NULL,
    "title"               TEXT NOT NULL,
    "summary"             TEXT,
    "content"             TEXT,
    "author"              TEXT,
    "language"            TEXT NOT NULL,
    "language_confidence" DOUBLE PRECISION NOT NULL,
    "published_at"        TIMESTAMPTZ NOT NULL,
    "scraped_at"          TIMESTAMPTZ NOT NULL,
    "category"            TEXT,
    "content_hash"        TEXT NOT NULL,
    "title_hash"          TEXT NOT NULL,
    "content_truncated"   BOOLEAN NOT NULL DEFAULT false,
    "timestamp_inferred"  BOOLEAN NOT NULL DEFAULT false,
    "duplicate_count"     INTEGER NOT NULL DEFAULT 0,
    "cluster_id"          UUID,
    "created_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "news_articles_pkey"          PRIMARY KEY ("id"),
    CONSTRAINT "news_articles_source_id_external_id_key" UNIQUE ("source_id", "external_id"),
    CONSTRAINT "news_articles_canonical_url_key"         UNIQUE ("canonical_url"),
    CONSTRAINT "news_articles_content_hash_key"          UNIQUE ("content_hash"),
    CONSTRAINT "news_articles_title_hash_key"            UNIQUE ("title_hash"),
    CONSTRAINT "news_articles_source_id_fkey"
        FOREIGN KEY ("source_id")  REFERENCES "news_sources"("id"),
    CONSTRAINT "news_articles_cluster_id_fkey"
        FOREIGN KEY ("cluster_id") REFERENCES "news_clusters"("id")
);

-- Composite index: Req 28.2 — time-ordered article lookups
CREATE INDEX "news_articles_published_at_idx"
    ON "news_articles" ("published_at" DESC);

CREATE INDEX "news_articles_cluster_id_idx"
    ON "news_articles" ("cluster_id");

-- =============================================================================
-- 4. news_article_versions
--    Immutable snapshot of each content change detected on re-scrape.
-- =============================================================================
CREATE TABLE "news_article_versions" (
    "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
    "article_id"   UUID NOT NULL,
    "content_hash" TEXT NOT NULL,
    "title_hash"   TEXT NOT NULL,
    "version"      INTEGER NOT NULL,
    "captured_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "news_article_versions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "news_article_versions_article_id_fkey"
        FOREIGN KEY ("article_id") REFERENCES "news_articles"("id")
);

CREATE INDEX "news_article_versions_article_id_idx"
    ON "news_article_versions" ("article_id");

-- =============================================================================
-- 5. news_events
--    Structured market event extracted from one or more articles.
--    Idempotency key: (article_id, event_type, actor)
-- =============================================================================
CREATE TABLE "news_events" (
    "id"                  UUID NOT NULL DEFAULT gen_random_uuid(),
    "article_id"          UUID NOT NULL,
    "event_type"          TEXT NOT NULL,
    "actor"               TEXT,
    "action"              TEXT,
    "target_entities"     TEXT[] NOT NULL DEFAULT '{}',
    "quantitative_value"  DOUBLE PRECISION,
    "expected_value"      DOUBLE PRECISION,
    "expected_value_src"  TEXT,
    "surprise_direction"  TEXT,
    "surprise_score"      DOUBLE PRECISION,
    "surprise_score_err"  TEXT,
    "importance"          DOUBLE PRECISION NOT NULL DEFAULT 0,
    "confidence"          DOUBLE PRECISION NOT NULL,
    "event_timestamp"     TIMESTAMPTZ NOT NULL,
    "created_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "news_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "news_events_article_id_event_type_actor_key"
        UNIQUE ("article_id", "event_type", "actor"),
    CONSTRAINT "news_events_article_id_fkey"
        FOREIGN KEY ("article_id") REFERENCES "news_articles"("id")
);

-- Composite index: Req 28.2 — event_type + published_at (via join on news_articles)
CREATE INDEX "news_events_event_timestamp_idx"
    ON "news_events" ("event_timestamp" DESC);

-- =============================================================================
-- 6. news_article_event_links
--    Many-to-many join between articles and events.
-- =============================================================================
CREATE TABLE "news_article_event_links" (
    "article_id" UUID NOT NULL,
    "event_id"   UUID NOT NULL,

    CONSTRAINT "news_article_event_links_pkey"
        PRIMARY KEY ("article_id", "event_id"),
    CONSTRAINT "news_article_event_links_article_id_fkey"
        FOREIGN KEY ("article_id") REFERENCES "news_articles"("id"),
    CONSTRAINT "news_article_event_links_event_id_fkey"
        FOREIGN KEY ("event_id") REFERENCES "news_events"("id")
);

-- =============================================================================
-- 7. news_entities
--    Canonical entity registry — surface form resolved to InstrumentMaster.
-- =============================================================================
CREATE TABLE "news_entities" (
    "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
    "surface_form"  TEXT NOT NULL,
    "entity_type"   TEXT NOT NULL,
    "instrument_id" TEXT,
    "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "news_entities_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "news_entities_surface_form_entity_type_key"
        UNIQUE ("surface_form", "entity_type")
);

-- =============================================================================
-- 8. news_entity_mentions
--    Per-article record of every named entity extracted.
-- =============================================================================
CREATE TABLE "news_entity_mentions" (
    "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
    "article_id"   UUID NOT NULL,
    "entity_id"    UUID,
    "surface_form" TEXT NOT NULL,
    "entity_type"  TEXT NOT NULL,
    "confidence"   DECIMAL(4,2) NOT NULL,
    "sentence_pos" INTEGER NOT NULL,
    "char_offset"  INTEGER NOT NULL,
    "created_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "news_entity_mentions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "news_entity_mentions_article_id_fkey"
        FOREIGN KEY ("article_id") REFERENCES "news_articles"("id"),
    CONSTRAINT "news_entity_mentions_entity_id_fkey"
        FOREIGN KEY ("entity_id") REFERENCES "news_entities"("id")
);

-- Composite index: Req 28.2 — entity lookups by article and confidence
CREATE INDEX "news_entity_mentions_article_id_idx"
    ON "news_entity_mentions" ("article_id");

CREATE INDEX "news_entity_mentions_entity_id_confidence_idx"
    ON "news_entity_mentions" ("entity_id", "confidence");

-- =============================================================================
-- 9. news_asset_links
--    Resolved article → tradeable instrument mapping.
-- =============================================================================
CREATE TABLE "news_asset_links" (
    "article_id"   UUID NOT NULL,
    "asset_id"     TEXT NOT NULL,
    "confidence"   DECIMAL(4,2) NOT NULL,
    "published_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "news_asset_links_pkey"
        PRIMARY KEY ("article_id", "asset_id"),
    CONSTRAINT "news_asset_links_article_id_fkey"
        FOREIGN KEY ("article_id") REFERENCES "news_articles"("id")
);

-- Composite index: Req 28.2 — asset_id lookups by recency
CREATE INDEX "news_asset_links_asset_id_published_at_idx"
    ON "news_asset_links" ("asset_id", "published_at" DESC);

-- =============================================================================
-- 10. news_sector_links
--     Resolved article → sector mapping.
-- =============================================================================
CREATE TABLE "news_sector_links" (
    "article_id"   UUID NOT NULL,
    "sector_id"    TEXT NOT NULL,
    "confidence"   DECIMAL(4,2) NOT NULL,
    "published_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "news_sector_links_pkey"
        PRIMARY KEY ("article_id", "sector_id"),
    CONSTRAINT "news_sector_links_article_id_fkey"
        FOREIGN KEY ("article_id") REFERENCES "news_articles"("id")
);

-- Composite index: Req 28.2
CREATE INDEX "news_sector_links_sector_id_published_at_idx"
    ON "news_sector_links" ("sector_id", "published_at" DESC);

-- =============================================================================
-- 11. news_event_relationships
--     Cross-market relationship graph used by MarketImpactEngine.
-- =============================================================================
CREATE TABLE "news_event_relationships" (
    "id"                     UUID NOT NULL DEFAULT gen_random_uuid(),
    "source_entity_id"       TEXT NOT NULL,
    "target_entity_id"       TEXT NOT NULL,
    "relationship_type"      TEXT NOT NULL,
    "chain_order"            INTEGER NOT NULL DEFAULT 1,
    "historical_correlation" DOUBLE PRECISION NOT NULL,
    "confidence"             DOUBLE PRECISION NOT NULL,
    "regime_dependency"      TEXT[] NOT NULL DEFAULT '{}',
    "sample_size"            INTEGER NOT NULL DEFAULT 0,
    "low_sample"             BOOLEAN NOT NULL DEFAULT false,
    "last_updated"           TIMESTAMPTZ NOT NULL DEFAULT now(),
    "created_at"             TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "news_event_relationships_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "news_event_relationships_source_target_type_key"
        UNIQUE ("source_entity_id", "target_entity_id", "relationship_type")
);

-- Composite index: Req 28.2 — relationship confidence filtering
CREATE INDEX "news_event_relationships_source_confidence_idx"
    ON "news_event_relationships" ("source_entity_id", "confidence");

-- =============================================================================
-- 12. news_sentiment
--     Multi-dimensional sentiment scores per article × model version.
-- =============================================================================
CREATE TABLE "news_sentiment" (
    "id"                  UUID NOT NULL DEFAULT gen_random_uuid(),
    "article_id"          UUID NOT NULL,
    "event_id"            UUID,
    "sentiment_score"     DECIMAL(6,4) NOT NULL,
    "market_sentiment"    DECIMAL(6,4) NOT NULL,
    "company_sentiment"   DECIMAL(6,4) NOT NULL,
    "macro_sentiment"     DECIMAL(6,4) NOT NULL,
    "risk_sentiment"      DECIMAL(6,4) NOT NULL,
    "qualitative_signals" TEXT[] NOT NULL DEFAULT '{}',
    "confidence"          DECIMAL(4,2) NOT NULL,
    "model_version"       TEXT NOT NULL,
    "computed_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "news_sentiment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "news_sentiment_article_id_model_version_key"
        UNIQUE ("article_id", "model_version"),
    CONSTRAINT "news_sentiment_article_id_fkey"
        FOREIGN KEY ("article_id") REFERENCES "news_articles"("id"),
    CONSTRAINT "news_sentiment_event_id_fkey"
        FOREIGN KEY ("event_id") REFERENCES "news_events"("id")
);

CREATE INDEX "news_sentiment_article_id_idx"
    ON "news_sentiment" ("article_id");

-- =============================================================================
-- 13. news_importance
--     Importance score for each NewsEvent with full sub-score audit trail.
-- =============================================================================
CREATE TABLE "news_importance" (
    "id"                       UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id"                 UUID NOT NULL,
    "importance_score"         DOUBLE PRECISION NOT NULL,
    "sub_scores"               JSONB NOT NULL,
    "historical_data_available" BOOLEAN NOT NULL DEFAULT false,
    "model_version"            TEXT NOT NULL,
    "computed_at"              TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "news_importance_pkey"     PRIMARY KEY ("id"),
    CONSTRAINT "news_importance_event_id_key" UNIQUE ("event_id"),
    CONSTRAINT "news_importance_event_id_fkey"
        FOREIGN KEY ("event_id") REFERENCES "news_events"("id")
);

-- Composite index: Req 28.2 — importance score DESC for high-impact event queries
CREATE INDEX "news_importance_score_computed_at_idx"
    ON "news_importance" ("importance_score" DESC, "computed_at" DESC);

-- =============================================================================
-- 14. news_market_impacts
--     Directional impact prediction per (event, asset/sector) pair.
-- =============================================================================
CREATE TABLE "news_market_impacts" (
    "id"                         UUID NOT NULL DEFAULT gen_random_uuid(),
    "article_id"                 UUID NOT NULL,
    "event_id"                   UUID NOT NULL,
    "asset_id"                   TEXT,
    "sector_id"                  TEXT,
    "direction"                  TEXT NOT NULL,
    "strength"                   DOUBLE PRECISION NOT NULL,
    "confidence"                 DOUBLE PRECISION NOT NULL,
    "expected_horizon"           TEXT NOT NULL,
    "evidence_type"              TEXT NOT NULL,
    "relationship_id"            UUID,
    "news_impact_score"          DOUBLE PRECISION,
    "impact_components"          JSONB,
    "impact_computation_version" TEXT NOT NULL,
    "computed_at"                TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "news_market_impacts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "news_market_impacts_event_id_asset_id_key"
        UNIQUE ("event_id", "asset_id"),
    CONSTRAINT "news_market_impacts_article_id_fkey"
        FOREIGN KEY ("article_id") REFERENCES "news_articles"("id"),
    CONSTRAINT "news_market_impacts_event_id_fkey"
        FOREIGN KEY ("event_id") REFERENCES "news_events"("id"),
    CONSTRAINT "news_market_impacts_relationship_id_fkey"
        FOREIGN KEY ("relationship_id") REFERENCES "news_event_relationships"("id")
);

-- Composite index: Req 28.2
CREATE INDEX "news_market_impacts_asset_id_computed_at_idx"
    ON "news_market_impacts" ("asset_id", "computed_at" DESC);

-- =============================================================================
-- 15. news_market_reactions
--     Observed price/volume/volatility changes following past events.
-- =============================================================================
CREATE TABLE "news_market_reactions" (
    "id"                          UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id"                    UUID NOT NULL,
    "asset_id"                    TEXT NOT NULL,
    "return_1m"                   DOUBLE PRECISION,
    "return_5m"                   DOUBLE PRECISION,
    "return_15m"                  DOUBLE PRECISION,
    "return_30m"                  DOUBLE PRECISION,
    "return_1h"                   DOUBLE PRECISION,
    "return_4h"                   DOUBLE PRECISION,
    "return_1d"                   DOUBLE PRECISION,
    "volume_change_ratio"         DOUBLE PRECISION,
    "volatility_change_ratio"     DOUBLE PRECISION,
    "high_impact_flag"            BOOLEAN NOT NULL DEFAULT false,
    "market_open"                 BOOLEAN NOT NULL DEFAULT true,
    "data_service_timeout"        BOOLEAN NOT NULL DEFAULT false,
    "data_service_snapshot_version" TEXT,
    "computed_at"                 TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "news_market_reactions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "news_market_reactions_event_id_asset_id_key"
        UNIQUE ("event_id", "asset_id"),
    CONSTRAINT "news_market_reactions_event_id_fkey"
        FOREIGN KEY ("event_id") REFERENCES "news_events"("id")
);

CREATE INDEX "news_market_reactions_event_id_idx"
    ON "news_market_reactions" ("event_id");

CREATE INDEX "news_market_reactions_asset_id_computed_at_idx"
    ON "news_market_reactions" ("asset_id", "computed_at" DESC);

-- =============================================================================
-- 16. news_market_regimes
--     Current and historical discrete market environment classifications.
--     valid_to = NULL → current active regime for that market.
-- =============================================================================
CREATE TABLE "news_market_regimes" (
    "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
    "market_id"  TEXT NOT NULL,
    "regime"     TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "valid_from" TIMESTAMPTZ NOT NULL,
    "valid_to"   TIMESTAMPTZ,

    CONSTRAINT "news_market_regimes_pkey" PRIMARY KEY ("id")
);

-- Index with NULLS FIRST so current regime (valid_to IS NULL) appears first
CREATE INDEX "news_market_regimes_market_id_valid_to_idx"
    ON "news_market_regimes" ("market_id", "valid_to" ASC NULLS FIRST);

-- =============================================================================
-- 17. news_features
--     Point-in-time correct numerical feature vectors for ml-service.
--     Idempotency key: (event_id, asset_id, feature_version)
-- =============================================================================
CREATE TABLE "news_features" (
    "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id"         UUID,
    "asset_id"         TEXT,
    "entity_type"      TEXT,
    "entity_id"        TEXT,
    "feature_type"     TEXT NOT NULL,
    "feature_vector"   JSONB,
    "window"           TEXT,
    "value"            DOUBLE PRECISION,
    "baseline"         DOUBLE PRECISION,
    "momentum"         DOUBLE PRECISION,
    "feature_version"  TEXT NOT NULL,
    "pipeline_version" TEXT NOT NULL,
    "computed_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "news_features_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "news_features_event_id_asset_id_feature_version_key"
        UNIQUE ("event_id", "asset_id", "feature_version"),
    CONSTRAINT "news_features_event_id_fkey"
        FOREIGN KEY ("event_id") REFERENCES "news_events"("id")
    -- entity_id is TEXT; no DB-level FK to news_articles (UUID PK incompatible).
    -- Article linkage is enforced at the application layer only.
);

CREATE INDEX "news_features_event_id_idx"
    ON "news_features" ("event_id");

CREATE INDEX "news_features_asset_id_computed_at_idx"
    ON "news_features" ("asset_id", "computed_at" DESC);

-- Composite index: Req 28.2
CREATE INDEX "news_features_feature_type_entity_id_computed_at_idx"
    ON "news_features" ("feature_type", "entity_id", "computed_at" DESC);

-- =============================================================================
-- 18. news_embeddings
--     Semantic embedding vectors (pgvector) for articles, events, entities.
--     HNSW index: Req 18.2 — vector_cosine_ops for cosine similarity search.
-- =============================================================================
CREATE TABLE "news_embeddings" (
    "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
    "entity_type"   TEXT NOT NULL,
    "entity_id"     UUID NOT NULL,
    "embedding"     vector(1536),
    "model_version" TEXT NOT NULL,
    "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "news_embeddings_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "news_embeddings_entity_type_entity_id_model_version_idx"
    ON "news_embeddings" ("entity_type", "entity_id", "model_version");

-- HNSW index for efficient approximate nearest-neighbour search (Req 18.2)
-- Target p95 < 500ms for corpus up to 1M embeddings
CREATE INDEX "news_embeddings_embedding_hnsw_idx"
    ON "news_embeddings" USING hnsw ("embedding" vector_cosine_ops);

-- =============================================================================
-- 19. news_training_samples
--     Labelled feature vectors for ml-service model training.
-- =============================================================================
CREATE TABLE "news_training_samples" (
    "id"                           UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id"                     UUID NOT NULL,
    "asset_id"                     TEXT NOT NULL,
    "article_ids"                  UUID[] NOT NULL,
    "feature_vector_id"            UUID NOT NULL,
    "future_return_5m"             DOUBLE PRECISION,
    "future_return_15m"            DOUBLE PRECISION,
    "future_return_30m"            DOUBLE PRECISION,
    "future_return_1h"             DOUBLE PRECISION,
    "future_return_4h"             DOUBLE PRECISION,
    "future_return_1d"             DOUBLE PRECISION,
    "label_5m"                     TEXT,
    "label_15m"                    TEXT,
    "label_30m"                    TEXT,
    "label_1h"                     TEXT,
    "label_4h"                     TEXT,
    "label_1d"                     TEXT,
    "label_cutoff_5m"              TIMESTAMPTZ,
    "label_cutoff_15m"             TIMESTAMPTZ,
    "label_cutoff_30m"             TIMESTAMPTZ,
    "label_cutoff_1h"              TIMESTAMPTZ,
    "label_cutoff_4h"              TIMESTAMPTZ,
    "label_cutoff_1d"              TIMESTAMPTZ,
    "feature_version"              TEXT NOT NULL,
    "pipeline_version"             TEXT NOT NULL,
    "market_data_snapshot_version" TEXT NOT NULL,
    "model_version"                TEXT NOT NULL,
    "created_at"                   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "news_training_samples_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "news_training_samples_event_id_fkey"
        FOREIGN KEY ("event_id") REFERENCES "news_events"("id"),
    CONSTRAINT "news_training_samples_feature_vector_id_fkey"
        FOREIGN KEY ("feature_vector_id") REFERENCES "news_features"("id")
);

-- Composite index: Req 28.2
CREATE INDEX "news_training_samples_event_id_asset_id_feature_version_idx"
    ON "news_training_samples" ("event_id", "asset_id", "feature_version");

CREATE INDEX "news_training_samples_asset_id_created_at_idx"
    ON "news_training_samples" ("asset_id", "created_at" DESC);

-- =============================================================================
-- 20. news_source_metrics
--     Rolling window performance metrics per source.
-- =============================================================================
CREATE TABLE "news_source_metrics" (
    "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
    "source_id"        TEXT NOT NULL,
    "window_start"     TIMESTAMPTZ NOT NULL,
    "window_end"       TIMESTAMPTZ NOT NULL,
    "articles_fetched" INTEGER NOT NULL DEFAULT 0,
    "articles_failed"  INTEGER NOT NULL DEFAULT 0,
    "avg_latency_ms"   DOUBLE PRECISION,
    "recorded_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "news_source_metrics_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "news_source_metrics_source_id_fkey"
        FOREIGN KEY ("source_id") REFERENCES "news_sources"("id")
);

-- Composite index: Req 28.2
CREATE INDEX "news_source_metrics_source_id_window_start_idx"
    ON "news_source_metrics" ("source_id", "window_start" DESC);

-- =============================================================================
-- 21. news_ingestion_runs
--     One record per scheduled ingestion run per source.
--     status: "success" | "partial_failure" | "failed"
-- =============================================================================
CREATE TABLE "news_ingestion_runs" (
    "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
    "source_id"        TEXT NOT NULL,
    "started_at"       TIMESTAMPTZ NOT NULL,
    "completed_at"     TIMESTAMPTZ,
    "articles_fetched" INTEGER NOT NULL DEFAULT 0,
    "articles_failed"  INTEGER NOT NULL DEFAULT 0,
    "status"           TEXT NOT NULL,

    CONSTRAINT "news_ingestion_runs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "news_ingestion_runs_source_id_fkey"
        FOREIGN KEY ("source_id") REFERENCES "news_sources"("id")
);

-- Composite index: Req 28.2
CREATE INDEX "news_ingestion_runs_source_id_started_at_idx"
    ON "news_ingestion_runs" ("source_id", "started_at" DESC);

-- =============================================================================
-- 22. news_processing_errors
--     Error records for all pipeline stages.
-- =============================================================================
CREATE TABLE "news_processing_errors" (
    "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
    "source_id"     TEXT,
    "external_id"   TEXT,
    "stage"         TEXT NOT NULL,
    "error_type"    TEXT NOT NULL,
    "error_message" TEXT NOT NULL,
    "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "news_processing_errors_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "news_processing_errors_source_id_fkey"
        FOREIGN KEY ("source_id") REFERENCES "news_sources"("id")
);

-- Composite index: Req 28.2
CREATE INDEX "news_processing_errors_stage_created_at_idx"
    ON "news_processing_errors" ("stage", "created_at" DESC);

-- =============================================================================
-- 23. news_alerts
--     High-importance event alerts delivered to subscribed channels.
-- =============================================================================
CREATE TABLE "news_alerts" (
    "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
    "alert_type"       TEXT NOT NULL,
    "trigger_reason"   TEXT NOT NULL,
    "asset_id"         TEXT NOT NULL,
    "event_id"         UUID,
    "cluster_id"       UUID,
    "importance_score" DOUBLE PRECISION NOT NULL,
    "description"      TEXT NOT NULL,
    "payload"          JSONB NOT NULL,
    "delivery_channels" JSONB NOT NULL,
    "computed_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "news_alerts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "news_alerts_event_id_fkey"
        FOREIGN KEY ("event_id") REFERENCES "news_events"("id"),
    CONSTRAINT "news_alerts_cluster_id_fkey"
        FOREIGN KEY ("cluster_id") REFERENCES "news_clusters"("id")
);

-- Composite indexes: Req 28.2
CREATE INDEX "news_alerts_asset_id_computed_at_idx"
    ON "news_alerts" ("asset_id", "computed_at" DESC);

-- Composite index for cooldown/dedup lookups
CREATE INDEX "news_alerts_cluster_id_alert_type_computed_at_idx"
    ON "news_alerts" ("cluster_id", "alert_type", "computed_at" DESC);
