# SentinelPulse — Temporal Data Contract

**Version:** 1.0.0  
**Date:** 2026-09-16  
**Status:** NORMATIVE — all pipeline components must comply  
**Supersedes:** ad-hoc timestamp comments in Phase 3A code  

---

## 1. Purpose

This document defines every timestamp used in the SentinelPulse pipeline, the
rules governing each, and the correct look-ahead constraint.

The central insight that governs Phase 3B historical dataset generation:

> **Processing timestamp** (`computed_at`) and **information timestamp**
> (`information_as_of`) are DIFFERENT things.  Only the information timestamp
> participates in look-ahead validation.

---

## 2. Timestamp Definitions

All timestamps are stored as `TIMESTAMPTZ` in UTC.

### 2.1 `source_published_at`

| Field | `news_articles.published_at` |
|---|---|
| **Meaning** | The date and time the author/source claims the article was published. |
| **Owner** | Source adapter (Reuters, Moneycontrol, ET, …) |
| **Trust level** | Medium — RSS feed timestamps are sometimes wrong or missing.  When missing, `timestamp_inferred = true` and `scraped_at` is used as the fallback. |
| **Timezone** | Always normalised to UTC at ingestion. |
| **Key rule** | This is the **information timestamp** for the article.  It represents the earliest moment a market participant could have read this article and acted on it. |

### 2.2 `source_available_at`

| Field | `news_articles.scraped_at` |
|---|---|
| **Meaning** | The wall-clock time at which SentinelPulse actually downloaded and processed the article.  Always >= `source_published_at` by definition. |
| **Owner** | NewsIngestionWorker (set at the moment of fetch) |
| **Trust level** | High — set by the local clock, no external dependency. |
| **Key rule** | Used as the fallback information timestamp ONLY when `source_published_at` is unavailable.  Never used as a substitute for `published_at` in look-ahead validation. |

### 2.3 `event_timestamp`

| Field | `news_events.event_timestamp` |
|---|---|
| **Meaning** | The point-in-time anchor for the underlying market event described by the article.  In almost all cases this equals `source_published_at`.  For events with an explicit occurrence time (e.g. "RBI announced at 14:30 IST"), the EventDetectionEngine extracts the time and sets `event_timestamp` accordingly. |
| **Owner** | EventDetectionEngine |
| **Key rule** | All feature values used in a FeatureVector for this event must have `information_as_of <= event_timestamp`.  This is the pivot timestamp for look-ahead validation. |

### 2.4 `feature_as_of`

| Field | `news_features.computed_at` (used as the feature's information anchor) |
|---|---|
| **Meaning** | The latest information timestamp among all data sources contributing to the feature vector.  Distinct from `computed_at` (see §2.5). |
| **Owner** | FeatureEngineeringEngine |
| **Key rule** | `feature_as_of <= event_timestamp`.  This is the constraint enforced by LookAheadGuard. |
| **Correct representation** | Should be stored as a dedicated field (see §4 — Gap G-1). |

### 2.5 `computed_at`

| Field | `news_sentiment.computed_at`, `news_importance.computed_at`, `news_features.computed_at` |
|---|---|
| **Meaning** | The wall-clock time at which the SentinelPulse engine computed this record.  This is always the present moment (2026-09-16 for live runs; 2026-09-16 for historical backfill runs). |
| **Owner** | Each engine, set via `new Date()` at time of computation |
| **Trust level** | High for provenance; IRRELEVANT for look-ahead validation. |
| **CRITICAL RULE** | `computed_at` MUST NOT be used in look-ahead validation.  A sentiment record with `computed_at = 2026-09-16` is NOT look-ahead leakage for an event with `event_timestamp = 2024-05-10` **if and only if** the sentiment was computed exclusively from information that was available at 2024-05-10 (the article text as published on that date). |

### 2.6 `prediction_timestamp`

| Field | Supplied by AlphaForge at signal generation time; stored in training sample as `event_timestamp` |
|---|---|
| **Meaning** | The moment at which AlphaForge generates a buy/sell/hold signal for a given instrument.  All news features presented to the ml-service at this moment must have `feature_as_of <= prediction_timestamp`. |
| **Owner** | AlphaForge (consumer of SentinelPulse features) |
| **Key rule** | `feature_as_of <= prediction_timestamp`.  This is the Phase 3B ML contract constraint. |

### 2.7 `label_cutoff_5m`, `label_cutoff_15m`, `label_cutoff_30m`, `label_cutoff_1h`, `label_cutoff_1d`

| Field | `news_training_samples.label_cutoff_5m` … `label_cutoff_1d` |
|---|---|
| **Meaning** | The timestamp at which the outcome label was observed.  `label_cutoff_5m = event_timestamp + 5 minutes`, etc. |
| **Owner** | MLDatasetGenerator |
| **CRITICAL RULE** | `label_cutoff_X > prediction_timestamp` always.  Label values are NEVER available before the cutoff timestamp.  Including label data in the feature vector is the most severe look-ahead violation class. |

---

## 3. The Correct Look-Ahead Constraint

### 3.1 Correct formulation

```
feature_as_of  <=  prediction_timestamp
```

where:

```
feature_as_of  =  max(information_as_of for each source used to compute the feature)
```

and `information_as_of` for each source is:

| Source | information_as_of |
|---|---|
| Article text (title + content) | `article.published_at` |
| Market OHLCV bar | `bar.timestamp` (the open-time of the bar) |
| Analyst consensus estimate | Timestamp of last revision before `event_timestamp` |
| Calculated feature (velocity, breadth) | Timestamp of the most recent underlying data point |
| Regime classification | Timestamp of the OHLCV / market data used for classification |

### 3.2 Incorrect formulation (Phase 3A bug)

The Phase 3A LookAheadGuard implemented:

```
computed_at  >  event_timestamp  →  REJECT
```

This is wrong for historical backfill because:

- Article published `2024-05-10`
- SentinelPulse backfill run: `2026-09-16`
- Sentiment `computed_at`: `2026-09-16`
- Sentiment input: exclusively the `2024-05-10` article text

`computed_at (2026) > event_timestamp (2024)` → guard fires → feature REJECTED

This is a false positive.  The information used to compute the sentiment (the article text) was published on `2024-05-10`.  The computation happened later but consumed no future information.

### 3.3 Correct formulation example

| Scenario | `information_as_of` | `event_timestamp` | Result |
|---|---|---|---|
| Article published 2024-05-10; sentiment computed 2026-09-16 from article text only | 2024-05-10 | 2024-05-10 | **PASS** |
| OHLCV bar timestamped 2024-05-10 14:35 used for event at 14:30 | 2024-05-10 14:35 | 2024-05-10 14:30 | **FAIL** (5-min future bar) |
| Feature uses `close_at_T+1h` as input feature (not label) | 2024-05-10 15:30 | 2024-05-10 14:30 | **FAIL** (future market price as feature) |
| Analyst estimate revised after `event_timestamp` | 2024-05-15 09:00 | 2024-05-10 14:30 | **FAIL** (future revision) |
| Feature uses article text from `2024-05-10`, computed `2026-09-16` | 2024-05-10 | 2024-05-10 | **PASS** |
| Forward return at T+5m used as feature (not label) | 2024-05-10 14:35 | 2024-05-10 14:30 | **FAIL** (future label data as feature) |

---

## 4. Identified Gaps Requiring Code Changes

### Gap G-1 — LookAheadGuard uses `computed_at` instead of `information_as_of`

**File:** `src/engines/feature-engineering/LookAheadGuard.ts`  
**File:** `src/engines/feature-engineering/FeatureEngineeringEngine.ts`

**Problem:** `FeatureEngineeringEngine.buildFeatureVector()` calls:

```typescript
this.guard.validateOne('sentiment.computedAt', sentimentRow.computedAt, event.eventTimestamp);
this.guard.validateOne('importance.computedAt', importanceRow.computedAt, event.eventTimestamp);
this.guard.validateOne('velocity.computedAt', velocityRow.computedAt, event.eventTimestamp);
```

`sentimentRow.computedAt` is the wall-clock time the sentiment engine ran, NOT the
timestamp of the article text it consumed.  For historical backfill (articles from
2024 processed in 2026) this will always fire and block all feature generation.

**Fix required:** LookAheadGuard must receive `information_as_of` (the article's
`published_at`) instead of `computed_at` for text-derived features.  For market-data
features, it must receive the bar's `timestamp` field.

**Implemented in:** `src/engines/feature-engineering/LookAheadGuard.ts` (Phase 3B-Preflight redesign)

### Gap G-2 — `feature_as_of` is not stored as a distinct field

**Problem:** The `news_features` table has `computed_at` but no `feature_as_of`
column.  Downstream validation cannot distinguish when information was available
from when it was processed.

**Fix required:** Add `feature_as_of TIMESTAMPTZ` to `news_features` and populate
it as `max(article.published_at, ...)` across all information sources.

### Gap G-3 — `prediction_timestamp` is not stored in `news_training_samples`

**Problem:** The training sample schema does not have an explicit `prediction_timestamp`
field.  The `event_timestamp` serves as a proxy but these are semantically different.

**Fix required:** Add `prediction_timestamp TIMESTAMPTZ` to `news_training_samples`.

---

## 5. Timestamp Flow Through the Pipeline

```
Source publishes article
       ↓
  article.published_at           ← information_as_of for text-derived features
  article.scraped_at             ← when SentinelPulse fetched it (always ≥ published_at)
       ↓
  EventDetectionEngine
       ↓
  event.event_timestamp          ← usually = article.published_at
                                    sometimes = explicit occurrence time from article
       ↓
  FeatureEngineeringEngine
  (uses data where information_as_of ≤ event.event_timestamp)
       ↓
  feature.feature_as_of          ← max of all information_as_of across inputs
  feature.computed_at            ← when the engine ran (irrelevant for validation)
       ↓
  [AlphaForge calls at prediction_timestamp]
  Constraint: feature.feature_as_of ≤ prediction_timestamp
       ↓
  MLDatasetGenerator
       ↓
  training_sample.label_cutoff_Xm = event_timestamp + horizon
  Constraint: label_cutoff_Xm > prediction_timestamp  (always true by definition)
```

---

## 6. Market Data Temporal Rules

Market data carries an additional constraint: **the data-service `asOf` parameter
must equal the offset timestamp**, not the current wall clock.

```
HistoricalReactionEngine:
  For event at T,  OHLCV at offset T+5m:
    query: asOf = T+5m   → CORRECT (bar.timestamp ≤ T+5m)
    query: asOf = now()  → WRONG   (could return bars up to 2026-09-16)

FeatureEngineeringEngine:
  For event at T, market context snapshot:
    query: asOf = T      → CORRECT
    query: asOf = now()  → WRONG
```

The `DataServiceClient.getOHLCV()` implementation correctly caps `to` at `asOf`:

```typescript
const effectiveTo = params.to > params.asOf ? params.asOf : params.to;
```

This is correct and must not be removed.

---

## 7. Label Timestamp Rules

Labels are OUTCOMES, not inputs.  They are always future relative to the event.

```
For event at T:
  label_cutoff_5m  = T + 5 minutes
  label_cutoff_15m = T + 15 minutes
  label_cutoff_30m = T + 30 minutes
  label_cutoff_1h  = T + 60 minutes
  label_cutoff_1d  = T + 24 hours

Rules:
  label_cutoff_X  >  event_timestamp          (always — by construction)
  label_cutoff_X  >  prediction_timestamp     (always — labels are not available yet)
  OHLCV bar used for label:  bar.timestamp <= label_cutoff_X
```

MLDatasetGenerator validates this with `LookAheadBiasError` if
`cutoffTimestamp <= eventTimestamp`.

---

## 8. Summary Reference Table

| Timestamp | Column | Set by | Used for | look-ahead guard input? |
|---|---|---|---|---|
| source_published_at | `news_articles.published_at` | Adapter | information_as_of for text | **YES** |
| source_available_at | `news_articles.scraped_at` | IngestionWorker | fallback when published_at missing | Fallback only |
| event_timestamp | `news_events.event_timestamp` | EventDetectionEngine | look-ahead pivot | **ANCHOR** |
| feature_as_of | `news_features.feature_as_of` (Gap G-2) | FeatureEngineeringEngine | ML contract validation | YES (derived) |
| computed_at (text features) | `news_sentiment.computed_at`, etc. | Each engine | Audit trail only | **NO** |
| computed_at (market features) | `news_market_reactions.computed_at` | HistoricalReactionEngine | Audit trail only | **NO** |
| bar.timestamp (OHLCV) | returned from data-service | data-service | Market data information_as_of | **YES** |
| prediction_timestamp | future field in training sample | MLDatasetGenerator | ML contract | YES |
| label_cutoff_Xm | `news_training_samples.label_cutoff_*` | MLDatasetGenerator | Outcome boundary | YES (must be > prediction_timestamp) |

---

*Generated by Phase 3B-Preflight Audit — 2026-09-16*
