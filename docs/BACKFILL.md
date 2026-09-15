# Backfill Guide

## Overview

The BackfillEngine reprocesses historical news articles through the full pipeline. It is used to:

- Populate the feature store from historical data after a fresh deployment
- Recompute features under a new `feature_version` without losing prior version records
- Recover from pipeline outages where articles were ingested but not fully processed

Backfill jobs run on the `news.backfill` BullMQ queue and are subject to a concurrency cap to avoid starving the live ingestion pipeline.

---

## Job Configuration

Backfill jobs are created via:

```
POST /api/v1/admin/backfill
Authorization: Bearer {api_key}
```

**Request Body**

```json
{
  "startDate": "2024-01-01T00:00:00.000Z",
  "endDate":   "2024-01-07T23:59:59.999Z",
  "sources":    ["reuters", "moneycontrol"],
  "categories": ["NIFTY50", "BANKNIFTY"],
  "assets":     ["RELIANCE.NS", "INFY.NS"],
  "batchSize":  100
}
```

| Parameter | Type | Required | Constraints | Description |
|-----------|------|----------|-------------|-------------|
| `startDate` | ISO 8601 UTC | Yes | Must be before `endDate` | Start of historical window |
| `endDate` | ISO 8601 UTC | Yes | Must be after `startDate` | End of historical window |
| `sources` | string[] | Yes | 1–50 entries | Source IDs to include |
| `categories` | string[] | No | Taxonomy category names | Filter articles by primary category |
| `assets` | string[] | No | Asset IDs from InstrumentMaster | Filter articles by linked asset |
| `batchSize` | integer | No | 1–1000; default 100 | Articles per checkpoint batch |

If `startDate >= endDate`, the API returns `HTTP 400` with an error indicating an invalid date range.

**Response**

```json
{
  "job_id": "backfill-550e8400-e29b-41d4-a716-446655440000",
  "status": "queued"
}
```

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
