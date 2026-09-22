# SentinelPulse — Phase 3A Implementation Matrix

**Date:** 2026-09-15  
**Auditor:** Kiro (deep code + runtime inspection)  
**Baseline:** PHASE2_VALIDATION_REPORT.md  

Classification key:
- **IMPLEMENTED + VERIFIED** — code exists AND live runtime evidence confirmed
- **IMPLEMENTED + UNVERIFIED** — code exists, correctness not yet proven against live data
- **PARTIAL** — code exists but has a known gap or missing dependency
- **MOCK** — code exists but the real integration is a stub/no-op
- **BROKEN** — code exists but will fail at runtime for a known reason
- **MISSING** — the component does not exist at all

---

## 1. Infrastructure

| Component | Classification | Evidence / Notes |
|---|---|---|
| PostgreSQL (TimescaleDB, port 5444) | IMPLEMENTED + VERIFIED | Running healthy, has `sentinel_pulse` DB with 23 tables + pgvector |
| Redis (port 6379) | IMPLEMENTED + VERIFIED | alpha-forge-redis shared; PING confirmed |
| SentinelPulse Fastify API (port 3001) | IMPLEMENTED + VERIFIED | Runtime certified Phase 3A; `npm run dev` confirmed running on port 3001 |
| Scrapling sidecar (port 8001) | PARTIAL | `docker/scrapling_service.py` exists; Docker image defined; sidecar NOT running |
| data-service (port 8200) | IMPLEMENTED + VERIFIED | Running healthy; 34,459 instruments |
| ml-service (port 8100) | IMPLEMENTED + VERIFIED | Running healthy; 5 models loaded |
| AlphaForge (port 3000) | IMPLEMENTED + VERIFIED | Next.js app running (unhealthy flag is cosmetic); zero SentinelPulse integration |
| docker-compose.yml | PARTIAL | Defines all services correctly but uses port 5432 for its own Postgres; production runs use existing 5444 |

---

## 2. News Adapters

| Component | Classification | Evidence / Notes |
|---|---|---|
| NewsSourceAdapter (base) | IMPLEMENTED + VERIFIED | Interface + RSS parser confirmed in Phase 2 |
| ReutersAdapter (Google News RSS) | IMPLEMENTED + VERIFIED | 100 articles, 803ms, Phase 2 live test |
| MoneycontrolAdapter (RSS) | IMPLEMENTED + VERIFIED | 18 articles, 434ms, Phase 2 live test |
| EconomicTimesAdapter (RSS) | IMPLEMENTED + VERIFIED | 76 articles, 1053ms, Phase 2 live test |
| CoinDeskAdapter (RSS) | IMPLEMENTED + VERIFIED | 25 articles, 1181ms, Phase 2 live test; disabled in `.env.local` |
| BloombergAdapter | MOCK | No API key; gracefully returns `[]` with WARN log |
| FinancialTimesAdapter | MOCK | No API key; gracefully returns `[]` with WARN log |

---

## 3. Ingestion Pipeline

| Component | Classification | Evidence / Notes |
|---|---|---|
| Scheduler | IMPLEMENTED + UNVERIFIED | Complete CB + RL + tier-ordering; no live DB run yet |
| CircuitBreaker | IMPLEMENTED + VERIFIED | 26 unit tests pass |
| RateLimiter | IMPLEMENTED + VERIFIED | 22 unit tests pass |
| news.raw BullMQ queue | IMPLEMENTED + UNVERIFIED | Queue definition correct; Redis connected in Phase 2; never populated |
| `news_sources` table rows | **MISSING** | Table exists (23 tables migrated) but **zero rows seeded** — Scheduler.recordIngestionRun() will fail FK |
| NewsIngestionRun recording | PARTIAL | Code exists but requires `news_sources` rows; blocked by seed gap |

---

## 4. BullMQ Workers (8 total)

| Worker | Queue In | Queue Out | Classification | Evidence / Notes |
|---|---|---|---|---|
| normalize.worker.ts | news.raw | news.normalized | IMPLEMENTED + UNVERIFIED | Code complete; never started |
| dedup.worker.ts | news.normalized | news.deduplicated | IMPLEMENTED + UNVERIFIED | Code complete; never started |
| entity.worker.ts | news.deduplicated | news.entities | IMPLEMENTED + UNVERIFIED | Code complete; never started |
| event.worker.ts | news.entities | news.events | IMPLEMENTED + UNVERIFIED | Code complete; never started |
| sentiment.worker.ts | news.events | news.sentiment | IMPLEMENTED + UNVERIFIED | Code complete; never started |
| impact.worker.ts | news.sentiment | news.impact | IMPLEMENTED + UNVERIFIED | Code complete; never started |
| feature.worker.ts | news.impact | news.features | IMPLEMENTED + UNVERIFIED | Code complete; never started |
| embed.worker.ts | news.features | news.embeddings | **PARTIAL** | Code complete; EMBEDDING_API_KEY is empty — will enqueue retry jobs silently |

---

## 5. Processing Engines

| Engine | Classification | Gap / Notes |
|---|---|---|
| NormalizationEngine | IMPLEMENTED + UNVERIFIED | HTML stripping, language detection, taxonomy classification; no live run |
| DeduplicationEngine | IMPLEMENTED + UNVERIFIED | Content hash + title hash dedup; property tests pass; no DB run |
| EntityResolutionEngine | **PARTIAL** | ~200 entity dictionary (hardcoded); resolveInstrument() tries only 3 exact ID forms; 34,459 data-service instruments are unreachable without local index |
| EventDetectionEngine | IMPLEMENTED + UNVERIFIED | 35+ regex rules; no live run |
| SentimentEngine | IMPLEMENTED + UNVERIFIED | Lexicon-based, 5 dimensions; 12 unit tests pass; no live run |
| ImportanceEngine | IMPLEMENTED + UNVERIFIED | Multi-factor weighted; 20 unit tests pass; no live run |
| MarketImpactEngine | IMPLEMENTED + UNVERIFIED | Direction × strength calculation; no live run |
| HistoricalReactionEngine | IMPLEMENTED + UNVERIFIED | OHLCV-based reaction measurement; 18 tests pass; no live run |
| FeatureEngineeringEngine | IMPLEMENTED + UNVERIFIED | 7-group feature vector; LookAheadGuard integrated; no live run |
| MLDatasetGenerator | IMPLEMENTED + UNVERIFIED | Training sample assembly; no live run |
| EmbeddingEngine | **PARTIAL** | Code correct; EMBEDDING_API_KEY missing → every call enqueues retry; embeddings will be 0 |
| VelocityEngine | IMPLEMENTED + UNVERIFIED | No live run |
| BreadthEngine | IMPLEMENTED + UNVERIFIED | No live run |
| CrossMarketEngine | IMPLEMENTED + UNVERIFIED | No live run |
| MarketRegimeEngine | **BROKEN** | `getRegimeSignals()` always returns `[]` → engine always classifies SIDEWAYS/0.5; feature vectors will carry a fabricated silent regime |
| HistoricalAnalogueEngine | IMPLEMENTED + UNVERIFIED | Requires embeddings (none); will return empty analogues |
| BackfillEngine | IMPLEMENTED + UNVERIFIED | Never run; checkpointing untested |
| LookAheadGuard | IMPLEMENTED + VERIFIED | CI check: 0 violations on empty DB |
| AlertEngine | IMPLEMENTED + UNVERIFIED | No live run |
| RetentionEngine | IMPLEMENTED + UNVERIFIED | No live run |

---

## 6. Integrations

| Integration | Classification | Gap / Notes |
|---|---|---|
| DataServiceClient | IMPLEMENTED + VERIFIED | Real API paths; X-API-Key auth; 5 methods verified live in Phase 2 |
| `getRegimeSignals()` | **BROKEN** | Returns `[]` with console.warn; data-service has no regime endpoint; must call ml-service |
| MlServiceClient | **MISSING** | No HTTP client exists for ml-service. MarketRegimeEngine and FeatureEngineeringEngine cannot call `POST /predict/regime` |
| ScraplingClient | IMPLEMENTED + UNVERIFIED | Client code correct; sidecar not running |
| Scrapling sidecar | **MISSING (runtime)** | Not started; Moneycontrol + ET full-content extraction unavailable |

---

## 7. API Routes

| Route Group | Classification | Notes |
|---|---|---|
| GET /health | IMPLEMENTED + UNVERIFIED | Returns 200 on process alive (not yet started) |
| GET /ready | IMPLEMENTED + UNVERIFIED | Probes Postgres + Redis + tier-1 source |
| GET /metrics | IMPLEMENTED + UNVERIFIED | Prometheus scrape endpoint |
| GET /api/v1/admin/sources | IMPLEMENTED + UNVERIFIED | Correct DB query; DB empty |
| GET /api/v1/admin/ingestion | IMPLEMENTED + UNVERIFIED | Correct DB query; DB empty |
| GET /api/v1/admin/queues | **MOCK** | Returns structural stubs; BullMQ not connected to HTTP handler |
| GET /api/v1/admin/data-quality | IMPLEMENTED + UNVERIFIED | Correct DB query; DB empty |
| POST /api/v1/admin/test/pipeline | **MISSING** | Phase 3A requirement; not yet built |
| GET /api/v1/admin/lineage/:articleId | **MISSING** | Phase 3A requirement; not yet built |
| GET /api/v1/news/* | IMPLEMENTED + UNVERIFIED | Read routes only; DB empty |
| GET /api/v1/alphaforge/news-context/:instrument | IMPLEMENTED + UNVERIFIED | Complete bundle assembly; DB empty → will return 404 |
| GET /api/v1/alphaforge/context/* | IMPLEMENTED + UNVERIFIED | DB empty |
| GET /api/v1/alphaforge/high-impact-events | IMPLEMENTED + UNVERIFIED | DB empty |
| GET /api/v1/ml/features/* | IMPLEMENTED + UNVERIFIED | DB empty |
| GET /api/v1/ml/training/events | IMPLEMENTED + UNVERIFIED | DB empty |
| GET /api/v1/ml/training/samples | IMPLEMENTED + UNVERIFIED | DB empty |
| GET /api/v1/ml/historical-reactions | IMPLEMENTED + UNVERIFIED | DB empty |
| GET /api/v1/ml/training/samples/:id/lineage | IMPLEMENTED + UNVERIFIED | DB empty |

---

## 8. Data Quality & Safety

| Feature | Classification | Gap / Notes |
|---|---|---|
| LookAheadGuard (code) | IMPLEMENTED + VERIFIED | 5 call sites in FeatureEngineeringEngine; throws LookAheadBiasError on violation |
| LookAheadGuard (DB validation) | IMPLEMENTED + UNVERIFIED | CI check passed on empty DB; must re-run with real data |
| content_depth field | **MISSING** | No `content_depth` (FULL_ARTICLE / SUMMARY / HEADLINE_ONLY) in schema or normalization; Reuters RSS is summary-only but treated identically to full articles |
| content_quality_score | **MISSING** | Not in schema or engine |
| source_confidence calculation | **PARTIAL** | `sourceReliability` field exists in `news_sources` but is not incorporated into sentiment/importance scoring; no multi-source confirmation weighting |
| Staleness protection (FRESH/STALE/EXPIRED/UNAVAILABLE) | **MISSING** | No `feature_timestamp`, `data_as_of`, `freshness_seconds`, `data_available` fields on feature output |
| Embedding status tracking | **PARTIAL** | EmbeddingEngine enqueues retries on failure; no explicit `embedding_available` / `embedding_status` flag exposed |

---

## 9. ML & AlphaForge Integration

| Feature | Classification | Gap / Notes |
|---|---|---|
| ml-service StockFeatures news fields | **MISSING** | 27 fields, all technical; 0 news fields |
| SentinelPulse → ml-service push mechanism | **MISSING** | No code sends features to ml-service |
| AlphaForge → SentinelPulse API calls | **MISSING** | AlphaForge (Next.js) has zero calls to SentinelPulse endpoints |
| SENTINELPULSE_ML_FEATURE_CONTRACT.md | **MISSING** | Phase 3A deliverable |
| ALPHAFORGE_SENTINELPULSE_CONTRACT.md | **MISSING** | Phase 3A deliverable |
| ML dataset (training samples) | MISSING (data) | 0 training samples; pipeline never run |
| Ablation study | **MISSING** | Pre-conditions not met |

---

## 10. Instrument Index (Entity Resolution)

| Feature | Classification | Gap / Notes |
|---|---|---|
| Entity dictionary (~200 entries) | IMPLEMENTED + VERIFIED | Present in EntityResolutionEngine; Nifty indices + major Indian companies + commodities + currencies + institutions |
| data-service instrument index | **MISSING** | No local projection of 34,459 instruments; resolveInstrument() cannot find non-dict entities |
| Alias / fuzzy matching | **PARTIAL** | n-gram scanning against dict only; no fuzzy match against instrument master |
| Instrument sync cron | **MISSING** | No mechanism to pull new instruments from data-service into a local searchable index |

---

## 11. Phase 3A Specific Gaps (Summary)

| # | Gap | Severity | Action Required |
|---|---|---|---|
| G-1 | `news_sources` table is empty | **BLOCKER** | Seed Reuters, Moneycontrol, Economic Times, CoinDesk rows |
| G-2 | SentinelPulse API never started | BLOCKER | `npm run dev` + start all 8 workers |
| G-3 | Scrapling sidecar not running | HIGH | Start Python sidecar (`uvicorn scrapling_service:app`) |
| G-4 | MarketRegimeEngine silently uses SIDEWAYS | HIGH | Implement MlServiceClient + wire `POST /predict/regime` |
| G-5 | content_depth field missing | HIGH | Add FULL_ARTICLE / SUMMARY / HEADLINE_ONLY to normalization |
| G-6 | Staleness protection missing | HIGH | Add feature_timestamp, data_as_of, freshness states |
| G-7 | Embedding non-blocking not guaranteed | MEDIUM | Add embedding_available / embedding_status flags explicitly |
| G-8 | source_confidence not multi-factor | MEDIUM | Incorporate content_depth + source_diversity into confidence calc |
| G-9 | Entity instrument index missing | MEDIUM | Build Redis/memory projection from data-service instrument master |
| G-10 | ESLint v9 not actually linting | MEDIUM | Replace .eslintrc.json with eslint.config.js (flat config) |
| G-11 | POST /api/v1/admin/test/pipeline missing | MEDIUM | Build controlled pipeline smoke test endpoint |
| G-12 | GET /api/v1/admin/lineage/:articleId missing | MEDIUM | Build full lineage trace endpoint |
| G-13 | MlServiceClient missing | MEDIUM | Create HTTP client for ml-service regime endpoint |
| G-14 | AlphaForge makes no SP calls | LOW (Phase 3A scope) | Document in contract; integration is Phase 3B |
| G-15 | ML feature contract not documented | LOW (Phase 3A scope) | Write SENTINELPULSE_ML_FEATURE_CONTRACT.md |

---

*Generated by Phase 3A audit — 2026-09-15*
