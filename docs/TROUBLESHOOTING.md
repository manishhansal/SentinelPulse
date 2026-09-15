# SentinelPulse Troubleshooting Guide

## Quick Reference

| Symptom | Section |
|---------|---------|
| Reuters / Moneycontrol / Economic Times not fetching | [Tier-1 Source Outage](#tier-1-source-outage) |
| Redis connection errors or cache misses | [Redis Unavailable](#redis-unavailable) |
| FeatureVectors not being computed; data-service timeouts | [data-service Timeout](#data-service-timeout) |
| LookAheadBiasError in logs | [Look-Ahead Bias Errors](#look-ahead-bias-errors) |
| Dead-letter queues growing | [DLQ Accumulation](#dlq-accumulation) |
| Semantic search returning stale or no results | [Embedding Service Degradation](#embedding-service-degradation) |

---

## Tier-1 Source Outage

**Symptoms**
- `sentinel_source_health{source_name="reuters"}` (or moneycontrol / economictimes) is `0`
- WARN log: `"Source health check failed"` with the source name
- `news.raw` queue depth is not growing
- `GET /api/v1/admin/sources` shows `"health": false` or `"cb_state": "OPEN"` for the affected source

**Impact**

A Tier-1 outage reduces news coverage but does not stop the pipeline for other sources. Tier-2 sources continue unaffected. Existing articles continue flowing through the pipeline.

**Runbook**

1. **Identify the failing source**:
   ```bash
   curl -H "Authorization: Bearer $SENTINEL_API_KEY" \
     http://localhost:3000/api/v1/admin/sources \
     | jq '.data.sources[] | select(.health == false)'
   ```

2. **Check the circuit breaker state** (`cb_state`). If `OPEN`, the source is automatically blocked. The circuit will transition to `HALF_OPEN` after `CB_RECOVERY_TIMEOUT_MS` (default 60s) and attempt a probe fetch.

3. **Check external feed availability**:
   - Reuters: `curl -I https://feeds.reuters.com/reuters`
   - Moneycontrol: `curl -I https://www.moneycontrol.com`
   - Economic Times: `curl -I https://economictimes.indiatimes.com`

4. **Check logs** for error details:
   ```bash
   # Filter for the failing source
   grep '"sourceId":"reuters"' /var/log/sentinel-pulse.log | grep '"level":"ERROR"' | tail -20
   ```

5. **If the source feed is restored**: The circuit breaker will auto-recover after the recovery timeout. No manual intervention is needed unless the circuit has been open for > 15 minutes.

6. **If the source is down for > 30 minutes**: Consider disabling it temporarily to reduce noise:
   ```bash
   # Set NEWS_SOURCE_REUTERS_ENABLED=false and restart the relevant worker
   ```

7. **After recovery**: Monitor `sentinel_source_health` to confirm it returns to `1`. Check `GET /api/v1/admin/ingestion` for any backlog of failed ingestion runs.

---

## Redis Unavailable

**Symptoms**
- WARN log: `"Redis connection unavailable"` or `"Cache miss"` with Redis as the reason
- API responses are slower than usual (falling back to PostgreSQL)
- BullMQ jobs are not being enqueued (workers will stall)
- `GET /ready` returns `503`

**Impact**

Two separate Redis concerns:

1. **Cache unavailability**: Non-fatal. The service automatically falls back to direct PostgreSQL queries. Performance degrades but correctness is maintained.
2. **BullMQ queue unavailability**: Fatal to pipeline processing. Workers cannot dequeue jobs, and new articles cannot be enqueued.

**Runbook**

1. **Check Redis connectivity**:
   ```bash
   redis-cli -u $REDIS_URL ping
   # Expected: PONG
   ```

2. **Check Redis health** (memory, persistence):
   ```bash
   redis-cli -u $REDIS_URL info memory
   redis-cli -u $REDIS_URL info persistence
   ```

3. **If Redis is a memory issue**: Check `used_memory_rss` vs `maxmemory`. If near the limit, consider increasing `maxmemory` or evicting stale keys.

4. **If Redis is restarting**: Check if `aof-rewrite-in-progress` or an AOF corruption is the cause. Check Docker/system logs:
   ```bash
   docker logs sentinel-redis --tail 100
   ```

5. **While Redis is down**:
   - The API continues serving from PostgreSQL. Response times will be higher.
   - New articles fetched from sources cannot be enqueued — they will be dropped with errors logged.
   - Consider pausing source adapters to prevent dropped articles.

6. **After Redis recovers**:
   - Workers will automatically reconnect and resume dequeuing.
   - Cache keys will be repopulated on next access (no manual cache warming needed).
   - Check DLQ counts — articles that failed during the outage may have landed there.

---

## data-service Timeout

**Symptoms**
- WARN log: `"data-service timeout"` with `data_service_timeout: true`
- `news_market_reactions` records have null return fields with `data_service_timeout = true`
- FeatureVectors are not being computed (`feature-worker` jobs are failing or being skipped)
- `GET /api/v1/admin/data-quality` shows declining `high_importance_events_with_reactions_pct`

**Impact**

- `HistoricalReactionEngine` records null returns for all offsets at the timed-out timestamp. This is expected and non-fatal — records are stored with null values rather than skipped.
- `FeatureEngineeringEngine` **aborts** FeatureVector computation for affected events (cannot compute market context features without data-service). The events are logged as failed.
- `MarketRegimeEngine` retains the last cached regime and logs WARN.

**Runbook**

1. **Confirm the issue is data-service, not SentinelPulse**:
   ```bash
   curl -H "Authorization: Bearer $DATA_SERVICE_API_KEY" \
     $DATA_SERVICE_URL/health
   ```

2. **Check data-service logs** for upstream errors or overload.

3. **Check SentinelPulse feature worker errors**:
   ```bash
   curl -H "Authorization: Bearer $SENTINEL_API_KEY" \
     http://localhost:3000/api/v1/admin/ingestion \
     | jq '.data.errors[] | select(.stage == "feature")'
   ```

4. **During sustained outage**: The feature pipeline stalls for affected events. Impact and sentiment pipeline stages are unaffected (they do not require data-service).

5. **After data-service recovers**: Events that failed during the outage will NOT be automatically reprocessed. To recover them:
   - Identify the time window when data-service was unavailable.
   - Run a targeted backfill job for that window:
     ```bash
     curl -X POST -H "Authorization: Bearer $SENTINEL_API_KEY" \
       -H "Content-Type: application/json" \
       -d '{"startDate":"<outage_start>","endDate":"<outage_end>","sources":["reuters","moneycontrol","economictimes"],"batchSize":50}' \
       http://localhost:3000/api/v1/admin/backfill
     ```

6. **If timeouts are chronic**: Consider increasing the data-service timeout (it is currently hardcoded at 10 seconds per request). Alternatively, reduce `WORKER_FEATURE_CONCURRENCY` to reduce concurrent load on data-service.

---

## Look-Ahead Bias Errors

**Symptoms**
- ERROR log: `"Look-ahead bias detected — aborting"` with a `correlationId`
- FeatureVectors are missing for certain events
- CI look-ahead check fails (`npm run ci:look-ahead-check`)

**Impact**

A `LookAheadBiasError` is a **hard abort** — the FeatureVector is never persisted. This is the correct behaviour. It protects the ML dataset from contamination with future information.

**Runbook**

1. **Identify the affected event**:
   ```bash
   grep 'LookAheadBiasError' /var/log/sentinel-pulse.log \
     | jq '{correlationId, message, metadata}'
   ```

2. **Determine the root cause**:
   - Was this a data-service response that included data from after `event_timestamp`? This can happen if the data-service `asOf` parameter is being ignored or incorrectly applied.
   - Was this a clock skew issue (server clock drift causing `event_timestamp` to appear in the past)?
   - Was this a pipeline bug where a feature computation bypassed the `LookAheadGuard`?

3. **For data-service `asOf` issues**:
   - Confirm the `DataServiceClient.getOHLCV()` call includes `asOf = event.event_timestamp`.
   - Log the raw data-service response to verify returned timestamps.

4. **For clock skew**: Ensure NTP is configured on all servers. The `scraped_at` timestamp used when `published_at` is missing can be affected by clock drift.

5. **For CI failures**: The look-ahead check (`tests/ci/look-ahead-check.ts`) reports the offending record IDs and feature names. Do not override or skip the check — the records must be investigated and corrected.

6. **Reprocessing**: After fixing the root cause, run a backfill for the affected time window. The backfill will generate correct FeatureVectors.

---

## DLQ Accumulation

**Symptoms**
- `sentinel_queue_depth{queue_name=~"news.*.deadletter"}` is growing
- `GET /api/v1/admin/queues` shows `dlq_count > 0` for one or more queues
- Increasing `sentinel_articles_failed_total` counter

**Impact**

Jobs in the DLQ are preserved and not lost. However, they represent articles or events that did not complete the pipeline. Growing DLQs indicate a systemic issue with a pipeline stage.

**Runbook**

1. **Identify which DLQ is accumulating**:
   ```bash
   curl -H "Authorization: Bearer $SENTINEL_API_KEY" \
     http://localhost:3000/api/v1/admin/queues \
     | jq '.data.queues[] | select(.dlq_count > 0)'
   ```

2. **Inspect DLQ job errors** via the BullMQ dashboard or Redis directly:
   ```bash
   redis-cli -u $REDIS_URL LRANGE "bull:news.normalize.deadletter:failed" 0 9
   ```

3. **Common causes by stage**:

   | Stage | Common DLQ Causes |
   |-------|------------------|
   | `news.raw` | Source returning malformed JSON; network timeout on source fetch |
   | `news.normalized` | HTML parser crash on malformed HTML; encoding issues |
   | `news.deduplicated` | PostgreSQL query timeout on large embedding search |
   | `news.entities` | data-service InstrumentMaster lookup timeout |
   | `news.sentiment` | Sentiment model API timeout or error |
   | `news.impact` | data-service timeout; missing HistoricalReaction data |
   | `news.features` | data-service timeout; LookAheadBiasError (see above) |

4. **Resolve the root cause** before replaying DLQ jobs. Replaying without fixing the root cause will just re-fail the same jobs.

5. **Replay DLQ jobs** (manual replay via BullMQ admin or Redis):
   ```bash
   # Move DLQ jobs back to the main queue for reprocessing
   # (Use BullMQ's job promotion API or your monitoring tool's replay feature)
   ```

6. **If DLQ growth is due to a temporary upstream outage**: Once the upstream recovers, replay the DLQ in batches to avoid overloading the worker.

---

## Embedding Service Degradation

**Symptoms**
- WARN or ERROR logs from `EmbeddingEngine`
- `news.embeddings` queue depth growing
- Semantic search (`GET /api/v1/news/search`) returning `"no results"` or stale results
- `GET /api/v1/news/events/similar` returning zero or low-quality analogues

**Impact**

- New articles and events are not getting embeddings. Semantic search quality degrades over time as new articles are missing from the index.
- Existing embeddings remain intact — old semantic search results still work for historical content.
- The rest of the pipeline (normalization, sentiment, impact, features) is unaffected.

**Runbook**

1. **Check the embedding service**:
   ```bash
   # Verify the API key is valid and the service is reachable
   curl -H "Authorization: Bearer $EMBEDDING_API_KEY" \
     https://api.openai.com/v1/models
   ```

2. **Check the `news.embeddings` queue depth**:
   ```bash
   curl -H "Authorization: Bearer $SENTINEL_API_KEY" \
     http://localhost:3000/api/v1/admin/queues \
     | jq '.data.queues[] | select(.name == "news.embeddings")'
   ```

3. **Check embed worker logs**:
   ```bash
   grep '"stage":"embed"' /var/log/sentinel-pulse.log | grep '"level":"ERROR"' | tail -20
   ```

4. **Expected auto-recovery behaviour**: The `EmbeddingEngine` enqueues failed entities back to `news.embeddings` with exponential backoff. Once the embedding service recovers, the queue will drain automatically.

5. **If the queue is very large (> 10,000 jobs)**: Consider temporarily reducing `WORKER_EMBED_CONCURRENCY` to spread the load during recovery rather than overwhelming the embedding API with burst traffic.

6. **Model version change**: If the embedding model has changed (new `EMBEDDING_MODEL` env var), the system marks old embeddings with the prior model_version and enqueues all existing entities for regeneration. This is expected and may cause the queue to grow temporarily. Monitor progress via queue depth.

7. **Semantic search accuracy**: During degradation, semantic search results reflect only entities that have already been embedded. Results will improve automatically as the embedding backlog clears.
