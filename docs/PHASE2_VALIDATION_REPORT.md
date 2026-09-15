# SentinelPulse — Phase 2 Validation Report

**Date:** 2026-09-15  
**Auditor:** Kiro (automated deep audit + fixes)  
**Status:** Blockers resolved. Pipeline ready to run. ML/AlphaForge integration pending.

---

## Executive Summary

SentinelPulse was inspected against its full runtime environment — not against its documentation. Three critical blockers were found and fixed during this audit. The system now has a working database, correct data-service integration, and three live RSS sources confirmed reachable. However the pipeline has never processed a real article end-to-end because it has not been started yet. The ML and AlphaForge integrations documented in the README are **not implemented** — the ml-service StockFeatures schema has zero news fields and there is no push mechanism. The most important next step is to run the stack and ingest real data before any ML experiment is meaningful.

---

## A. Source Validation

| Source | Type | Reachable | Articles | Latency | Status |
|---|---|---|---|---|---|
| Reuters | Google News RSS¹ | YES | 100 | 803ms | **FIXED** — was BROKEN |
| Moneycontrol | RSS | YES | 18 | 434ms | VERIFIED LIVE |
| Economic Times | RSS | YES | 76 | 1053ms | VERIFIED LIVE |
| CoinDesk | RSS | YES | 25 | 1181ms | VERIFIED LIVE |
| Bloomberg | API | N/A | 0 | N/A | MOCKED — no API key |
| Financial Times | API | N/A | 0 | N/A | MOCKED — no API key |

**¹ Reuters RSS history:** Reuters officially discontinued `feeds.reuters.com` in June 2020 (domain now NXDOMAIN). The Reuters adapter was updated to use the Google News RSS search API (`news.google.com`), which surfaces Reuters articles in standard RSS 2.0 format. The `news.google.com` domain was added to the SSRF allowlist. Bloomberg and Financial Times are correctly disabled by default — they return an empty array with a WARN log when no API key is configured.

---

## B. Infrastructure State

| Component | Port | Status | Notes |
|---|---|---|---|
| data-service | 8200 | RUNNING HEALTHY | v2.0.0, Angel One + Upstox providers configured |
| ml-service | 8100 | RUNNING HEALTHY | v1.0.0, 5 models loaded |
| alpha-forge-app | 3000 | RUNNING (unhealthy) | AlphaForge signal engine |
| PostgreSQL (AlphaForge) | 5433 | RUNNING HEALTHY | postgres:17, no pgvector |
| PostgreSQL (TimescaleDB) | 5444 | RUNNING HEALTHY | timescale/pg15, **has pgvector** |
| Redis | 6379 | RUNNING HEALTHY | Shared with AlphaForge |
| **sentinel_pulse DB** | 5444 | **CREATED + MIGRATED** | 23 tables + pgvector extension |
| SentinelPulse API | 3000 | NOT STARTED | Needs `npm run dev` |
| SentinelPulse workers | — | NOT STARTED | 8 worker processes |

The `sentinel_pulse` database was created on the TimescaleDB instance (port 5444) because it is the only available PostgreSQL that has the `pgvector` extension required by the `news_embeddings` table. The `sentinel` user owns all 23 tables.

---

## C. Pipeline Validation

### C.1 Component Classification

| Component | Classification | Evidence |
|---|---|---|
| RSS parser (rss-parser.ts) | IMPLEMENTED + VERIFIED | Parses all 4 live feeds correctly |
| ReutersAdapter | IMPLEMENTED + VERIFIED | Live: 100 articles, 803ms |
| MoneycontrolAdapter | IMPLEMENTED + VERIFIED | Live: 18 articles, 434ms |
| EconomicTimesAdapter | IMPLEMENTED + VERIFIED | Live: 76 articles, 1053ms |
| CoinDeskAdapter | IMPLEMENTED + VERIFIED | Live: 25 articles, 1181ms |
| BloombergAdapter | IMPLEMENTED + MOCKED | No API key; graceful empty list |
| FinancialTimesAdapter | IMPLEMENTED + MOCKED | No API key; graceful empty list |
| CircuitBreaker | IMPLEMENTED + VERIFIED | 26 unit tests pass |
| RateLimiter | IMPLEMENTED + VERIFIED | 22 unit tests pass |
| Scheduler | IMPLEMENTED + NOT VERIFIED | 0% test coverage; not started |
| NormalizationEngine | IMPLEMENTED + NOT VERIFIED | 0% coverage; no DB run yet |
| DeduplicationEngine | IMPLEMENTED + NOT VERIFIED | Property tests pass; no DB run |
| EntityResolutionEngine | IMPLEMENTED + NOT VERIFIED | 13 unit tests pass; no DB run |
| EventDetectionEngine | IMPLEMENTED + NOT VERIFIED | Property tests pass; no DB run |
| SentimentEngine | IMPLEMENTED + NOT VERIFIED | 12 unit tests pass; no DB run |
| ImportanceEngine | IMPLEMENTED + NOT VERIFIED | 20 unit tests pass; no DB run |
| MarketImpactEngine | IMPLEMENTED + NOT VERIFIED | 0% coverage; no DB run |
| HistoricalReactionEngine | IMPLEMENTED + NOT VERIFIED | 18 unit tests pass; no DB run |
| FeatureEngineeringEngine | IMPLEMENTED + NOT VERIFIED | 23 unit tests pass; no DB run |
| LookAheadGuard | IMPLEMENTED + VERIFIED | CI check: 0 violations (empty DB) |
| MLDatasetGenerator | IMPLEMENTED + NOT VERIFIED | 0% coverage; no DB run |
| EmbeddingEngine | IMPLEMENTED + NOT VERIFIED | 0% coverage; no API key |
| BackfillEngine | IMPLEMENTED + NOT VERIFIED | 0% coverage; not started |
| VelocityEngine | IMPLEMENTED + NOT VERIFIED | 0% coverage |
| BreadthEngine | IMPLEMENTED + NOT VERIFIED | 0% coverage |
| CrossMarketEngine | IMPLEMENTED + NOT VERIFIED | 0% coverage |
| MarketRegimeEngine | IMPLEMENTED + NOT VERIFIED | 0% coverage |
| HistoricalAnalogueEngine | IMPLEMENTED + NOT VERIFIED | 0% coverage |
| DataServiceClient | **FIXED + VERIFIED** | All 5 methods tested against live data-service |
| ScraplingClient | IMPLEMENTED + NOT VERIFIED | Scrapling sidecar not running |
| BullMQ queues | IMPLEMENTED + NOT VERIFIED | Queue definitions correct; not started |
| All 8 workers | IMPLEMENTED + NOT VERIFIED | 0% coverage; not started |
| AlphaForge API routes | IMPLEMENTED + NOT VERIFIED | Routes registered; DB not populated |
| ML API routes | IMPLEMENTED + NOT VERIFIED | Routes registered; DB not populated |
| Admin API routes | IMPLEMENTED + NOT VERIFIED | Routes registered; DB not populated |

### C.2 Pipeline Stage Drop/Latency (Not Yet Measurable)

The pipeline has not processed a single real article. No stage-level metrics exist. This table will be populated after the first ingestion run.

| Stage | Status |
|---|---|
| Source → Raw queue | NOT RUN |
| Raw → Normalized | NOT RUN |
| Normalized → Dedup | NOT RUN |
| Dedup → Entity | NOT RUN |
| Entity → Event | NOT RUN |
| Event → Sentiment | NOT RUN |
| Sentiment → Importance | NOT RUN |
| Importance → MarketImpact | NOT RUN |
| MarketImpact → HistoricalReaction | NOT RUN |
| HistoricalReaction → Features | NOT RUN |
| Features → TrainingSample | NOT RUN |
| TrainingSample → Embedding | NOT RUN |

---

## D. Data-Service Integration

**Pre-fix state:** `DataServiceClient.ts` called five endpoints that do not exist in data-service v2.0.0. Every call would have returned 404 or 401.

**Post-fix state — verified live calls:**

| SentinelPulse method | Actual endpoint | Verified result |
|---|---|---|
| `healthCheck()` | `GET /v1/health/live` | `true` |
| `getInstrumentById("NSE:RELIANCE")` | `GET /v1/instruments/NSE:RELIANCE` | Returns correct instrument record |
| `resolveInstrument("RELIANCE")` | Falls through to `NSE:RELIANCE` lookup | Returns `NSE:RELIANCE` |
| `getMarketContextSnapshot("RELIANCE")` | `GET /v1/india/quotes/RELIANCE` | Returns snapshot (prices null — provider not connected) |
| `getOHLCV(RELIANCE, 2024-01-02..10, 1d)` | `GET /v1/india/historical` | Returns 6 bars |
| `getRegimeSignals("india")` | **Not in data-service** | Returns `[]` with WARN log |

**Remaining gap:** `getRegimeSignals()` has no counterpart in the data-service. Regime data must come from the ml-service `POST /predict/regime` endpoint. This is documented as a `@deprecated` warning in the rewritten client.

**Auth correction:** data-service v2.0.0 uses `X-API-Key` header (not `Authorization: Bearer`). The original client used the wrong header, causing all authenticated calls to return 401. Fixed.

**Instrument master:** The data-service holds 34,459 instruments. There is no fuzzy `resolve` endpoint — only exact ID lookup (`/v1/instruments/{id}`). The rewritten `resolveInstrument()` tries three forms: raw surface form, `NSE:` prefix, `BSE:` prefix. For unmapped entities the EntityResolutionEngine will fall back to its internal dictionary — this is the correct design (SentinelPulse does not duplicate the instrument master).

---

## E. Intelligence Quality

### Not yet measurable — pipeline has not run.

The following metrics require real article throughput and cannot be fabricated:

- Entity accuracy
- Event classification accuracy  
- Sentiment accuracy vs human judgment
- Importance score calibration
- Market-impact direction accuracy

### What the audit confirmed about the algorithms:

**Sentiment:** Lexicon-based, 5 dimensions (market, company, macro, risk, overall), keyword density threshold prevents noise. Model version `sentiment-lexicon-v1.0`. Qualitative signal detection (9 signal types + NEUTRAL fallback). This approach is deterministic and fast but has known limitations: irony, negation patterns, and domain-specific jargon can cause mis-scoring.

**Event detection:** 35+ regex pattern rules covering monetary policy, earnings, M&A, geopolitical, commodity, and crypto events. Quantitative value extraction for surprise calculation. Unclassified fallback for events not matching named rules.

**Importance scoring:** Multi-factor weighted score combining event type weight, source tier reliability, surprise magnitude, actor significance, quantitative value presence, and cross-market relationship count.

**Entity resolution:** Internal dictionary of ~200 company/instrument surface forms plus DataServiceClient lookup. The dictionary is the primary bottleneck — it will miss entities not pre-loaded, and the data-service fuzzy-resolve gap means unrecognised entities stay unresolved.

---

## F. Historical Data

**Article count:** 0 (pipeline not started)  
**Event count:** 0  
**Training samples:** 0  
**Historical reactions:** 0  
**Embeddings:** 0  

Target agreed in Phase 2 spec: 2024-01-01 → current date backfill.  
**This cannot begin until the pipeline is started and source ingestion is verified.**

---

## G. ML Value Assessment

### Not yet determinable.

The ml-service `StockFeatures` schema (27 fields) contains **zero news fields**. There is no `news_impact_score`, `news_sentiment`, `news_velocity`, or any other SentinelPulse-derived feature in the current ML model inputs. The SentinelPulse ML API (`/api/v1/ml/*`) is a read-only data-export API for external consumers — it does not push features into the ml-service.

**The ablation study requested in Phase 2 cannot be run until:**
1. The pipeline ingests articles and builds training samples
2. The ml-service schema is extended with news features
3. A mechanism exists to feed SentinelPulse features into `POST /predict/rankings`

Until these three things exist, the question "does SentinelPulse improve AlphaForge?" cannot be answered. Do not claim it does or does not.

---

## H. AlphaForge Integration

**Current state:** SentinelPulse exposes `GET /api/v1/alphaforge/news-context/:instrument` and four related endpoints. AlphaForge does not call any of them. The integration is wired in documentation only.

**Signal architecture implemented in code:**

```
SentinelPulse (news context API)  →  not yet connected
                                        ↓
AlphaForge reads: data-service + technical + smart money + volume + OI
                                        ↓
                                  ml-service predict
                                        ↓
                               AlphaForge signal decision
```

The architecture in code correctly prevents SentinelPulse from generating BUY/SELL/HOLD — it only provides a `news_impact_score` and supporting evidence bundle. The AlphaForge app would need to call the SentinelPulse API and pass `news_impact_score` as an additional field in its `StockFeatures` payload.

---

## I. Look-Ahead Safety

**CI check result:** PASSED — 0 violations (0 records scanned, empty DB)

**Code review result:** `LookAheadGuard.validate()` is called in `FeatureEngineeringEngine` at lines 235, 242, 249, 512, and 597 — once per external data source used. The guard throws `LookAheadBiasError` on any `recordTimestamp > eventTimestamp` and the worker catches it without persisting the feature vector. This design is correct.

**Unverified:** The look-ahead check has only ever scanned an empty database. It must be re-run after the first backfill completes.

**Known gap — label timestamps:** The `labelCutoff*` fields in `NewsTrainingSample` (e.g. `labelCutoff5m`) are stored correctly in the schema and represent the future timestamp at which the outcome label was determined. The MLDatasetGenerator correctly separates feature timestamps from label timestamps. This design is sound but has not been exercised with real data.

---

## J. Operational Quality

| Metric | Value | Notes |
|---|---|---|
| Build | PASS | `tsc` — zero errors |
| Lint | Exit 0 | `--ext .ts` flag invalid for ESLint v9 (silent pass, no actual lint) |
| Tests total | 464 / 464 | All pass |
| Test coverage (lines) | 25.3% | **Below 80% threshold** — workers and engines uncovered |
| Test coverage (functions) | 50.3% | Below 80% threshold |
| Property tests | 75 / 75 | All pass |
| Integration tests | 48 / 48 | All pass (mocked network) |
| Look-ahead CI | PASSED | 0 violations |
| /health | Not running | Needs stack start |
| /ready | Not running | Will return 503 until DB + Redis confirmed |
| API latency (p95) | Not measured | No traffic yet |

**ESLint note:** The `lint` script uses `eslint src --ext .ts` which is invalid for ESLint v9. The command exits 0 silently without actually linting. This needs to be fixed before CI lint gates are meaningful.

---

## K. Remaining Issues

### BLOCKER

None remaining after this audit's fixes.

The three original blockers are resolved:
1. ✅ Database created and migrated (23 tables, pgvector)
2. ✅ DataServiceClient rewritten to match actual API
3. ✅ Reuters adapter fixed (Google News RSS)

### HIGH

**H-1: Pipeline has never run.** No article has been ingested, normalized, or processed. All engine quality claims are unverified. The Scheduler, workers, and BullMQ consumers have 0% test coverage because they require a live Redis + DB to function. **Start the stack and ingest at least 24 hours of live data before any ML or AlphaForge experiment.**

**H-2: ML integration not implemented.** The ml-service `StockFeatures` and `RegimePredictionRequest` schemas have no news fields. There is no code that sends SentinelPulse features to the ml-service. The ablation study and incremental-value experiment cannot run. This is the most important unresolved work item.

**H-3: Scrapling sidecar not running.** The Scrapling Python microservice (port 8001) is not in the running Docker stack. The `MoneycontrolAdapter` and `EconomicTimesAdapter` health checks depend on it. Moneycontrol falls back gracefully to RSS-only, but the sidecar is required for full-content extraction.

**H-4: Regime signal gap.** `DataServiceClient.getRegimeSignals()` returns `[]` because no such endpoint exists in data-service. The `MarketRegimeEngine` and `FeatureEngineeringEngine` depend on regime context. Regime must come from `POST /predict/regime` on the ml-service. A direct call path needs to be implemented.

**H-5: Embedding API key absent.** `EMBEDDING_API_KEY` is empty in `.env.local`. The `EmbeddingEngine` will fail silently on every article, leaving `news_embeddings` empty. Historical analogue search depends on embeddings. Either configure an OpenAI key or implement a local embedding fallback.

**H-6: Entity dictionary coverage unknown.** The `EntityResolutionEngine` internal dictionary covers ~200 entities. It has not been tested against live Moneycontrol or Economic Times articles. The data-service fuzzy-resolve gap (no `/instruments/resolve?q=` endpoint) means entities not in the local dictionary will remain unresolved.

### MEDIUM

**M-1: ESLint configuration broken.** `npm run lint` uses `--ext .ts` which is invalid for ESLint v9 (exit 0, no linting). Fix the script to `eslint src` or configure `eslint.config.js` properly.

**M-2: Test coverage below threshold.** Coverage is 25% lines, 50% functions against a configured 80% threshold. The threshold failure is suppressed (exit 0). Workers, most engines, and the queue layer have 0% coverage because they need live infrastructure. The threshold should either be lowered to match the unit-testable portions or integration tests should be added.

**M-3: `getMarketContextSnapshot` returns null prices.** The data-service quote endpoint returns all-null price fields because the Angel One and Upstox provider circuits are in `UNKNOWN` state (never successfully connected in this environment). Historical OHLCV works (6 bars returned for test range) but live quotes do not. This is an environment configuration issue, not a code bug.

**M-4: Backfill not checkpointed.** The `BackfillEngine` is implemented but has never run. Its checkpointing, resume, and deduplication guarantees are untested. Start with a narrow date range (one week) before attempting 2024-01-01 → present.

**M-5: `news.google.com` content is article summaries only.** The Google News RSS description field contains only a one-line snippet (~20 words). Full Reuters article content requires a separate fetch of the reuters.com article URL, which is behind a paywall / cookie gate. Sentiment scoring on snippet-length content will be noisy. Consider this a temporary workaround until a proper Reuters API is obtained.

### LOW

**L-1: `DataServiceClient.resolveInstrument()` is shallow.** It only tries three exact ID patterns. A fuzzy scan over the 34,459 instrument records would find more matches but would be too slow for per-article resolution. A local search index over the instrument master (pre-loaded into Redis) would be the correct solution.

**L-2: `getRegimeSignals()` deprecated method.** It returns `[]` with a console warning. Any code that calls it silently gets no regime data. The MarketRegimeEngine should be wired to the ml-service directly.

**L-3: Migration bug fixed but test suite doesn't cover migration.** The incompatible FK (`entity_id TEXT → news_articles.id UUID`) was a schema defect that would have blocked any real deployment. The fix (remove the DB-level FK, enforce at application layer) is correct but the Prisma schema relation was also removed, so any code using `feature.article` via Prisma would fail. No such code was found in the current codebase.

**L-4: `/ready` endpoint will return 503.** Until the SentinelPulse API is started with `SENTINEL_API_KEY` set and the DB + Redis accessible, `/ready` will return 503. This is expected — it is not a bug.

---

## Phase 2 Success Criteria Checklist

| Criterion | Status |
|---|---|
| ✅ Real news sources validated | Done — 4/6 live, 2 disabled (no key) |
| ✅ Reuters replacement found and working | Done — Google News RSS, 100 articles |
| ✅ DataServiceClient matched to real API | Done — all 5 methods verified live |
| ✅ Database created and migrated | Done — 23 tables, pgvector |
| ⏳ Real articles processed | NOT DONE — pipeline not started |
| ⏳ Full lineage verified | NOT DONE — no data |
| ⏳ Entity mapping verified | NOT DONE — no data |
| ⏳ Historical reactions verified | NOT DONE — no data |
| ⏳ Look-ahead leakage = 0 | PASSED on empty DB; needs re-run post-backfill |
| ⏳ Historical backfill completed (2024-01-01 → present) | NOT DONE |
| ⏳ ML dataset generated | NOT DONE |
| ⏳ News-only baseline evaluated | NOT DONE |
| ⏳ News + market model evaluated | NOT DONE |
| ⏳ Ablation study completed | NOT DONE |
| ⏳ AlphaForge integration tested | NOT DONE — ml-service schema has no news fields |
| ⏳ Current-day validation completed | NOT DONE |
| ⏳ Failure recovery tested | NOT DONE |
| ⏳ Stale-data protection verified | NOT DONE |
| ✅ Evidence/report generated | This document |

**The most important question — "Does SentinelPulse provide statistically useful incremental information to AlphaForge?" — cannot be answered yet.** The pre-conditions (working pipeline, populated training dataset, news features in ml-service schema) are not met. This report does not claim the answer is yes or no.

---

## Next Actions (Ordered by Priority)

1. **Start the stack.** Run `npm run dev` (SentinelPulse API) and start all 8 workers. Verify `/health` returns 200 and `/ready` returns 200.

2. **Seed `news_sources`.** Insert rows for reuters, moneycontrol, economic-times (and optionally coindesk) into the `news_sources` table so the Scheduler can register ingestion runs.

3. **Run 24 hours of live ingestion.** Let the Scheduler poll all enabled sources. Verify articles flow through the full pipeline: raw → normalized → dedup → entity → event → sentiment → importance → market-impact → features.

4. **Re-run look-ahead CI check.** `npx tsx tests/ci/look-ahead-check.ts` against the populated DB.

5. **Start Scrapling sidecar.** `docker-compose up scrapling` from the `docker/` directory, or start the Python service standalone.

6. **Add news features to ml-service.** Extend `StockFeatures` with: `news_impact_score`, `news_sentiment_market`, `news_velocity_1h`, `news_velocity_24h`, `news_event_intensity`, `news_data_available` (staleness flag). Update the model retrain pipeline to include these fields.

7. **Run the backfill.** `POST /api/v1/admin/backfill` with `from=2024-01-01` and `to=<today>`. Use a narrow date range first.

8. **Run the ablation study.** Compare ml-service predictions with and without news features over the backfilled historical period.
