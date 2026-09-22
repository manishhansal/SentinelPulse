# SentinelPulse — 60-Minute Runtime Certification

**Version:** 1.1.0 (Phase 3B.2)  
**Date:** 2026-09-18  
**Status:** PRECONDITIONS MET — ready to execute  
**Test framework:** `src/scripts/runtime-60min-test.ts`  

---

## Status

A genuine 60-minute runtime test has NOT been completed as of Phase 3B.2.

However, **all preconditions that were blocking the test are now met.** The test can be scheduled immediately once the data-service Docker image is rebuilt with the Phase 3B.2 fixes committed (see Outstanding Items in `PHASE3B2_CERTIFICATION_REPORT.md §14`).

---

## Preconditions

| Precondition | Phase 3B.1 | Phase 3B.2 | Status |
|---|---|---|---|
| LookAheadGuard redesigned (`information_as_of`) | ✓ DONE | — | ✅ MET |
| DataServiceClient timestamp fix (`candle.time * 1000`) | ✓ DONE | — | ✅ MET |
| HistoricalReactionEngine interval fix (RXN-G1) | ✓ DONE | — | ✅ MET |
| Provider metadata surfaced (`OHLCVResponse` envelope) | ✓ DONE | — | ✅ MET |
| Angel One OHLCV operational (EQ, all intervals) | ✓ DONE | — | ✅ MET |
| Upstox OHLCV operational (IDX + EQ, all intervals) | ✗ Blocked (RC-1, RC-3) | ✓ FIXED | ✅ MET |
| Historical backfill not blocked by Redis checkpoint | ✗ Blocked (RC-2) | ✓ FIXED | ✅ MET |
| Training sample idempotency | ✗ Open | ✓ FIXED | ✅ MET |
| All unit tests passing | 578/578 | 578/578 | ✅ MET |
| data-service Docker image rebuilt with all fixes | — | ⚠️ NOT DONE | ⏳ PENDING |
| Server + 8 workers running for 60 min | — | — | ⏳ PENDING |
| Pilot news ingestion (2024-01-08 to 2024-01-14) | — | — | ⏳ PENDING |

---

## How to Execute

```bash
# 1. Start all services
npm run dev    # or: docker-compose up

# 2. Wait for server to be healthy
curl http://localhost:3001/api/v1/health

# 3. Run the 60-minute test (MUST run for full 60 minutes)
npx tsx src/scripts/runtime-60min-test.ts
```

The script captures snapshots every 5 minutes and produces:
- `RUNTIME_60MIN_CERTIFICATION.md` (this file, overwritten with real results)
- `raw-60min-snapshots.json` (full JSON data)

---

## Expected Snapshot Table (Template)

When the test is run, this table will be populated:

| T+ | Articles | Events | Reactions | QueueDepth | DLQ | Crashes | API | Notes |
|---|---|---|---|---|---|---|---|---|
| T+0m | — | — | — | — | — | — | — | Test start |
| T+5m | — | — | — | — | — | — | — | |
| T+10m | — | — | — | — | — | — | — | |
| T+15m | — | — | — | — | — | — | — | |
| T+20m | — | — | — | — | — | — | — | Worker restart |
| T+25m | — | — | — | — | — | — | — | Post-restart check |
| T+30m | — | — | — | — | — | — | — | |
| T+35m | — | — | — | — | — | — | — | Redis pause (manual) |
| T+40m | — | — | — | — | — | — | — | Post-Redis check |
| T+45m | — | — | — | — | — | — | — | Source disable |
| T+50m | — | — | — | — | — | — | — | |
| T+55m | — | — | — | — | — | — | — | |
| T+60m | — | — | — | — | — | — | — | Test end |

---

## Pass Criteria (Must all be satisfied)

- [ ] All 13 snapshots (T+0 to T+60) actually captured
- [ ] Articles fetched is monotonically non-decreasing
- [ ] No worker crashes in final 40 minutes after restart
- [ ] Redis error count 0 after pause recovery
- [ ] Disabled source articles = 0 after T+45m; others continue
- [ ] Provider error rate < 50% at any snapshot
- [ ] DLQ count = 0 throughout (or explained)
- [ ] API reachable in ≥ 12/13 snapshots

---

## Reliability Tests

### Test 1: Worker Restart (T+20m)
- Trigger: `pkill -f "run-worker"; npm run worker &`
- Recovery criterion: article count at T+25m >= article count at T+15m
- Result: **NOT RUN**

### Test 2: Redis Pause (T+35m)
- Trigger: manual `redis-cli PAUSE 60000` or equivalent
- Recovery criterion: queue processes normally within 2 minutes
- Result: **SKIPPED** (requires manual intervention; do not automate in CI)

### Test 3: Source Disable (T+45m)
- Trigger: `PATCH /api/v1/admin/sources/coindesk { enabled: false }`
- Recovery criterion: other sources continue fetching at T+50m, T+55m
- Result: **NOT RUN**

---

## Final Verdict

**PRECONDITIONS MET — NOT YET EXECUTED**

All code-level preconditions are satisfied as of Phase 3B.2.  
Two operational steps remain before the test can run:

1. Rebuild the data-service Docker image with the Phase 3B.2 fixes committed (currently applied via `docker cp` only — a container restart would revert them).
2. Run Jan 2024 news ingestion to populate `news_events` for the pilot window.

Once both are done, execute:
```bash
npx tsx src/scripts/runtime-60min-test.ts
```
This file will be overwritten with real results when the test completes.

---

## Phase 3B.2 Precondition Evidence

All code-level preconditions verified in `PHASE3B2_CERTIFICATION_REPORT.md`:

| Check | Evidence |
|---|---|
| Angel One data (all intervals) | 375 bars × 5 sessions × 8 instruments (Windows A–D) |
| Upstox data (IDX, all intervals) | 150/375 bars confirmed post RC-1+RC-3 fix |
| Backfill not checkpoint-blocked | TCS/HDFCBANK/ICICIBANK/INFY all returned 375 bars for Jan 2024 after `force=True` |
| Provider waterfall 5/5 PASS | Tests A–E: angel_one / upstox / yahoo_finance / null all observed |
| OHLCVResponse contract 15/15 PASS | All envelope fields present and typed correctly |
| Timestamp semantics 10/10 PASS | Monotonic, no duplicates, epoch seconds, IST session start |
| Training idempotency 8/8 PASS | `uq_training_sample_identity` constraint + upsert verified |
| PIT SQL 6/6 PASS | All violation queries returned 0 (vacuously — no samples yet) |
| Unit tests | 578/578 passing |

---

*Updated: Phase 3B.2 — 2026-09-18*  
*This file will be overwritten with real snapshot results when the test executes.*
