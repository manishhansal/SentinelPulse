-- =============================================================================
-- Migration 004 — news_training_samples idempotency constraint
-- =============================================================================
-- Phase 3B.2 (Phase 3B.2 requirement §17): Prevent duplicate training samples
-- for the same event × asset × prediction_timestamp × feature_version tuple.
-- Repeated calls to MLDatasetGenerator.generate() for the same pilot window
-- MUST produce exactly one persisted row per (event, asset, ts, version).
--
-- Uniqueness key rationale:
--   event_id              — identifies the news event
--   asset_id              — identifies the target instrument
--   prediction_timestamp  — the moment at which a signal would be generated
--                           (= event_timestamp under current policy)
--   feature_version       — isolates samples across feature schema versions
--
-- This combination is the minimal set that uniquely identifies one training
-- sample under the current prediction_timestamp = event_timestamp policy.
-- If that policy changes in the future, the constraint remains correct because
-- a different prediction_timestamp produces a genuinely different sample.
-- =============================================================================

-- Remove any existing duplicate rows before adding the constraint.
-- Keeps only the most-recently created duplicate per group.
DELETE FROM news_training_samples
WHERE id NOT IN (
    SELECT DISTINCT ON (event_id, asset_id, prediction_timestamp, feature_version) id
    FROM news_training_samples
    ORDER BY event_id, asset_id, prediction_timestamp, feature_version,
             created_at DESC
);

-- Add the unique constraint.
-- Using a partial index so NULL prediction_timestamp rows are unaffected
-- (they were pre-Phase-3B rows and will be cleaned up separately).
ALTER TABLE news_training_samples
    ADD CONSTRAINT uq_training_sample_identity
    UNIQUE (event_id, asset_id, prediction_timestamp, feature_version);

-- Document the constraint purpose.
COMMENT ON CONSTRAINT uq_training_sample_identity ON news_training_samples IS
    'Prevents duplicate training samples: each (event, asset, prediction_timestamp, '
    'feature_version) tuple must appear at most once. Phase 3B.2 §17.';

-- Ensure the index backing the constraint is visible in query plans.
-- Postgres creates the index automatically for UNIQUE constraints, but we
-- document it explicitly for operational visibility.
COMMENT ON INDEX uq_training_sample_identity IS
    'Unique index for idempotent training sample generation. '
    'Created by migration 004_training_sample_uniqueness.';
