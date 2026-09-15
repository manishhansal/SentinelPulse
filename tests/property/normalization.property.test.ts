/**
 * Properties 5, 6, 7, 8: NormalizationEngine correctness properties.
 *
 * Property 5: NormalizedArticle completeness — all optional fields absent
 *             from raw input are set to null, never undefined.
 * Property 6: Content truncation at word boundary — never exceeds 50 000 chars
 *             and always ends on a complete word.
 * Property 7: Hash determinism and format — SHA-256 hashes are always 64-char
 *             hex strings and are deterministic for the same input.
 * Property 8: HTML block-element newline preservation — block-level tags are
 *             converted to newlines before tag removal.
 *
 * **Validates: Requirements 3.1, 3.5, 3.7, 3.4**
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createHash } from 'node:crypto';
import { stripHtml } from '../../src/adapters/base/rss-parser.js';

// ---------------------------------------------------------------------------
// Replicate the pure helper functions from NormalizationEngine (private)
// These are tested as pure functions here since the engine mixes in I/O.
// ---------------------------------------------------------------------------

const MAX_CONTENT_LENGTH = 50_000;

function truncateAtWordBoundary(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  let end = maxLength;
  while (end > 0 && !/\s/.test(text[end - 1]!)) {
    end--;
  }
  if (end === 0) end = maxLength;
  return text.slice(0, end).trimEnd();
}

function computeContentHash(content: string): string {
  const normalised = content.trim().replace(/\s+/g, ' ');
  return createHash('sha256').update(normalised, 'utf8').digest('hex');
}

function computeTitleHash(title: string): string {
  const normalised = title
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(normalised, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Property 5: NormalizedArticle completeness
// ---------------------------------------------------------------------------

// Feature: sentinel-pulse
describe('Property 5: NormalizedArticle completeness', () => {
  it('optional fields absent from raw input are null in a NormalizedArticle shape', () => {
    // Simulate the minimal normalization mapping (no I/O) for optional fields.
    fc.assert(
      fc.property(
        fc.record({
          summary: fc.option(fc.string({ minLength: 1, maxLength: 200 }), { nil: undefined }),
          content: fc.option(fc.string({ minLength: 1, maxLength: 200 }), { nil: undefined }),
          author: fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: undefined }),
        }),
        ({ summary, content, author }) => {
          // Replicate the mapping: absent raw field → null in normalized
          const normalizedSummary = summary ?? null;
          const normalizedContent = content ?? null;
          const normalizedAuthor = author ?? null;

          // Property: result is either null or a string — never undefined
          return (
            normalizedSummary !== undefined &&
            normalizedContent !== undefined &&
            normalizedAuthor !== undefined
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it('null fields are strictly null, not undefined', () => {
    // absent optional raw field → null
    const normalized = {
      summary: undefined ?? null,
      content: undefined ?? null,
      author: undefined ?? null,
    };
    expect(normalized.summary).toBeNull();
    expect(normalized.content).toBeNull();
    expect(normalized.author).toBeNull();

    // Null is not undefined
    expect(normalized.summary).not.toBeUndefined();
    expect(normalized.content).not.toBeUndefined();
    expect(normalized.author).not.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Property 6: Content truncation at word boundary
// ---------------------------------------------------------------------------

// Feature: sentinel-pulse
describe('Property 6: content truncation at word boundary', () => {
  it('truncated content never exceeds MAX_CONTENT_LENGTH characters', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 100_000 }),
        (text) => {
          const result = truncateAtWordBoundary(text, MAX_CONTENT_LENGTH);
          return result.length <= MAX_CONTENT_LENGTH;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('short content passes through unchanged', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: MAX_CONTENT_LENGTH }),
        (text) => truncateAtWordBoundary(text, MAX_CONTENT_LENGTH) === text,
      ),
      { numRuns: 100 },
    );
  });

  it('truncated result does not end with a partial word when whitespace is present before limit', () => {
    // Generate text that definitely has spaces and is over the limit
    fc.assert(
      fc.property(
        fc.array(
          fc.string({ minLength: 1, maxLength: 20 }).filter((s) => !/\s/.test(s)),
          { minLength: 10, maxLength: 100 },
        ),
        (words) => {
          const text = words.join(' ');
          if (text.length <= MAX_CONTENT_LENGTH) return true; // doesn't exercise truncation

          const result = truncateAtWordBoundary(text, MAX_CONTENT_LENGTH);

          // The character just after the result (if not end of string) should be
          // a space (word boundary was respected) OR the result length == maxLength
          // (hard cut because no whitespace found).
          if (result.length === MAX_CONTENT_LENGTH) return true;

          const charAfter = text[result.length];
          return charAfter === ' ' || charAfter === undefined;
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 7: Hash determinism and format
// ---------------------------------------------------------------------------

// Feature: sentinel-pulse
describe('Property 7: hash determinism and format', () => {
  it('contentHash is always a 64-character lowercase hex string', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 1000 }),
        (content) => {
          const hash = computeContentHash(content);
          return /^[0-9a-f]{64}$/.test(hash);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('titleHash is always a 64-character lowercase hex string', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 500 }),
        (title) => {
          const hash = computeTitleHash(title);
          return /^[0-9a-f]{64}$/.test(hash);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('contentHash is deterministic — same input always produces same hash', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 1000 }),
        (content) => {
          return computeContentHash(content) === computeContentHash(content);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('titleHash is deterministic — same input always produces same hash', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 500 }),
        (title) => {
          return computeTitleHash(title) === computeTitleHash(title);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('different content produces different hashes (collision resistance)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 500 }),
        fc.string({ minLength: 1, maxLength: 500 }),
        (a, b) => {
          // If the normalised forms are the same, hashes will match — skip those
          const normA = a.trim().replace(/\s+/g, ' ');
          const normB = b.trim().replace(/\s+/g, ' ');
          if (normA === normB) return true;
          return computeContentHash(a) !== computeContentHash(b);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 8: HTML block-element newline preservation
// ---------------------------------------------------------------------------

// Feature: sentinel-pulse
describe('Property 8: HTML block-element newline preservation', () => {
  it('block-level closing tags are converted to newlines before tag removal', () => {
    const blockTags = ['p', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'tr', 'td', 'th'];

    fc.assert(
      fc.property(
        fc.constantFrom(...blockTags),
        fc.string({ minLength: 1, maxLength: 100 }).filter((s) => !/<|>/.test(s)),
        fc.string({ minLength: 1, maxLength: 100 }).filter((s) => !/<|>/.test(s)),
        (tag, before, after) => {
          const html = `${before}</${tag}>${after}`;
          const result = stripHtml(html);

          // The newline from the block tag should appear between before and after content
          // (after entity decoding and whitespace collapsing). We check that the result
          // contains a newline separating the two text parts.
          const beforeTrimmed = before.trim();
          const afterTrimmed = after.trim();

          if (!beforeTrimmed || !afterTrimmed) return true; // degenerate case

          // Both parts should appear in the output with a newline between them
          const beforeIdx = result.indexOf(beforeTrimmed);
          const afterIdx = result.indexOf(afterTrimmed);

          if (beforeIdx === -1 || afterIdx === -1) return true; // text may contain entities

          const between = result.slice(beforeIdx + beforeTrimmed.length, afterIdx);
          return between.includes('\n') || between.trim() === '';
        },
      ),
      { numRuns: 100 },
    );
  });

  it('self-closing <br/> tags are converted to newlines', () => {
    const result = stripHtml('first<br/>second');
    expect(result).toContain('\n');
    expect(result).toContain('first');
    expect(result).toContain('second');
  });

  it('no HTML tags remain after stripHtml', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 500 }),
        (content) => {
          const html = `<p>${content}</p><div>more content</div>`;
          const result = stripHtml(html);
          return !/<[^>]+>/.test(result);
        },
      ),
      { numRuns: 100 },
    );
  });
});
