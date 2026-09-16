# SentinelPulse — Market Data Certification

**Version:** 1.0.0  
**Date:** 2026-09-16  
**Auditor:** Phase 3B-Preflight automated test + manual inspection  
**data-service version:** 2.0.0  
**data-service URL:** http://localhost:8200  
**Test machine:** macOS, local dev  

---

## 1. Architecture Compliance

SentinelPulse routes ALL market data requests through the data-service.  
No direct calls to Angel One, Upstox, or Yahoo Finance exist in SentinelPulse code.

```
SentinelPulse
  └─ DataServiceClient (src/integrations/data-service/DataServiceClient.ts)
       └─ GET /v1/india/historical   (OHLCV bars)
       └─ GET /v1/india/quotes/{sym} (live quote / snapshot)
       └─ GET /v1/instruments/{id}   (instrument master)
       └─ GET /v1/health/live        (health probe)
            ↓
       data-service v2.0.0 (port 8200)
            ↓ provider waterfall
       Angel One  →  Upstox  →  Yahoo Finance
```

**Compliance:** PASS — no direct provider calls in SentinelPulse.

---

## 2. data-service Health

| Endpoint | Response | Status |
|---|---|---|
| GET /v1/health/live | `{"status":"alive","version":"2.0.0"}` | ✓ HEALTHY |
| GET /v1/health/ready | `{"status":"ready","capabilities":{"redis":true,"postgres":true}}` | ✓ HEALTHY |

---

## 3. Instrument Master Verification

All 8 required instruments were verified to exist in the data-service instrument master.

| Symbol | HTTP | instrumentId | exchange | segment | activeTo |
|---|---|---|---|---|---|
| RELIANCE | 200 | NSE:RELIANCE | NSE | EQ | null (active) |
| TCS | 200 | NSE:TCS | NSE | EQ | null (active) |
| HDFCBANK | 200 | NSE:HDFCBANK | NSE | EQ | null (active) |
| ICICIBANK | 200 | NSE:ICICIBANK | NSE | EQ | null (active) |
| SBIN | 200 | NSE:SBIN | NSE | EQ | null (active) |
| INFY | 200 | NSE:INFY | NSE | EQ | null (active) |
| NIFTY | 200 | NSE:NIFTY | NSE | — | null (active) |
| BANKNIFTY | 200 | NSE:BANKNIFTY | NSE | — | null (active) |

All 8 instruments exist. HTTP 200 confirmed for both bare symbol and `NSE:` prefixed forms.

---

## 4. Historical Daily OHLCV (1d interval)

Test range: 2024-01-02 to 2024-01-12 (8 calendar days, ~6 trading sessions)

| Instrument | Bars returned | Provider | Latency | Status |
|---|---|---|---|---|
| RELIANCE | 8 | angel_one | 68ms | ✓ DATA |
| TCS | 0 | None | 50ms | ✗ NO DATA |
| HDFCBANK | 7 | yahoo_finance | 96ms | ✓ DATA (fallback) |
| ICICIBANK | 0 | None | 50ms | ✗ NO DATA |
| SBIN | 0 | None | 50ms | ✗ NO DATA |
| INFY | 7 | yahoo_finance | 28ms | ✓ DATA (fallback) |
| NIFTY | 0 | None | 50ms | ✗ NO DATA |
| BANKNIFTY | 8 | yahoo_finance | 29ms | ✓ DATA (fallback) |

**Coverage rate: 4/8 instruments (50%) return daily OHLCV.**

---

## 5. Historical Intraday OHLCV (5m, 15m, 1h intervals)

Test ranges tested: Jan 2024, Mar 2024, May 2024, Jun 2024.

| Instrument | 5m | 15m | 1h | 1d | Notes |
|---|---|---|---|---|---|
| RELIANCE | 0 bars | 0 bars | 0 bars | 8 bars (Jan only) | Intraday: no data from any provider |
| TCS | 0 bars | 0 bars | 0 bars | 0 bars | No data at any interval |
| HDFCBANK | 0 bars | 0 bars | 0 bars | 7 bars (Jan only) | Intraday: no data from any provider |
| ICICIBANK | 0 bars | 0 bars | 0 bars | 0 bars | No data at any interval |
| SBIN | 0 bars | 0 bars | 0 bars | 0 bars | No data at any interval |
| INFY | 0 bars | 0 bars | 0 bars | 7 bars (Jan only) | Intraday: no data from any provider |
| NIFTY | 0 bars | 0 bars | 0 bars | 0 bars | No data at any interval |
| BANKNIFTY | 0 bars | 0 bars | 0 bars | 8 bars (Jan only) | Intraday: no data from any provider |

**Intraday OHLCV: 0/8 instruments return any intraday bars at any tested range.**

---

## 6. Provider Fallback Verification

### 6.1 Observed provider assignments

The data-service metadata field `provider` in each response reveals which provider served the data:

| Instrument | Observed provider | Interpretation |
|---|---|---|
| RELIANCE | `angel_one` | Angel One succeeded |
| HDFCBANK | `yahoo_finance` | Angel One failed → Upstox unknown → Yahoo succeeded |
| INFY | `yahoo_finance` | Same waterfall, Yahoo served |
| BANKNIFTY | `yahoo_finance` | Yahoo served |
| TCS, ICICIBANK, SBIN, NIFTY | `null` | All providers returned empty/failed |

### 6.2 Upstox observation

No response was observed with `provider: "upstox"` during this test.  This means either:
- Upstox is configured but unavailable, so the waterfall skipped directly to Yahoo, **or**
- Upstox is not configured for this environment.

The data-service does not expose a provider circuit-breaker status endpoint, so it is not possible to confirm Upstox's circuit state from SentinelPulse.

### 6.3 Fallback behaviour

| Scenario | Expected | Observed | Pass? |
|---|---|---|---|
| Angel One succeeds | Returns data, `provider=angel_one` | ✓ RELIANCE Jan 2024 | ✓ |
| Angel One fails, Yahoo succeeds | Returns data, `provider=yahoo_finance` | ✓ HDFCBANK, INFY, BANKNIFTY | ✓ |
| All providers fail | Returns `{"data":[], "provider":null}` | ✓ TCS, ICICIBANK, SBIN, NIFTY | ✓ |
| Silent empty return on all-fail | Must not throw, must return empty array | ✓ Confirmed via DataServiceClient | ✓ |
| Provider response carries `provider` field | Each response shows which provider | ✓ Visible in metadata | ✓ |

### 6.4 Missing provider metadata in SentinelPulse response

The current `DataServiceClient.getOHLCV()` returns `OHLCVBar[]` only — it does not surface `provider`, `provider_status`, `fallback_used`, `data_available`, or `actual_range` back to the caller. This means SentinelPulse components (HistoricalReactionEngine, FeatureEngineeringEngine) cannot observe which provider served the data or whether a fallback occurred.

**Gap MKT-G1:** Add provider metadata to `OHLCVBar` response so callers can log and audit provider fallback events.

---

## 7. Timestamp and Timezone Audit

### 7.1 Critical field mapping bug

**BUG MKT-BUG-1 (HIGH):** `DataServiceClient.ts` contains a field mapping error.

The `RawHistoricalCandle` interface declares:
```typescript
interface RawHistoricalCandle {
  datetime: string;  // ← assumed ISO-8601 string
  ...
}
```

The actual data-service API returns:
```json
{ "time": 1704167100, ... }  // ← Unix epoch integer (seconds), NOT "datetime"
```

The mapping code:
```typescript
timestamp: new Date(candle.datetime),  // candle.datetime is undefined!
```

`new Date(undefined)` produces `Invalid Date`.  All `OHLCVBar.timestamp` values are `Invalid Date` in the current implementation.

This bug does not surface as a runtime error because:
1. No current code path reads `bar.timestamp` for validation
2. The HistoricalReactionEngine only reads `bar.close` / `bar.volume`
3. The LookAheadGuard validates `asOf` (the parameter) not `bar.timestamp`

However, it means **temporal ordering of bars cannot be verified**, and any future code that uses `bar.timestamp` for look-ahead validation will receive `Invalid Date`, silently bypassing the check.

### 7.2 Unix epoch timezone

The `time` field is Unix epoch seconds (e.g. `1704167100`).

Converting: `1704167100` → `2024-01-02T03:45:00Z` (UTC).

This is 09:15 IST (UTC+5:30), consistent with NSE market open time.  Timestamps are therefore NSE IST market session timestamps, stored as UTC epoch seconds.

### 7.3 Session boundaries

From the observed bar timestamps, the data-service uses NSE session boundaries:
- Market open: 09:15 IST (03:45 UTC)
- Market close: 15:30 IST (10:00 UTC)

---

## 8. Date Range Coverage Analysis

Angel One data appears to have a coverage cutoff around 2024-01-18 for this environment.

| Date range | RELIANCE coverage | Note |
|---|---|---|
| 2024-01-02 to 2024-01-12 | 8 bars | ✓ angel_one |
| 2024-01-12 to 2024-01-19 | 2 bars | ✓ angel_one (partial) |
| 2024-01-15 to 2024-01-22 | 1 bar | ✓ angel_one (last bar) |
| 2024-01-20 to 2024-01-27 | 0 bars | ✗ all providers empty |
| 2024-02-01 to 2024-02-08 | 0 bars | ✗ all providers empty |
| 2024-03-01 to 2024-03-08 | 0 bars | ✗ all providers empty |
| 2024-05-06 to 2024-05-10 | 0 bars | ✗ all providers empty |

**Data availability is limited to approximately 2024-01-02 through 2024-01-18 in this environment.**

This is the root cause of HistoricalReactionEngine returning 0 reactions for Phase 3A events:
- Phase 3A events came from RSS feeds fetched in September 2026
- The articles themselves are current (2026) or historical (2009–2024)
- OHLCV data for most date ranges returns empty
- Provider circuits are in a state where only a limited Jan 2024 window is served

---

## 9. Market Data Requirements for Phase 3B

For the 7-day historical pilot, a date range within the confirmed working window must be used:

**Confirmed working range: 2024-01-02 to 2024-01-18**

Within this range:
- RELIANCE: ✓ angel_one
- HDFCBANK: ✓ yahoo_finance
- INFY: ✓ yahoo_finance
- BANKNIFTY: ✓ yahoo_finance
- TCS, ICICIBANK, SBIN, NIFTY: ✗ no data

**Pilot date range recommendation: 2024-01-08 to 2024-01-14 (7 calendar days, ~5 trading sessions)**

---

## 10. Bug Fix Required Before Phase 3B

### BUG MKT-BUG-1 — DataServiceClient field mapping

**File:** `src/integrations/data-service/DataServiceClient.ts`

**Change required:**

```typescript
// WRONG (current):
interface RawHistoricalCandle {
  datetime: string;
  ...
}
// mapping:
timestamp: new Date(candle.datetime),  // returns Invalid Date

// CORRECT (fix):
interface RawHistoricalCandle {
  time: number;  // Unix epoch seconds
  ...
}
// mapping:
timestamp: new Date(candle.time * 1000),  // epoch seconds → ms
```

This fix is required for LookAheadGuard bar-timestamp validation to work correctly.

---

## 11. Certification Verdict

| Check | Result | Notes |
|---|---|---|
| Architecture: no direct provider calls | ✓ PASS | All calls via DataServiceClient |
| data-service healthy | ✓ PASS | v2.0.0, alive + ready |
| Instrument master: all 8 instruments | ✓ PASS | HTTP 200 for all |
| Historical daily OHLCV (Jan 2024) | **⚠ PARTIAL** | 4/8 instruments, limited date range |
| Intraday OHLCV (5m/15m/1h) | **✗ FAIL** | 0/8 instruments return intraday data |
| Provider fallback observed | ✓ PASS | angel_one → yahoo_finance confirmed |
| Silent empty return on all-fail | ✓ PASS | No exceptions thrown |
| Provider metadata in response | ✓ PASS | `metadata.provider` field present |
| Provider surfaced to SentinelPulse callers | **✗ FAIL** | DataServiceClient drops provider field |
| Timestamp field mapping | **✗ FAIL** | `candle.datetime` undefined; must be `candle.time * 1000` |
| Timezone correctness | ✓ PASS | UTC epoch seconds, NSE 09:15 IST open confirmed |

### Overall: MARKET DATA — CONDITIONALLY BLOCKED

Daily OHLCV for a narrow Jan 2024 window is available for 4 instruments.  
Intraday OHLCV is not available from any provider.  
The timestamp field mapping bug must be fixed before Phase 3B backfill.  
The 7-day pilot MUST use the 2024-01-08 to 2024-01-14 date range.

---

*Generated by Phase 3B-Preflight Audit — 2026-09-16*
