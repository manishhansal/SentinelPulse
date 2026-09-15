/**
 * Unit tests for ReutersAdapter (task 6.1)
 *
 * Covers:
 *   - parseRssItems: well-formed RSS, CDATA, dc:creator, missing fields,
 *     malformed XML, author email stripping
 *   - stripHtml: block-level → newlines, tag removal, entity decoding
 *   - ReutersAdapter.normalize(): timestamp inference, content truncation,
 *     contentHash / titleHash correctness, absent-field null-filling
 *   - ReutersAdapter.getRateLimit(): reads from env / defaults
 *
 * Requirements: Req 1.2, Req 1.4, Req 3.1, Req 3.3, Req 3.5, Req 3.7
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { parseRssItems, stripHtml } from '../../src/adapters/reuters/ReutersAdapter.js';
import { ReutersAdapter } from '../../src/adapters/reuters/ReutersAdapter.js';
import type { RawArticle } from '../../src/adapters/base/NewsSourceAdapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function makeRawArticle(overrides: Partial<RawArticle> = {}): RawArticle {
  return {
    sourceId: 'reuters',
    sourceName: 'Reuters',
    externalId: 'test-guid-1',
    url: 'https://www.reuters.com/article/test',
    title: 'Test Article Title',
    summary: 'Brief summary of the article.',
    content: 'Full article content here.',
    publishedAt: 'Thu, 01 Jan 2024 12:00:00 GMT',
    adapterVersion: '1.0.0',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseRssItems
// ---------------------------------------------------------------------------

describe('parseRssItems', () => {
  const SAMPLE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Reuters Top News</title>
    <item>
      <title>Fed raises rates by 25bp</title>
      <link>https://www.reuters.com/article/fed-rates-12345</link>
      <guid>https://www.reuters.com/article/fed-rates-12345</guid>
      <description>The Federal Reserve raised its benchmark interest rate.</description>
      <pubDate>Mon, 22 Jul 2024 18:00:00 GMT</pubDate>
      <dc:creator>Howard Schneider</dc:creator>
    </item>
    <item>
      <title><![CDATA[Oil prices drop on demand fears & supply glut]]></title>
      <link>https://www.reuters.com/article/oil-prices-67890</link>
      <guid isPermaLink="false">reuters-oil-prices-67890</guid>
      <description><![CDATA[Crude oil fell more than 3% on Tuesday as traders weighed weak demand signals.]]></description>
      <pubDate>Tue, 23 Jul 2024 09:30:00 GMT</pubDate>
      <author>Ahmad Ghaddar</author>
    </item>
    <item>
      <title>Minimal item — no author, no date</title>
      <link>https://www.reuters.com/article/minimal-99999</link>
      <guid>reuters-minimal-99999</guid>
      <description>Just a description.</description>
      <pubDate></pubDate>
    </item>
  </channel>
</rss>`;

  it('returns an array with the correct number of items', () => {
    const items = parseRssItems(SAMPLE_RSS);
    expect(items).toHaveLength(3);
  });

  it('parses plain text fields correctly', () => {
    const items = parseRssItems(SAMPLE_RSS);
    const first = items[0];
    expect(first?.title).toBe('Fed raises rates by 25bp');
    expect(first?.link).toBe('https://www.reuters.com/article/fed-rates-12345');
    expect(first?.guid).toBe('https://www.reuters.com/article/fed-rates-12345');
    expect(first?.pubDate).toBe('Mon, 22 Jul 2024 18:00:00 GMT');
    expect(first?.description).toBe(
      'The Federal Reserve raised its benchmark interest rate.',
    );
  });

  it('unwraps CDATA sections in title and description', () => {
    const items = parseRssItems(SAMPLE_RSS);
    const second = items[1];
    // Ampersand entity in CDATA-wrapped title must be decoded
    expect(second?.title).toBe('Oil prices drop on demand fears & supply glut');
    expect(second?.description).toBe(
      'Crude oil fell more than 3% on Tuesday as traders weighed weak demand signals.',
    );
  });

  it('uses guid with isPermaLink="false" attribute correctly', () => {
    const items = parseRssItems(SAMPLE_RSS);
    expect(items[1]?.guid).toBe('reuters-oil-prices-67890');
  });

  it('prefers dc:creator over <author> for the first item', () => {
    const items = parseRssItems(SAMPLE_RSS);
    expect(items[0]?.author).toBe('Howard Schneider');
  });

  it('falls back to <author> when dc:creator is absent', () => {
    const items = parseRssItems(SAMPLE_RSS);
    expect(items[1]?.author).toBe('Ahmad Ghaddar');
  });

  it('returns empty author for an item with neither dc:creator nor author', () => {
    const items = parseRssItems(SAMPLE_RSS);
    expect(items[2]?.author).toBe('');
  });

  it('returns empty string for missing pubDate', () => {
    const items = parseRssItems(SAMPLE_RSS);
    // Third item has an empty pubDate tag
    expect(items[2]?.pubDate).toBe('');
  });

  it('returns an empty array for an empty string', () => {
    expect(parseRssItems('')).toEqual([]);
  });

  it('returns an empty array when no <item> blocks are present', () => {
    const xml = '<rss><channel><title>Test</title></channel></rss>';
    expect(parseRssItems(xml)).toEqual([]);
  });

  it('strips author email address (RFC 5322 "email (Name)" format)', () => {
    const xml = `<rss><channel><item>
      <title>T</title><link>L</link><guid>G</guid>
      <description>D</description><pubDate>P</pubDate>
      <author>john.doe@reuters.com (John Doe)</author>
    </item></channel></rss>`;
    const items = parseRssItems(xml);
    expect(items[0]?.author).toBe('John Doe');
  });

  it('strips author email address ("Name <email>" format)', () => {
    const xml = `<rss><channel><item>
      <title>T</title><link>L</link><guid>G</guid>
      <description>D</description><pubDate>P</pubDate>
      <author>Jane Smith &lt;jane@reuters.com&gt;</author>
    </item></channel></rss>`;
    const items = parseRssItems(xml);
    expect(items[0]?.author).toBe('Jane Smith');
  });

  it('handles numeric character references in titles', () => {
    const xml = `<rss><channel><item>
      <title>Dollar &#36; rises; euro &#x20AC; falls</title>
      <link>L</link><guid>G</guid><description>D</description><pubDate>P</pubDate>
    </item></channel></rss>`;
    const items = parseRssItems(xml);
    expect(items[0]?.title).toBe('Dollar $ rises; euro € falls');
  });
});

// ---------------------------------------------------------------------------
// stripHtml
// ---------------------------------------------------------------------------

describe('stripHtml', () => {
  it('removes simple inline tags', () => {
    expect(stripHtml('<b>Bold</b> and <em>italic</em>')).toBe('Bold and italic');
  });

  it('converts block-level closing tags to newlines', () => {
    const html = '<p>First paragraph.</p><p>Second paragraph.</p>';
    const result = stripHtml(html);
    expect(result).toContain('\n');
    expect(result).toContain('First paragraph.');
    expect(result).toContain('Second paragraph.');
  });

  it('converts <br> variants to newlines', () => {
    const html = 'Line one<br>Line two<br />Line three';
    const result = stripHtml(html);
    expect(result).toBe('Line one\nLine two\nLine three');
  });

  it('decodes HTML entities', () => {
    expect(stripHtml('&amp; &lt; &gt; &quot; &apos;')).toBe('& < > " \'');
  });

  it('decodes &nbsp; to a space', () => {
    expect(stripHtml('hello&nbsp;world')).toBe('hello world');
  });

  it('collapses more than two consecutive newlines', () => {
    const html = '<p>A</p>\n\n\n\n<p>B</p>';
    const result = stripHtml(html);
    // Should not have more than two consecutive newlines after collapsing
    expect(result).not.toMatch(/\n{3,}/);
  });

  it('returns an empty string for empty input', () => {
    expect(stripHtml('')).toBe('');
  });

  it('removes all HTML tags and preserves text content', () => {
    // stripHtml removes tags; text from all elements (nav, article, etc.) is kept
    const html = '<nav>Skip nav</nav><article><p>Real content</p></article>';
    const result = stripHtml(html);
    // Tags are removed; text nodes from all elements are retained
    expect(result).not.toContain('<nav>');
    expect(result).not.toContain('<article>');
    expect(result).toContain('Skip nav');
    expect(result).toContain('Real content');
  });
});

// ---------------------------------------------------------------------------
// ReutersAdapter identity and configuration
// ---------------------------------------------------------------------------

describe('ReutersAdapter — identity', () => {
  it('exposes correct static identity fields', () => {
    const adapter = new ReutersAdapter();
    expect(adapter.sourceId).toBe('reuters');
    expect(adapter.sourceName).toBe('Reuters');
    expect(adapter.adapterVersion).toBe('1.0.0');
    expect(adapter.tier).toBe(1);
  });
});

describe('ReutersAdapter.getRateLimit()', () => {
  const origEnv = process.env['NEWS_SOURCE_REUTERS_RPM'];

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env['NEWS_SOURCE_REUTERS_RPM'];
    } else {
      process.env['NEWS_SOURCE_REUTERS_RPM'] = origEnv;
    }
  });

  it('returns default RPM of 10 when env is not set', () => {
    delete process.env['NEWS_SOURCE_REUTERS_RPM'];
    const adapter = new ReutersAdapter();
    expect(adapter.getRateLimit()).toEqual({ requestsPerMinute: 10 });
  });

  it('reads RPM from NEWS_SOURCE_REUTERS_RPM env variable', () => {
    process.env['NEWS_SOURCE_REUTERS_RPM'] = '30';
    const adapter = new ReutersAdapter();
    expect(adapter.getRateLimit()).toEqual({ requestsPerMinute: 30 });
  });
});

// ---------------------------------------------------------------------------
// ReutersAdapter.normalize()
// ---------------------------------------------------------------------------

describe('ReutersAdapter.normalize()', () => {
  let adapter: ReutersAdapter;

  beforeEach(() => {
    adapter = new ReutersAdapter();
  });

  it('produces a NormalizedArticle with all required fields (Req 3.1)', () => {
    const raw = makeRawArticle();
    const normalized = adapter.normalize(raw);

    expect(normalized.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(normalized.sourceId).toBe('reuters');
    expect(normalized.sourceName).toBe('Reuters');
    expect(normalized.externalId).toBe('test-guid-1');
    expect(normalized.canonicalUrl).toBe('https://www.reuters.com/article/test');
    expect(normalized.title).toBe('Test Article Title');
    expect(normalized.language).toBe('en');
    expect(normalized.publishedAt).toBeInstanceOf(Date);
    expect(normalized.scrapedAt).toBeInstanceOf(Date);
    expect(normalized.secondaryCategories).toEqual([]);
  });

  it('sets absent optional fields to null (Req 3.1)', () => {
    const raw = makeRawArticle({
      summary: undefined,
      content: undefined,
      author: undefined,
      category: undefined,
    });
    const normalized = adapter.normalize(raw);

    expect(normalized.summary).toBeNull();
    expect(normalized.content).toBeNull();
    expect(normalized.author).toBeNull();
    expect(normalized.category).toBeNull();
  });

  it('parses a valid RFC 2822 publishedAt correctly (Req 3.2)', () => {
    const raw = makeRawArticle({ publishedAt: 'Mon, 01 Jan 2024 00:00:00 GMT' });
    const normalized = adapter.normalize(raw);
    expect(normalized.publishedAt.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect(normalized.timestampInferred).toBe(false);
  });

  it('infers publishedAt from scrapedAt when publishedAt is missing (Req 3.3)', () => {
    const before = Date.now();
    const raw = makeRawArticle({ publishedAt: undefined });
    const normalized = adapter.normalize(raw);
    const after = Date.now();

    expect(normalized.timestampInferred).toBe(true);
    expect(normalized.publishedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(normalized.publishedAt.getTime()).toBeLessThanOrEqual(after);
  });

  it('infers publishedAt when the raw value is unparseable (Req 3.3)', () => {
    const raw = makeRawArticle({ publishedAt: 'not-a-date' });
    const normalized = adapter.normalize(raw);
    expect(normalized.timestampInferred).toBe(true);
  });

  it('truncates content longer than 50,000 chars at a word boundary (Req 3.5)', () => {
    // Build a string that is just over 50,000 characters with a known word boundary
    const word = 'word ';
    const longContent = word.repeat(10_100); // ~50,500 chars
    const raw = makeRawArticle({ content: longContent });
    const normalized = adapter.normalize(raw);

    expect(normalized.content!.length).toBeLessThanOrEqual(50_000);
    expect(normalized.contentTruncated).toBe(true);
    // Truncation must end at a word boundary (no trailing space after trim)
    expect(normalized.content!.at(-1)).not.toBe(' ');
  });

  it('does not set contentTruncated when content is within limit (Req 3.5)', () => {
    const raw = makeRawArticle({ content: 'Short content.' });
    const normalized = adapter.normalize(raw);
    expect(normalized.contentTruncated).toBe(false);
  });

  it('computes a 64-char hex contentHash (Req 3.7)', () => {
    const raw = makeRawArticle({ content: 'Hello world.' });
    const normalized = adapter.normalize(raw);
    expect(normalized.contentHash).toHaveLength(64);
    expect(normalized.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('computes contentHash as SHA-256 of whitespace-normalised content (Req 3.7)', () => {
    const raw = makeRawArticle({ content: '  Hello   world.  ' });
    const normalized = adapter.normalize(raw);
    // Stripped HTML of "  Hello   world.  " is "Hello   world."
    // After whitespace normalization: "Hello world."
    const stripped = stripHtml('  Hello   world.  ');
    const expected = sha256(stripped.trim().replace(/\s+/g, ' '));
    expect(normalized.contentHash).toBe(expected);
  });

  it('computes a 64-char hex titleHash (Req 3.7)', () => {
    const raw = makeRawArticle();
    const normalized = adapter.normalize(raw);
    expect(normalized.titleHash).toHaveLength(64);
    expect(normalized.titleHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('computes titleHash as SHA-256 of lowercased punctuation-stripped title (Req 3.7)', () => {
    const raw = makeRawArticle({ title: 'Fed Hikes Rates — 25bp!' });
    const normalized = adapter.normalize(raw);
    // lowercase, strip punctuation, collapse whitespace
    const titleForHash = 'fed hikes rates  25bp'
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const expected = sha256(titleForHash);
    expect(normalized.titleHash).toBe(expected);
  });

  it('strips HTML from content during normalize', () => {
    const raw = makeRawArticle({
      content: '<p>Oil <b>rose</b> on Monday.</p>',
      summary: undefined,
    });
    const normalized = adapter.normalize(raw);
    expect(normalized.content).not.toContain('<');
    expect(normalized.content).toContain('Oil');
    expect(normalized.content).toContain('rose');
  });

  it('two identical articles produce the same contentHash (deterministic)', () => {
    const raw1 = makeRawArticle({ content: 'Same content.' });
    const raw2 = makeRawArticle({ content: 'Same content.' });
    expect(adapter.normalize(raw1).contentHash).toBe(
      adapter.normalize(raw2).contentHash,
    );
  });

  it('two articles with different content produce different contentHashes', () => {
    const raw1 = makeRawArticle({ content: 'Content A.' });
    const raw2 = makeRawArticle({ content: 'Content B.' });
    expect(adapter.normalize(raw1).contentHash).not.toBe(
      adapter.normalize(raw2).contentHash,
    );
  });

  it('produces a unique UUID id for each call', () => {
    const raw = makeRawArticle();
    const n1 = adapter.normalize(raw);
    const n2 = adapter.normalize(raw);
    expect(n1.id).not.toBe(n2.id);
  });
});
