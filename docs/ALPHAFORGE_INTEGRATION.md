# AlphaForge Integration Contract

## Role of SentinelPulse in AlphaForge

SentinelPulse is a **supporting factor service** within the AlphaForge multi-factor signal model. Its role is to transform unstructured financial news into structured, evidence-backed inputs that AlphaForge combines with other signal factors.

**SentinelPulse does NOT generate autonomous trading signals.** It does not produce BUY, SELL, or HOLD recommendations. No endpoint in SentinelPulse exposes a directional trading action.

The final trading signal is computed entirely within AlphaForge:

```
News Score (SentinelPulse)
  + Technical Analysis Factor
  + Smart Money Factor
  + Volume Factor
  + Open Interest Factor
  + Market Regime Factor
  + Macro Factor
  ──────────────────────────
  → ML Probability (ml-service)
  → Final Signal (AlphaForge)
```

SentinelPulse contributes the **News Score** component only.

---

## Primary Integration Endpoint

### `GET /api/v1/alphaforge/news-context/:instrument`

This is the main integration endpoint. AlphaForge calls it per instrument when computing the multi-factor signal.

- **Latency target**: p95 < 100ms (served from Redis cache, TTL 30s)
- **Cache key**: `news:signal:{instrument}`
- **Authentication**: `Authorization: Bearer {api_key}`
- Returns `HTTP 404` if the instrument has no news context in the SentinelPulse database

---

## Response Shape

```typescript
interface NewsContextBundle {
  // Core news impact factor (0.0–1.0). NOT a trading signal.
  news_impact_score: number;

  // 5-dimensional sentiment summary
  sentiment_summary: {
    overall: number;    // –1.0 to +1.0
    market: number;
    company: number;
    macro: number;
    risk: number;
  };

  // Rolling velocity metrics
  velocity_metrics: {
    velocity_1m: number;   // articles in trailing 60s
    velocity_5m: number;   // articles in trailing 5m
    momentum: number | null; // velocity / 7-day baseline; null if baseline = 0
  };

  // Current market regime
  regime_context: {
    regime: MarketRegime;
    confidence: number;
  };

  // Top events by importance (max 5)
  top_contributing_events: Array<{
    event_id: string;
    title: string;
    importance_score: number;    // 0.0–1.0
    sentiment_direction: 'positive' | 'negative' | 'neutral';
  }>;

  // Active cross-market signals for this instrument
  active_cross_market_signals: CrossMarketSignal[];

  // Aggregate statistics across historical analogues
  historical_analogue_summary: {
    analogue_count: number;
    median_return_1h: number | null;
    win_rate: number | null;     // 0.0–1.0; null if < 2 analogues have data
  };

  // Explainability block (for transparency in multi-factor decisions)
  explainability: {
    top_events: Array<{
      title: string;
      importance_score: number;
      sentiment_direction: 'positive' | 'negative' | 'neutral';
    }>;                          // top 3 events
    top_cross_market: CrossMarketSignal[];   // top 3 relationships
    best_analogue: {
      event_date: string;        // ISO 8601
      return_1h: number | null;
      regime: MarketRegime;
    } | null;
  };
}
```

---

## Explainability Block

The `explainability` block allows AlphaForge to surface the evidence behind each news score to end users and risk managers without exposing raw model internals.

It contains exactly:
- The **top 3 contributing news events** (by `importance_score`), with title, score, and sentiment direction
- The **top 3 active cross-market relationships** relevant to the instrument
- The **single most relevant historical analogue** with its 1-hour return and the market regime at the time

If no historical analogue exists with similarity ≥ 0.5, `best_analogue` is `null`.

---

## Multi-Factor Signal Formula

For transparency and audit purposes, the multi-factor formula that AlphaForge applies is:

```
Final Signal = f(
  news_impact_score,       // ← SentinelPulse contribution
  technical_score,
  smart_money_score,
  volume_score,
  open_interest_score,
  market_regime_score,
  macro_score
)
→ ML Probability (ml-service)
→ Final Signal (AlphaForge)
```

The weighting and combination logic is owned and maintained by AlphaForge. SentinelPulse is not aware of those weights and does not need to be.

---

## NewsImpactScore Computation

Within SentinelPulse, the `news_impact_score` in the response bundle is derived from per-event `NewsImpactScore` values, which are computed as:

```
NewsImpactScore = Sentiment
               × Importance
               × SourceReliability
               × EntityRelevance
               × HistoricalImpact
               × MarketRegimeCompatibility
               × Confidence
```

Normalised to **–100 to +100**, then aggregated to the **0.0–1.0** bundle score.

Each component is stored in `news_market_impacts.impact_components` (JSONB) for full traceability. This means every `news_impact_score` can be decomposed to its constituent factors on demand.

---

## Additional AlphaForge Endpoints

| Endpoint | Scope | Use Case |
|----------|-------|---------|
| `GET /api/v1/alphaforge/context/market` | Whole market | Market-level regime + breadth context |
| `GET /api/v1/alphaforge/context/index/:index` | Index (e.g., NIFTY50) | Index-level news context |
| `GET /api/v1/alphaforge/context/sector/:sector` | NIFTY sector | Sector rotation context |
| `GET /api/v1/alphaforge/context/asset/:asset` | Single asset | Same as `news-context/:instrument` |
| `GET /api/v1/alphaforge/high-impact-events` | All instruments | High-importance event feed (importance > 0.7) |

---

## What SentinelPulse Does NOT Provide

- BUY / SELL / HOLD recommendations
- Position sizing guidance
- Portfolio-level risk assessment
- Order execution or routing
- Any output that constitutes investment advice

These responsibilities are entirely within AlphaForge's signal computation layer.

---

## Error Handling for Integration

| Condition | SentinelPulse Response | AlphaForge Expected Action |
|-----------|----------------------|--------------------------|
| Instrument not found | `HTTP 404` | Skip news factor; proceed with 0 or neutral weight |
| Redis cache unavailable | Serve from PostgreSQL; same response shape, slightly higher latency | No change needed |
| SentinelPulse service unavailable | No response / connection error | Apply configurable fallback weight or bypass news factor |
| Stale cache (TTL elapsed) | Fresh query returns new data | Transparent to AlphaForge |
