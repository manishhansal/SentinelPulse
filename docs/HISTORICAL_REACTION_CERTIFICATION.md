# SentinelPulse — Historical Reaction Certification

**Version:** 1.0.0  
**Date:** 2026-09-16  
**Auditor:** Phase 3B-Preflight  
**Test window:** 7 calendar days, 2024-01-08 to 2024-01-14  
**Instruments in scope:** RELIANCE, HDFCBANK, INFY, BANKNIFTY  

---

## 1. Methodology

The HistoricalReactionEngine measures actual post-event price reactions by querying
the data-service at 9 fixed time offsets relative to each event's `event_timestamp`:

| Offset | Label | Purpose |
|---|---|---|
| T−15m | minus15m | Pre-event context |
| T−5m | minus5m | Baseline price (denominator for all returns) |
| T+1m | plus1m | Immediate reaction |
| T+5m | plus5m | Short-term (label horizon) |
| T+15m | plus15m | Short-term (label horizon) |
| T+30m | plus30m | Medium-term (label horizon) |
| T+1h | plus1h | 1-hour (label horizon) |
| T+4h | plus4h | Half-day reaction |
| T+1d | plus1d | Daily return (label horizon) |

Return formula (Req 12.2):

```
return_Xm = (close_at_offset − close_at_baseline) / close_at_baseline × 100
```

Baseline = close of the bar covering T−5m.

---

## 2. Pilot Date Range Selection

The MARKET_DATA_CERTIFICATION.md established that OHLCV data is available only in a
narrow Jan 2024 window.  After systematic testing:

| Date range | RELIANCE data | Rationale |
|---|---|---|
| 2024-01-02 to 2024-01-18 | ✓ 8+ bars | Confirmed working range |
| 2024-01-19 onward | ✗ empty | All providers return no data |

**Selected pilot window: 2024-01-08 (Mon) to 2024-01-14 (Sun) — 7 calendar days, 5 trading sessions.**

NSE trading sessions in this window:
- 2024-01-08 (Mon): NSE open
- 2024-01-09 (Tue): NSE open
- 2024-01-10 (Wed): NSE open
- 2024-01-11 (Thu): NSE open
- 2024-01-12 (Fri): NSE open
- 2024-01-13 (Sat): NSE closed
- 2024-01-14 (Sun): NSE closed

---

## 3. Reaction Engine Code Audit

### 3.1 Temporal correctness

The HistoricalReactionEngine (`src/engines/historical-reaction/HistoricalReactionEngine.ts`)
passes `asOf = offsetTime` to every `dataServiceClient.getOHLCV()` call:

```typescript
const bars = await this.dataServiceClient.getOHLCV({
  assetId,
  from,
  to,
  asOf: offsetTime,   // ← correct: caps data to the offset timestamp
});
```

This correctly prevents look-ahead bias in OHLCV fetches: a query for T+5m only returns
bars with timestamps ≤ T+5m.

**Temporal correctness: PASS**

### 3.2 Reaction timestamp ordering validation

For every generated reaction record, the following must hold:

```
event_timestamp   < reaction_timestamp (each offset)
reaction_timestamp <= label_cutoff (matching horizon)
```

For offset T+5m with event at 2024-01-08T10:00:00Z:
- reaction_timestamp = 2024-01-08T10:05:00Z  → > event ✓
- label_cutoff_5m    = 2024-01-08T10:05:00Z  → ≥ reaction ✓

This ordering is enforced structurally — all offset timestamps are calculated as
`eventTimestamp + N × 60_000ms` which is always > eventTimestamp.

### 3.3 Null/missing data handling (Req 12.3)

When a bar is unavailable:
- `marketClosed = true`, all return fields = null
- NO interpolation, NO adjacent-bar substitution
- `dataServiceTimeout = true` when any offset fetch times out (Req 12.4)
- `high_impact_flag = false` when return_15m is null

**Null handling: PASS (code review)**

---

## 4. Measured Reaction Results

### 4.1 Phase 3A runtime (12-minute window)

From PHASE3A_PIPELINE_METRICS.md:

| Metric | Value |
|---|---|
| Events processed | 159 |
| Events with asset links | 12 (7.5%) |
| Historical reactions generated | **0** |
| dataServiceTimeout | true for all |
| marketOpen | false for all |

**Cause of 0 reactions:** The data-service OHLCV providers were in an UNKNOWN/disconnected
state for all assets during the Phase 3A run.  Angel One and Upstox circuits had never
successfully connected, and Yahoo Finance fallback was not resolving for those specific
event timestamps (September 2026 / January 2024 events with wrong symbol formats).

### 4.2 Root causes of 0 reactions

Three compounding issues:

| Issue | Root Cause | Fix |
|---|---|---|
| RC-1 | Intraday OHLCV returns empty for all instruments | Angel One + Upstox intraday not available; Yahoo intraday not working |
| RC-2 | Daily OHLCV available for only 4/8 instruments in Jan 2024 | Partial provider coverage |
| RC-3 | HistoricalReactionEngine queries 1-minute bars for all offsets | Even 1d reactions use `interval=1d` in default DataServiceClient call — but 1-min intraday fails for all dates beyond Jan 18 |

### 4.3 Projected pilot window reactions (2024-01-08 to 2024-01-14)

Based on MARKET_DATA_CERTIFICATION.md findings:

| Instrument | 1d data available | Intraday (5m/15m/1h) available |
|---|---|---|
| RELIANCE | ✓ angel_one | ✗ empty |
| HDFCBANK | ✓ yahoo_finance | ✗ empty |
| INFY | ✓ yahoo_finance | ✗ empty |
| BANKNIFTY | ✓ yahoo_finance | ✗ empty |
| TCS, ICICIBANK, SBIN, NIFTY | ✗ empty | ✗ empty |

**Projected reaction outcome for pilot:**
- return_1d: potentially non-null for RELIANCE, HDFCBANK, INFY, BANKNIFTY
- return_5m, return_15m, return_30m, return_1h: null for all instruments (intraday unavailable)
- Training samples with label_5m/15m/30m/1h: 0 (labels require intraday data)
- Training samples with label_1d only: potentially non-zero

---

## 5. HistoricalReactionEngine Interval Bug

The HistoricalReactionEngine queries a 1-minute window for each offset:

```typescript
const from = new Date(offsetTime.getTime() - BAR_WINDOW_MS); // 1 minute window
const to = offsetTime;
// interval defaults to "1d" in DataServiceClient.getOHLCV()
```

**Issue:** The DataServiceClient default interval is `1d`. When querying a 1-minute
window with a 1d interval, the data-service returns at most 1 daily bar.  For
intraday offsets (T+5m, T+15m, T+30m, T+1h), requesting a 1-minute window with a
1-day interval is semantically incorrect — it returns the daily bar that contains the
offset, not the 5-minute or 15-minute bar at that exact time.

**Gap RXN-G1:** HistoricalReactionEngine should pass `interval: '5m'` or `'1m'` for
intraday offsets and `interval: '1d'` only for the T+1d offset.  This is masked
currently because intraday data is unavailable anyway, but must be fixed before
any intraday provider data becomes available.

---

## 6. Timestamp Ordering Validation Queries

These SQL queries must return 0 rows for reactions to be considered valid:

```sql
-- Q1: Reaction record computed before event (must be 0)
SELECT count(*)
FROM news_market_reactions nmr
JOIN news_events ne ON nmr.event_id = ne.id
WHERE nmr.computed_at <= ne.event_timestamp
AND (nmr.return_5m IS NOT NULL OR nmr.return_1d IS NOT NULL);

-- Q2: Event timestamp after reaction asset link (sanity check)
SELECT count(*)
FROM news_market_reactions nmr
JOIN news_events ne ON nmr.event_id = ne.id
WHERE ne.event_timestamp IS NULL;

-- Q3: Any non-null return with market_open = false (inconsistency)
-- market_open=false should always imply all returns are null
SELECT count(*)
FROM news_market_reactions
WHERE market_open = false
AND (return_5m IS NOT NULL OR return_15m IS NOT NULL
     OR return_30m IS NOT NULL OR return_1h IS NOT NULL OR return_1d IS NOT NULL);
```

Expected result: all queries return 0.  These cannot be run until reactions are populated.

---

## 7. Reaction Coverage Gate

The Phase 3B requirement states: do not proceed to large backfill unless the pilot
has meaningful reaction coverage.

| Metric | Target | Measured (Phase 3A) | Measured (Pilot — projected) |
|---|---|---|---|
| Events with asset links | >20% | 12/159 = 7.5% | TBD |
| Reactions generated (non-zero count) | >0 | 0 | TBD (depends on pilot execution) |
| return_5m non-null rate | >10% | 0% | ~0% (no intraday data) |
| return_1d non-null rate | >10% | 0% | ~15–30% (4 instruments have 1d data) |
| missing_market_data_rate | <80% | 100% | ~70–80% (most instruments missing) |

---

## 8. Certification Verdict

| Check | Result | Notes |
|---|---|---|
| Engine temporal correctness | ✓ PASS | asOf = offsetTime correctly prevents look-ahead |
| Null handling (no interpolation) | ✓ PASS | Confirmed in code review |
| Reaction timestamp > event timestamp | ✓ PASS | Structural guarantee |
| Phase 3A historical reactions | **✗ FAIL** | 0 reactions — no OHLCV data available |
| Intraday OHLCV availability | **✗ FAIL** | 0/8 instruments return intraday bars |
| Daily OHLCV availability | **⚠ PARTIAL** | 4/8 instruments, Jan 2024 window only |
| Interval bug (intraday offsets use 1d) | **✗ FAIL** | Must be fixed before intraday data available |
| Timestamp field mapping bug fixed | ✓ FIXED | MKT-BUG-1 resolved in DataServiceClient |
| 7-day pilot range selected | ✓ DONE | 2024-01-08 to 2024-01-14 |

### Overall: HISTORICAL REACTIONS — NOT CERTIFIABLE YET

The engine code is correct but historical reactions cannot be generated until:
1. Intraday OHLCV data becomes available through data-service providers (RC-1)
2. The intraday interval bug (RXN-G1) is fixed
3. The pilot is actually executed against the 2024-01-08 window

At best, with current data availability, only `return_1d` labels can be generated
for 4 instruments (RELIANCE, HDFCBANK, INFY, BANKNIFTY) in the Jan 2024 window.
This is insufficient for a complete ML training dataset but may be sufficient for
a proof-of-concept reaction check.

---

*Generated by Phase 3B-Preflight Audit — 2026-09-16*
