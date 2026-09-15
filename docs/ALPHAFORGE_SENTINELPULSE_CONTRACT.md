# AlphaForge ↔ SentinelPulse Integration Contract

**Version:** 1.0.0  
**Date:** 2026-09-15  
**Status:** DOCUMENTED — integration not yet connected  
**Authors:** Phase 3A Runtime Certification Audit

> **IMPORTANT:** SentinelPulse does not generate BUY/SELL/HOLD signals. It provides a `news_impact_score` and supporting evidence bundle as an input factor to the AlphaForge multi-factor model. SentinelPulse does not claim to improve AlphaForge accuracy — that question is Phase 3B.

---

## 1. Current Integration State

```
CURRENT STATE (Phase 3A):

AlphaForge (Next.js app, port 3000)
  ↓ reads from
data-service + technical indicators + smart money + volume + OI
  ↓ sends to
ml-service POST /predict/rankings (StockFeatures — 27 fields, 0 news)
  ↓
AlphaForge signal decision

SentinelPulse (Fastify API, port 3001)
  → Exposes: GET /api/v1/alphaforge/news-context/{instrument}
  → AlphaForge does NOT currently call this endpoint
  → ml-service StockFeatures has NO news fields

STATUS: DOCUMENTED, NOT CONNECTED
```

---

## 2. Target Integration Architecture (Phase 3B)

```
TARGET STATE (Phase 3B):

AlphaForge signal generation
  ↓ at each prediction cycle
  1. Call SentinelPulse:
     GET /api/v1/alphaforge/news-context/{instrument}
  2. Receive news_context bundle (see section 4)
  3. Check news_data_available — if false, skip news features
  4. Check freshness_state — if EXPIRED, skip news features
  5. Append 6 news fields to StockFeatures payload
  6. Call ml-service POST /predict/rankings with extended StockFeatures
  7. ml-service returns ranking with news context incorporated
  ↓
AlphaForge signal decision
```

---

## 3. SentinelPulse → AlphaForge Interface

### 3.1 Endpoint

```
GET /api/v1/alphaforge/news-context/{instrument}

Auth: Authorization: Bearer {SENTINEL_API_KEY}
Rate limit: 300 RPM per API key
Cache TTL: 30 seconds (Redis key: news:signal:{instrument})
```

### 3.2 Request

| Parameter | Type | Description |
|---|---|---|
| `instrument` | string (path) | Instrument ID in upper-case (e.g. `RELIANCE`, `NSE:HDFCBANK`) |

### 3.3 Response Shape

```json
{
  "success": true,
  "data": {
    "instrument": "RELIANCE",
    "news_impact_score": 0.23,
    "sentiment_summary": {
      "market": 0.18,
      "company": 0.31,
      "macro": -0.05,
      "risk": -0.12,
      "overall": 0.17,
      "direction": "positive"
    },
    "velocity_metrics": {
      "articles_1h": 3,
      "articles_24h": 14
    },
    "regime_context": {
      "regime": "TRENDING_BULL",
      "confidence": 0.72,
      "validFrom": "2026-09-15T12:00:00Z"
    },
    "top_contributing_events": [...],
    "active_cross_market_signals": [...],
    "explainability": {
      "disclaimer": "news_impact_score is an input factor to the AlphaForge multi-factor model (News + Technical + Smart Money + Volume + Open Interest + Market Regime + Macro → ML Probability → Final Signal). SentinelPulse does not generate autonomous trading signals."
    },
    "computed_at": "2026-09-15T18:09:00Z"
  },
  "meta": {
    "timestamp": "2026-09-15T18:09:00Z",
    "cached": false
  }
}
```

### 3.4 Fields Used by AlphaForge

| Field | Maps to StockFeatures | Notes |
|---|---|---|
| `news_impact_score` | `news_impact_score` | Primary signal; range [-1, +1] after normalization |
| `sentiment_summary.market` | `news_sentiment_market` | Market tone |
| `velocity_metrics.articles_1h` | `news_velocity_1h` | News volume |
| `velocity_metrics.articles_24h` | `news_velocity_24h` | News volume 24h |
| (derived from `top_contributing_events`) | `news_event_intensity` | Max importance in window |
| (derived from data availability) | `news_data_available` | Sentinel flag |

### 3.5 Error Handling

| HTTP Status | Meaning | AlphaForge action |
|---|---|---|
| 200 | News context available | Use news features normally |
| 404 | No news data for instrument | Set `news_data_available = false` |
| 503 | SentinelPulse unavailable | Set `news_data_available = false`; proceed without news |
| 429 | Rate limit exceeded | Backoff 1s; retry once; then `news_data_available = false` |

**SentinelPulse unavailability must never block AlphaForge signal generation.**

---

## 4. AlphaForge → ml-service Interface (Extended)

### 4.1 Current StockFeatures (27 fields — technical only)

```
symbol, relative_volume, atr_expansion, momentum_5d, momentum_10d,
vwap_distance_pct, ema_stack_score, rsi_14, macd_histogram, adx_14,
delivery_pct, sector_momentum, relative_strength_vs_nifty, options_oi_score,
pcr, iv_rank, market_breadth, volume_profile_score, gap_pct,
bollinger_position, atr_pct, obv_trend, stoch_rsi, williams_r, cci, mfi, cmf
```

### 4.2 Phase 3B Extended StockFeatures (27 + 8 = 35 fields)

```python
# New fields to add (defined in SENTINELPULSE_ML_FEATURE_CONTRACT.md):
news_impact_score: float = 0.0
news_sentiment_market: float = 0.0
news_velocity_1h: int = 0
news_velocity_24h: int = 0
news_event_intensity: float = 0.0
news_data_available: bool = False
news_feature_as_of: Optional[datetime] = None
news_freshness_state: str = "UNAVAILABLE"
```

### 4.3 ml-service /predict/rankings (unchanged endpoint)

No changes to the endpoint contract. Only the payload schema is extended. The ml-service model must be retrained on historical data with news features (Phase 3B).

---

## 5. Data Flow Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                      PHASE 3B TARGET FLOW                        │
│                                                                  │
│  RSS Feeds → Scheduler → news.raw                               │
│                            ↓ (8 BullMQ workers)                 │
│  normalize → dedup → entity → event → sentiment → importance    │
│                                          → market_impact         │
│                                          → features              │
│                            ↓                                     │
│  SentinelPulse DB (news_articles, news_events, news_features...) │
│                            ↓                                     │
│  GET /api/v1/alphaforge/news-context/{instrument}               │
│                            ↓ (cached 30s)                        │
│  AlphaForge Signal Engine                                        │
│    + data-service (prices, OI, FII/DII)                         │
│    + news_context bundle (from SentinelPulse)                   │
│    ↓                                                             │
│  ml-service POST /predict/rankings (StockFeatures + news)       │
│    ↓                                                             │
│  AlphaForge Signal Decision (BUY/SELL/HOLD + confidence)        │
│                                                                  │
│  SentinelPulse: NEVER generates BUY/SELL/HOLD                   │
└──────────────────────────────────────────────────────────────────┘
```

---

## 6. Integration Readiness Checklist

| Item | Phase 3A Status | Required for Phase 3B |
|---|---|---|
| SentinelPulse API running | ✓ Port 3001 | ✓ |
| news-context endpoint implemented | ✓ Full bundle | ✓ |
| news_impact_score calculation | ✓ Rule-based | ✓ |
| Freshness metadata on all features | ✓ DataFreshness.ts | ✓ |
| Look-ahead guard operational | ✓ 0 violations | ✓ |
| AlphaForge calls SentinelPulse | ✗ Not connected | Required |
| ml-service StockFeatures extended | ✗ 0 news fields | Required |
| ml-service retrained with news features | ✗ No training data | Required |
| Ablation study completed | ✗ Phase 3B | Required |
| Production backtest validated | ✗ Phase 3B | Required |

---

## 7. Explicit Constraints

1. **SentinelPulse must never be in the critical path of AlphaForge.** If SentinelPulse is down, AlphaForge continues with `news_data_available = false`.

2. **No BUY/SELL/HOLD from SentinelPulse.** The `explainability.disclaimer` field in every response enforces this at the API level.

3. **Stale or expired news must not silently influence signals.** `news_freshness_state = EXPIRED` → AlphaForge must set `news_data_available = false`.

4. **No direct DB access.** AlphaForge reads only via the SentinelPulse REST API. No direct PostgreSQL access to the `sentinel_pulse` database from AlphaForge.

5. **Feature version pinning.** The ml-service model version must be trained on features from the same `feature_version` contract. Mixed-version training is not permitted.

---

## 8. What Must NOT Happen

- ✗ AlphaForge must not query SentinelPulse DB directly
- ✗ SentinelPulse must not call AlphaForge's prediction endpoint
- ✗ SentinelPulse news features must not be the sole basis for any signal
- ✗ Expired news data must not silently remain in the feature vector
- ✗ The word "BUY", "SELL", or "HOLD" must never appear in SentinelPulse API responses

---

*Generated by Phase 3A Runtime Certification Audit — 2026-09-15*
