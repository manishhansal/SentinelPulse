# SentinelPulse Source Adapters

SentinelPulse supports six news sources via pluggable `NewsSourceAdapter` implementations. Each adapter encapsulates all connection, authentication, and normalisation logic for its source.

## Adapter Interface

All adapters implement the `NewsSourceAdapter` interface:

```typescript
interface NewsSourceAdapter {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly adapterVersion: string;
  readonly tier: 1 | 2;

  healthCheck(): Promise<HealthStatus>;
  fetchLatest(options: FetchOptions): Promise<RawArticle[]>;
  fetchHistorical(options: HistoricalFetchOptions): Promise<RawArticle[]>;
  normalize(raw: RawArticle): NormalizedArticle;
  getRateLimit(): RateLimitConfig;
}
```

Every adapter passes all outbound URLs through `SsrfGuard.validateOutboundUrl()` before making HTTP requests. The allowlist of permitted domains is configured via `ALLOWED_SOURCE_DOMAINS`.

---

## Tier Classification

| Tier | Sources | Polling Priority |
|------|---------|-----------------|
| **Tier-1** | Reuters, Moneycontrol, Economic Times | Polled first in every scheduling cycle; Tier-2 sources do not start until all Tier-1 sources have been polled or returned non-healthy |
| **Tier-2** | Bloomberg, Financial Times, CoinDesk | Polled after all Tier-1 sources complete |

---

## Reuters

| Property | Value |
|----------|-------|
| **Adapter file** | `src/adapters/reuters/ReutersAdapter.ts` |
| **Source ID** | `reuters` |
| **Tier** | 1 |
| **Fetch mechanism** | RSS / Atom feed |
| **Feed URL** | `https://feeds.reuters.com/reuters` (configured via `NEWS_SOURCE_REUTERS_BASE_URL`) |
| **Rate limit** | No hard API limit; default poll interval 60s |
| **Authentication** | None required for public RSS feeds |
| **Default poll interval** | 60,000 ms |

**Environment Variables**

| Variable | Description | Default |
|----------|-------------|---------|
| `NEWS_SOURCE_REUTERS_ENABLED` | Enable/disable this source | `true` |
| `NEWS_SOURCE_REUTERS_BASE_URL` | Base URL for Reuters RSS | `https://feeds.reuters.com/reuters` |
| `NEWS_SOURCE_REUTERS_POLL_INTERVAL_MS` | Poll interval in milliseconds | `60000` |

**Known Limitations**

- Public RSS feeds do not include full article body; `content` field is limited to the feed summary. Full content requires scraping the article URL, which is subject to Reuters ToS.
- Feed may lag up to 2 minutes behind live publication.
- Category data in the RSS feed is coarse-grained; taxonomy assignment is applied by the NormalizationEngine.

---

## Moneycontrol

| Property | Value |
|----------|-------|
| **Adapter file** | `src/adapters/moneycontrol/MoneycontrolAdapter.ts` |
| **Source ID** | `moneycontrol` |
| **Tier** | 1 |
| **Fetch mechanism** | RSS feed |
| **Feed URL** | `https://www.moneycontrol.com` (configured via `NEWS_SOURCE_MONEYCONTROL_BASE_URL`) |
| **Rate limit** | No published API limit; adapter respects 60s default poll interval |
| **Authentication** | None |
| **Default poll interval** | 60,000 ms |

**Environment Variables**

| Variable | Description | Default |
|----------|-------------|---------|
| `NEWS_SOURCE_MONEYCONTROL_ENABLED` | Enable/disable | `true` |
| `NEWS_SOURCE_MONEYCONTROL_BASE_URL` | Base URL | `https://www.moneycontrol.com` |
| `NEWS_SOURCE_MONEYCONTROL_POLL_INTERVAL_MS` | Poll interval | `60000` |

**Known Limitations**

- Strong focus on Indian equities (NSE/BSE); global macro coverage is limited.
- RSS feed structure may change without notice; adapter version tracks the schema version.
- Articles occasionally carry incorrect publication timestamps; `timestamp_inferred` flag is set when `publishedAt` is absent.

---

## Economic Times

| Property | Value |
|----------|-------|
| **Adapter file** | `src/adapters/economic-times/EconomicTimesAdapter.ts` |
| **Source ID** | `economictimes` |
| **Tier** | 1 |
| **Fetch mechanism** | RSS feed |
| **Feed URL** | `https://economictimes.indiatimes.com` (configured via `NEWS_SOURCE_ECONOMICTIMES_BASE_URL`) |
| **Rate limit** | No published limit; 60s poll interval |
| **Authentication** | None |
| **Default poll interval** | 60,000 ms |

**Environment Variables**

| Variable | Description | Default |
|----------|-------------|---------|
| `NEWS_SOURCE_ECONOMICTIMES_ENABLED` | Enable/disable | `true` |
| `NEWS_SOURCE_ECONOMICTIMES_BASE_URL` | Base URL | `https://economictimes.indiatimes.com` |
| `NEWS_SOURCE_ECONOMICTIMES_POLL_INTERVAL_MS` | Poll interval | `60000` |

**Known Limitations**

- RSS feed contains significant ad and boilerplate HTML; the NormalizationEngine strips these before content storage.
- Hindi-language articles may appear in the feed; language detection sets `language` to `hi` and `language_confidence` accordingly.
- Duplicate articles from syndicated content are common; the DeduplicationEngine handles these via title Jaro-Winkler and content embedding similarity.

---

## Bloomberg

| Property | Value |
|----------|-------|
| **Adapter file** | `src/adapters/bloomberg/BloombergAdapter.ts` |
| **Source ID** | `bloomberg` |
| **Tier** | 2 |
| **Fetch mechanism** | Bloomberg API (paid subscription required) |
| **Base URL** | `https://www.bloomberg.com` (configured via `NEWS_SOURCE_BLOOMBERG_BASE_URL`) |
| **Rate limit** | Governed by Bloomberg API subscription tier |
| **Authentication** | API key via `NEWS_SOURCE_BLOOMBERG_API_KEY` header |
| **Default poll interval** | 120,000 ms |

**Environment Variables**

| Variable | Description | Default |
|----------|-------------|---------|
| `NEWS_SOURCE_BLOOMBERG_ENABLED` | Enable/disable | `false` (disabled by default — requires paid API key) |
| `NEWS_SOURCE_BLOOMBERG_BASE_URL` | API base URL | `https://www.bloomberg.com` |
| `NEWS_SOURCE_BLOOMBERG_API_KEY` | Bloomberg API key | — |
| `NEWS_SOURCE_BLOOMBERG_POLL_INTERVAL_MS` | Poll interval | `120000` |

**Known Limitations**

- Disabled by default. Set `NEWS_SOURCE_BLOOMBERG_ENABLED=true` and provide a valid `NEWS_SOURCE_BLOOMBERG_API_KEY` to activate.
- API rate limits vary by subscription tier; consult Bloomberg API documentation for your plan.
- Paywall-protected articles return metadata only (no full body) without a content-enabled subscription.
- The adapter aborts any fetch that does not receive a response within 10 seconds.

---

## Financial Times

| Property | Value |
|----------|-------|
| **Adapter file** | `src/adapters/financial-times/FinancialTimesAdapter.ts` |
| **Source ID** | `financialtimes` |
| **Tier** | 2 |
| **Fetch mechanism** | FT Content API (CAPI) |
| **Base URL** | `https://www.ft.com` (configured via `NEWS_SOURCE_FINANCIALTIMES_BASE_URL`) |
| **Rate limit** | Governed by FT CAPI subscription |
| **Authentication** | API key via `NEWS_SOURCE_FINANCIALTIMES_API_KEY` |
| **Default poll interval** | 120,000 ms |

**Environment Variables**

| Variable | Description | Default |
|----------|-------------|---------|
| `NEWS_SOURCE_FINANCIALTIMES_ENABLED` | Enable/disable | `false` |
| `NEWS_SOURCE_FINANCIALTIMES_BASE_URL` | CAPI base URL | `https://www.ft.com` |
| `NEWS_SOURCE_FINANCIALTIMES_API_KEY` | FT CAPI key | — |
| `NEWS_SOURCE_FINANCIALTIMES_POLL_INTERVAL_MS` | Poll interval | `120000` |

**Known Limitations**

- Disabled by default. A valid FT CAPI subscription and API key are required.
- Full article body availability depends on the CAPI tier; some articles return summary only.
- Strong UK/European market bias; India-specific coverage is limited compared to Tier-1 sources.

---

## CoinDesk

| Property | Value |
|----------|-------|
| **Adapter file** | `src/adapters/coindesk/CoinDeskAdapter.ts` |
| **Source ID** | `coindesk` |
| **Tier** | 2 |
| **Fetch mechanism** | RSS feed |
| **Base URL** | `https://www.coindesk.com` (configured via `NEWS_SOURCE_COINDESK_BASE_URL`) |
| **Rate limit** | No published limit; 5-minute poll interval by default |
| **Authentication** | None |
| **Default poll interval** | 300,000 ms |

**Environment Variables**

| Variable | Description | Default |
|----------|-------------|---------|
| `NEWS_SOURCE_COINDESK_ENABLED` | Enable/disable | `false` |
| `NEWS_SOURCE_COINDESK_BASE_URL` | Base URL | `https://www.coindesk.com` |
| `NEWS_SOURCE_COINDESK_POLL_INTERVAL_MS` | Poll interval | `300000` |

**Known Limitations**

- Disabled by default; crypto coverage is optional for most AlphaForge deployments.
- Coverage is limited to crypto assets (BTC, ETH, altcoins, crypto regulation). Macro and equity coverage is minimal.
- RSS feed may aggregate content from CoinDesk partner publications; `source_id` is always `coindesk` regardless of original publisher.

---

## Adding a New Adapter

1. Create a new directory under `src/adapters/{source-name}/`.
2. Implement the `NewsSourceAdapter` interface (extend the abstract base class in `src/adapters/base/NewsSourceAdapter.ts`).
3. Register the adapter in the Scheduler's source registry.
4. Add the required environment variables to `.env.example`.
5. **Update this document** (`SOURCE_ADAPTERS.md`) with the new source's feed URL, rate limits, auth method, and known limitations **before merging**.

> The CI pipeline verifies that a `SOURCE_ADAPTERS.md` diff is present in any pull request that adds a new adapter file, and blocks the merge if the documentation update is absent (Req 34.5).

---

## Scrapling Sidecar

Where no official RSS or API feed is available, adapters can delegate HTML extraction to the Scrapling Python sidecar:

```
POST http://{SCRAPLING_URL}/scrape
Body: { url, sourceName, selectors: { title, content, author?, publishedAt? } }
```

The sidecar handles:
- robots.txt compliance
- Per-source rate limit enforcement
- ToS constraint adherence

The sidecar is configured via `SCRAPLING_URL` (default: `http://localhost:8001`). Its source code is in `docker/scrapling_service.py`.

Currently, none of the six production adapters require the Scrapling sidecar — all use official RSS feeds or APIs.
