# SentinelPulse — Phase 3B-Preflight Report

**Date:** 2026-09-16  
**Auditor:** Phase 3B-Preflight (automated inspection + live DB + runtime tests)  
**Baseline:** Phase 3A Runtime Certification Report (2026-09-15)  
**Stack state:** Running — API port 3001, 8 workers, Scrapling port 8001  
**Post-audit annotation:** Phase 3B.1 (2026-09-17) and Phase 3B.2 (2026-09-18) resolution notes added inline — look for **[3B.1]** and **[3B.2]** markers.

---

## Executive Summary

Phase 3B-Preflight has audited all components required before historical ML dataset
generation.  Fourteen critical checks were evaluated.  Seven pass, five fail, and
two are partial.  The most critical findings are:

1. **LookAheadGuard was using `computed_at` instead of `information_as_of`** — this
   would have caused every historical backfill feature to be rejected as false look-ahead.
   **Fixed and 53 new tests pass.** **[3B.1: ✅ Resolved — `FeatureSource.informationAsOf` interface, 79/79 tests pass]**

2. **`DataServiceClient` field mapping bug** — `candle.datetime` (undefined) instead of
   `new Date(candle.time * 1000)`.  All `OHLCVBar.timestamp` values were `Invalid Date`.
   **Fixed.** **[3B.1: ✅ Resolved — MKT-BUG-1 fix confirmed; `OHLCVResponse` envelope also added]**

3. **Historical reactions = 0** — intraday OHLCV is unavailable from all providers.
   Daily OHLCV works only for 4 instruments in the Jan 2024 window.
   **[3B.2: ✅ Resolved — RC-1 (Upstox key mismatch), RC-2 (Redis checkpoint), RC-3 (Docker env missing) all fixed. All 8 instruments × 4 intervals now operational. Remaining blocker: Jan 2024 news ingestion + data-service image rebuild.]**

4. **One-hour run was 12–14 minutes** — the Phase 3A runtime test did not run for 60
   minutes.  A genuine 60-minute run has not been completed.
   **[3B.2: ⏳ Pending — all code preconditions are met. Test can proceed after data-service image is rebuilt.]**

5. **Training samples = 0** — no ML training data has been generated.
   **[3B.2: ⏳ Still 0 — blocked on Jan 2024 news ingestion and reactions, not on code issues.]**

**GO / NO-GO decisions are at the end of this document (§10).**

---

## 1. Temporal Contract (Critical)

**Status: FIXED**

### 1.1 Phase 3A problem

`LookAheadGuard.validateOne()` compared `computed_at > event_timestamp`.  For any
historical backfill (e.g. 2024-05-10 article processed in 2026), this would always
fire and block feature generation.

### 1.2 Phase 3B-Preflight fix

`LookAheadGuard` redesigned to validate `information_as_of` (the underlying data
timestamp) not `computed_at` (when the engine ran).  `FeatureEngineeringEngine` now
fetches `article.published_at` and passes it as `informationAsOf` for all text-derived
features.

The correct constraint is:

```
feature_as_of (= article.published_at for text features)  <=  event_timestamp
```

NOT:

```
computed_at  <=  event_timestamp
```

### 1.3 Test coverage

53 new unit tests + 3 property tests covering cases A–F from the temporal contract:
- CASE A (historical article processed later) → PASS ✓
- CASE B (future OHLCV bar) → FAIL ✓
- CASE C (future market price as feature) → FAIL ✓
- CASE D (historical article text processed later) → PASS ✓
- CASE E (analyst estimate revised after prediction) → FAIL ✓
- CASE F (future label data as feature) → FAIL ✓

79/79 tests pass (unit + property).

### 1.4 Remaining gaps

| Gap | Status |
|---|---|
| `feature_as_of` not stored as dedicated column | OPEN — needs schema migration |
| `prediction_timestamp` not in training samples schema | OPEN — needs schema migration |

**Reference:** `docs/TEMPORAL_DATA_CONTRACT.md`

---

## 2. LookAheadGuard Redesign

**Status: IMPLEMENTED + TESTED**

| Component | Change | Status |
|---|---|---|
| `LookAheadGuard.ts` | New `FeatureSource` interface with `informationAsOf` | ✓ Done |
| `LookAheadGuard.ts` | `validateLabelCutoff()` method for label ordering | ✓ Done |
| `LookAheadGuard.ts` | Deprecated `DataPoint.recordTimestamp` shim for migration | ✓ Done |
| `FeatureEngineeringEngine.ts` | Fetches `article.published_at` in parallel | ✓ Done |
| `FeatureEngineeringEngine.ts` | Passes `textInformationAsOf` (not `computed_at`) | ✓ Done |
| Property tests | Updated to `FeatureSource` interface + backfill invariant | ✓ Done |
| Unit tests | 53 new tests, 6 named cases, integration + property sections | ✓ Done |

**Genuine look-ahead violations on current DB: 0** (confirmed by SQL Q1).

---

## 3. Market Data Certification

**Status: PARTIAL PASS — data range severely limited** *(at preflight — see Phase 3B.2 resolution below)*

### 3.1 Architecture compliance

All market data goes through `DataServiceClient` → data-service.  No direct provider
calls in SentinelPulse.  **PASS.**

### 3.2 DataServiceClient timestamp bug

**Fixed:** `candle.datetime` (undefined) → `new Date(candle.time * 1000)` (correct epoch conversion).
This fix is required for LookAheadGuard bar-timestamp validation.
**[3B.1: ✅ Confirmed — MKT-BUG-1. `OHLCVResponse` envelope also added with `metadata.provider`, `metadata.dataAsOf`, `metadata.quality`.]**

### 3.3 OHLCV availability (at preflight)

| Interval | Available instruments | Date range |
|---|---|---|
| 1d | RELIANCE, HDFCBANK, INFY, BANKNIFTY (4/8) | 2024-01-02 to ~2024-01-18 only |
| 1h | 0/8 | No data |
| 15m | 0/8 | No data |
| 5m | 0/8 | No data |

**[3B.2: ✅ Fully resolved.** Three root causes fixed (RC-1/RC-2/RC-3). Current state: all 8 instruments × 5m/15m/1h/1d operational across Windows A–D (Sep 2026, Jun 2026, Jan 2024, Apr 2024). See `PHASE3B2_CERTIFICATION_REPORT.md §4` for the full coverage matrix.]

### 3.4 Provider fallback observed (at preflight)

- Angel One → `angel_one` (RELIANCE Jan 2024)
- Angel One failed → Yahoo → `yahoo_finance` (HDFCBANK, INFY, BANKNIFTY)
- All providers failed → empty response (TCS, ICICIBANK, SBIN, NIFTY)
- Silent empty return: PASS (no exceptions thrown)

**[3B.2: ✅ Full waterfall certified (5/5 tests A–E): angel_one / upstox / yahoo_finance / null all observed. Upstox now confirmed as active provider for IDX instruments.]**

### 3.5 Provider metadata gap

`DataServiceClient.getOHLCV()` returns `OHLCVBar[]` without `provider`, `fallback_used`,
or `data_available` fields.  SentinelPulse callers cannot observe which provider served
the data.

**[3B.1: ✅ Resolved — `OHLCVResponse` envelope added. `metadata.provider` now surfaced.]**

**Reference:** `docs/MARKET_DATA_CERTIFICATION.md` (preflight), `docs/MARKET_DATA_FINAL_CERTIFICATION.md` (Phase 3B.1)

---

## 4. Provider Fallback Verification

**Status: PASS (observed) — INCOMPLETE (Upstox not observed)**

| Scenario | Result |
|---|---|
| Angel One succeeds | ✓ Observed (RELIANCE) |
| Angel One fails → Yahoo succeeds | ✓ Observed (HDFCBANK, INFY, BANKNIFTY) |
| All providers fail → empty (not exception) | ✓ Confirmed |
| Upstox observed as active provider | ✗ NOT observed |
| Deliberate provider failure injection test | ✗ NOT done (no kill-switch endpoint) |

Upstox was not observed as a provider in any response.  It is unknown whether Upstox
is configured and failing silently or not configured in this environment.

---

## 5. Historical Reaction Test

**Status: FAIL — 0 reactions generated** *(at preflight — see Phase 3B.2 resolution below)*

| Metric | Result |
|---|---|
| Reactions in DB | **0** |
| Root cause | Intraday OHLCV unavailable; daily only for 4 instruments in Jan 2024 |
| Engine temporal correctness | ✓ PASS (code review — asOf=offsetTime enforced) |
| Null/missing data handling | ✓ PASS (no interpolation) |
| Intraday interval bug | ✗ FAIL (RXN-G1: engine uses 1d interval for all offset queries) |
| 7-day pilot range selected | ✓ 2024-01-08 to 2024-01-14 |

**Historical reactions are currently 0.** The root cause is environmental (provider
data availability) not a code bug in the reaction engine.  The engine code is correct
but cannot produce results without OHLCV data.

For the pilot: only `return_1d` labels are achievable.  `return_5m`, `return_15m`,
`return_30m`, `return_1h` will remain null until intraday OHLCV becomes available.

**[3B.1: ✅ RXN-G1 fixed — `intervalForOffset()` now returns `'5m'` for all intraday offsets. Provider metadata now persisted. 27/27 reaction tests pass.]**

**[3B.2: ✅ OHLCV data now fully available for all 8 instruments × all intervals. Intraday labels (return_5m/15m/1h) are now achievable. Reactions remain 0 only because Jan 2024 news ingestion has not yet run. Once `news_events` rows exist for 2024-01-08 → 2024-01-14, `pilot-reaction-test.ts` will generate reactions immediately.]**

**Reference:** `docs/HISTORICAL_REACTION_CERTIFICATION.md` (preflight), `docs/HISTORICAL_REACTION_FINAL_CERTIFICATION.md` (Phase 3B.1)

---

## 6. Asset Resolution (Entity Resolution Audit)

**Status: PARTIAL — architecture correct, coverage low but measurable**

| Metric | Value |
|---|---|
| Total articles | 230 |
| Articles with ≥1 asset link | 19 |
| **Asset linkage rate** | **8.3%** |
| Moneycontrol linkage | 22.7% (best source) |
| Reuters linkage | 3.4% (global news, not NSE-specific) |
| CoinDesk linkage | 0% (crypto, not in instrument master) |
| Entity mention resolution (has entity_id) | 100% (888/888) |

> Note: Phase 3A report cited 26.1% (from 12-minute window of 157 articles).
> The current 8.3% reflects the full 230-article corpus where Reuters global news
> dominates.  These are consistent — Moneycontrol remains ~22.7% in both windows.

The architecture is correct: InstrumentIndex provides O(1) lookup, no per-entity
HTTP calls.  Coverage is limited by news source mix.

**Gap:** 500-entity ground truth test not completable with current corpus (only 101
Company + Index mentions vs 500 required).

**Reference:** `docs/ENTITY_RESOLUTION_CERTIFICATION.md`

---

## 7. Event Classification Audit

**Status: NEEDS IMPROVEMENT — 85.3% UNCLASSIFIED**

| Metric | Value |
|---|---|
| Total events | 232 |
| Classified | 34 (14.7%) |
| UNCLASSIFIED | 198 (85.3%) |
| False positive rate (estimated) | ~10% |
| False negative rate (estimated) | ~60% |

High UNCLASSIFIED rate driven by:
1. Reuters global news (51% of articles) doesn't match India-centric regex patterns
2. CoinDesk crypto content (11%) not matched by any rule
3. HEADLINE_ONLY content has insufficient keyword density

5 missing regex patterns identified that would improve classification by 15–20%.
The deterministic engine is retained — no ML replacement.

**Not a Phase 3B blocker** — UNCLASSIFIED events still generate valid feature vectors.

**Reference:** `docs/EVENT_CLASSIFICATION_AUDIT.md`

---

## 8. Content Quality Audit

**Status: STRUCTURALLY CORRECT — data quality low by design**

| Metric | Value |
|---|---|
| FULL_ARTICLE articles | 0 (0%) |
| SUMMARY articles | 2 (0.9%) |
| HEADLINE_ONLY articles | 228 (99.1%) |
| Avg content_quality_score | 0.250 |
| Avg source_confidence | 0.61–0.64 |
| HEADLINE_ONLY sentiment (avg) | 0.047 (near-neutral) |
| HEADLINE_ONLY sentiment (stddev) | 0.329 (high noise) |

Content depth model is correctly implemented and propagated through the entire pipeline.
Bloomberg/FT would raise quality to 0.90–0.93 but require paid API keys.

The low quality is a deliberate structural reality of RSS-only sources, not a bug.
The model must be trained on it, not filtered around it.

**Reference:** `docs/NEWS_CONTENT_QUALITY_AUDIT.md`

---

## 9. One-Hour Runtime Test

**Status: FAIL — 12–14 minutes observed, not 60 minutes**

The Phase 3A Certification Report states:

> "The 1-hour run is stable. Incremental growth is low..."

But the `PHASE3A_PIPELINE_METRICS.md` records:

> "Run window: 18:02–18:14 UTC (12 minutes of live data)"

A 12-minute run is NOT a 60-minute test.  The certification claimed stability at T+14min
and extrapolated — this is not the same as a verified 60-minute run.

**A genuine 60-minute run with 5-minute metric snapshots has not been completed.**

This is a Phase 3B-Preflight blocker.  The 60-minute run must be completed and documented
before proceeding to the 7-day historical pilot.

---

## 10. Seven-Day Historical Pilot Status

**Status: NOT STARTED**

Pre-conditions for the pilot:
- [✓] LookAheadGuard redesigned
- [✓] DataServiceClient timestamp bug fixed
- [✓] Pilot date range selected: 2024-01-08 to 2024-01-14
- [✗] 60-minute runtime test not completed
- [✗] Intraday OHLCV not available
- [✓] Daily OHLCV available for 4 instruments in pilot window
- [✗] Reactions = 0

The pilot cannot start until the 60-minute runtime test passes.

---

## 11. Training Sample Schema

**Status: CORRECT IN CODE — 0 SAMPLES GENERATED**

`MLDatasetGenerator.generateSample()` correctly:
- Sets `labelCutoff_Xm = eventTimestamp + horizon` (always future)
- Sets `asOf = cutoffTimestamp` for each label OHLCV fetch
- Throws `LookAheadBiasError` if `cutoffTimestamp <= eventTimestamp`
- Does not persist when baseline OHLCV is unavailable

Required training sample fields present in schema:
- `prediction_timestamp`: MISSING (Gap PT-G4 — `event_timestamp` is proxy)
- `label_cutoff_5m` through `label_cutoff_1d`: ✓ present
- `feature_version`, `pipeline_version`: ✓ present

---

## 12. Core Six News Features

**Status: DEFINED — GENERATED FOR 2 EVENTS ONLY**

| Feature | Contract | In DB |
|---|---|---|
| `news_impact_score` | ✓ Defined | 2 records |
| `news_sentiment_market` | ✓ Defined | 2 records |
| `news_velocity_1h` | ✓ Defined | 2 records |
| `news_velocity_24h` | ✓ Defined | 2 records |
| `news_event_intensity` | ✓ Defined | 2 records |
| `news_data_available` | ✓ Defined | 2 records |

All 6 features carry `feature_as_of`, `freshness_state`, `data_available`, `feature_version`.
Only 2 feature vectors exist (from Phase 3A smoke test).  The backfill will generate
more once the look-ahead bug is fixed and OHLCV data is available.

---

## 13. Embeddings

**Status: CORRECTLY NON-BLOCKING**

- `EMBEDDING_API_KEY` absent → `embedding_status = SKIPPED`
- Core pipeline (sentiment, importance, market impact, feature generation) unaffected
- Embeddings do not block any Phase 3B operation
- Historical analogue features are NOT in the Phase 3B core feature set
- `EmbeddingEngine` enqueues retry jobs silently — no worker crash

**Reference:** `docs/SENTINELPULSE_ML_FEATURE_CONTRACT.md §5.17, §5.18`

---

## 14. AlphaForge Integration

**Status: CORRECTLY DISCONNECTED**

- AlphaForge makes 0 calls to SentinelPulse
- SentinelPulse makes 0 BUY/SELL/HOLD decisions
- No news features flow into ml-service StockFeatures
- Integration requires ablation study (Phase 3B outcome)

**No production ML training has occurred.  No live AlphaForge decision uses news.**

---

## 15. Summary of Bugs Found and Fixed in This Preflight

| Bug ID | Component | Description | Status |
|---|---|---|---|
| BUG-LAG-1 | LookAheadGuard | Used `computed_at` instead of `information_as_of` — caused false positives for all historical backfill | ✓ FIXED |
| BUG-MKT-1 | DataServiceClient | `candle.datetime` (undefined) instead of `candle.time * 1000` — all bar timestamps were Invalid Date | ✓ FIXED |

---

## 16. Open Issues Requiring Action Before Phase 3B

> **Note (Phase 3B.2 update — 2026-09-18):** Items marked ✅ RESOLVED below were addressed in Phase 3B.1 or 3B.2. Items still marked ⏳ PENDING are the remaining blockers for Phase 3B.3.

| Priority | Gap | Action Required | Resolution |
|---|---|---|---|
| **BLOCKER** | 60-minute runtime test not done | Run actual 60-minute test with 5-min snapshots | ⏳ PENDING — all preconditions met; data-service image rebuild required first |
| **BLOCKER** | Historical reactions = 0 (intraday OHLCV missing) | Verify provider circuits with data-service team | ✅ RESOLVED (Phase 3B.2) — RC-1/RC-2/RC-3 fixed; all 8 instruments × 4 intervals now operational |
| **BLOCKER** | Training samples = 0 | Blocked by reactions; pilot must run first | ⏳ PENDING — blocked on Jan 2024 news ingestion + data-service image rebuild |
| HIGH | `feature_as_of` not a dedicated column | Add `feature_as_of TIMESTAMPTZ` to `news_features` | ✅ RESOLVED (Phase 3B.1) — migration 003 added `feature_as_of` |
| HIGH | `prediction_timestamp` not in training samples | Add `prediction_timestamp TIMESTAMPTZ` to `news_training_samples` | ✅ RESOLVED (Phase 3B.1) — migration 003 added `prediction_timestamp` + `label_bar_timestamp_*` |
| HIGH | HistoricalReactionEngine interval bug (RXN-G1) | Pass `interval: '5m'` or `'1m'` for intraday offsets, not `'1d'` | ✅ RESOLVED (Phase 3B.1) — `intervalForOffset()` now maps all intraday offsets to `'5m'` |
| HIGH | Provider metadata not surfaced | Add provider + fallback_used to `DataServiceClient` response | ✅ RESOLVED (Phase 3B.1) — `OHLCVResponse` envelope with `metadata.provider`, `metadata.dataAsOf`, `metadata.quality` |
| HIGH | Event classification false negative rate ~60% | Add 5 missing regex patterns | ⏳ PENDING — not a blocker for 3B.3 |
| MEDIUM | Asset linkage 8.3% overall | Add more India-specific source coverage | ⏳ PENDING — low priority |
| MEDIUM | Actor extraction quality poor | Fix actor extraction artifacts | ⏳ PENDING — low priority |
| MEDIUM | Upstox not observed as active provider | Confirm Upstox circuit state with data-service | ✅ RESOLVED (Phase 3B.2) — RC-1 + RC-3 fixed; Upstox now serves IDX instruments confirmed via Test B + Test D |

---

## 10. GO / NO-GO

> Based strictly on measured evidence as of Phase 3B-Preflight (2026-09-16).  
> **Phase 3B.2 resolution notes added in brackets where items have since been addressed.**

---

### FULL HISTORICAL BACKFILL (2024-01-01 to present)

**NO-GO** *(as of preflight — conditions improving)*

Reasons:
1. Genuine 60-minute runtime test has not been completed. **[3B.2: preconditions now met; test pending]**
2. Intraday OHLCV is not available — backfill would generate 0 intraday labels. **[3B.2: RESOLVED — all 8 instruments × 4 intervals now operational post RC-1/RC-2/RC-3 fixes]**
3. Daily OHLCV available only through ~2024-01-18 — backfill beyond this date produces empty reactions. **[3B.2: Coverage confirmed for Windows A–D including Jan 2024 and Sep 2026]**
4. Training samples = 0 — the look-ahead bug fix and reaction engine must first be validated on the 7-day pilot. **[3B.2: still 0 samples; Jan 2024 news ingestion pending]**
5. `feature_as_of` column missing — point-in-time audit trail is incomplete. **[3B.1: RESOLVED — migration 003 added `feature_as_of`]**

Do not proceed to full backfill until the 7-day pilot completes successfully with non-zero reactions.

---

### ML TRAINING

**NO-GO** *(unchanged)*

Reasons:
1. Training samples = 0. **[3B.2: still 0; blocked on reactions]**
2. Historical reactions = 0 — no labels can be generated. **[3B.2: OHLCV data now available; reactions blocked only on Jan 2024 news ingestion]**
3. Intraday labels (return_5m through return_1h) are not achievable with current OHLCV availability. **[3B.2: RESOLVED — intraday OHLCV fully operational]**
4. The 7-day pilot must first generate training samples and confirm reaction coverage > 10%.

ml-service StockFeatures has 0 news fields. Adding news features requires training data first.

---

### ALPHAFORGE INTEGRATION

**NO-GO** *(unchanged)*

Reasons:
1. No ablation study has been run.
2. No training data exists to validate that news features have predictive value.
3. The feature contract requires empirical validation before any production use.
4. AlphaForge correctly makes 0 calls to SentinelPulse — this is the correct state.

---

### 7-DAY HISTORICAL PILOT (2024-01-08 to 2024-01-14)

**CONDITIONAL GO** *(conditions tightening — closer than at preflight)*

The pilot is possible IF:
- The data-service Docker image is rebuilt with Phase 3B.2 fixes committed (**new requirement — highest priority**)
- The 60-minute runtime test is completed first (genuine 60 minutes, with 5-minute snapshots)
- Jan 2024 news ingestion is run to populate `news_events` for the pilot window
- The pilot accepts all return horizons (5m/15m/1h/1d) — all OHLCV data is now available **[3B.2 update]**
- The pilot targets all 8 instruments — full coverage confirmed **[3B.2 update — was 4 instruments only at preflight]**
- The pilot measures reaction coverage rate before any decision to proceed further

If reaction coverage rate (articles with any non-null return / articles with asset links) < 20%, stop.

---

## Appendix: Documents Produced by This Preflight

| Document | Location |
|---|---|
| TEMPORAL_DATA_CONTRACT.md | docs/TEMPORAL_DATA_CONTRACT.md |
| MARKET_DATA_CERTIFICATION.md | docs/MARKET_DATA_CERTIFICATION.md |
| HISTORICAL_REACTION_CERTIFICATION.md | docs/HISTORICAL_REACTION_CERTIFICATION.md |
| ENTITY_RESOLUTION_CERTIFICATION.md | docs/ENTITY_RESOLUTION_CERTIFICATION.md |
| EVENT_CLASSIFICATION_AUDIT.md | docs/EVENT_CLASSIFICATION_AUDIT.md |
| NEWS_CONTENT_QUALITY_AUDIT.md | docs/NEWS_CONTENT_QUALITY_AUDIT.md |
| POINT_IN_TIME_DATASET_CERTIFICATION.md | docs/POINT_IN_TIME_DATASET_CERTIFICATION.md |

## Appendix: Code Changes in This Preflight

| File | Change |
|---|---|
| `src/engines/feature-engineering/LookAheadGuard.ts` | Full redesign — FeatureSource interface, informationAsOf, validateLabelCutoff |
| `src/engines/feature-engineering/FeatureEngineeringEngine.ts` | Fetch article.published_at; pass as informationAsOf |
| `src/integrations/data-service/DataServiceClient.ts` | Fix RawHistoricalCandle: time (epoch) not datetime (string) |
| `tests/unit/engines/feature-engineering/LookAheadGuard.test.ts` | 53 new tests (NEW FILE) |
| `tests/property/feature-engineering.property.test.ts` | Updated to FeatureSource interface + backfill property |

---

*Generated by Phase 3B-Preflight Audit — 2026-09-16*  
*Annotated with Phase 3B.1 resolutions — 2026-09-17*  
*Annotated with Phase 3B.2 resolutions — 2026-09-18*
