# Backfill Guide

## Overview

The BackfillEngine reprocesses historical news articles through the full pipeline. It is used to:

- Populate the feature store from historical data after a fresh deployment
- Recompute features under a new `feature_version` without losing prior version records
- Recover from pipeline outages where articles were ingested but not fully processed

Backfill jobs run on the `news.backfill` BullMQ queue and are subject to a concurrency cap to avoid starving the live ingestion pipeline.

---

## Triggering a Backfill

> **⚠️ Important:** The `POST /api/v1/admin/backfill` HTTP endpoint is a **placeholder stub** — it returns `{ "data": { "jobId": null } }` and does not trigger a real backfill job. Use the CLI path below.

### Production Path (CLI)

```bash
# Full backfill — 2021-01-01 to today (default)
npm run backfill
# or via Makefile
make backfill

# Custom date range
npm run backfill -- --start 2024-01-01 --end 2024-01-31

# Custom date range + specific sources + batch size
npm run backfill -- --start 2024-01-08 --end 2024-01-14 --sources reuters,moneycontrol --batch 50

# Check progress
npm run backfill:status
# or
make backfill-status
```

**The CLI path:** `start-backfill.ts` → `BackfillEngine.startJob()` → enqueues to `news.backfill` → consumed by `src/workers/backfill.worker.ts`.

### Worker must be running

```bash
npm run worker:backfill
# or via Makefile
make worker-backfill
```

---

## Job Configuration (CLI flags for `npm run backfill`)

| Parameter | Default | Description |
|-----------|---------|-------------|
| `--start` | `2021-01-01T00:00:00.000Z` | Start of historical window |
| `--end` | Today | End of historical window |
| `--batch` | `100` | Articles per checkpoint batch (1–1000) |
| `--sources` | all enabled | Comma-separated source IDs |

---

## Processing Stages

Each backfill batch runs articles through the full pipeline in order:

1. **Normalization** — HTML stripping, language detection, hash computation
2. **Deduplication** — cluster assignment or new cluster creation
3. **Entity extraction** — NER + InstrumentMaster resolution
4. **Event detection** — structured NewsEvent extraction
5. **Sentiment** — 5-dimensional sentiment scoring
6. **Impact** — directional impact predictions per asset
7. **Feature engineering** — FeatureVector assembly with point-in-time guard

**Point-in-time correctness is fully enforced during backfill.** If any stage uses data with a timestamp > the article's `event_timestamp`, a `LookAheadBiasError` is raised and that article is skipped. This ensures that backfilled FeatureVectors are indistinguishable from ones produced during live ingestion.

---

## Checkpoint / Resume Behavior

The BackfillEngine writes a checkpoint to PostgreSQL after every successfully processed batch. The checkpoint records:

| Field | Description |
|-------|-------------|
| `job_id` | Backfill job identifier |
| `current_date_cursor` | UTC timestamp of the last successfully processed article |
| `articles_processed` | Cumulative count |
| `articles_failed` | Cumulative failed count |
| `last_checkpoint_at` | UTC timestamp of this checkpoint write |

Checkpoint persistence must complete within 2 seconds of batch completion. If it does not, the batch is retried from the last successful checkpoint.

**Resuming after interruption**: When a backfill process is restarted with the same `job_id`, it reads the last checkpoint and resumes from `current_date_cursor`. Articles already recorded as processed are not reprocessed.

This means you can safely kill and restart a backfill job at any time without data loss or duplication.

---

## Pause / Resume / Cancel

Once a job is running, use the admin API to control it:

```
POST /api/v1/admin/backfill/{jobId}/pause
POST /api/v1/admin/backfill/{jobId}/resume
POST /api/v1/admin/backfill/{jobId}/cancel
```

**Timing**: Commands take effect within **one batch cycle** of being received. If a batch is in progress when the pause or cancel command arrives, the current batch completes before the command is applied.

| Operation | Effect |
|-----------|--------|
| `pause` | Suspends processing after current batch; checkpoint is written; job remains in the queue |
| `resume` | Resumes from last checkpoint |
| `cancel` | Terminates the job; no further batches; checkpoint is preserved for audit |

**Response**

```json
{ "job_id": "backfill-...", "status": "paused" }
```

---

## Concurrency Limits

Backfill jobs run with a configurable concurrency cap:

| Variable | Default | Range | Description |
|----------|---------|-------|-------------|
| `BACKFILL_MAX_CONCURRENCY` | `2` | 1–20 | Max concurrent backfill workers |
| `BACKFILL_MAX_LIVE_QUEUE_SHARE` | `0.20` | — | Max fraction of live BullMQ worker concurrency backfill may consume |

While backfill jobs are running, the BackfillEngine monitors total BullMQ worker concurrency and limits backfill to 20% of that total. This ensures live ingestion throughput is not starved by a large backfill job.

To run a faster backfill (e.g., during a maintenance window with no live traffic), temporarily increase `BACKFILL_MAX_CONCURRENCY` and restart the backfill workers.

---

## Point-in-Time Correctness During Backfill

All data-service queries during backfill use `asOf = article.event_timestamp`. This is identical to the live pipeline behaviour and guarantees that:

1. Historical market data used in FeatureVectors reflects only what was known at the time of the event.
2. Labels in TrainingSamples are not contaminated with future information.
3. The resulting dataset can be used directly for ML model training without look-ahead bias.

If the data-service returns data with a timestamp > `event_timestamp` for any request, the article is skipped with a `LookAheadBiasError` log entry and counted in `articles_failed`. It is not retried.

---

## Monitoring a Running Backfill

Check queue status via:

```
GET /api/v1/admin/queues
```

Look for the `news.backfill` entry:

```json
{
  "name": "news.backfill",
  "depth": 12,
  "throughput_rpm": 45,
  "error_rate": 0.002,
  "dlq_count": 1
}
```

For article-level errors during backfill, check:

```
GET /api/v1/admin/ingestion
```

The `errors` array will include `news_processing_errors` records with `stage = "backfill"` for any articles that failed.

---

## Phase 3B Gate — Do Not Backfill Until

The historical backfill (2024-01-01 → present) must not begin until ALL of the following are confirmed:

| Pre-condition | Status | Verified by |
|---|---|---|
| 5-minute smoke test passed | ✓ DONE | PHASE3A_SMOKE_TEST.md |
| 1-hour live run stable | ✓ DONE | PHASE3A_RUNTIME_CERTIFICATION_REPORT.md |
| Look-ahead check passes on populated DB | ✓ DONE | `npx tsx tests/ci/look-ahead-check.ts` |
| Entity resolution validated | ✓ DONE | 26.1% rate, 2-layer resolution working |
| Regime integration fixed | ✓ DONE | MlServiceClient wired |
| Stale-data protection verified | ✓ DONE | DataFreshness.ts deployed |
| ML feature contract finalized | ✓ DONE | docs/SENTINELPULSE_ML_FEATURE_CONTRACT.md |

**Recommended backfill range for Phase 3B:** Start with 2024-01-01 to present with `batchSize=50`.

**ET historical content note:** The Economic Times RSS feed includes articles dating back to 2009–2010. For the backfill, use a date filter: `startDate >= 2024-01-01`. The LookAheadGuard will block feature generation on old articles where `sentiment.computedAt > article.publishedAt` — this is correct behavior for real-time sentiment, but will reduce feature coverage for historical data. For historical backfill, a dedicated backfill-mode sentiment engine that uses the article's original publication time as `computedAt` will be needed (Phase 3B scope).
