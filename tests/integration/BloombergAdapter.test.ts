/**
 * Integration tests for BloombergAdapter.
 *
 * All outbound HTTP calls are intercepted via vi.mock('axios') so that no
 * real network requests are made and the tests remain hermetic.
 *
 * Coverage targets (Req 31.2):
 *   - 200 success path  →  correct RawArticle[] produced
 *   - 429 rate-limited  →  retried, eventual success / correct retry count
 *   - 500 server error  →  retried, eventual failure
 *   - Malformed body    →  graceful empty-list return
 *   - Network timeout   →  no exception propagation
 *   - No API key        →  empty list + WARN log (no HTTP call)
 *   - normalize()       →  all required NormalizedArticle fields populated
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';

// ---------------------------------------------------------------------------
// We mock the axios *module* so that axios.create() returns a controlled spy.
// ---------------------------------------------------------------------------
vi.mock('axios');

// Helper: build a minimal Axios-like response object
function makeResponse(
  status: number,
  data: unknown,
): { status: number; data: unknown; headers: Record<string, string> } {
  return { status, data, headers: {} };
}

// A minimal valid Bloomberg API article
const MOCK_BLOOMBERG_ARTICLE = {
  id: 'bbl-001',
  headline: 'Fed Raises Rates by 25 Basis Points',
  summary: 'The Federal Reserve increased its benchmark interest rate.',
  body: 'In a widely expected move, the Federal Reserve raised rates.',
  byline: 'Jane Smith',
  publishedAt: '2024-03-15T14:30:00Z',
  topic: 'Monetary Policy',
  url: 'https://bloomberg.com/news/bbl-001',
};

describe('BloombergAdapter', () => {
  let httpGet: ReturnType<typeof vi.fn>;
  let httpPost: ReturnType<typeof vi.fn>;
  let BloombergAdapter: (typeof import('../../src/adapters/bloomberg/BloombergAdapter.js'))['BloombergAdapter'];

  beforeEach(async () => {
    // Reset env
    delete process.env['NEWS_SOURCE_BLOOMBERG_BASE_URL'];
    delete process.env['NEWS_SOURCE_BLOOMBERG_API_KEY'];
    delete process.env['ADAPTER_MAX_RETRIES'];
    delete process.env['ADAPTER_RETRY_BASE_DELAY_MS'];
    delete process.env['ALLOWED_SOURCE_DOMAINS'];

    // Speed up retries in tests
    process.env['ADAPTER_MAX_RETRIES'] = '2';
    process.env['ADAPTER_RETRY_BASE_DELAY_MS'] = '10';
    process.env['ALLOWED_SOURCE_DOMAINS'] = 'bloomberg.com,bloomberg-api.example.com';

    // Build fresh per-test axios instance mock
    httpGet = vi.fn();
    httpPost = vi.fn();

    const mockedAxios = vi.mocked(axios, true);
    mockedAxios.create = vi.fn().mockReturnValue({
      get: httpGet,
      post: httpPost,
    });
    mockedAxios.isAxiosError = vi.fn((e) => (e as { isAxiosError?: boolean }).isAxiosError === true);

    // Re-import with fresh mocks on each test
    vi.resetModules();
    const mod = await import('../../src/adapters/bloomberg/BloombergAdapter.js');
    BloombergAdapter = mod.BloombergAdapter;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // Identity / metadata
  // -----------------------------------------------------------------------

  it('exposes correct identity fields', () => {
    const adapter = new BloombergAdapter();
    expect(adapter.sourceId).toBe('bloomberg');
    expect(adapter.sourceName).toBe('Bloomberg');
    expect(adapter.adapterVersion).toBe('1.0.0');
    expect(adapter.tier).toBe(2);
  });

  it('returns a rate-limit config with a positive RPM', () => {
    const adapter = new BloombergAdapter();
    const rl = adapter.getRateLimit();
    expect(typeof rl.requestsPerMinute).toBe('number');
    expect((rl.requestsPerMinute ?? 0) > 0).toBe(true);
  });

  // -----------------------------------------------------------------------
  // healthCheck — no API key
  // -----------------------------------------------------------------------

  it('healthCheck returns unhealthy when no API key is configured', async () => {
    const adapter = new BloombergAdapter();
    const result = await adapter.healthCheck();
    expect(result.healthy).toBe(false);
    expect(result.message).toMatch(/api key not configured/i);
    expect(httpGet).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // healthCheck — with API key
  // -----------------------------------------------------------------------

  it('healthCheck returns healthy on HTTP 200', async () => {
    process.env['NEWS_SOURCE_BLOOMBERG_API_KEY'] = 'test-key';
    vi.resetModules();
    const mod = await import('../../src/adapters/bloomberg/BloombergAdapter.js');
    const adapter = new mod.BloombergAdapter();

    httpGet.mockResolvedValueOnce(makeResponse(200, { status: 'ok' }));

    const result = await adapter.healthCheck();
    expect(result.healthy).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(typeof result.latencyMs).toBe('number');
  });

  it('healthCheck returns unhealthy on HTTP 503', async () => {
    process.env['NEWS_SOURCE_BLOOMBERG_API_KEY'] = 'test-key';
    vi.resetModules();
    const mod = await import('../../src/adapters/bloomberg/BloombergAdapter.js');
    const adapter = new mod.BloombergAdapter();

    httpGet.mockResolvedValueOnce(makeResponse(503, {}));

    const result = await adapter.healthCheck();
    expect(result.healthy).toBe(false);
    expect(result.statusCode).toBe(503);
  });

  it('healthCheck returns unhealthy on network error', async () => {
    process.env['NEWS_SOURCE_BLOOMBERG_API_KEY'] = 'test-key';
    vi.resetModules();
    const mod = await import('../../src/adapters/bloomberg/BloombergAdapter.js');
    const adapter = new mod.BloombergAdapter();

    const networkErr = Object.assign(new Error('ECONNREFUSED'), { isAxiosError: true });
    httpGet.mockRejectedValueOnce(networkErr);

    const result = await adapter.healthCheck();
    expect(result.healthy).toBe(false);
    expect(result.message).toContain('ECONNREFUSED');
  });

  // -----------------------------------------------------------------------
  // fetchLatest — no API key returns empty list (with WARN log)
  // -----------------------------------------------------------------------

  it('fetchLatest returns empty array when no API key is configured', async () => {
    const adapter = new BloombergAdapter();
    const articles = await adapter.fetchLatest();
    expect(articles).toEqual([]);
    expect(httpGet).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // fetchLatest — 200 success path
  // -----------------------------------------------------------------------

  it('fetchLatest maps API response to RawArticle[] on 200', async () => {
    process.env['NEWS_SOURCE_BLOOMBERG_API_KEY'] = 'test-key';
    vi.resetModules();
    const mod = await import('../../src/adapters/bloomberg/BloombergAdapter.js');
    const adapter = new mod.BloombergAdapter();

    httpGet.mockResolvedValueOnce(
      makeResponse(200, { articles: [MOCK_BLOOMBERG_ARTICLE] }),
    );

    const articles = await adapter.fetchLatest({ limit: 10 });

    expect(articles).toHaveLength(1);
    const a = articles[0]!;
    expect(a.sourceId).toBe('bloomberg');
    expect(a.sourceName).toBe('Bloomberg');
    expect(a.externalId).toBe('bbl-001');
    expect(a.title).toBe('Fed Raises Rates by 25 Basis Points');
    expect(a.author).toBe('Jane Smith');
    expect(a.publishedAt).toBe('2024-03-15T14:30:00Z');
    expect(a.category).toBe('Monetary Policy');
    expect(a.url).toBe('https://bloomberg.com/news/bbl-001');
    expect(a.adapterVersion).toBe('1.0.0');
  });

  it('fetchLatest returns empty array for empty articles list', async () => {
    process.env['NEWS_SOURCE_BLOOMBERG_API_KEY'] = 'test-key';
    vi.resetModules();
    const mod = await import('../../src/adapters/bloomberg/BloombergAdapter.js');
    const adapter = new mod.BloombergAdapter();

    httpGet.mockResolvedValueOnce(makeResponse(200, { articles: [] }));

    const articles = await adapter.fetchLatest();
    expect(articles).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // fetchLatest — malformed body → graceful empty list
  // -----------------------------------------------------------------------

  it('fetchLatest returns empty array when response articles field is missing', async () => {
    process.env['NEWS_SOURCE_BLOOMBERG_API_KEY'] = 'test-key';
    vi.resetModules();
    const mod = await import('../../src/adapters/bloomberg/BloombergAdapter.js');
    const adapter = new mod.BloombergAdapter();

    // The API contract: mapApiArticles uses `res.data.articles ?? []`
    httpGet.mockResolvedValueOnce(makeResponse(200, {}));

    const articles = await adapter.fetchLatest();
    expect(articles).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // fetchLatest — 429 / 500 retry behaviour
  // -----------------------------------------------------------------------

  it('fetchLatest retries on 429 and succeeds on subsequent attempt', async () => {
    process.env['NEWS_SOURCE_BLOOMBERG_API_KEY'] = 'test-key';
    vi.resetModules();
    const mod = await import('../../src/adapters/bloomberg/BloombergAdapter.js');
    const adapter = new mod.BloombergAdapter();

    const rateLimitErr = Object.assign(new Error('Too Many Requests'), {
      isAxiosError: true,
      response: { status: 429 },
    });
    httpGet
      .mockRejectedValueOnce(rateLimitErr)
      .mockResolvedValueOnce(makeResponse(200, { articles: [MOCK_BLOOMBERG_ARTICLE] }));

    const articles = await adapter.fetchLatest();
    expect(articles).toHaveLength(1);
    expect(httpGet).toHaveBeenCalledTimes(2);
  });

  it('fetchLatest throws after exhausting all retry attempts on 500', async () => {
    process.env['NEWS_SOURCE_BLOOMBERG_API_KEY'] = 'test-key';
    process.env['ADAPTER_MAX_RETRIES'] = '2';
    vi.resetModules();
    const mod = await import('../../src/adapters/bloomberg/BloombergAdapter.js');
    const adapter = new mod.BloombergAdapter();

    const serverErr = Object.assign(new Error('Internal Server Error'), {
      isAxiosError: true,
      response: { status: 500 },
    });
    httpGet.mockRejectedValue(serverErr);

    await expect(adapter.fetchLatest()).rejects.toThrow('Internal Server Error');
    // Called maxAttempts (2) times
    expect(httpGet).toHaveBeenCalledTimes(2);
  });

  // -----------------------------------------------------------------------
  // fetchLatest — network timeout does not propagate after retries
  // -----------------------------------------------------------------------

  it('fetchLatest does not swallow errors — re-throws after retry exhaustion', async () => {
    process.env['NEWS_SOURCE_BLOOMBERG_API_KEY'] = 'test-key';
    process.env['ADAPTER_MAX_RETRIES'] = '2';
    vi.resetModules();
    const mod = await import('../../src/adapters/bloomberg/BloombergAdapter.js');
    const adapter = new mod.BloombergAdapter();

    const timeoutErr = Object.assign(new Error('timeout of 10000ms exceeded'), {
      isAxiosError: true,
      code: 'ECONNABORTED',
    });
    httpGet.mockRejectedValue(timeoutErr);

    // The abstract base re-throws after exhausting retries;
    // caller (IngestionEngine) is responsible for catching (Req 1.10)
    await expect(adapter.fetchLatest()).rejects.toThrow(/timeout/i);
  });

  // -----------------------------------------------------------------------
  // fetchHistorical
  // -----------------------------------------------------------------------

  it('fetchHistorical returns empty array when no API key configured', async () => {
    const adapter = new BloombergAdapter();
    const articles = await adapter.fetchHistorical({
      from: new Date('2024-01-01'),
      to: new Date('2024-01-31'),
    });
    expect(articles).toEqual([]);
  });

  it('fetchHistorical maps API response to RawArticle[] on 200', async () => {
    process.env['NEWS_SOURCE_BLOOMBERG_API_KEY'] = 'test-key';
    vi.resetModules();
    const mod = await import('../../src/adapters/bloomberg/BloombergAdapter.js');
    const adapter = new mod.BloombergAdapter();

    httpGet.mockResolvedValueOnce(
      makeResponse(200, { articles: [MOCK_BLOOMBERG_ARTICLE] }),
    );

    const articles = await adapter.fetchHistorical({
      from: new Date('2024-01-01'),
      to: new Date('2024-01-31'),
      limit: 5,
      page: 2,
    });
    expect(articles).toHaveLength(1);
    expect(articles[0]?.externalId).toBe('bbl-001');
  });

  // -----------------------------------------------------------------------
  // normalize()
  // -----------------------------------------------------------------------

  it('normalize produces a NormalizedArticle with all required fields', () => {
    const adapter = new BloombergAdapter();
    const raw = {
      sourceId: 'bloomberg',
      sourceName: 'Bloomberg',
      externalId: 'bbl-001',
      url: 'https://bloomberg.com/news/bbl-001',
      title: 'Fed Raises Rates by 25 Basis Points',
      summary: 'Summary text here',
      content: 'Full article body here.',
      author: 'Jane Smith',
      publishedAt: '2024-03-15T14:30:00Z',
      category: 'Monetary Policy',
      adapterVersion: '1.0.0',
    };

    const normalized = adapter.normalize(raw);

    expect(normalized.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(normalized.sourceId).toBe('bloomberg');
    expect(normalized.sourceName).toBe('Bloomberg');
    expect(normalized.externalId).toBe('bbl-001');
    expect(normalized.canonicalUrl).toBe('https://bloomberg.com/news/bbl-001');
    expect(normalized.title).toBe('Fed Raises Rates by 25 Basis Points');
    expect(normalized.summary).toBe('Summary text here');
    expect(normalized.content).toBe('Full article body here.');
    expect(normalized.author).toBe('Jane Smith');
    expect(normalized.publishedAt).toBeInstanceOf(Date);
    expect(normalized.scrapedAt).toBeInstanceOf(Date);
    expect(normalized.category).toBe('Monetary Policy');
    expect(normalized.secondaryCategories).toEqual([]);
    expect(normalized.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(normalized.titleHash).toMatch(/^[0-9a-f]{64}$/);
    expect(normalized.contentTruncated).toBe(false);
    expect(normalized.timestampInferred).toBe(false);
  });

  it('normalize sets optional fields to null when absent', () => {
    const adapter = new BloombergAdapter();
    const raw = {
      sourceId: 'bloomberg',
      sourceName: 'Bloomberg',
      externalId: 'bbl-002',
      url: 'https://bloomberg.com/news/bbl-002',
      title: 'Minimal article',
      adapterVersion: '1.0.0',
    };

    const normalized = adapter.normalize(raw);

    expect(normalized.summary).toBeNull();
    expect(normalized.content).toBeNull();
    expect(normalized.author).toBeNull();
    expect(normalized.category).toBeNull();
    expect(normalized.timestampInferred).toBe(true);
  });

  it('normalize sets timestampInferred when publishedAt is unparseable', () => {
    const adapter = new BloombergAdapter();
    const raw = {
      sourceId: 'bloomberg',
      sourceName: 'Bloomberg',
      externalId: 'bbl-003',
      url: 'https://bloomberg.com/news/bbl-003',
      title: 'Bad timestamp article',
      publishedAt: 'not-a-date',
      adapterVersion: '1.0.0',
    };

    const normalized = adapter.normalize(raw);
    expect(normalized.timestampInferred).toBe(true);
  });

  it('normalize truncates content over 50,000 chars at a word boundary', () => {
    const adapter = new BloombergAdapter();
    const longContent = 'word '.repeat(15_000); // 75,000 chars
    const raw = {
      sourceId: 'bloomberg',
      sourceName: 'Bloomberg',
      externalId: 'bbl-004',
      url: 'https://bloomberg.com/news/bbl-004',
      title: 'Long article',
      content: longContent,
      adapterVersion: '1.0.0',
    };

    const normalized = adapter.normalize(raw);
    expect(normalized.contentTruncated).toBe(true);
    expect((normalized.content ?? '').length).toBeLessThanOrEqual(50_000);
    // Must not end mid-word (trailing space OK because of word-boundary slicing)
    expect(normalized.content).not.toMatch(/\S{50000}$/);
  });

  it('normalize produces deterministic hashes for the same content', () => {
    const adapter = new BloombergAdapter();
    const raw = {
      sourceId: 'bloomberg',
      sourceName: 'Bloomberg',
      externalId: 'bbl-005',
      url: 'https://bloomberg.com/news/bbl-005',
      title: 'Hash test article',
      content: 'Consistent content for hashing.',
      adapterVersion: '1.0.0',
    };

    const n1 = adapter.normalize(raw);
    const n2 = adapter.normalize(raw);

    expect(n1.contentHash).toBe(n2.contentHash);
    expect(n1.titleHash).toBe(n2.titleHash);
  });
});
