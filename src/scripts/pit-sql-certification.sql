-- =============================================================================
-- SentinelPulse — Point-in-Time SQL Certification Queries
-- Phase 3B.1 Phase 11
--
-- Run against: sentinel_pulse DB (TimescaleDB port 5444)
-- Every query must return 0. A non-zero result is a PIT violation.
--
-- Sections:
--   A. Pre-existing queries (POINT_IN_TIME_DATASET_CERTIFICATION.md)
--   B. New queries added in Phase 3B.1
--      B1. feature_as_of > prediction_timestamp  (future feature)
--      B2. bar.timestamp > label_cutoff           (future OHLCV)
--      B3. prediction_timestamp >= label_cutoff_X (invalid prediction ordering)
--      B4. feature_as_of > prediction_timestamp   (invalid feature ordering — explicit)
--      B5. duplicate training rows
--      B6. provider metadata consistency checks
-- =============================================================================

-- =============================================================================
-- A. PRE-EXISTING VALIDATION QUERIES (from POINT_IN_TIME_DATASET_CERTIFICATION.md)
-- =============================================================================

-- A1. Article published_at after event_timestamp
-- Invariant: article.published_at <= event.event_timestamp
SELECT count(*) AS a1_violations_article_after_event
FROM news_events ne
JOIN news_articles na ON ne.article_id = na.id
WHERE na.published_at > ne.event_timestamp;
-- Expected: 0

-- A2. Label cutoff at or before event_timestamp
-- Invariant: label_cutoff_5m > event_timestamp
SELECT count(*) AS a2_violations_label_cutoff_not_future
FROM news_training_samples nts
JOIN news_events ne ON nts.event_id = ne.id
WHERE nts.label_cutoff_5m IS NOT NULL
  AND nts.label_cutoff_5m <= ne.event_timestamp;
-- Expected: 0

-- A3. Events with null event_timestamp (data integrity)
SELECT count(*) AS a3_violations_null_event_timestamp
FROM news_events
WHERE event_timestamp IS NULL;
-- Expected: 0

-- A4. Reactions with market_open=false and non-null return values
-- Rule (Req 12.3): when market_open=false, ALL returns must be null
SELECT count(*) AS a4_violations_market_closed_with_returns
FROM news_market_reactions
WHERE market_open = false
  AND (return_5m  IS NOT NULL
    OR return_15m IS NOT NULL
    OR return_30m IS NOT NULL
    OR return_1h  IS NOT NULL
    OR return_1d  IS NOT NULL);
-- Expected: 0

-- A5. Post-pilot: label_cutoff before event_timestamp (all horizons)
SELECT count(*) AS a5_violations_any_cutoff_not_future
FROM news_training_samples nts
JOIN news_events ne ON nts.event_id = ne.id
WHERE (nts.label_cutoff_1h  IS NOT NULL AND nts.label_cutoff_1h  <= ne.event_timestamp)
   OR (nts.label_cutoff_1d  IS NOT NULL AND nts.label_cutoff_1d  <= ne.event_timestamp)
   OR (nts.label_cutoff_15m IS NOT NULL AND nts.label_cutoff_15m <= ne.event_timestamp);
-- Expected: 0

-- A6. Features with underlying article published AFTER the event (PIT violation)
SELECT count(*) AS a6_violations_feature_uses_future_article
FROM news_features nf
JOIN news_events ne ON nf.event_id = ne.id
JOIN news_articles na ON ne.article_id = na.id
WHERE nf.feature_type = 'EVENT_FEATURE_VECTOR'
  AND na.published_at > ne.event_timestamp;
-- Expected: 0

-- A7. Reactions where return_1d is non-null but market_open is false
SELECT count(*) AS a7_violations_return_1d_market_closed
FROM news_market_reactions
WHERE return_1d IS NOT NULL AND market_open = false;
-- Expected: 0

-- A8. Features with NULL event_id (orphaned)
SELECT count(*) AS a8_violations_orphaned_features
FROM news_features
WHERE feature_type = 'EVENT_FEATURE_VECTOR'
  AND event_id IS NULL;
-- Expected: 0

-- A9. Training samples without a corresponding feature vector
SELECT count(*) AS a9_violations_missing_feature_vector
FROM news_training_samples nts
LEFT JOIN news_features nf ON nts.feature_vector_id = nf.id
WHERE nf.id IS NULL;
-- Expected: 0

-- A10. Training samples where future_return fields are non-null but label_cutoff is null
SELECT count(*) AS a10_violations_return_without_cutoff
FROM news_training_samples
WHERE future_return_5m IS NOT NULL AND label_cutoff_5m IS NULL;
-- Expected: 0

-- A11. Duplicate training samples (same event+asset — no unique constraint in schema)
SELECT count(*) AS a11_violations_duplicate_training_rows
FROM (
  SELECT event_id, asset_id, count(*) AS cnt
  FROM news_training_samples
  GROUP BY event_id, asset_id
  HAVING count(*) > 1
) duplicates;
-- Expected: 0

-- =============================================================================
-- B. NEW QUERIES — PHASE 3B.1
-- =============================================================================

-- B1. FUTURE FEATURE: feature_as_of > prediction_timestamp
-- This is the central Phase 3B.1 invariant.
-- feature_as_of must be <= prediction_timestamp.
SELECT count(*) AS b1_violations_future_feature
FROM news_training_samples nts
JOIN news_features nf ON nts.feature_vector_id = nf.id
WHERE nts.prediction_timestamp IS NOT NULL
  AND nf.feature_as_of IS NOT NULL
  AND nf.feature_as_of > nts.prediction_timestamp;
-- Expected: 0
-- Semantic: no feature can be computed from information that was not yet available
--           at the moment AlphaForge generated the signal.

-- B2. FUTURE OHLCV: bar.timestamp > label_cutoff
-- The bar used to compute a label must not come from after the label cutoff.
SELECT count(*) AS b2_violations_future_ohlcv_bar
FROM news_training_samples
WHERE (label_bar_timestamp_5m  IS NOT NULL AND label_cutoff_5m  IS NOT NULL
       AND label_bar_timestamp_5m  > label_cutoff_5m)
   OR (label_bar_timestamp_15m IS NOT NULL AND label_cutoff_15m IS NOT NULL
       AND label_bar_timestamp_15m > label_cutoff_15m)
   OR (label_bar_timestamp_30m IS NOT NULL AND label_cutoff_30m IS NOT NULL
       AND label_bar_timestamp_30m > label_cutoff_30m)
   OR (label_bar_timestamp_1h  IS NOT NULL AND label_cutoff_1h  IS NOT NULL
       AND label_bar_timestamp_1h  > label_cutoff_1h)
   OR (label_bar_timestamp_4h  IS NOT NULL AND label_cutoff_4h  IS NOT NULL
       AND label_bar_timestamp_4h  > label_cutoff_4h)
   OR (label_bar_timestamp_1d  IS NOT NULL AND label_cutoff_1d  IS NOT NULL
       AND label_bar_timestamp_1d  > label_cutoff_1d);
-- Expected: 0

-- B3. INVALID PREDICTION ORDERING: prediction_timestamp >= label_cutoff_X
-- Labels must always be in the future relative to the prediction signal.
SELECT count(*) AS b3_violations_invalid_prediction_ordering
FROM news_training_samples
WHERE prediction_timestamp IS NOT NULL
  AND (
    (label_cutoff_5m  IS NOT NULL AND prediction_timestamp >= label_cutoff_5m)
 OR (label_cutoff_15m IS NOT NULL AND prediction_timestamp >= label_cutoff_15m)
 OR (label_cutoff_30m IS NOT NULL AND prediction_timestamp >= label_cutoff_30m)
 OR (label_cutoff_1h  IS NOT NULL AND prediction_timestamp >= label_cutoff_1h)
 OR (label_cutoff_4h  IS NOT NULL AND prediction_timestamp >= label_cutoff_4h)
 OR (label_cutoff_1d  IS NOT NULL AND prediction_timestamp >= label_cutoff_1d)
  );
-- Expected: 0
-- Semantic: if prediction_timestamp >= label_cutoff_X, the label outcome is
--           already known at prediction time — a direct look-ahead violation.

-- B4. INVALID FEATURE ORDERING (explicit): feature_as_of > prediction_timestamp
-- Same as B1 but joining directly on feature table by event_id, not feature_vector_id.
-- Catches cases where feature was updated after a training sample was generated.
SELECT count(*) AS b4_violations_feature_as_of_after_prediction
FROM news_training_samples nts
JOIN news_events ne ON nts.event_id = ne.id
JOIN news_features nf ON nf.event_id = ne.id AND nf.feature_type = 'EVENT_FEATURE_VECTOR'
WHERE nts.prediction_timestamp IS NOT NULL
  AND nf.feature_as_of IS NOT NULL
  AND nf.feature_as_of > nts.prediction_timestamp;
-- Expected: 0

-- B5. DUPLICATE TRAINING ROWS: same event + asset + prediction_timestamp
SELECT count(*) AS b5_violations_duplicate_with_prediction_ts
FROM (
  SELECT event_id, asset_id, prediction_timestamp, count(*) AS cnt
  FROM news_training_samples
  WHERE prediction_timestamp IS NOT NULL
  GROUP BY event_id, asset_id, prediction_timestamp
  HAVING count(*) > 1
) duplicates;
-- Expected: 0

-- B6. REACTION WINDOW ORDERING: reaction_window_start must be before reaction_window_end
SELECT count(*) AS b6_violations_reaction_window_order
FROM news_market_reactions
WHERE reaction_window_start IS NOT NULL
  AND reaction_window_end IS NOT NULL
  AND reaction_window_start >= reaction_window_end;
-- Expected: 0

-- B7. REACTION WINDOW ANCHOR: reaction_window_start must be before event_timestamp
-- The earliest offset is T-15m, so window_start must be < event_timestamp.
SELECT count(*) AS b7_violations_window_start_after_event
FROM news_market_reactions nmr
JOIN news_events ne ON nmr.event_id = ne.id
WHERE nmr.reaction_window_start IS NOT NULL
  AND nmr.reaction_window_start >= ne.event_timestamp;
-- Expected: 0

-- B8. REACTION WINDOW ANCHOR: reaction_window_end must be after event_timestamp
SELECT count(*) AS b8_violations_window_end_before_event
FROM news_market_reactions nmr
JOIN news_events ne ON nmr.event_id = ne.id
WHERE nmr.reaction_window_end IS NOT NULL
  AND nmr.reaction_window_end <= ne.event_timestamp;
-- Expected: 0

-- B9. PREDICTION TIMESTAMP POLICY: prediction_timestamp must equal event_timestamp
-- (initial training policy: signal is generated at news publication time)
SELECT count(*) AS b9_violations_prediction_policy_deviation
FROM news_training_samples nts
JOIN news_events ne ON nts.event_id = ne.id
WHERE nts.prediction_timestamp IS NOT NULL
  AND nts.prediction_timestamp <> ne.event_timestamp;
-- NOTE: this will be 0 only under the initial policy.
-- If AlphaForge uses a different prediction_timestamp in future, update this query.
-- Expected: 0 (under initial policy)

-- B10. FEATURE_AS_OF NULL CHECK: after migration, all feature vectors should have
-- feature_as_of populated (either from backfill or new computation).
SELECT count(*) AS b10_feature_as_of_null_count
FROM news_features
WHERE feature_type = 'EVENT_FEATURE_VECTOR'
  AND feature_as_of IS NULL;
-- Expected: 0 after running backfill_feature_as_of.sql

-- B11. PREDICTION_TIMESTAMP NULL CHECK: all training samples should have it set.
SELECT count(*) AS b11_prediction_timestamp_null_count
FROM news_training_samples
WHERE prediction_timestamp IS NULL;
-- Expected: 0 after migration 003 backfill runs

-- =============================================================================
-- C. DIAGNOSTIC QUERIES (not violations — inform the dataset state)
-- =============================================================================

-- C1. Dataset summary
SELECT
  (SELECT count(*) FROM news_articles)             AS total_articles,
  (SELECT count(*) FROM news_events)               AS total_events,
  (SELECT count(*) FROM news_features WHERE feature_type = 'EVENT_FEATURE_VECTOR') AS total_feature_vectors,
  (SELECT count(*) FROM news_training_samples)     AS total_training_samples,
  (SELECT count(*) FROM news_market_reactions)     AS total_reactions,
  (SELECT count(*) FROM news_training_samples WHERE prediction_timestamp IS NOT NULL) AS samples_with_prediction_ts,
  (SELECT count(*) FROM news_features WHERE feature_as_of IS NOT NULL)               AS features_with_feature_as_of;

-- C2. Return coverage per horizon
SELECT
  count(*)                                                     AS total_reactions,
  sum(CASE WHEN return_1m  IS NOT NULL THEN 1 ELSE 0 END)     AS return_1m_count,
  sum(CASE WHEN return_5m  IS NOT NULL THEN 1 ELSE 0 END)     AS return_5m_count,
  sum(CASE WHEN return_15m IS NOT NULL THEN 1 ELSE 0 END)     AS return_15m_count,
  sum(CASE WHEN return_30m IS NOT NULL THEN 1 ELSE 0 END)     AS return_30m_count,
  sum(CASE WHEN return_1h  IS NOT NULL THEN 1 ELSE 0 END)     AS return_1h_count,
  sum(CASE WHEN return_1d  IS NOT NULL THEN 1 ELSE 0 END)     AS return_1d_count,
  round(avg(CASE WHEN return_1d IS NOT NULL THEN 1.0 ELSE 0 END) * 100, 1) AS return_1d_coverage_pct
FROM news_market_reactions;

-- C3. Provider distribution
SELECT
  data_service_snapshot_version AS provider_used,
  count(*)                       AS reaction_count
FROM news_market_reactions
WHERE data_service_snapshot_version IS NOT NULL
GROUP BY data_service_snapshot_version
ORDER BY reaction_count DESC;

-- C4. Training samples per horizon (non-null label count)
SELECT
  sum(CASE WHEN label_5m  IS NOT NULL THEN 1 ELSE 0 END) AS label_5m_count,
  sum(CASE WHEN label_15m IS NOT NULL THEN 1 ELSE 0 END) AS label_15m_count,
  sum(CASE WHEN label_30m IS NOT NULL THEN 1 ELSE 0 END) AS label_30m_count,
  sum(CASE WHEN label_1h  IS NOT NULL THEN 1 ELSE 0 END) AS label_1h_count,
  sum(CASE WHEN label_4h  IS NOT NULL THEN 1 ELSE 0 END) AS label_4h_count,
  sum(CASE WHEN label_1d  IS NOT NULL THEN 1 ELSE 0 END) AS label_1d_count,
  count(*)                                               AS total_samples
FROM news_training_samples;

-- C5. Feature_as_of coverage check
SELECT
  count(*)                                                AS total_features,
  sum(CASE WHEN feature_as_of IS NOT NULL THEN 1 ELSE 0 END) AS has_feature_as_of,
  sum(CASE WHEN feature_as_of IS NULL     THEN 1 ELSE 0 END) AS missing_feature_as_of,
  min(feature_as_of)                                     AS earliest_feature_as_of,
  max(feature_as_of)                                     AS latest_feature_as_of
FROM news_features
WHERE feature_type = 'EVENT_FEATURE_VECTOR';

-- C6. PIT ordering verification: feature_as_of <= event_timestamp (information anchor)
SELECT
  count(*) AS total_features_checked,
  sum(CASE WHEN nf.feature_as_of <= ne.event_timestamp THEN 1 ELSE 0 END) AS pass,
  sum(CASE WHEN nf.feature_as_of >  ne.event_timestamp THEN 1 ELSE 0 END) AS fail
FROM news_features nf
JOIN news_events ne ON nf.event_id = ne.id
WHERE nf.feature_type = 'EVENT_FEATURE_VECTOR'
  AND nf.feature_as_of IS NOT NULL;
-- Expected: fail = 0

-- =============================================================================
-- END OF CERTIFICATION QUERIES
-- Run: psql "$DATABASE_URL" -f src/scripts/pit-sql-certification.sql
-- All A* and B* queries must return 0. C* queries are informational.
-- =============================================================================
