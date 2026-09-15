/**
 * Integration tests for FinancialTimesAdapter.
 *
 * All outbound HTTP calls are intercepted via vi.mock('axios') so that no
 * real network requests are made and the tests remain hermetic.
 *
 * Coverage targets (Req 31.2):
 *   - 200 success path  →  correct RawArticle[] produced
 *   - 429 rate-limited  →  retried, eventual success / correct retry count
 *   - 500 server error  →  retried, eventual failure
 *   - Malformed body    →  graceful empty-list return
 *   - Network timeout   →  re-throws after retry exhaustion
 *   - No API key        →  empty list + WARN log (no HTTP call)
 *   - normalize()       →  all required NormalizedArticle fields populated
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';

vi.mock('axios');

// Helper: build a minimal Axios-like response object
function makeResponse(
  status: number,
  data: unknown,
): { status: number; data: unknown; headers: Record<string, string> } {
  return { status, data, headers: {} };
}

// A minimal valid FT CAPI content item
const MOCK_FT_CONTENT_ITEM = {
  id: 'ft-uuid-001',
  webUrl: 'https://www.ft.com/content/ft-uuid-001',
  title: 'Bank of England Holds Rates Steady',
  summary: { excerpt: 'The BoE kept its benchmark rate unchanged at 5.25%.' },
  body: { body: 'In a split decision the Monetary Policy Committee voted 6-3.' },
  byline: 'John Doe',
  publishedDate: '2024-03-15T12:00:00Z',
  genre: 'Markets',
  section: { term: { name: 'Economics' } },
};

// A valid FT CAPI search response wrapping the above item
const MOCK_FT_RESPONSE = {
  results: [
    {
      hits: [MOCK_FT_CONTENT_ITEM],
      indexCount: 1,
    },
  ],
};

describe('FinancialTimesAdapter', () => {
  let httpGet: ReturnType<typeof vi.fn>;
  let httpPost: ReturnType<typeof vi.fn>;
  let FinancialTimesAdapter: (typeof import('../../src/adapters/financial-times/FinancialTimesAdapter.js'))['FinancialTimesAdapter'];

  beforeEach(async () => {
    // Reset env
    delete process.env['NEWS_SOURCE_FINANCIALTIMES_BASE_URL'];
    delete process.env['NEWS_SOURCE_FINANCIALTIMES_API_KEY'];
    delete process.env['ADAPTER_MAX_RETRIES'];
    delete process.env['ADAPTER_RETRY_BASE_DELAY_MS'];
    delete process.env['ALLOWED_SOURCE_DOMAINS'];

    // Speed up retries in tests
    process.env['ADAPTER_MAX_RETRIES'] = '2';
    process.env['ADAPTER_RETRY_BASE_DELAY_MS'] = '10';
    process.env['ALLOWED_SOURCE_DOMAINS'] = 'api.ft.com,www.ft.com';

    httpGet = vi.fn();
    httpPost = vi.fn();

    const mockedAxios = vi.mocked(axios, true);
    mockedAxios.create = vi.fn().mockReturnValue({
      get: httpGet,
      post: httpPost,
    });
    mockedAxios.isAxiosError = vi.fn(
      (e) => (e as { isAxiosError?: boolean }).isAxiosError === true,
    );

    vi.resetModules();
    const mod = await import(
      '../../src/adapters/financial-times/FinancialTimesAdapter.js'
    );
    FinancialTimesAdapter = mod.FinancialTimesAdapter;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // Identity / metadata
  // -----------------------------------------------------------------------

  it('exposes correct identity fields', () => {
    const adapter = new FinancialTimesAdapter();
    expect(adapter.sourceId).toBe('financial-times');
    expect(adapter.sourceName).toBe('Financial Times');
    expect(adapter.adapterVersion).toBe('1.0.0');
    expect(adapter.tier).toBe(2);
  });

  it('returns a rate-limit config with a positive RPM', () => {
    const adapter = new FinancialTimesAdapter();
    const rl = adapter.getRateLimit();
    expect(typeof rl.requestsPerMinute).toBe('number');
    expect((rl.requestsPerMinute ?? 0) > 0).toBe(true);
  });

  // -----------------------------------------------------------------------
  // healthCheck — no API key
  // -----------------------------------------------------------------------

  it('healthCheck returns unhealthy when no API key is configured', async () => {
    const adapter = new FinancialTimesAdapter();
    const result = await adapter.healthCheck();
    expect(result.healthy).toBe(false);
    expect(result.message).toMatch(/api key not configured/i);
    expect(httpGet).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // healthCheck — with API key
  // -----------------------------------------------------------------------

  it('healthCheck returns healthy on HTTP 200', async () => {
    process.env['NEWS_SOURCE_FINANCIALTIMES_API_KEY'] = 'ft-key';
    vi.resetModules();
    const mod = await import(
      '../../src/adapters/financial-times/FinancialTimesAdapter.js'
    );
    const adapter = new mod.FinancialTimesAdapter();

    httpGet.mockResolvedValueOnce(makeResponse(200, { status: 'ok' }));

    const result = await adapter.healthCheck();
    expect(result.healthy).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(typeof result.latencyMs).toBe('number');
  });

  it('healthCheck returns unhealthy on HTTP 503', async () => {
    process.env['NEWS_SOURCE_FINANCIALTIMES_API_KEY'] = 'ft-key';
    vi.resetModules();
    const mod = await import(
      '../../src/adapters/financial-times/FinancialTimesAdapter.js'
    );
    const adapter = new mod.FinancialTimesAdapter();

    httpGet.mockResolvedValueOnce(makeResponse(503, {}));

    const result = await adapter.healthCheck();
    expect(result.healthy).toBe(false);
    expect(result.statusCode).toBe(503);
  });

  it('healthCheck returns unhealthy on network error', async () => {
    process.env['NEWS_SOURCE_FINANCIALTIMES_API_KEY'] = 'ft-key';
    vi.resetModules();
    const mod = await import(
      '../../src/adapters/financial-times/FinancialTimesAdapter.js'
    );
    const adapter = new mod.FinancialTimesAdapter();

    const networkErr = Object.assign(new Error('ECONNREFUSED'), {
      isAxiosError: true,
    });
    httpGet.mockRejectedValueOnce(networkErr);

    const result = await adapter.healthCheck();
    expect(result.healthy).toBe(false);
    expect(result.message).toContain('ECONNREFUSED');
  });

  // -----------------------------------------------------------------------
  // fetchLatest — no API key returns empty list
  // -----------------------------------------------------------------------

  it('fetchLatest returns empty array when no API key is configured', async () => {
    const adapter = new FinancialTimesAdapter();
    const articles = await adapter.fetchLatest();
    expect(articles).toEqual([]);
    expect(httpPost).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // fetchLatest — 200 success path
  // -----------------------------------------------------------------------

  it('fetchLatest maps FT CAPI response to RawArticle[] on 200', async () => {
    process.env['NEWS_SOURCE_FINANCIALTIMES_API_KEY'] = 'ft-key';
    vi.resetModules();
    const mod = await import(
      '../../src/adapters/financial-times/FinancialTimesAdapter.js'
    );
    const adapter = new mod.FinancialTimesAdapter();

    httpPost.mockResolvedValueOnce(makeResponse(200, MOCK_FT_RESPONSE));

    const articles = await adapter.fetchLatest({ limit: 10 });

    expect(articles).toHaveLength(1);
    const a = articles[0]!;
    expect(a.sourceId).toBe('financial-times');
    expect(a.sourceName).toBe('Financial Times');
    expect(a.externalId).toBe('ft-uuid-001');
    expect(a.title).toBe('Bank of England Holds Rates Steady');
    expect(a.url).toBe('https://www.ft.com/content/ft-uuid-001');
    expect(a.summary).toBe('The BoE kept its benchmark rate unchanged at 5.25%.');
    expect(a.content).toBe(
      'In a split decision the Monetary Policy Committee voted 6-3.',
    );
    expect(a.author).toBe('John Doe');
    expect(a.publishedAt).toBe('2024-03-15T12:00:00Z');
    expect(a.category).toBe('Economics');
    expect(a.adapterVersion).toBe('1.0.0');
  });

  it('fetchLatest returns empty array when results.hits is empty', async () => {
    process.env['NEWS_SOURCE_FINANCIALTIMES_API_KEY'] = 'ft-key';
    vi.resetModules();
    const mod = await import(
      '../../src/adapters/financial-times/FinancialTimesAdapter.js'
    );
    const adapter = new mod.FinancialTimesAdapter();

    httpPost.mockResolvedValueOnce(
      makeResponse(200, { results: [{ hits: [], indexCount: 0 }] }),
    );

    const articles = await adapter.fetchLatest();
    expect(articles).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // fetchLatest — malformed body → graceful empty list
  // -----------------------------------------------------------------------

  it('fetchLatest returns empty array when results field is absent', async () => {
    process.env['NEWS_SOURCE_FINANCIALTIMES_API_KEY'] = 'ft-key';
    vi.resetModules();
    const mod = await import(
      '../../src/adapters/financial-times/FinancialTimesAdapter.js'
    );
    const adapter = new mod.FinancialTimesAdapter();

    httpPost.mockResolvedValueOnce(makeResponse(200, {}));

    const articles = await adapter.fetchLatest();
    expect(articles).toEqual([]);
  });

  it('fetchLatest filters out items missing id or title', async () => {
    process.env['NEWS_SOURCE_FINANCIALTIMES_API_KEY'] = 'ft-key';
    vi.resetModules();
    const mod = await import(
      '../../src/adapters/financial-times/FinancialTimesAdapter.js'
    );
    const adapter = new mod.FinancialTimesAdapter();

    const badItem = { id: 'ft-bad', webUrl: 'https://ft.com/x' }; // no title
    httpPost.mockResolvedValueOnce(
      makeResponse(200, {
        results: [{ hits: [badItem, MOCK_FT_CONTENT_ITEM] }],
      }),
    );

    const articles = await adapter.fetchLatest();
    // Only the valid item should survive the filter
    expect(articles).toHaveLength(1);
    expect(articles[0]?.externalId).toBe('ft-uuid-001');
  });

  // -----------------------------------------------------------------------
  // fetchLatest — 429 / 500 retry behaviour
  // -----------------------------------------------------------------------

  it('fetchLatest retries on 429 and succeeds on subsequent attempt', async () => {
    process.env['NEWS_SOURCE_FINANCIALTIMES_API_KEY'] = 'ft-key';
    vi.resetModules();
    const mod = await import(
      '../../src/adapters/financial-times/FinancialTimesAdapter.js'
    );
    const adapter = new mod.FinancialTimesAdapter();

    const rateLimitErr = Object.assign(new Error('Too Many Requests'), {
      isAxiosError: true,
      response: { status: 429 },
    });
    httpPost
      .mockRejectedValueOnce(rateLimitErr)
      .mockResolvedValueOnce(makeResponse(200, MOCK_FT_RESPONSE));

    const articles = await adapter.fetchLatest();
    expect(articles).toHaveLength(1);
    expect(httpPost).toHaveBeenCalledTimes(2);
  });

  it('fetchLatest throws after exhausting all retry attempts on 500', async () => {
    process.env['NEWS_SOURCE_FINANCIALTIMES_API_KEY'] = 'ft-key';
    process.env['ADAPTER_MAX_RETRIES'] = '2';
    vi.resetModules();
    const mod = await import(
      '../../src/adapters/financial-times/FinancialTimesAdapter.js'
    );
    const adapter = new mod.FinancialTimesAdapter();

    const serverErr = Object.assign(new Error('Internal Server Error'), {
      isAxiosError: true,
      response: { status: 500 },
    });
    httpPost.mockRejectedValue(serverErr);

    await expect(adapter.fetchLatest()).rejects.toThrow('Internal Server Error');
    expect(httpPost).toHaveBeenCalledTimes(2);
  });

  // -----------------------------------------------------------------------
  // fetchLatest — network timeout re-throws after retry exhaustion
  // -----------------------------------------------------------------------

  it('fetchLatest re-throws timeout error after retry exhaustion', async () => {
    process.env['NEWS_SOURCE_FINANCIALTIMES_API_KEY'] = 'ft-key';
    process.env['ADAPTER_MAX_RETRIES'] = '2';
    vi.resetModules();
    const mod = await import(
      '../../src/adapters/financial-times/FinancialTimesAdapter.js'
    );
    const adapter = new mod.FinancialTimesAdapter();

    const timeoutErr = Object.assign(
      new Error('timeout of 10000ms exceeded'),
      { isAxiosError: true, code: 'ECONNABORTED' },
    );
    httpPost.mockRejectedValue(timeoutErr);

    await expect(adapter.fetchLatest()).rejects.toThrow(/timeout/i);
  });

  // -----------------------------------------------------------------------
  // fetchHistorical
  // -----------------------------------------------------------------------

  it('fetchHistorical returns empty array when no API key configured', async () => {
    const adapter = new FinancialTimesAdapter();
    const articles = await adapter.fetchHistorical({
      from: new Date('2024-01-01'),
      to: new Date('2024-01-31'),
    });
    expect(articles).toEqual([]);
  });

  it('fetchHistorical maps FT CAPI response to RawArticle[] on 200', async () => {
    process.env['NEWS_SOURCE_FINANCIALTIMES_API_KEY'] = 'ft-key';
    vi.resetModules();
    const mod = await import(
      '../../src/adapters/financial-times/FinancialTimesAdapter.js'
    );
    const adapter = new mod.FinancialTimesAdapter();

    httpPost.mockResolvedValueOnce(makeResponse(200, MOCK_FT_RESPONSE));

    const articles = await adapter.fetchHistorical({
      from: new Date('2024-01-01'),
      to: new Date('2024-01-31'),
      limit: 5,
      page: 2,
    });
    expect(articles).toHaveLength(1);
    expect(articles[0]?.externalId).toBe('ft-uuid-001');
  });

  it('fetchHistorical passes date range filters in request body', async () => {
    process.env['NEWS_SOURCE_FINANCIALTIMES_API_KEY'] = 'ft-key';
    vi.resetModules();
    const mod = await import(
      '../../src/adapters/financial-times/FinancialTimesAdapter.js'
    );
    const adapter = new mod.FinancialTimesAdapter();

    httpPost.mockResolvedValueOnce(makeResponse(200, MOCK_FT_RESPONSE));

    const from = new Date('2024-01-01T00:00:00Z');
    const to = new Date('2024-01-31T23:59:59Z');
    await adapter.fetchHistorical({ from, to });

    const [, body] = httpPost.mock.calls[0] as [string, Record<string, unknown>];
    const dateRange = (body.queryContext as Record<string, unknown>)['dateRange'] as Record<string, string>;
    expect(dateRange['greaterThan']).toBe(from.toISOString());
    expect(dateRange['lessThan']).toBe(to.toISOString());
  });

  // -----------------------------------------------------------------------
  // normalize()
  // -----------------------------------------------------------------------

  it('normalize produces a NormalizedArticle with all required fields', () => {
    const adapter = new FinancialTimesAdapter();
    const raw = {
      sourceId: 'financial-times',
      sourceName: 'Financial Times',
      externalId: 'ft-uuid-001',
      url: 'https://www.ft.com/content/ft-uuid-001',
      title: 'Bank of England Holds Rates Steady',
      summary: 'Summary sentence.',
      content: 'Full body content here.',
      author: 'John Doe',
      publishedAt: '2024-03-15T12:00:00Z',
      category: 'Economics',
      adapterVersion: '1.0.0',
    };

    const normalized = adapter.normalize(raw);

    expect(normalized.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(normalized.sourceId).toBe('financial-times');
    expect(normalized.sourceName).toBe('Financial Times');
    expect(normalized.externalId).toBe('ft-uuid-001');
    expect(normalized.canonicalUrl).toBe('https://www.ft.com/content/ft-uuid-001');
    expect(normalized.title).toBe('Bank of England Holds Rates Steady');
    expect(normalized.summary).toBe('Summary sentence.');
    expect(normalized.content).toBe('Full body content here.');
    expect(normalized.author).toBe('John Doe');
    expect(normalized.publishedAt).toBeInstanceOf(Date);
    expect(normalized.scrapedAt).toBeInstanceOf(Date);
    expect(normalized.category).toBe('Economics');
    expect(normalized.secondaryCategories).toEqual([]);
    expect(normalized.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(normalized.titleHash).toMatch(/^[0-9a-f]{64}$/);
    expect(normalized.contentTruncated).toBe(false);
    expect(normalized.timestampInferred).toBe(false);
  });

  it('normalize sets optional fields to null when absent', () => {
    const adapter = new FinancialTimesAdapter();
    const raw = {
      sourceId: 'financial-times',
      sourceName: 'Financial Times',
      externalId: 'ft-002',
      url: 'https://www.ft.com/content/ft-002',
      title: 'Minimal FT article',
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
    const adapter = new FinancialTimesAdapter();
    const raw = {
      sourceId: 'financial-times',
      sourceName: 'Financial Times',
      externalId: 'ft-003',
      url: 'https://www.ft.com/content/ft-003',
      title: 'Bad timestamp article',
      publishedAt: 'not-a-valid-date',
      adapterVersion: '1.0.0',
    };

    const normalized = adapter.normalize(raw);
    expect(normalized.timestampInferred).toBe(true);
  });

  it('normalize truncates content over 50,000 chars at a word boundary', () => {
    const adapter = new FinancialTimesAdapter();
    const longContent = 'word '.repeat(15_000); // 75,000 chars
    const raw = {
      sourceId: 'financial-times',
      sourceName: 'Financial Times',
      externalId: 'ft-004',
      url: 'https://www.ft.com/content/ft-004',
      title: 'Very long FT article',
      content: longContent,
      adapterVersion: '1.0.0',
    };

    const normalized = adapter.normalize(raw);
    expect(normalized.contentTruncated).toBe(true);
    expect((normalized.content ?? '').length).toBeLessThanOrEqual(50_000);
  });

  it('normalize produces deterministic hashes for the same content', () => {
    const adapter = new FinancialTimesAdapter();
    const raw = {
      sourceId: 'financial-times',
      sourceName: 'Financial Times',
      externalId: 'ft-005',
      url: 'https://www.ft.com/content/ft-005',
      title: 'Hash determinism test',
      content: 'Consistent FT content for hashing.',
      adapterVersion: '1.0.0',
    };

    const n1 = adapter.normalize(raw);
    const n2 = adapter.normalize(raw);

    expect(n1.contentHash).toBe(n2.contentHash);
    expect(n1.titleHash).toBe(n2.titleHash);
  });

  it('normalize contentHash and titleHash are valid SHA-256 hex strings', () => {
    const adapter = new FinancialTimesAdapter();
    const raw = {
      sourceId: 'financial-times',
      sourceName: 'Financial Times',
      externalId: 'ft-006',
      url: 'https://www.ft.com/content/ft-006',
      title: 'SHA-256 validation test',
      content: 'Some content.',
      adapterVersion: '1.0.0',
    };

    const normalized = adapter.normalize(raw);
    expect(normalized.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(normalized.titleHash).toMatch(/^[0-9a-f]{64}$/);
    // Hashes must be different from each other for different inputs
    expect(normalized.contentHash).not.toBe(normalized.titleHash);
  });
});
