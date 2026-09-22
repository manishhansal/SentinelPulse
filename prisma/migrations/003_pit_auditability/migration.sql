-- Migration 003: point-in-time auditability columns
-- Phase 3B.1: Close gaps PT-G3 (prediction_timestamp) and PT-G2 (feature_as_of)
--
-- TEMPORAL_DATA_CONTRACT.md defines the semantic difference:
--   feature_as_of      = max(information_as_of) across all data sources in the vector
--                        (e.g. article.published_at) — NOT computed_at
--   prediction_timestamp = the moment AlphaForge generates a signal;
--                          all features must satisfy feature_as_of <= prediction_timestamp
--
-- Gap PT-G2: news_features.feature_as_of
--   Previously absent — computed_at was used as a proxy, which breaks for historical
--   backfill (computed_at = 2026-09-16 for an article published 2024-05-10).
--   We add feature_as_of as a dedicated TIMESTAMPTZ column.
--
-- Gap PT-G3: news_training_samples.prediction_timestamp
--   Previously absent — event_timestamp was used as a proxy.  These are semantically
--   different: event_timestamp is when the news occurred, prediction_timestamp is when
--   AlphaForge would have generated a signal.  We add an explicit column.
--   Default: event_timestamp (explicit policy: for the initial training dataset,
--   prediction_timestamp = event_timestamp, meaning we assume signal generation
--   happens immediately when the news is published).
--   This default is documented as a training policy, not an implicit assumption.
--
-- Additionally adds label_bar_timestamp columns to news_training_samples so the
-- exact OHLCV bar used for each label can be audited (Gap PT-G5 from
-- POINT_IN_TIME_DATASET_CERTIFICATION.md).

-- ============================================================================
-- 1. news_features — add feature_as_of column
-- ============================================================================

ALTER TABLE news_features
  ADD COLUMN IF NOT EXISTS feature_as_of TIMESTAMPTZ;

-- Backfill existing rows: use computed_at as the initial value.
-- NOTE: for existing rows this is an approximation (the correct value would be
-- article.published_at, but that requires a join we cannot do in a pure DDL migration).
-- The backfill script (scripts/backfill_feature_as_of.sql) will correct these values.
-- For all NEW rows, FeatureEngineeringEngine explicitly sets feature_as_of.
UPDATE news_features
SET feature_as_of = computed_at
WHERE feature_as_of IS NULL;

-- Add index for post-hoc PIT queries (feature_as_of > prediction_timestamp check)
CREATE INDEX IF NOT EXISTS idx_news_features_feature_as_of
  ON news_features (feature_as_of DESC NULLS LAST);

COMMENT ON COLUMN news_features.feature_as_of IS
  'Latest information timestamp across all data sources used to build this feature vector. '
  'For text-derived features: article.published_at. '
  'For market-data features: bar.timestamp. '
  'MUST be <= prediction_timestamp. '
  'Distinct from computed_at (when engine ran), which is NOT used in look-ahead validation.';

-- ============================================================================
-- 2. news_training_samples — add prediction_timestamp column
-- ============================================================================

ALTER TABLE news_training_samples
  ADD COLUMN IF NOT EXISTS prediction_timestamp TIMESTAMPTZ;

-- Backfill existing rows with event_timestamp (the initial training policy).
-- This join-based update sets prediction_timestamp = event.event_timestamp for
-- all existing training samples.
UPDATE news_training_samples nts
SET prediction_timestamp = ne.event_timestamp
FROM news_events ne
WHERE nts.event_id = ne.id
  AND nts.prediction_timestamp IS NULL;

-- Index for PIT violation queries
CREATE INDEX IF NOT EXISTS idx_news_training_samples_prediction_ts
  ON news_training_samples (prediction_timestamp DESC NULLS LAST);

COMMENT ON COLUMN news_training_samples.prediction_timestamp IS
  'The moment at which AlphaForge would generate a signal using the features in this sample. '
  'Initial training policy: prediction_timestamp = event_timestamp (signal generated at news time). '
  'INVARIANT: feature_as_of <= prediction_timestamp < label_cutoff_X for all horizons X. '
  'Distinct from event_timestamp — these are the same only under the initial policy.';

-- ============================================================================
-- 3. news_training_samples — add label_bar_timestamp columns (Gap PT-G5)
-- ============================================================================
-- These store the exact bar timestamp used to compute each forward-return label,
-- enabling the post-pilot SQL check:
--   bar.timestamp > label_cutoff → 0 violations

ALTER TABLE news_training_samples
  ADD COLUMN IF NOT EXISTS label_bar_timestamp_5m  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS label_bar_timestamp_15m TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS label_bar_timestamp_30m TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS label_bar_timestamp_1h  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS label_bar_timestamp_4h  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS label_bar_timestamp_1d  TIMESTAMPTZ;

COMMENT ON COLUMN news_training_samples.label_bar_timestamp_5m IS
  'Timestamp of the OHLCV bar used to compute future_return_5m. '
  'INVARIANT: label_bar_timestamp_5m <= label_cutoff_5m.';

COMMENT ON COLUMN news_training_samples.label_bar_timestamp_1d IS
  'Timestamp of the OHLCV bar used to compute future_return_1d. '
  'INVARIANT: label_bar_timestamp_1d <= label_cutoff_1d.';

-- ============================================================================
-- 4. news_market_reactions — add reaction_timestamp column (Phase 3B.1 Phase 8)
-- ============================================================================
-- Stores the timestamp of the offset (e.g. event_timestamp + 5m) for each
-- reaction record, enabling explicit validation:
--   event_timestamp < reaction_timestamp <= label_cutoff

ALTER TABLE news_market_reactions
  ADD COLUMN IF NOT EXISTS reaction_window_start TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reaction_window_end   TIMESTAMPTZ;

COMMENT ON COLUMN news_market_reactions.reaction_window_start IS
  'The start of the earliest query window used to fetch reaction bars (event_timestamp - 15m).';

COMMENT ON COLUMN news_market_reactions.reaction_window_end IS
  'The end of the latest query window used to fetch reaction bars (event_timestamp + 1d).';

-- ============================================================================
-- 5. Verify constraints (must all be true after migration)
-- ============================================================================
-- These queries are documentation only — they assert expected post-migration state.
--
-- After backfill:
--   SELECT count(*) FROM news_features WHERE feature_as_of IS NULL
--   → should be 0 for rows with computed_at populated
--
--   SELECT count(*) FROM news_training_samples WHERE prediction_timestamp IS NULL
--   → should be 0 (event_timestamp is always NOT NULL per schema)
