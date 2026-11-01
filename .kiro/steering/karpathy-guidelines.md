# Karpathy-Inspired Coding Guidelines — SentinelPulse

> Derived from Andrej Karpathy's observations on LLM coding pitfalls.
> Source: https://github.com/multica-ai/andrej-karpathy-skills
>
> **Tradeoff:** These guidelines bias toward caution over speed.
> For trivial tasks (a typo fix, an obvious one-liner) use judgment.

---

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing anything:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

**In this project specifically:**
- SentinelPulse is a **point-in-time correct** news intelligence pipeline. Every stage of the pipeline has a strict as-of timestamp. Before touching any feature calculation, impact score, or reaction engine, state explicitly what the PIT anchor is — `pitAnchorPublishedAt` vs `prediction_timestamp` vs `feature_as_of`.
- `LookAheadGuard` is the PIT enforcement boundary. Any code path that accesses OHLCV data must pass through it. State whether your change touches or bypasses it before proceeding.
- The 8 BullMQ workers run as separate processes — changes to a queue message schema (job payload shape) are breaking changes for all downstream workers. Flag the impact before changing any BullMQ job type.
- `CircuitBreaker` is per-adapter. Before adding a new news source adapter, confirm it has its own circuit breaker instance and rate limiter.
- Do not assume the OpenAI API key is present — the embed worker is designed to SKIP gracefully when it isn't. Do not add hard dependencies on the embedding step elsewhere.

---

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: *Would a senior TS/Node engineer say this is overcomplicated?* If yes, simplify.

**In this project specifically:**
- There are already 15+ engines (normalization, dedup, entity, event, sentiment, impact, feature, embedding, velocity, breadth, market-regime, historical-analogue, historical-reaction, event-clustering, importance). Do not add a new engine when the task can be handled by extending an existing one.
- BullMQ workers follow a consistent pattern: consume a queue → process → publish to the next queue. Do not break this pattern by adding direct function calls between workers.
- Zod is the validation layer. Do not add a second validation library (e.g., `joi`, `yup`). All new schemas go through Zod.
- Do not add new npm dependencies without explicit user approval — check `package.json` first.

---

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style (Pino logging, Zod schemas, BullMQ job patterns, async/await, strict TypeScript).
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:
- Remove imports/types/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: *Every changed line should trace directly to the user's request.*

**In this project specifically:**
- `news_training_samples` schema has `lookAheadValidated` and `pitAnchorPublishedAt` fields that are PIT audit fields — do not remove or rename them as a side effect.
- Prisma schema changes require a migration. Do not alter `prisma/schema.prisma` without also noting that `prisma migrate dev` must be run.
- The `InstrumentIndex` (34K instruments) is a shared in-memory lookup. Do not reload or reconstruct it as a side effect of unrelated changes.
- Adapter files in `src/adapters/` are isolated per news source. Do not add cross-adapter logic.
- `src/security/` (SSRF guard, credential validation) — do not touch unless the task is explicitly security-related.

---

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add a news adapter" → "Adapter returns normalized articles that pass the normalize.worker schema, with its own circuit breaker, verified by unit tests"
- "Fix sentiment scoring" → "Write a test with known-good article → expected sentiment dimensions, then make it pass"
- "Add a new BullMQ worker" → "Worker consumes correct queue, publishes to correct queue, handles failures gracefully — verified by vitest"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

**In this project specifically:**
- Run `npm test` (vitest run) before and after any change. **578 tests must stay green.**
- PIT correctness has a dedicated check: `npm run test:lookahead`. Run it when touching any feature, impact, or reaction engine.
- New BullMQ workers must have a corresponding test that exercises the consume → process → publish path.
- Coverage target: run `npm run test:coverage` and verify no regression.

---

## Architecture Snapshot

| Layer | Path | Notes |
|-------|------|-------|
| API | `src/api/` | Fastify routes: news, ml, alphaforge, admin |
| Workers | `src/workers/` | 8 BullMQ workers (normalize→dedup→entity→event→sentiment→impact→feature→embed) |
| Engines | `src/engines/` | 15+ processing engines (stateless logic) |
| Adapters | `src/adapters/` | Per-source news scrapers (Reuters, ET, Moneycontrol, FT, Bloomberg, CoinDesk) |
| Integrations | `src/integrations/` | Clients for data-service, ml-service, Scrapling |
| Queue | `src/queue/` | BullMQ queue definitions |
| DB | `src/db/` | Prisma client + migrations |
| Cache | `src/cache/` | Redis (ioredis) |
| Observability | `src/observability/` | Pino logging, Prometheus (prom-client) |
| Security | `src/security/` | SSRF guard, credential validation |

**Stack:** TypeScript · Node ≥20 · Fastify · BullMQ · Prisma · PostgreSQL · Redis · Vitest · Zod · Pino
**Tests:** 578 ✓ | **PIT enforced by:** LookAheadGuard
