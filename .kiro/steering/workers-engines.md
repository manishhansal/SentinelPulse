---
inclusion: fileMatch
fileMatchPattern: "src/{workers,engines,queue}/**"
---

# Workers & Engines — Karpathy Guidelines (Service-Specific)

> Applies on top of `karpathy-guidelines.md` when working in `src/workers/`, `src/engines/`, or `src/queue/`.

## Think Before Coding

- The pipeline is a **strict linear queue chain**: normalize → dedup → entity → event → sentiment → impact → feature → embed. Each worker consumes one queue and publishes to the next. Before adding a step or changing queue names, state the full before/after pipeline topology.
- BullMQ job payloads are the contract between workers. A payload shape change is a breaking change for the consuming worker. State both the producer and consumer impacts before changing a job type.
- `LookAheadGuard` is called in the **feature worker** to enforce PIT correctness. Do not move, skip, or call it earlier — the feature worker is the correct enforcement point.
- The `HistoricalReactionEngine` uses OHLCV data fetched from data-service. Any change to how it constructs the as-of timestamp must be verified against `LookAheadGuard` compliance.

## Simplicity First

- Engines are **stateless logic modules** — they take inputs and return outputs with no side effects. Do not add database writes inside an engine; those belong in the worker that calls the engine.
- The `ImportanceEngine` aggregates 9 sub-scores. Do not add a 10th sub-score as a side effect of another change — each sub-score is a deliberate design decision.
- Do not add direct worker-to-worker function calls. All inter-worker communication must go through BullMQ queues.

## Surgical Changes

- `src/engines/historical-reaction/` is the most PIT-sensitive engine — do not touch it without running `npm run test:lookahead` before and after.
- `src/engines/sentiment/` produces 5 sentiment dimensions and 9 qualitative signals. Do not change dimension names — they are consumed by ml-service as feature columns.
- The `backfill.worker.ts` is a separate CLI worker, not part of the live pipeline chain. Do not add backfill logic to the live pipeline workers.
- `src/queue/` contains the BullMQ queue definitions. Do not create ad-hoc queues inline in worker files.

## Goal-Driven Execution

- For engine changes: success = the engine returns a valid output for a known-good fixture input, verified by vitest.
- For worker changes: success = worker consumes a mock job → processes it → publishes a correctly shaped output job, verified by vitest with a BullMQ mock.
- For pipeline topology changes: success = a full end-to-end test with a fixture article produces a `TrainingSample` with the correct fields.
- Run `npm run test:lookahead` for any change touching feature engineering or historical reaction engines.
