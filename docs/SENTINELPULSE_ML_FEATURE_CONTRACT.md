# SentinelPulse ML Feature Contract

**Version:** 1.0.0  
**Date:** 2026-09-15  
**Status:** DRAFT — awaiting ablation study before production use  
**Authors:** Phase 3A Runtime Certification Audit  

> **IMPORTANT:** This contract does not claim that any of these features improve AlphaForge predictions. It defines what SentinelPulse can provide and the constraints that govern their use. Empirical validation (ablation study, backtest) is Phase 3B.

---

## 1. Purpose

This document defines the feature contract between SentinelPulse (news intelligence engine) and the ml-service (machine learning prediction engine). It specifies every proposed news-derived feature: name, type, range, meaning, calculation, data source, freshness requirements, look-ahead risk, and null behavior.

No feature may be added to the ml-service `StockFeatures` schema without a corresponding entry here. No entry here may be used in production until the ablation study (Phase 3B) validates incremental value.

---

## 2. Point-in-Time Constraint

Every feature in this contract must satisfy:

```
feature_as_of  ≤  prediction_timestamp
```

Where:
- `feature_as_of` — the latest data timestamp used to compute the feature
- `prediction_timestamp` — the moment at which AlphaForge generates a signal

This is enforced in code by `LookAheadGuard.validateOne()` in `FeatureEngineeringEngine`. Any feature that violates this constraint is discarded and not persisted.

---

## 3. Freshness States

All features carry a `FreshnessMetadata` block (see `src/engines/feature-engineering/DataFreshness.ts`):

| State | Condition | AlphaForge behavior |
|---|---|---|
| `FRESH` | `freshness_seconds ≤ 300` (5 min) | Use normally |
| `STALE` | `300 < freshness_seconds ≤ 3600` (1 hour) | Use with caution; mark as stale |
| `EXPIRED` | `freshness_seconds > 3600` | **Must not be used** — treat as unavailable |
| `UNAVAILABLE` | No data available | Set `news_data_available = false` |

---

## 4. Core Features (Minimum Viable Set)

These 6 features are the minimum required for any ML experiment. All others are optional.

---

### 4.1 `news_impact_score`

| Property | Value |
|---|---|
| **Type** | `float` |
| **Range** | `[-1.0, +1.0]` (normalized from raw [-100, +100]) |
| **Null** | `0.0` when `news_data_available = false` |
| **Meaning** | Directional impact of recent news on the instrument. Positive = bullish news signal, negative = bearish. |
| **Calculation** | `mean(newsImpactScore) / 100` over all `news_market_impacts` for the instrument in the trailing 4-hour window, capped to [-1, 1]. |
| **Data source** | `news_market_impacts.news_impact_score` via `GET /api/v1/alphaforge/news-context/{instrument}` |
| **Feature timestamp** | `max(computed_at)` of contributing impact records |
| **Freshness** | FRESH if within 5 min, STALE within 1 hour, EXPIRED after 1 hour |
| **Look-ahead risk** | LOW — derived from historical event patterns, no future price data |
| **Version** | `1.0.0` |

---

### 4.2 `news_sentiment_market`

| Property | Value |
|---|---|
| **Type** | `float` |
| **Range** | `[-1.0, +1.0]` |
| **Null** | `0.0` |
| **Meaning** | Market-facing sentiment dimension from the lexicon model. Measures directional market tone (bullish/bearish language) in news text about the instrument. |
| **Calculation** | `mean(market_sentiment)` over `news_sentiment` records for articles linked to the instrument via `news_asset_links` in trailing 4h window. |
| **Data source** | `news_sentiment.market_sentiment` |
| **Feature timestamp** | `max(computed_at)` of contributing sentiment records |
| **Freshness** | FRESH ≤5 min, STALE ≤1h |
| **Look-ahead risk** | LOW — sentiment computed from article text only |
| **Limitation** | Lexicon-based; does not capture irony or domain-specific negation |
| **Version** | `1.0.0` |

---

### 4.3 `news_velocity_1h`

| Property | Value |
|---|---|
| **Type** | `integer` |
| **Range** | `[0, ∞)` |
| **Null** | `0` |
| **Meaning** | Count of news articles mentioning the instrument in the trailing 1-hour window. Proxy for news volume / attention intensity. |
| **Calculation** | `COUNT(news_asset_links WHERE published_at >= prediction_timestamp - 1h AND asset_id = instrument)` |
| **Data source** | `news_asset_links.published_at` |
| **Feature timestamp** | `prediction_timestamp` (computed at request time, no stored value) |
| **Freshness** | Always FRESH (computed live) |
| **Look-ahead risk** | NONE — only counts articles with `published_at ≤ prediction_timestamp` |
| **Version** | `1.0.0` |

---

### 4.4 `news_velocity_24h`

| Property | Value |
|---|---|
| **Type** | `integer` |
| **Range** | `[0, ∞)` |
| **Null** | `0` |
| **Meaning** | Count of news articles mentioning the instrument in the trailing 24-hour window. Captures sustained coverage vs. single-article spikes. |
| **Calculation** | Same as `news_velocity_1h` but with 24h lookback window. |
| **Data source** | `news_asset_links.published_at` |
| **Feature timestamp** | `prediction_timestamp` |
| **Freshness** | Always FRESH |
| **Look-ahead risk** | NONE |
| **Version** | `1.0.0` |

---

### 4.5 `news_event_intensity`

| Property | Value |
|---|---|
| **Type** | `float` |
| **Range** | `[0.0, 1.0]` |
| **Null** | `0.0` |
| **Meaning** | Normalized intensity of the highest-importance event detected for this instrument in the trailing 4h window. A value of 1.0 means a max-importance event was detected recently. |
| **Calculation** | `max(news_importance.importance_score)` for events linked to the instrument in trailing 4h, or 0 if no events. |
| **Data source** | `news_importance.importance_score`, `news_market_impacts.asset_id` |
| **Feature timestamp** | `max(news_importance.computed_at)` |
| **Freshness** | FRESH ≤5 min, STALE ≤1h, EXPIRED >1h |
| **Look-ahead risk** | LOW — importance computed from article content, not market outcomes |
| **Version** | `1.0.0` |

---

### 4.6 `news_data_available`

| Property | Value |
|---|---|
| **Type** | `boolean` |
| **Range** | `{true, false}` |
| **Null** | N/A (always present) |
| **Meaning** | Whether any usable (FRESH or STALE) news data exists for this instrument at prediction time. When `false`, all other news features should be treated as unavailable (do not impute with zeros as if the news is neutral). |
| **Calculation** | `true` iff at least one FRESH or STALE news_asset_link exists for the instrument |
| **Data source** | Derived from `news_asset_links`, `DataFreshness.isUsable()` |
| **Feature timestamp** | `prediction_timestamp` |
| **Look-ahead risk** | NONE |
| **Version** | `1.0.0` |

---

## 5. Extended Features (Optional — Subject to Ablation)

These features are proposed for evaluation in the ablation study. None should be added to `StockFeatures` until Phase 3B validates their incremental value.

---

### 5.7 `news_momentum`

| Property | Value |
|---|---|
| **Type** | `float` |
| **Range** | `[-1.0, +1.0]` |
| **Null** | `0.0` |
| **Meaning** | Change in `news_impact_score` over the past 4 hours vs. the 4 hours before that. Positive momentum = news is getting more bullish recently. |
| **Calculation** | `impact_score[t-0h:t-4h] - impact_score[t-4h:t-8h]` |
| **Look-ahead risk** | LOW |
| **Phase** | 3B evaluation |

---

### 5.8 `news_breadth_positive`

| Property | Value |
|---|---|
| **Type** | `integer` |
| **Range** | `[0, ∞)` |
| **Null** | `0` |
| **Meaning** | Count of distinct instruments with positive sentiment in the same sector as the target instrument in the trailing 4h. Measures sector-level news breadth. |
| **Calculation** | `COUNT(DISTINCT asset_id)` where `news_sentiment.market_sentiment > 0.1` and `sector_id` matches |
| **Look-ahead risk** | LOW |
| **Phase** | 3B evaluation |

---

### 5.9 `news_importance`

| Property | Value |
|---|---|
| **Type** | `float` |
| **Range** | `[0.0, 1.0]` |
| **Null** | `0.0` |
| **Meaning** | Mean importance score of all news events linked to the instrument in trailing 4h. Distinct from `news_event_intensity` (which is max). |
| **Calculation** | `mean(news_importance.importance_score)` |
| **Look-ahead risk** | LOW |
| **Phase** | 3B evaluation |

---

### 5.10 `news_surprise`

| Property | Value |
|---|---|
| **Type** | `float` |
| **Range** | `[-5.0, +5.0]` (raw scale from SurpriseEngine) |
| **Null** | `null` (not imputed — genuine absence of surprise data) |
| **Meaning** | Quantitative surprise magnitude for earnings/data releases. Positive = beat consensus, negative = miss. |
| **Calculation** | `news_events.surprise_score` for the most recent EARNINGS or MACRO_DATA event |
| **Look-ahead risk** | **MEDIUM** — requires careful validation that consensus estimates are available at T; post-event analyst revisions must not leak |
| **Phase** | 3B evaluation with extra look-ahead audit |

---

### 5.11 `news_source_diversity`

| Property | Value |
|---|---|
| **Type** | `float` |
| **Range** | `[0.0, 1.0]` |
| **Null** | `0.0` |
| **Meaning** | Fraction of distinct source tiers covering this instrument in trailing 4h. A single Reuters headline = 0.25; Reuters + Moneycontrol + ET = 0.75. Measures corroboration. |
| **Calculation** | `COUNT(DISTINCT source.tier) / 4.0` (4 = max distinct tiers) |
| **Look-ahead risk** | NONE |
| **Phase** | 3B evaluation |

---

### 5.12 `global_risk_score`

| Property | Value |
|---|---|
| **Type** | `float` |
| **Range** | `[-1.0, +1.0]` |
| **Null** | `0.0` |
| **Meaning** | Aggregated macro/geopolitical risk signal derived from GEOPOLITICAL + MACRO_DATA events across all instruments in trailing 24h. Negative = elevated risk environment. |
| **Calculation** | `mean(risk_sentiment)` from `news_sentiment` for articles with `category IN (CRUDE_OIL, GLOBAL_MACRO, GEOPOLITICAL)` in trailing 24h |
| **Look-ahead risk** | LOW |
| **Phase** | 3B evaluation |

---

### 5.13 `commodity_pressure_score`

| Property | Value |
|---|---|
| **Type** | `float` |
| **Range** | `[-1.0, +1.0]` |
| **Null** | `0.0` |
| **Meaning** | Net directional pressure from commodity news (Crude Oil, Gold, Metals) in trailing 24h. Relevant for energy/metal sector instruments. |
| **Calculation** | `mean(market_sentiment)` from articles with `category IN (CRUDE_OIL, GOLD, METALS)` |
| **Look-ahead risk** | LOW |
| **Phase** | 3B evaluation |

---

### 5.14 `geopolitical_risk_score`

| Property | Value |
|---|---|
| **Type** | `float` |
| **Range** | `[0.0, 1.0]` |
| **Null** | `0.0` |
| **Meaning** | Intensity of geopolitical risk news in trailing 24h. 0 = no geopolitical events, 1 = high-importance geopolitical event. |
| **Calculation** | `max(importance_score)` for events with `event_type = GEOPOLITICAL` in trailing 24h |
| **Look-ahead risk** | LOW |
| **Phase** | 3B evaluation |

---

### 5.15 `macro_pressure_score`

| Property | Value |
|---|---|
| **Type** | `float` |
| **Range** | `[-1.0, +1.0]` |
| **Null** | `0.0` |
| **Meaning** | Net macro sentiment signal (RBI policy, Fed, inflation data) in trailing 24h. Derived from RBI + FED + ECB taxonomy categories. |
| **Calculation** | `mean(macro_sentiment)` from articles with `category IN (RBI, FED_POLICY, INDIA_MACRO, GLOBAL_MACRO)` |
| **Look-ahead risk** | LOW |
| **Phase** | 3B evaluation |

---

### 5.16 `market_regime_news_interaction`

| Property | Value |
|---|---|
| **Type** | `float` |
| **Range** | `[-1.0, +1.0]` |
| **Null** | `0.0` |
| **Meaning** | Interaction term: `news_impact_score × regime_modifier`. In TRENDING_BULL regime, bullish news is amplified; in RISK_OFF, negative news is amplified. |
| **Calculation** | `news_impact_score × regime_weight[current_regime]` where `regime_weight = {TRENDING_BULL: 1.2, RISK_OFF: 1.3, PANIC: 1.5, SIDEWAYS: 0.7, ...}` |
| **Look-ahead risk** | LOW — regime is classified from current market data |
| **Dependencies** | Requires regime integration (Task 9) to be operational |
| **Phase** | 3B evaluation |

---

### 5.17 `historical_event_similarity`

| Property | Value |
|---|---|
| **Type** | `float` |
| **Range** | `[0.0, 1.0]` |
| **Null** | `null` (not imputed — absence means no historical analogue found) |
| **Meaning** | Cosine similarity score of the current event's embedding to the nearest historical analogue event. Higher = more similar to a previously observed event pattern. |
| **Calculation** | `max(similarity_score)` from `HistoricalAnalogueEngine.findAnalogues()` |
| **Look-ahead risk** | **REQUIRES CAREFUL VALIDATION** — analogue search must only use embeddings from events with `event_timestamp < prediction_timestamp` |
| **Dependencies** | Requires `EMBEDDING_API_KEY` to be configured (currently absent) |
| **Phase** | 3C evaluation (after embeddings are operational) |

---

### 5.18 `historical_event_win_rate`

| Property | Value |
|---|---|
| **Type** | `float` |
| **Range** | `[0.0, 1.0]` |
| **Null** | `null` |
| **Meaning** | Historical win rate of similar past events: fraction of analogues where `return_1d > 0` (bullish outcome) for the instrument. |
| **Calculation** | Aggregated from `news_market_reactions` for analogue events |
| **Look-ahead risk** | LOW — reactions are computed from price data AFTER the event |
| **Dependencies** | Requires embeddings (5.17) + historical reactions populated |
| **Phase** | 3C evaluation |

---

## 6. Features Explicitly Rejected

| Feature name | Reason |
|---|---|
| Any feature derived from price data at event time | Requires data-service live quotes; not reliably available |
| Analyst consensus estimate at prediction time | Not available in data-service; consensus data would need a separate licensed feed |
| Real-time social media sentiment | Not in scope for Phase 3 |
| Article-level buy/sell/hold recommendation | SentinelPulse explicitly does not generate trading signals |
| Any feature with `feature_as_of > prediction_timestamp` | Hard violation of look-ahead constraint |

---

## 7. Feature Vector Schema for ml-service

When Phase 3B begins, the following fields should be added to ml-service `StockFeatures`:

```python
class StockFeatures(BaseModel):
    # ... existing 27 technical fields ...
    
    # SentinelPulse news features (Phase 3B addition)
    news_impact_score: float = 0.0
    news_sentiment_market: float = 0.0
    news_velocity_1h: int = 0
    news_velocity_24h: int = 0
    news_event_intensity: float = 0.0
    news_data_available: bool = False
    news_feature_as_of: Optional[datetime] = None  # ISO-8601 UTC
    news_freshness_state: str = "UNAVAILABLE"       # FRESH | STALE | EXPIRED | UNAVAILABLE
```

The `news_data_available` flag is a sentinel — when `False`, all other `news_*` fields should be treated as absent by the ML model, not as genuine zero values.

---

## 8. API Contract

SentinelPulse exposes news context via:

```
GET /api/v1/alphaforge/news-context/{instrument}
```

Response includes all 6 core features plus metadata. AlphaForge should:
1. Call this endpoint at signal generation time
2. Check `news_data_available` before using any news feature
3. Check `freshness_state` — do not use EXPIRED data
4. Pass the 6 core features to ml-service `POST /predict/rankings`

---

## 9. Versioning

Feature contract version `1.0.0` corresponds to:
- `feature_version = "1.0.0"` in `news_features` table
- `pipeline_version = "1.0.0"` in `news_features` table
- Model trained on features from this contract must not be mixed with `2.x` contract features

Any change to feature calculation must increment the minor version. Any change to feature set (add/remove) must increment the major version.

---

## 10. What This Contract Does NOT Claim

- ✗ Does not claim news features improve prediction accuracy
- ✗ Does not claim `news_impact_score` is predictive
- ✗ Does not claim any specific feature has signal value
- ✗ Does not specify model architecture or training procedure

All of the above are Phase 3B questions, answerable only after the ablation study completes.

---

*Generated by Phase 3A Runtime Certification Audit — 2026-09-15*
