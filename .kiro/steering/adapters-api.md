---
inclusion: fileMatch
fileMatchPattern: "src/{adapters,api,integrations,security}/**"
---

# Adapters, API & Integrations — Karpathy Guidelines (Service-Specific)

> Applies on top of `karpathy-guidelines.md` when working in `src/adapters/`, `src/api/`, `src/integrations/`, or `src/security/`.

## Think Before Coding

- Each adapter (`reuters`, `economic-times`, `moneycontrol`, `financial-times`, `bloomberg`, `coindesk`) has its own scraping pattern, rate limit, and circuit breaker. Before adding a new adapter, confirm a circuit breaker instance and per-adapter rate limiter are part of the design.
- `src/integrations/ml-service/` calls ml-service (8100). Any change to how SentinelPulse invokes ml-service must be checked against ml-service's API contract (authentication via `X-API-KEY`, paths under `/v2/`).
- `src/integrations/data-service/` calls data-service (8200). Timestamp handling in this client is the root cause of past RC-1/RC-2 bugs — state your assumption about timestamp format before making changes.
- `src/security/` contains the SSRF guard. Before allowing a new outbound domain in any adapter, verify it passes the SSRF guard allowlist logic.

## Simplicity First

- Adapter base class lives in `src/adapters/base/`. New adapters extend it — do not duplicate auth, retry, or circuit-breaker logic per adapter.
- API routes (`src/api/`) are thin Fastify handlers. Business logic belongs in engines, not routes.
- The Scrapling integration (`src/integrations/scrapling/`) is a sidecar for JavaScript-rendered pages. Do not use it for sources that serve static HTML — use direct HTTP fetching.

## Surgical Changes

- Do not modify the `news.raw` queue payload shape in an adapter — that shape is the contract for the `normalize.worker`.
- API routes in `src/api/alphaforge/` and `src/api/ml/` are consumed by external services. Breaking these contracts requires coordinating the change with alpha-forge and ml-service.
- `src/security/` — treat this like the credential stripper in data-service. Do not change security logic as a side effect of feature work.

## Goal-Driven Execution

- For new adapters: success = adapter returns an array of raw articles with the correct fields, passes the SSRF guard, has a circuit breaker, verified by vitest with HTTP mocks.
- For API changes: success = route returns correct response shape and status code for happy path and error cases, verified by vitest.
- For integration client changes: success = client calls the correct endpoint with correct headers, handles 4xx/5xx gracefully, verified by vitest with a mock server.
