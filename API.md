# SentinelPulse API Reference

## Overview

| Property | Value |
|---|---|
| Version | v1 |
| Base URL | `http://localhost:3000/api/v1` (configurable via `PORT` env var) |
| Transport | HTTP/1.1 and HTTP/2 |
| Data Format | `application/json` for all request and response bodies |
| Authentication | Bearer token (see [Authentication](#authentication)) |
| Rate Limit | 300 requests per minute per token (see [Rate Limiting](#rate-limiting)) |

All endpoints except `/health`, `/ready`, and `/metrics` require authentication. All timestamps are ISO 8601 UTC strings (e.g., `2024-01-15T09:30:00.000Z`). All numeric scores are in the range `[0, 1]` unless otherwise noted.

---

## Authentication

Every request to a protected endpoint must include an `Authorization` header with the API key configured in the `SENTINEL_API_KEY` environment variable.

```
Authorization: Bearer <your-api-key>
```

**Example:**

```bash
curl -H "Authorization: Bearer sp_abc123def456" \
  http://localhost:3000/api/v1/news/latest
```

**401 Response — missing or invalid token:**

```json
{
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Missing or invalid Authorization header"
  }
}
```

---

## Rate Limiting

The API enforces a **300 requests per minute** sliding window per API key. The limit resets continuously — it is not a hard bucket that flips at the top of each minute.

Every response includes rate limit headers:

| Header | Description |
|---|---|
| `X-RateLimit-Limit` | Maximum requests allowed per window (300) |
| `X-RateLimit-Remaining` | Requests remaining in the current window |
| `X-RateLimit-Reset` | Unix timestamp when the window resets |

**429 Response — rate limit exceeded:**

```json
{
  "success": false,
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Too many requests. Retry after 12 seconds.",
    "retry_after": 12
  }
}
```

The `Retry-After` response header is also set with the same value in seconds.

---

## Response Envelope

All responses are wrapped in a consistent envelope.

### Success

```json
{
  "success": true,
  "data": { ... },
  "meta": {
    "request_id": "req_01HXYZ",
    "timestamp": "2024-01-15T09:30:00.000Z",
    "processing_time_ms": 23
  }
}
```

For paginated responses, `meta` also includes `cursor`, `has_more`, and `total` (where available).

### Error

```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Asset INVALID_ID not found in InstrumentMaster"
  },
  "meta": {
    "request_id": "req_01HXYZ",
    "timestamp": "2024-01-15T09:30:00.000Z"
  }
}
```

### Validation Error

Returned when request parameters fail validation (400):

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "fields": [
      {
        "field": "limit",
        "message": "Must be an integer between 1 and 100",
        "received": "500"
      },
      {
        "field": "asset_id",
        "message": "Required when sector is not provided",
        "received": null
      }
    ]
  }
}
```

---

## HTTP Status Codes

| Code | Meaning |
|---|---|
| `200` | Request succeeded |
| `201` | Resource created (e.g., backfill job submitted) |
| `202` | Accepted for async processing |
| `400` | Bad request — invalid parameters or request body |
| `401` | Unauthorized — missing or invalid API key |
| `404` | Resource not found |
| `429` | Rate limit exceeded |
| `500` | Internal server error — transient; safe to retry with backoff |
| `503` | Service unavailable — dependency not ready (check `/ready`) |

---

## News Intelligence Endpoints

### GET /api/v1/news/latest

Returns the most recent normalized and enriched news articles. Supports filtering by asset, sector, event type, and minimum importance.

**Query Parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `limit` | integer | `20` | Number of articles to return. Range: 1–100. |
| `cursor` | string | — | Pagination cursor from a previous response. |
| `asset_id` | string | — | Filter to articles linked to a specific instrument (e.g., `RELIANCE`). |
| `sector` | string | — | Filter by sector slug (e.g., `banking`, `it`, `pharma`). |
| `event_type` | string | — | Filter by event type. See [NewsEvent](#newsevent) for valid values. |
| `min_importance` | float | `0` | Minimum importance score [0, 1]. Only returns articles scoring above this threshold. |
| `source_id` | string | — | Filter by source (e.g., `reuters`, `moneycontrol`). |

Filters are combined with AND logic. An article must satisfy all provided filters to be returned.

**Response:**

```json
{
  "success": true,
  "data": {
    "articles": [
      {
        "id": "art_01HXYZ123",
        "source_id": "reuters",
        "headline": "RBI holds repo rate at 6.5%, signals cautious stance",
        "summary": "The Reserve Bank of India's Monetary Policy Committee voted 4-2 to hold the repo rate...",
        "url": "https://www.reuters.com/...",
        "published_at": "2024-01-15T08:00:00.000Z",
        "language": "en",
        "content_hash": "a3f2b1c4d5e6...",
        "dedup_cluster_id": "clust_01HABC",
        "importance_score": 0.87,
        "event_type": "CENTRAL_BANK_DECISION",
        "primary_entities": ["NIFTY50", "BANKNIFTY", "HDFCBANK"],
        "sentiment": {
          "overall": 0.12,
          "market": -0.08,
          "macro": -0.15
        },
        "processing_stage": "FEATURE_COMPLETE"
      }
    ]
  },
  "meta": {
    "request_id": "req_01HXYZ",
    "timestamp": "2024-01-15T09:30:00.000Z",
    "cursor": "eyJpZCI6ImFydF8wMUhBQkMifQ==",
    "has_more": true,
    "total": 1842
  }
}
```

---

### GET /api/v1/news/assets/:assetId

Returns news articles, market impacts, and sentiment vectors for a specific instrument. `:assetId` is the NSE/BSE symbol or a synthetic identifier from the InstrumentMaster (e.g., `RELIANCE`, `NIFTY50`, `HDFCBANK`).

**Path Parameters:**

| Parameter | Description |
|---|---|
| `assetId` | Instrument identifier from InstrumentMaster |

**Query Parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `limit` | integer | `10` | Articles to return. Max: 50. |
| `hours` | integer | `24` | Lookback window in hours. Max: 168 (7 days). |
| `min_importance` | float | `0.3` | Minimum importance score filter. |

**Response:**

```json
{
  "success": true,
  "data": {
    "asset_id": "RELIANCE",
    "instrument_name": "Reliance Industries Limited",
    "sector": "energy",
    "articles": [
      {
        "id": "art_01HXYZ456",
        "headline": "Reliance Jio subscribers cross 500mn mark",
        "published_at": "2024-01-15T07:45:00.000Z",
        "source_id": "economic_times",
        "importance_score": 0.74,
        "event_type": "EARNINGS_GROWTH",
        "impact": {
          "direction": "BULLISH",
          "strength": 0.68,
          "confidence": 0.81,
          "horizon": "1h",
          "news_impact_score": 0.512
        },
        "sentiment": {
          "overall": 0.61,
          "market": 0.55,
          "company": 0.78,
          "macro": 0.02,
          "risk": -0.12
        }
      }
    ],
    "aggregate_sentiment": {
      "overall": 0.43,
      "market": 0.38,
      "company": 0.51,
      "macro": -0.05,
      "risk": -0.09,
      "article_count": 7,
      "window_hours": 24
    },
    "net_impact_direction": "BULLISH",
    "impact_confidence": 0.72
  }
}
```

---

### GET /api/v1/news/market/india

Returns a snapshot of the current news landscape for the Indian market: breadth metrics, regime classification, and the highest-impact active events.

**Response:**

```json
{
  "success": true,
  "data": {
    "as_of": "2024-01-15T09:30:00.000Z",
    "breadth": {
      "advancing_articles_pct": 54.2,
      "declining_articles_pct": 31.8,
      "neutral_articles_pct": 14.0,
      "net_breadth": 0.224,
      "high_importance_count": 12,
      "window_minutes": 60
    },
    "regime": {
      "nifty50": "RISK_ON",
      "banknifty": "NEUTRAL",
      "broad_market": "RISK_ON",
      "confidence": 0.76,
      "since": "2024-01-14T11:00:00.000Z"
    },
    "hot_events": [
      {
        "event_id": "evt_01HXYZ789",
        "event_type": "CENTRAL_BANK_DECISION",
        "headline": "RBI holds repo rate at 6.5%",
        "importance_score": 0.87,
        "affected_assets": ["NIFTY50", "BANKNIFTY", "HDFCBANK", "ICICIBANK"],
        "published_at": "2024-01-15T08:00:00.000Z"
      }
    ]
  }
}
```

---

### GET /api/v1/news/events/:eventId

Returns full details for a single detected news event, including its cluster membership, importance decomposition, and sentiment profile.

**Path Parameters:**

| Parameter | Description |
|---|---|
| `eventId` | Event identifier (e.g., `evt_01HXYZ789`) |

Returns `404` if the event ID does not exist.

**Response:**

```json
{
  "success": true,
  "data": {
    "id": "evt_01HXYZ789",
    "event_type": "CENTRAL_BANK_DECISION",
    "sub_type": "RATE_HOLD",
    "headline": "RBI holds repo rate at 6.5%, signals cautious stance",
    "description": "The Reserve Bank of India held rates for the fifth consecutive meeting...",
    "published_at": "2024-01-15T08:00:00.000Z",
    "source_id": "reuters",
    "surprise_score": 0.12,
    "cluster": {
      "id": "clust_01HABC",
      "size": 4,
      "canonical_article_id": "art_01HXYZ123"
    },
    "importance": {
      "total": 0.87,
      "source_credibility": 0.90,
      "event_severity": 0.85,
      "market_breadth": 0.92,
      "time_sensitivity": 0.80,
      "novelty": 0.70,
      "cross_asset_impact": 0.88,
      "macro_relevance": 0.95,
      "historical_impact": 0.83,
      "social_amplification": 0.60,
      "surprise_multiplier": 1.04
    },
    "sentiment": {
      "overall": 0.12,
      "market": -0.08,
      "company": 0.00,
      "macro": -0.15,
      "risk": 0.18
    },
    "affected_assets": [
      { "asset_id": "NIFTY50", "impact_direction": "BEARISH", "confidence": 0.71 },
      { "asset_id": "BANKNIFTY", "impact_direction": "BEARISH", "confidence": 0.78 },
      { "asset_id": "HDFCBANK", "impact_direction": "BEARISH", "confidence": 0.65 }
    ]
  }
}
```

---

### GET /api/v1/news/events/similar

Finds historical events semantically similar to a query string. Uses the pgvector HNSW index for sub-500ms retrieval over 1M+ articles. Also returns aggregate statistics across the matched events.

**Query Parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `q` | string | **required** | Free-text query (e.g., "RBI rate cut surprise") |
| `topK` | integer | `10` | Number of similar events to return. Max: 50. |
| `regime_filter` | string | — | Restrict matches to a market regime: `RISK_ON`, `RISK_OFF`, `NEUTRAL`, `CRISIS` |
| `min_similarity` | float | `0.75` | Minimum cosine similarity threshold [0, 1] |

> **Latency note:** p50 < 100ms, p95 < 500ms at 1M corpus size with the HNSW index. Cold starts (first query after index load) may take up to 2s.

**Response:**

```json
{
  "success": true,
  "data": {
    "query": "RBI rate cut surprise",
    "results": [
      {
        "event_id": "evt_01HABC001",
        "headline": "RBI surprises with 50bp rate cut amid slowdown fears",
        "event_type": "CENTRAL_BANK_DECISION",
        "published_at": "2019-10-04T06:30:00.000Z",
        "similarity": 0.927,
        "regime_at_time": "RISK_OFF",
        "importance_score": 0.91,
        "reactions": {
          "return_1h": -0.0234,
          "return_1d": 0.0189
        }
      }
    ],
    "aggregate_stats": {
      "event_count": 8,
      "median_return_1h": -0.018,
      "median_return_1d": 0.021,
      "win_rate_1d": 0.625,
      "max_adverse_excursion_1h": -0.043,
      "iqr_return_1d": 0.029
    }
  }
}
```

---

### GET /api/v1/news/impact/:assetId

Returns all active market impact assessments for a given instrument, across multiple horizons.

**Path Parameters:**

| Parameter | Description |
|---|---|
| `assetId` | Instrument identifier (e.g., `HDFCBANK`, `NIFTY50`) |

**Query Parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `hours` | integer | `4` | Lookback window. Max: 48. |
| `min_confidence` | float | `0.5` | Minimum confidence threshold for returned impacts. |

**Response:**

```json
{
  "success": true,
  "data": {
    "asset_id": "HDFCBANK",
    "impacts": [
      {
        "impact_id": "imp_01HXYZ111",
        "event_id": "evt_01HXYZ789",
        "direction": "BEARISH",
        "strength": 0.62,
        "confidence": 0.78,
        "horizon": "1h",
        "evidence_type": "DIRECT_MENTION",
        "news_impact_score": 0.484,
        "published_at": "2024-01-15T08:00:00.000Z",
        "headline": "RBI holds repo rate at 6.5%"
      },
      {
        "impact_id": "imp_01HXYZ222",
        "event_id": "evt_01HXYZ999",
        "direction": "BULLISH",
        "strength": 0.45,
        "confidence": 0.61,
        "horizon": "1d",
        "evidence_type": "CROSS_MARKET",
        "news_impact_score": 0.275,
        "published_at": "2024-01-15T06:00:00.000Z",
        "headline": "Foreign institutional investors net buyers in January"
      }
    ]
  }
}
```

---

### GET /api/v1/news/regime

Returns the current market regime classification for all three tracked markets.

**Response:**

```json
{
  "success": true,
  "data": {
    "as_of": "2024-01-15T09:30:00.000Z",
    "markets": {
      "nifty50": {
        "regime": "RISK_ON",
        "confidence": 0.76,
        "since": "2024-01-14T11:00:00.000Z",
        "breadth_score": 0.224,
        "volatility_percentile": 32
      },
      "banknifty": {
        "regime": "NEUTRAL",
        "confidence": 0.58,
        "since": "2024-01-15T06:00:00.000Z",
        "breadth_score": 0.041,
        "volatility_percentile": 51
      },
      "broad_market": {
        "regime": "RISK_ON",
        "confidence": 0.71,
        "since": "2024-01-14T11:00:00.000Z",
        "breadth_score": 0.187,
        "volatility_percentile": 28
      }
    },
    "next_update_at": "2024-01-15T09:45:00.000Z"
  }
}
```

---

### GET /api/v1/news/signal/:assetId

Returns a composite news signal summary for a given instrument: overall direction, constituent impacts, and latest sentiment. This endpoint is intended for monitoring and debugging; the canonical integration path for AlphaForge is `/alphaforge/news-context/:instrument`.

**Path Parameters:**

| Parameter | Description |
|---|---|
| `assetId` | Instrument identifier |

**Response:**

```json
{
  "success": true,
  "data": {
    "asset_id": "RELIANCE",
    "composite_score": 0.512,
    "dominant_direction": "BULLISH",
    "direction_confidence": 0.73,
    "recent_impacts": [
      {
        "impact_id": "imp_01HXYZ333",
        "direction": "BULLISH",
        "strength": 0.68,
        "horizon": "1h",
        "news_impact_score": 0.512,
        "age_minutes": 47
      }
    ],
    "latest_sentiment": {
      "overall": 0.43,
      "market": 0.38,
      "company": 0.51,
      "macro": -0.05,
      "risk": -0.09
    },
    "as_of": "2024-01-15T09:30:00.000Z"
  }
}
```

---

### GET /api/v1/news/search

Performs semantic search over the full article corpus using vector similarity.

**Query Parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `q` | string | **required** | Free-text query |
| `limit` | integer | `10` | Number of results. Max: 50. |
| `min_similarity` | float | `0.70` | Minimum cosine similarity [0, 1] |
| `asset_id` | string | — | Restrict search to articles linked to a specific instrument |
| `hours` | integer | `168` | Restrict search to articles published within this many hours |

> **Latency note:** p95 < 500ms for a 1M-article corpus with the HNSW index.

**Response:**

```json
{
  "success": true,
  "data": {
    "results": [
      {
        "article_id": "art_01HXYZ456",
        "headline": "Reliance Jio subscribers cross 500mn mark",
        "summary": "Reliance Industries announced that its telecom subsidiary...",
        "source_id": "economic_times",
        "published_at": "2024-01-15T07:45:00.000Z",
        "similarity": 0.891,
        "importance_score": 0.74,
        "primary_entities": ["RELIANCE", "NIFTY50"]
      }
    ],
    "query": "Jio subscriber growth",
    "total_searched": 1043221
  }
}
```

---

## AlphaForge Integration Endpoints

These endpoints form the primary contract between SentinelPulse and the AlphaForge signal engine. Responses are shaped for direct consumption by AlphaForge's feature ingestion layer.

### GET /api/v1/alphaforge/news-context/:instrument

Returns a complete, point-in-time news context package for a given instrument. This is the primary endpoint consumed by AlphaForge.

Results are cached in Redis with a **30-second TTL** to handle burst traffic during market open. The `cache_hit` field in the response indicates whether the result was served from cache.

> **Important:** `news_impact_score` is a normalized input feature in the range [0, 1]. It is NOT a trading signal and does NOT encode a directional recommendation. AlphaForge combines this score with price, volume, options flow, and macro factors in its multi-factor model.

Returns `404` if the instrument is not in the InstrumentMaster.

**Path Parameters:**

| Parameter | Description |
|---|---|
| `instrument` | NSE/BSE symbol (e.g., `NIFTY50`, `RELIANCE`, `HDFCBANK`) |

**Response:**

```json
{
  "success": true,
  "data": {
    "instrument": "RELIANCE",
    "as_of": "2024-01-15T09:30:00.000Z",
    "cache_hit": false,
    "news_impact_score": 0.512,
    "impact_direction": "BULLISH",
    "impact_confidence": 0.73,
    "impact_horizon": "1h",
    "sentiment": {
      "overall": 0.43,
      "market": 0.38,
      "company": 0.51,
      "macro": -0.05,
      "risk": -0.09
    },
    "event_count_24h": 7,
    "high_importance_event_count_24h": 2,
    "latest_event": {
      "event_id": "evt_01HXYZ999",
      "event_type": "EARNINGS_GROWTH",
      "headline": "Reliance Jio subscribers cross 500mn mark",
      "published_at": "2024-01-15T07:45:00.000Z",
      "importance_score": 0.74,
      "surprise_score": 0.31
    },
    "market_regime": "RISK_ON",
    "explainability": {
      "top_contributing_events": [
        {
          "event_id": "evt_01HXYZ999",
          "contribution_weight": 0.61,
          "event_type": "EARNINGS_GROWTH",
          "direction": "BULLISH"
        },
        {
          "event_id": "evt_01HXYZ789",
          "contribution_weight": 0.39,
          "event_type": "CENTRAL_BANK_DECISION",
          "direction": "BEARISH"
        }
      ],
      "score_breakdown": {
        "direct_events": 0.42,
        "cross_market_effects": 0.08,
        "sentiment_contribution": 0.06
      }
    }
  }
}
```

---

### GET /api/v1/alphaforge/context/market

Returns the current macro-level news context for the Indian market as a whole. Covers breadth, regime, and top-level sentiment aggregated across all tracked instruments.

**Response shape:** Similar to `/news/market/india` but shaped for AlphaForge consumption with normalized scores and the `news_impact_score` for the aggregate market.

---

### GET /api/v1/alphaforge/context/index/:index

Returns the news context package for a market index (e.g., `NIFTY50`, `BANKNIFTY`, `NIFTYMIDCAP100`).

**Path Parameters:**

| Parameter | Description |
|---|---|
| `index` | Index identifier (e.g., `NIFTY50`) |

Response shape is identical to `/alphaforge/news-context/:instrument`.

---

### GET /api/v1/alphaforge/context/sector/:sector

Returns aggregated news context for an NSE sector (e.g., `banking`, `it`, `pharma`, `auto`, `energy`, `fmcg`, `metals`, `realty`).

**Path Parameters:**

| Parameter | Description |
|---|---|
| `sector` | Sector slug |

Response includes per-sector breadth, aggregate sentiment, and the top-contributing events.

---

### GET /api/v1/alphaforge/context/asset/:asset

Alias for `/alphaforge/news-context/:instrument`. Included for API consistency with other context endpoints.

---

### GET /api/v1/alphaforge/high-impact-events

Returns a paginated feed of recent high-importance news events, ordered by `importance_score` descending. Intended for AlphaForge's event-driven strategy layer.

**Query Parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `limit` | integer | `20` | Events per page. Max: 100. |
| `cursor` | string | — | Pagination cursor for subsequent pages. |
| `asset_id` | string | — | Filter to events that affect a specific instrument. |
| `min_importance` | float | `0.7` | Minimum importance score. |
| `hours` | integer | `24` | Lookback window in hours. Max: 168. |

**Response:**

```json
{
  "success": true,
  "data": {
    "events": [
      {
        "event_id": "evt_01HXYZ789",
        "event_type": "CENTRAL_BANK_DECISION",
        "headline": "RBI holds repo rate at 6.5%, signals cautious stance",
        "published_at": "2024-01-15T08:00:00.000Z",
        "source_id": "reuters",
        "importance_score": 0.87,
        "surprise_score": 0.12,
        "impact_direction": "BEARISH",
        "impact_confidence": 0.74,
        "affected_assets": ["NIFTY50", "BANKNIFTY", "HDFCBANK", "ICICIBANK", "KOTAKBANK"],
        "news_impact_score": 0.643
      }
    ]
  },
  "meta": {
    "cursor": "eyJpZCI6ImV2dF8wMUhBQkMifQ==",
    "has_more": false,
    "total": 14,
    "request_id": "req_01HXYZ",
    "timestamp": "2024-01-15T09:30:00.000Z"
  }
}
```

---

## ML / Data Endpoints

These endpoints expose feature vectors, training samples, and historical reaction data for the ml-service and offline model training pipelines.

### GET /api/v1/ml/features/market

Returns the current market-level feature vector: breadth, velocity, regime, aggregate sentiment, and macro indicators.

---

### GET /api/v1/ml/features/asset/:assetId

### GET /api/v1/ml/features/sector/:sector

Returns the current feature vector for a specific asset or sector. The vector is computed by the `FeatureEngineeringEngine` and is guaranteed to be point-in-time correct (no look-ahead).

**Shared Query Parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `feature_version` | string | latest | Pin to a specific `FEATURE_VERSION` (semver). |
| `as_of` | string | now | Return the feature vector as of this ISO 8601 timestamp. Enables backtesting queries. |

**Response:**

```json
{
  "success": true,
  "data": {
    "asset_id": "RELIANCE",
    "feature_version": "1.2.0",
    "pipeline_version": "1.1.0",
    "computed_at": "2024-01-15T09:29:45.000Z",
    "event_timestamp": "2024-01-15T07:45:00.000Z",
    "look_ahead_validated": true,
    "features": {
      "sentiment_group": {
        "sentiment_overall": 0.43,
        "sentiment_market": 0.38,
        "sentiment_company": 0.51,
        "sentiment_macro": -0.05,
        "sentiment_risk": -0.09
      },
      "importance_group": {
        "importance_score": 0.74,
        "surprise_score": 0.31,
        "novelty_score": 0.62
      },
      "impact_group": {
        "impact_direction_encoded": 1,
        "impact_strength": 0.68,
        "impact_confidence": 0.73,
        "news_impact_score": 0.512
      },
      "velocity_group": { "...": "see ML_FEATURES.md" },
      "breadth_group": { "...": "see ML_FEATURES.md" },
      "regime_group": { "...": "see ML_FEATURES.md" },
      "historical_group": { "...": "see ML_FEATURES.md" }
    }
  }
}
```

For the complete feature schema and computation formulas for all 7 feature groups, see [docs/ML_FEATURES.md](docs/ML_FEATURES.md).

---

### GET /api/v1/ml/training/events

Returns a filtered, paginated list of news events for use as training data anchors.

**Query Parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `asset_id` | string | — | Filter to events affecting a specific instrument. |
| `event_type` | string | — | Filter by event type. |
| `min_importance` | float | `0.5` | Minimum importance score. |
| `start_date` | string | — | ISO 8601 start date (inclusive). |
| `end_date` | string | — | ISO 8601 end date (inclusive). |
| `limit` | integer | `100` | Events per page. Max: 1000. |
| `cursor` | string | — | Pagination cursor. |

**Response:**

```json
{
  "success": true,
  "data": {
    "events": [
      {
        "event_id": "evt_01HXYZ789",
        "event_type": "CENTRAL_BANK_DECISION",
        "published_at": "2024-01-15T08:00:00.000Z",
        "importance_score": 0.87,
        "surprise_score": 0.12,
        "affected_assets": ["NIFTY50", "BANKNIFTY"],
        "has_reactions": true,
        "has_features": true
      }
    ]
  },
  "meta": {
    "cursor": "eyJpZCI6ImV2dF8wMUhBQkMifQ==",
    "has_more": true,
    "request_id": "req_01HXYZ",
    "timestamp": "2024-01-15T09:30:00.000Z"
  }
}
```

---

### GET /api/v1/ml/training/samples

Returns a filtered, paginated list of `TrainingSample` records. Each sample is a complete, point-in-time-correct (feature vector, forward return label) pair ready for model training.

**Query Parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `feature_version` | string | — | Pin to a specific `FEATURE_VERSION`. Strongly recommended for training runs. |
| `asset_id` | string | — | Filter to a specific instrument. |
| `model_version` | string | — | Filter samples that were generated for a specific model version. |
| `start_date` | string | — | ISO 8601 start date (inclusive). |
| `end_date` | string | — | ISO 8601 end date (inclusive). |
| `min_importance` | float | `0` | Minimum importance score of the source event. |
| `limit` | integer | `100` | Samples per page. **Maximum: 1000.** |
| `cursor` | string | — | Pagination cursor. |

**Response:**

```json
{
  "success": true,
  "data": {
    "samples": [
      {
        "sample_id": "smp_01HXYZ001",
        "feature_version": "1.2.0",
        "pipeline_version": "1.1.0",
        "asset_id": "RELIANCE",
        "event_id": "evt_01HXYZ999",
        "event_timestamp": "2024-01-15T07:45:00.000Z",
        "feature_vector_id": "fvec_01HXYZ001",
        "labels": {
          "return_1h": 0.0112,
          "return_4h": 0.0089,
          "return_1d": 0.0203,
          "direction_1h": 1,
          "direction_1d": 1
        },
        "importance_score": 0.74,
        "created_at": "2024-01-15T09:00:00.000Z"
      }
    ]
  },
  "meta": {
    "cursor": "eyJpZCI6InNtcF8wMUhBQkMifQ==",
    "has_more": true,
    "total": 48231,
    "request_id": "req_01HXYZ",
    "timestamp": "2024-01-15T09:30:00.000Z"
  }
}
```

---

### GET /api/v1/ml/training/samples/:sampleId/lineage

Returns the complete provenance chain for a training sample: from the `TrainingSample` back through the `FeatureVector`, `NewsEvent`, `NormalizedArticle`, and `NewsSource`.

Returns `404` if the sample ID does not exist.

**Path Parameters:**

| Parameter | Description |
|---|---|
| `sampleId` | Training sample identifier (e.g., `smp_01HXYZ001`) |

**Response:**

```json
{
  "success": true,
  "data": {
    "sample_id": "smp_01HXYZ001",
    "lineage": {
      "training_sample": {
        "id": "smp_01HXYZ001",
        "feature_version": "1.2.0",
        "created_at": "2024-01-15T09:00:00.000Z"
      },
      "feature_vector": {
        "id": "fvec_01HXYZ001",
        "computed_at": "2024-01-15T09:29:45.000Z",
        "look_ahead_validated": true
      },
      "news_event": {
        "id": "evt_01HXYZ999",
        "event_type": "EARNINGS_GROWTH",
        "published_at": "2024-01-15T07:45:00.000Z",
        "surprise_score": 0.31
      },
      "normalized_article": {
        "id": "art_01HXYZ456",
        "headline": "Reliance Jio subscribers cross 500mn mark",
        "content_hash": "a3f2b1c4d5e6...",
        "language": "en",
        "dedup_cluster_id": "clust_01HABC"
      },
      "news_source": {
        "id": "economic_times",
        "name": "The Economic Times",
        "tier": 1,
        "url": "https://economictimes.indiatimes.com"
      }
    }
  }
}
```

---

### GET /api/v1/ml/historical-reactions

Returns measured historical price and volume reactions for news events, used as forward labels in the training pipeline.

**Query Parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `event_id` | string | — | Filter to reactions for a specific event. |
| `asset_id` | string | — | Filter to reactions for a specific instrument. |
| `event_type` | string | — | Filter by event type. |
| `start_date` | string | — | ISO 8601 start date. |
| `end_date` | string | — | ISO 8601 end date. |
| `min_importance` | float | `0.5` | Minimum importance of the source event. |
| `limit` | integer | `100` | Max: 1000. |
| `cursor` | string | — | Pagination cursor. |

**Response:**

```json
{
  "success": true,
  "data": {
    "reactions": [
      {
        "reaction_id": "rxn_01HXYZ001",
        "event_id": "evt_01HXYZ789",
        "asset_id": "NIFTY50",
        "event_timestamp": "2024-01-15T08:00:00.000Z",
        "return_1m": -0.0008,
        "return_5m": -0.0021,
        "return_15m": -0.0035,
        "return_30m": -0.0028,
        "return_1h": -0.0051,
        "return_2h": -0.0039,
        "return_4h": 0.0012,
        "return_8h": 0.0034,
        "return_1d": 0.0089,
        "volume_ratio_1h": 1.84,
        "volatility_ratio_1h": 1.31,
        "measured_at": "2024-01-16T08:00:00.000Z"
      }
    ]
  }
}
```

---

## Admin Endpoints

Admin endpoints provide operational visibility and control. All require the same Bearer token authentication.

### GET /api/v1/admin/sources

Returns health, circuit breaker state, and latest ingestion metrics for all 6 news source adapters.

**Response:**

```json
{
  "success": true,
  "data": {
    "sources": [
      {
        "id": "reuters",
        "name": "Reuters",
        "tier": 1,
        "enabled": true,
        "health": "UP",
        "failure_counter": 0,
        "cb_state": "CLOSED",
        "latest_metric": {
          "articles_fetched": 47,
          "articles_normalized": 47,
          "articles_deduplicated": 3,
          "dedup_rate": 0.064,
          "avg_fetch_ms": 312,
          "last_success_at": "2024-01-15T09:25:00.000Z"
        }
      },
      {
        "id": "bloomberg",
        "name": "Bloomberg",
        "tier": 2,
        "enabled": true,
        "health": "DEGRADED",
        "failure_counter": 3,
        "cb_state": "HALF_OPEN",
        "latest_metric": {
          "articles_fetched": 0,
          "last_failure_at": "2024-01-15T09:20:00.000Z",
          "last_error": "HTTP 503: Service Unavailable"
        }
      }
    ],
    "summary": {
      "total": 6,
      "up": 4,
      "degraded": 1,
      "down": 1
    }
  }
}
```

**Health values:** `UP` (circuit closed, operating normally), `DEGRADED` (circuit half-open, probing), `DOWN` (circuit open, rejecting requests).  
**Circuit breaker states:** `CLOSED` (normal), `OPEN` (failing, not attempting), `HALF_OPEN` (probing for recovery).

---

### GET /api/v1/admin/ingestion

Returns ingestion run history and per-run error details.

**Query Parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `source_id` | string | — | Filter to a specific source. |
| `status` | string | — | `SUCCESS`, `PARTIAL`, `FAILED` |
| `start_date` | string | — | ISO 8601 start date. |
| `end_date` | string | — | ISO 8601 end date. |
| `limit` | integer | `20` | Runs per page. Max: 100. |

**Response:**

```json
{
  "success": true,
  "data": {
    "runs": [
      {
        "run_id": "run_01HXYZ001",
        "source_id": "reuters",
        "status": "SUCCESS",
        "started_at": "2024-01-15T09:25:00.000Z",
        "completed_at": "2024-01-15T09:25:03.000Z",
        "articles_fetched": 47,
        "articles_enqueued": 47,
        "errors": []
      }
    ],
    "errors": [],
    "summary": {
      "total_runs": 144,
      "success": 140,
      "partial": 3,
      "failed": 1,
      "total_articles_fetched": 6241
    }
  }
}
```

---

### GET /api/v1/admin/queues

Returns queue depth and dead-letter queue metrics for all BullMQ queues. Queue metrics are stub values in development when Redis is not configured for BullMQ metrics collection. Enable `BULL_BOARD_ENABLED=true` for the full BullMQ dashboard.

**Queues monitored:**

Active queues: `news.raw` · `news.normalized` · `news.deduplicated` · `news.entities` · `news.events` · `news.sentiment` · `news.impact` · `news.features` · `news.embeddings` · *(internal scheduler queue)*

Dead-letter queues: `news.raw.deadletter` · `news.normalized.deadletter` · `news.deduplicated.deadletter` · `news.entities.deadletter` · `news.events.deadletter` · `news.sentiment.deadletter` · `news.impact.deadletter` · `news.features.deadletter` · `news.embeddings.deadletter` · *(1 additional)*

**Response:**

```json
{
  "success": true,
  "data": {
    "queues": [
      {
        "name": "news.raw",
        "waiting": 12,
        "active": 2,
        "completed": 48231,
        "failed": 0,
        "delayed": 0,
        "dlq_depth": 0
      },
      {
        "name": "news.normalized.deadletter",
        "waiting": 3,
        "active": 0,
        "completed": 0,
        "failed": 3,
        "delayed": 0,
        "dlq_depth": 3
      }
    ]
  }
}
```

---

### GET /api/v1/admin/data-quality

Returns data quality metrics for the last 24 hours, measuring pipeline completeness at four key checkpoints.

**Response:**

```json
{
  "success": true,
  "data": {
    "window_hours": 24,
    "as_of": "2024-01-15T09:30:00.000Z",
    "metrics": {
      "entity_resolution_rate": 0.924,
      "sentiment_coverage_rate": 0.991,
      "importance_coverage_rate": 0.989,
      "high_importance_reaction_rate": 0.831
    },
    "thresholds": {
      "entity_resolution_rate": 0.85,
      "sentiment_coverage_rate": 0.95,
      "importance_coverage_rate": 0.95,
      "high_importance_reaction_rate": 0.80
    },
    "all_thresholds_met": true
  }
}
```

- **entity_resolution_rate**: Fraction of articles with at least one resolved entity (asset or sector link).
- **sentiment_coverage_rate**: Fraction of events that have a completed sentiment record.
- **importance_coverage_rate**: Fraction of events that have a completed importance record.
- **high_importance_reaction_rate**: Fraction of events with `importance_score >= 0.7` that have a measured market reaction record.

---

### POST /api/v1/admin/backfill

Submits a historical backfill job. Backfill re-ingests articles from a source within a date range and re-runs the full pipeline.

**Request Body:**

```json
{
  "source_id": "reuters",
  "start_date": "2024-01-01T00:00:00.000Z",
  "end_date": "2024-01-14T23:59:59.000Z",
  "reprocess_existing": false,
  "priority": "low"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `source_id` | string | ✓ | Source to backfill. Must match a configured adapter ID. |
| `start_date` | string | ✓ | ISO 8601 start datetime. Must not be in the future. |
| `end_date` | string | ✓ | ISO 8601 end datetime. Must be after `start_date`. Max range: 90 days. |
| `reprocess_existing` | boolean | — | If `true`, re-runs pipeline for articles that already have features. Default: `false`. |
| `priority` | string | — | `low` (default), `normal`, `high`. Higher priority pre-empts queue. |

**Response (202 Accepted):**

```json
{
  "success": true,
  "data": {
    "job_id": "bf_01HXYZ001",
    "status": "QUEUED",
    "source_id": "reuters",
    "start_date": "2024-01-01T00:00:00.000Z",
    "end_date": "2024-01-14T23:59:59.000Z",
    "estimated_articles": 4200,
    "created_at": "2024-01-15T09:30:00.000Z"
  }
}
```

See [docs/BACKFILL.md](docs/BACKFILL.md) for rate limiting details, date range constraints, and progress monitoring.

---

### POST /api/v1/admin/backfill/:jobId/pause

### POST /api/v1/admin/backfill/:jobId/resume

### POST /api/v1/admin/backfill/:jobId/cancel

Control a running or queued backfill job. Cancel is irreversible — a cancelled job cannot be resumed and must be re-submitted.

---

## Health Endpoints

Health endpoints do not require authentication and are intended for load balancer health checks and readiness probes.

### GET /health

Returns the service's basic liveness status. Returns `200` if the process is running.

**Response:**

```json
{
  "status": "ok",
  "service": "sentinel-pulse",
  "version": "1.2.0",
  "uptime_seconds": 3842
}
```

---

### GET /ready

Returns the service's readiness status. Returns `200` when all dependencies are reachable, `503` when one or more checks fail.

Use this endpoint for Kubernetes `readinessProbe` and load balancer health checks. Traffic should not be routed to an instance returning `503`.

**200 Response (ready):**

```json
{
  "status": "ready",
  "checks": {
    "database": { "status": "ok", "latency_ms": 4 },
    "redis": { "status": "ok", "latency_ms": 1 },
    "data_service": { "status": "ok", "latency_ms": 18 },
    "scrapling": { "status": "ok", "latency_ms": 7 }
  }
}
```

**503 Response (not ready):**

```json
{
  "status": "not_ready",
  "checks": {
    "database": { "status": "ok", "latency_ms": 4 },
    "redis": { "status": "error", "error": "ECONNREFUSED" },
    "data_service": { "status": "ok", "latency_ms": 18 },
    "scrapling": { "status": "ok", "latency_ms": 7 }
  }
}
```

---

### GET /metrics

Returns Prometheus-compatible metrics in `text/plain` format. No authentication required. Mount behind a network-level firewall in production — do not expose publicly.

**Metrics exposed:**

| Metric | Type | Description |
|---|---|---|
| `sentinel_articles_ingested_total` | Counter | Total articles ingested, labelled by `source_id` |
| `sentinel_articles_deduplicated_total` | Counter | Total articles identified as duplicates |
| `sentinel_pipeline_stage_duration_seconds` | Histogram | Processing time per pipeline stage |
| `sentinel_queue_depth` | Gauge | Current BullMQ queue depth, labelled by `queue` |
| `sentinel_dlq_depth` | Gauge | Dead-letter queue depth, labelled by `queue` |
| `sentinel_circuit_breaker_state` | Gauge | CB state per source (0=CLOSED, 1=HALF_OPEN, 2=OPEN) |
| `sentinel_importance_score_histogram` | Histogram | Distribution of computed importance scores |
| `sentinel_api_request_duration_seconds` | Histogram | API request latency, labelled by `route` and `status_code` |
| `sentinel_cache_hit_total` | Counter | Redis cache hits, labelled by `cache_key` |
| `sentinel_look_ahead_violations_total` | Counter | LookAheadBiasError count (should always be 0 in production) |
| `sentinel_feature_publish_duration_seconds` | Histogram | Time from event ingestion to feature publish (SLA: p99 < 500ms) |

---

## Data Types

### NormalizedArticle

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique article identifier |
| `source_id` | string | Source adapter ID (e.g., `reuters`) |
| `headline` | string | Cleaned headline (HTML stripped) |
| `summary` | string | Extracted article summary |
| `url` | string | Canonical article URL |
| `published_at` | string | ISO 8601 publish timestamp |
| `language` | string | ISO 639-1 language code (e.g., `en`, `hi`) |
| `content_hash` | string | SHA-256 of normalized content body |
| `title_hash` | string | SHA-256 of normalized headline |
| `dedup_cluster_id` | string \| null | Cluster ID if article is part of a dedup group |
| `processing_stage` | string | Current pipeline stage: `RAW`, `NORMALIZED`, `DEDUPLICATED`, `ENTITIES`, `EVENTS`, `SENTIMENT`, `IMPORTANCE`, `IMPACT`, `FEATURE_COMPLETE` |

---

### NewsEvent

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique event identifier |
| `event_type` | string | One of 14 types (see below) |
| `sub_type` | string \| null | Optional sub-classification |
| `headline` | string | Event headline |
| `published_at` | string | ISO 8601 timestamp |
| `source_id` | string | Source adapter ID |
| `surprise_score` | float | Surprise relative to prior expectations, [0, 1] |
| `cluster_id` | string \| null | Dedup cluster membership |
| `importance_score` | float | Composite importance, [0, 1] |

**event_type values:** `EARNINGS_RELEASE` · `EARNINGS_GROWTH` · `CENTRAL_BANK_DECISION` · `REGULATORY_ACTION` · `MERGER_ACQUISITION` · `MANAGEMENT_CHANGE` · `MACRO_DATA_RELEASE` · `GEOPOLITICAL` · `CREDIT_RATING` · `FII_DII_FLOWS` · `COMMODITY_PRICE_MOVE` · `CURRENCY_MOVE` · `MARKET_STRUCTURE` · `SECTOR_DEVELOPMENT`

---

### NewsMarketImpact

| Field | Type | Description |
|---|---|---|
| `id` | string | Impact record identifier |
| `event_id` | string | Source news event |
| `asset_id` | string | Affected instrument |
| `direction` | string | `BULLISH`, `BEARISH`, `NEUTRAL` |
| `strength` | float | Impact magnitude, [0, 1] |
| `confidence` | float | Confidence in the assessment, [0, 1] |
| `horizon` | string | Expected effect horizon: `1m`, `5m`, `15m`, `1h`, `1d` |
| `evidence_type` | string | `DIRECT_MENTION`, `SECTOR_EFFECT`, `CROSS_MARKET`, `MACRO_SPILLOVER` |
| `news_impact_score` | float | Composite score = `strength × confidence × importance_weight`. Range: [0, 1]. NOT a trading signal. |

---

### NewsMarketReaction

Measured price and volume response at 9 time offsets after event publication.

| Field | Type | Description |
|---|---|---|
| `reaction_id` | string | Reaction record identifier |
| `event_id` | string | Source news event |
| `asset_id` | string | Instrument measured |
| `event_timestamp` | string | ISO 8601 event time |
| `return_1m` | float | Log return at +1 minute |
| `return_5m` | float | Log return at +5 minutes |
| `return_15m` | float | Log return at +15 minutes |
| `return_30m` | float | Log return at +30 minutes |
| `return_1h` | float | Log return at +1 hour |
| `return_2h` | float | Log return at +2 hours |
| `return_4h` | float | Log return at +4 hours |
| `return_8h` | float | Log return at +8 hours |
| `return_1d` | float | Log return at +1 trading day |
| `volume_ratio_1h` | float | Volume at +1h / average volume (1.0 = average) |
| `volatility_ratio_1h` | float | Realized volatility at +1h / rolling 30-day realized volatility |

---

### FeatureVector

A `FeatureVector` is the complete set of input features for the ml-service, computed by the `FeatureEngineeringEngine` for a specific (event, asset, timestamp) tuple. It covers 7 feature groups: sentiment, importance, impact, velocity, breadth, regime, and historical analogues. All features are point-in-time correct and validated by `LookAheadGuard`.

For the complete field list, formulas, and versioning policy, see [docs/ML_FEATURES.md](docs/ML_FEATURES.md).

---

### TrainingSample

A `TrainingSample` pairs a `FeatureVector` with its forward return labels. Labels are populated by the `HistoricalReactionEngine` once the market data for the corresponding time offsets becomes available.

For the label schema and lineage chain, see [docs/ML_FEATURES.md](docs/ML_FEATURES.md).

---

## Pagination

Cursor-based pagination is used on all list endpoints. Cursors are opaque base64-encoded strings — do not parse or construct them manually.

### Pattern

```json
{
  "meta": {
    "cursor": "eyJpZCI6ImFydF8wMUhBQkMifQ==",
    "has_more": true,
    "total": 1842
  }
}
```

Pass the cursor from the previous response as the `cursor` query parameter on the next request:

```
GET /api/v1/news/latest?limit=20&cursor=eyJpZCI6ImFydF8wMUhBQkMifQ==
```

### Iterating All Pages

```javascript
let cursor = null;
let allArticles = [];

do {
  const params = new URLSearchParams({ limit: '100' });
  if (cursor) params.set('cursor', cursor);

  const res = await fetch(`/api/v1/news/latest?${params}`, {
    headers: { Authorization: `Bearer ${API_KEY}` }
  });
  const body = await res.json();

  allArticles = allArticles.concat(body.data.articles);
  cursor = body.meta.has_more ? body.meta.cursor : null;
} while (cursor !== null);
```

---

## Error Handling

### Retrying Rate-Limited Requests

```javascript
async function fetchWithRetry(url, options, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, options);

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') ?? '5', 10);
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        continue;
      }
    }

    return res;
  }
}
```

### Handling Validation Errors

```javascript
const res = await fetch('/api/v1/admin/backfill', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${API_KEY}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify(payload)
});

if (res.status === 400) {
  const body = await res.json();
  if (body.error.code === 'VALIDATION_ERROR') {
    for (const field of body.error.fields) {
      console.error(`${field.field}: ${field.message} (received: ${field.received})`);
    }
  }
}
```

### 5xx Errors

`500` and `503` errors are transient and safe to retry with exponential backoff. Use `Retry-After` if present. If a `503` persists, check `/ready` to identify which dependency is unavailable.

---

## curl Examples

### 1. Get Latest India News (top 5 high-importance articles)

```bash
curl -s \
  -H "Authorization: Bearer $SENTINEL_API_KEY" \
  "http://localhost:3000/api/v1/news/latest?limit=5&min_importance=0.7" \
  | jq '.data.articles[] | {headline, importance_score, event_type, published_at}'
```

---

### 2. Get News Context for NIFTY50 (AlphaForge integration)

```bash
curl -s \
  -H "Authorization: Bearer $SENTINEL_API_KEY" \
  "http://localhost:3000/api/v1/alphaforge/news-context/NIFTY50" \
  | jq '{
      news_impact_score: .data.news_impact_score,
      impact_direction: .data.impact_direction,
      impact_confidence: .data.impact_confidence,
      regime: .data.market_regime,
      top_event: .data.latest_event.headline
    }'
```

---

### 3. High-Impact Events (last 4 hours, any asset)

```bash
curl -s \
  -H "Authorization: Bearer $SENTINEL_API_KEY" \
  "http://localhost:3000/api/v1/alphaforge/high-impact-events?hours=4&min_importance=0.75&limit=10" \
  | jq '.data.events[] | {event_type, headline, importance_score, affected_assets}'
```

---

### 4. Asset News for RELIANCE (last 12 hours)

```bash
curl -s \
  -H "Authorization: Bearer $SENTINEL_API_KEY" \
  "http://localhost:3000/api/v1/news/assets/RELIANCE?hours=12&min_importance=0.4" \
  | jq '{
      net_direction: .data.net_impact_direction,
      confidence: .data.impact_confidence,
      article_count: (.data.articles | length),
      aggregate_sentiment: .data.aggregate_sentiment
    }'
```

---

### 5. Training Samples (feature_version 1.2.0, last 30 days)

```bash
curl -s \
  -H "Authorization: Bearer $SENTINEL_API_KEY" \
  "http://localhost:3000/api/v1/ml/training/samples?feature_version=1.2.0&start_date=2023-12-16T00:00:00Z&end_date=2024-01-15T23:59:59Z&limit=100" \
  | jq '{total: .meta.total, has_more: .meta.has_more, sample_count: (.data.samples | length)}'
```

---

### 6. Data Quality Check

```bash
curl -s \
  -H "Authorization: Bearer $SENTINEL_API_KEY" \
  "http://localhost:3000/api/v1/admin/data-quality" \
  | jq '{
      all_ok: .data.all_thresholds_met,
      entity_rate: .data.metrics.entity_resolution_rate,
      sentiment_rate: .data.metrics.sentiment_coverage_rate,
      reaction_rate: .data.metrics.high_importance_reaction_rate
    }'
```

---

*For architecture details, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). For the ML feature schema, see [docs/ML_FEATURES.md](docs/ML_FEATURES.md). For operational runbooks, see [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).*
