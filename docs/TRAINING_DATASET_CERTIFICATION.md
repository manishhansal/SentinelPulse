# SentinelPulse — Training Dataset Certification

**Version:** 1.0.0 (Phase 3B.1)  
**Date:** 2026-09-16  
**Status:** PENDING — data not yet generated (preconditions not met)  

---

## 1. Current State

| Metric | Value |
|---|---|
| Total feature vectors | 2 |
| Total training samples | **0** |
| Reactions (labels source) | **0** |
| Events in DB | 232 |
| Articles in DB | 230 |
| Events with asset links | ~19 |

Training samples are currently 0 because:
1. Historical reactions = 0 (no OHLCV data for Sept 2026 events)
2. Intraday OHLCV unavailable (all 5m/15m/30m/1h labels impossible)
3. Pilot news ingestion (2024-01-08) not yet run

---

## 2. Schema Fields (Phase 3B.1 additions)

After migration 003, `news_training_samples` contains:

| Field | Type | Status | Semantic |
|---|---|---|---|
| `event_id` | UUID FK | ✓ existing | Which news event |
| `asset_id` | TEXT | ✓ existing | Which instrument |
| `prediction_timestamp` | TIMESTAMPTZ | ✓ NEW | When signal was generated |
| `future_return_5m` | FLOAT | ✓ existing | 5m forward return % |
| `future_return_15m` | FLOAT | ✓ existing | 15m forward return % |
| `future_return_30m` | FLOAT | ✓ existing | 30m forward return % |
| `future_return_1h` | FLOAT | ✓ existing | 1h forward return % |
| `future_return_4h` | FLOAT | ✓ existing | 4h forward return % |
| `future_return_1d` | FLOAT | ✓ existing | 1d forward return % |
| `label_5m` ... `label_1d` | TEXT | ✓ existing | Directional labels |
| `label_cutoff_5m` ... `label_cutoff_1d` | TIMESTAMPTZ | ✓ existing | Outcome timestamps |
| `label_bar_timestamp_5m` ... `label_bar_timestamp_1d` | TIMESTAMPTZ | ✓ NEW | Exact bar used |
| `feature_vector_id` | UUID FK | ✓ existing | Link to feature vector |
| `feature_version` | TEXT | ✓ existing | Feature schema version |

After migration 003, `news_features` contains:

| Field | Type | Status | Semantic |
|---|---|---|---|
| `feature_as_of` | TIMESTAMPTZ | ✓ NEW | Max information_as_of |
| `computed_at` | TIMESTAMPTZ | ✓ existing | Wall-clock when engine ran |

---

## 3. Prediction Timestamp Policy

**Initial training policy: `prediction_timestamp = event_timestamp`**

This means AlphaForge is assumed to generate a signal immediately when the
news is published.  This is an explicit policy documented in:
- `docs/TEMPORAL_DATA_CONTRACT.md §2.6`
- `prisma/migrations/003_pit_auditability/migration.sql`
- `src/engines/ml-dataset/MLDatasetGenerator.ts` (persistWithRetry comment)

SQL check (B9 in pit-sql-certification.sql) verifies this invariant holds.

---

## 4. Point-in-Time Invariants

For every training sample, these must hold:

```
1. feature_as_of <= prediction_timestamp
2. prediction_timestamp < label_cutoff_X  (for all horizons X)
3. label_bar_timestamp_X <= label_cutoff_X
4. event_timestamp == prediction_timestamp  (under initial policy)
5. feature_as_of = article.published_at  (for text-derived features)
```

All invariants are enforced by:
- `LookAheadGuard.validateOne()` — blocks feature computation if violated
- `MLDatasetGenerator.computeForwardReturns()` — throws `LookAheadBiasError`
- `pit-sql-certification.sql` queries B1–B5 — post-hoc DB verification

---

## 5. Samples Per Horizon (Projected)

Based on current OHLCV availability:

| Horizon | Expected samples | Reason |
|---|---|---|
| 5m | 0 | Intraday data unavailable |
| 15m | 0 | Intraday data unavailable |
| 30m | 0 | Intraday data unavailable |
| 1h | 0 | Intraday data unavailable |
| 4h | 0 | Intraday data unavailable |
| 1d | ~5–20 (after pilot) | Daily data for 4 instruments, Jan 2024 |

---

## 6. PIT Violations (Current)

All PIT violation queries from `pit-sql-certification.sql` return 0.  
This is expected because 0 training samples exist — cannot be violated.

Once training samples are generated, all A* and B* queries must continue returning 0.

---

## 7. Duplicate Violations

`news_training_samples` does NOT have a UNIQUE constraint on `(event_id, asset_id)`.  
The SQL check (A11, B5) must be run post-generation to detect duplicates.

`MLDatasetGenerator.generateSample()` does not guard against duplicate generation
if called twice for the same (eventId, assetId) — the second call creates a second
row. This is a known gap. Use `findFirst()` before `create()` if idempotency is needed.

---

## 8. Missing Data Statistics

| Field | Null policy |
|---|---|
| future_return_5m | null when intraday OHLCV unavailable |
| future_return_1d | null when daily OHLCV unavailable |
| label_bar_timestamp_X | null when no bar served for that horizon |
| prediction_timestamp | null pre-migration, non-null post-migration 003 |
| feature_as_of | null pre-migration, non-null post-migration 003 |

**Null labels are explicit and explainable.** The `MLDatasetGenerator` never
interpolates missing data — unavailable OHLCV = null label = excluded from that
horizon's training set.

---

## 9. Certification Verdict

| Check | Result | Notes |
|---|---|---|
| Schema fields complete | ✓ PASS | prediction_timestamp + feature_as_of added |
| Migration 003 written | ✓ PASS | prisma/migrations/003_pit_auditability/migration.sql |
| PIT invariants enforced in code | ✓ PASS | LookAheadGuard + LookAheadBiasError |
| Null labels explicit | ✓ PASS | No interpolation anywhere |
| Training samples = 0 | ✗ PENDING | Pilot not yet run |
| PIT SQL queries all return 0 | ✓ PASS | 0 samples = 0 violations |
| Duplicate check | ✓ PASS (trivially) | 0 samples |

### Overall: TRAINING DATASET — SCHEMA CERTIFIED, DATA NOT READY

The schema and code are fully correct for point-in-time compliant training sample
generation.  The dataset itself cannot be certified until:
1. Real news events with asset links are ingested for 2024-01-08 to 2024-01-14
2. `pilot-reaction-test.ts` generates non-zero reactions
3. `MLDatasetGenerator.generateSample()` is called for those events
4. All post-pilot SQL queries confirm 0 violations

---

*Generated by Phase 3B.1 — 2026-09-16*
