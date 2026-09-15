# SentinelPulse ML Feature Documentation

## Overview

The `FeatureEngineeringEngine` produces a `FeatureVector` for every `NewsEvent` with `importance_score > 0.3`. The vector is stored in `news_features.feature_vector` (JSONB) alongside `feature_version` and `pipeline_version` (both semver strings).

**Point-in-time correctness is mandatory.** Every feature uses only data with `record_timestamp <= event.event_timestamp`. Any violation raises a `LookAheadBiasError` and aborts the entire vector — no partial vectors are persisted.

---

## Feature Groups

The FeatureVector contains 7 feature groups, detailed below.

---

### Group 1: Article Features

Features derived from the source article and its sentiment/importance scores.

| Feature | Type | Derivation |
|---------|------|-----------|
| `sentiment_score` | float [-1.0, +1.0] | Overall sentiment dimension from `news_sentiment.sentiment_score`. Rounded to 4dp. |
| `market_sentiment` | float [-1.0, +1.0] | Market-specific sentiment dimension. |
| `company_sentiment` | float [-1.0, +1.0] | Company-specific sentiment dimension. |
| `macro_sentiment` | float [-1.0, +1.0] | Macroeconomic sentiment dimension. |
| `risk_sentiment` | float [-1.0, +1.0] | Risk-on/risk-off sentiment dimension. |
| `importance_score` | float [0.0, 1.0] | Final importance score from `news_importance.importance_score` (after surprise multiplier). |
| `novelty_score` | float [0.0, 1.0] | `1 / count_of_similar_events_in_past_7_days`. Approaches 0 for highly repeated events. |
| `surprise_score` | float [-5.0, +5.0] or null | `(quantitative_value - expected_value) / |expected_value|`, capped to ±5.0. Null if expected_value unavailable or zero. |
| `signal_uncertainty` | int {0, 1} | 1 if UNCERTAINTY is in `qualitative_signals`, else 0. |
| `signal_fear` | int {0, 1} | 1 if FEAR is in `qualitative_signals`. |
| `signal_hawkish` | int {0, 1} | 1 if HAWKISH is in `qualitative_signals`. |
| `signal_dovish` | int {0, 1} | 1 if DOVISH is in `qualitative_signals`. |
| `signal_risk_on` | int {0, 1} | 1 if RISK_ON is in `qualitative_signals`. |
| `signal_risk_off` | int {0, 1} | 1 if RISK_OFF is in `qualitative_signals`. |
| `signal_optimism` | int {0, 1} | 1 if OPTIMISM is in `qualitative_signals`. |
| `signal_panic` | int {0, 1} | 1 if PANIC is in `qualitative_signals`. |
| `signal_neutral` | int {0, 1} | 1 if NEUTRAL is in `qualitative_signals` (or no other signal qualifies). |

**Point-in-time guarantee**: All values sourced from records in `news_sentiment` and `news_importance` with `computed_at <= event.event_timestamp`.

---

### Group 2: Event Features

Features characterising the extracted news event itself.

| Feature | Type | Derivation |
|---------|------|-----------|
| `event_type_monetary_policy` | int {0, 1} | One-hot: 1 if `event_type = "MONETARY_POLICY"`. |
| `event_type_earnings` | int {0, 1} | One-hot for EARNINGS. |
| `event_type_economic_data` | int {0, 1} | One-hot for ECONOMIC_DATA. |
| `event_type_commodity_shock` | int {0, 1} | One-hot for COMMODITY_SHOCK. |
| `event_type_geopolitical` | int {0, 1} | One-hot for GEOPOLITICAL. |
| `event_type_regulatory` | int {0, 1} | One-hot for REGULATORY. |
| `event_type_corporate_action` | int {0, 1} | One-hot for CORPORATE_ACTION. |
| `event_type_macro_data` | int {0, 1} | One-hot for MACRO_DATA. |
| `event_type_credit_event` | int {0, 1} | One-hot for CREDIT_EVENT. |
| `event_type_natural_disaster` | int {0, 1} | One-hot for NATURAL_DISASTER. |
| `event_type_trade_policy` | int {0, 1} | One-hot for TRADE_POLICY. |
| `event_type_currency_event` | int {0, 1} | One-hot for CURRENCY_EVENT. |
| `event_type_sector_rotation` | int {0, 1} | One-hot for SECTOR_ROTATION. |
| `event_type_unclassified` | int {0, 1} | One-hot for UNCLASSIFIED. |
| `event_severity` | float [0.0, 1.0] | EventDetectionEngine extraction confidence. |
| `velocity_at_event_time` | float ≥ 0 | Articles-per-5-minutes for the primary entity at `event_timestamp`, from `news_features` VELOCITY records. |
| `cluster_size` | int ≥ 1 | `news_clusters.source_count` for the cluster containing this event's article. |
| `cluster_importance` | float [0.0, 1.0] | Weighted mean of member event `importance_score`s, weighted by `source_diversity`. |
| `surprise_direction_beat` | int {0, 1} | One-hot: 1 if `surprise_direction = "BEAT"`. |
| `surprise_direction_miss` | int {0, 1} | One-hot for MISS. |
| `surprise_direction_in_line` | int {0, 1} | One-hot for IN_LINE. |
| `surprise_direction_unknown` | int {0, 1} | One-hot for UNKNOWN (including when surprise_score is null). |

**Point-in-time guarantee**: `velocity_at_event_time` and `cluster_*` fields use records with `computed_at <= event.event_timestamp`.

---

### Group 3: Asset Features

Features about news activity for the primary associated asset.

| Feature | Type | Derivation |
|---------|------|-----------|
| `asset_mention_count` | int ≥ 0 | Count of `news_entity_mentions` records with `entity_id` matching the primary asset and `confidence >= 0.50`, from articles with `published_at <= event.event_timestamp`. |
| `asset_news_momentum` | float or null | `velocity_5m / baseline_7d` for the primary asset at `event_timestamp`. Null if `baseline_7d = 0`. |
| `asset_news_breadth_positive` | int ≥ 0 | Positive-sentiment article count from `news_features` BREADTH record for the asset's sector, using the most recent record with `computed_at <= event.event_timestamp`. |
| `asset_news_breadth_negative` | int ≥ 0 | Negative-sentiment article count from the same BREADTH record. |

**Point-in-time guarantee**: All counts and lookups restricted to records with timestamps ≤ `event.event_timestamp`.

---

### Group 4: Macro Features

Aggregated macro-level news sentiment scores for key economic variables.

| Feature | Type | Derivation |
|---------|------|-----------|
| `crude_oil_news_score` | float [-1.0, +1.0] | Rolling mean of `market_sentiment` from articles tagged `CRUDE_OIL` in the past 24h from `event_timestamp`. |
| `gold_news_score` | float [-1.0, +1.0] | Same for `GOLD`-tagged articles. |
| `usd_inr_news_score` | float [-1.0, +1.0] | Same for `CURRENCY_EVENT`-tagged articles involving USD/INR. |
| `fed_policy_score` | float [-1.0, +1.0] | Rolling mean of `macro_sentiment` from articles tagged `FED_POLICY`. |
| `rbi_policy_score` | float [-1.0, +1.0] | Rolling mean of `macro_sentiment` from articles tagged `RBI`. |

**Point-in-time guarantee**: All rolling mean computations use only articles with `published_at <= event.event_timestamp` and sentiment records with `computed_at <= event.event_timestamp`.

---

### Group 5: Cross-Market Features

Features encoding the state of cross-market event relationships.

| Feature | Type | Derivation |
|---------|------|-----------|
| `active_cross_market_relationships` | int ≥ 0 | Count of `news_event_relationships` records for the primary asset where `confidence >= 0.2 AND sample_size >= 30 AND low_sample = false`, as at `event.event_timestamp`. |
| `dominant_cross_market_direction` | int {-1, 0, 1} | Majority direction of active relationships: +1 (mostly POSITIVE_CORRELATION), -1 (mostly NEGATIVE_CORRELATION), 0 (balanced or no relationships). |

---

### Group 6: Temporal Features

Calendar and event-schedule features.

| Feature | Type | Derivation |
|---------|------|-----------|
| `hour_of_day` | int [0, 23] | UTC hour extracted from `event.event_timestamp`. |
| `day_of_week` | int [0, 6] | 0 = Monday … 6 = Sunday, from `event.event_timestamp`. |
| `days_to_rbi_meeting` | int ≥ 0 | Calendar days from `event.event_timestamp` to the next scheduled RBI Monetary Policy Committee meeting. |
| `days_to_fed_meeting` | int ≥ 0 | Calendar days to the next scheduled FOMC meeting. |
| `days_to_earnings` | int or null | Calendar days to the primary entity's next earnings date (from data-service InstrumentMaster). Null if no earnings date is available. |

**Point-in-time guarantee**: Calendar lookups use only scheduled-meeting data available as of `event.event_timestamp`. Future meetings not yet announced at that timestamp are not included.

---

### Group 7: Market Context Features

Real-time market microstructure features from the data-service, sampled at `event.event_timestamp`.

| Feature | Type | Derivation |
|---------|------|-----------|
| `ohlcv_open` | float | Open price from data-service OHLCV at `asOf = event.event_timestamp`. |
| `ohlcv_high` | float | High price. |
| `ohlcv_low` | float | Low price. |
| `ohlcv_close` | float | Close price. |
| `ohlcv_volume` | float | Volume. |
| `atr_14` | float | 14-period Average True Range at `event.event_timestamp`. |
| `vwap` | float | Volume-Weighted Average Price at `event.event_timestamp`. |
| `open_interest` | float or null | Open interest for futures/options, if available. |
| `vix` | float or null | India VIX or US VIX depending on primary asset market. Null if unavailable. |

All data-service requests use `asOf = event.event_timestamp`. If the data-service does not respond within 10 seconds, feature computation is aborted and the FeatureVector is not persisted.

**Point-in-time guarantee**: The `asOf` parameter enforces strict point-in-time correctness — the data-service returns only data that was available at `event.event_timestamp`, preventing any look-ahead bias.

---

## Look-Ahead Bias Prevention

The `LookAheadGuard` validates all data sources before the FeatureVector is assembled:

```
For each data record used in feature computation:
  if record.timestamp > event.event_timestamp:
    raise LookAheadBiasError
    abort computation
    do NOT persist FeatureVector
```

The CI pipeline includes an automated look-ahead leakage check (`tests/ci/look-ahead-check.ts`) that scans all FeatureVector records and asserts no market context feature has a source timestamp > `event_timestamp`. The check fails the build on any violation and reports the offending record IDs and feature names.

---

## Feature Versioning

When the feature schema changes, `FEATURE_VERSION` (semver) is incremented and a backfill job is enqueued to recompute historical events under the new version. Old feature_version records are never modified or deleted — they coexist in `news_features` and can be queried by version.

`feature_version` and `pipeline_version` must be valid semver strings (`MAJOR.MINOR.PATCH`). The application refuses to start if either is malformed.

---

## Phase 3A: ML Feature Contract

The complete ML feature contract for SentinelPulse → ml-service integration is documented in:

**[docs/SENTINELPULSE_ML_FEATURE_CONTRACT.md](SENTINELPULSE_ML_FEATURE_CONTRACT.md)**

This document supersedes any feature descriptions in this file for Phase 3B onwards. It defines:
- 6 core features (minimum viable set for any ML experiment)
- 12 extended features for ablation evaluation
- Point-in-time constraints per feature
- Freshness states and null behavior
- Python schema for ml-service `StockFeatures` extension
- API contract for AlphaForge → SentinelPulse integration

### Phase 3A Additions to FeatureVector

Two new fields are now available in the `news_articles` table and flow through to feature vectors:

| Field | Type | Description |
|---|---|---|
| `content_depth` | string | FULL_ARTICLE \| SUMMARY \| HEADLINE_ONLY |
| `content_quality_score` | float [0,1] | Composite quality: depth weight × timestamp confidence × truncation penalty |

These affect `sourceReliability` sub-score in `news_importance`:
```
source_confidence = source_reliability × 0.6 + content_quality_score × 0.4
```

### LookAheadGuard Behavior (Phase 3A Observation)

In Phase 3A, the LookAheadGuard correctly blocked feature generation for articles published in 2009–2024 (from ET RSS historical feed) because `sentiment.computedAt` (2026) > `article.publishedAt` (2009–2024).

For historical backfill (Phase 3B), the sentiment pipeline must use the article's original `publishedAt` as the computation anchor, not `new Date()`. Otherwise the guard will block all historical feature generation.

**Look-ahead violations in Phase 3A:** 0 (CI check confirmed)
