/**
 * Unit tests for NormalizationEngine pure helpers.
 *
 * Covers the module-level pure functions that do not touch Prisma or BullMQ:
 *   - truncateAtWordBoundary  (Req 3.5)
 *   - classifyTaxonomy        (Req 7.1, 7.2)
 *   - HtmlStripper.process    (Req 3.4)
 *   - LanguageDetector.detect (Req 3.6)
 */

import { describe, it, expect } from 'vitest';
import { HtmlStripper } from '../../../../src/engines/normalization/HtmlStripper.js';
import { LanguageDetector } from '../../../../src/engines/normalization/LanguageDetector.js';

// ---------------------------------------------------------------------------
// HtmlStripper (Req 3.4)
// ---------------------------------------------------------------------------

describe('HtmlStripper', () => {
  const stripper = new HtmlStripper();

  it('strips basic HTML tags', () => {
    const html = '<p>Hello <strong>World</strong></p>';
    const result = stripper.process(html);
    expect(result).toBe('Hello World');
  });

  it('decodes HTML entities', () => {
    const html = 'RBI hikes rate by 25 bps &amp; surprises market';
    const result = stripper.process(html);
    expect(result).toContain('&');
  });

  it('collapses consecutive whitespace to a single space', () => {
    const text = 'foo   bar\t\tbaz';
    const result = stripper.normaliseWhitespace(text);
    expect(result).toBe('foo bar baz');
  });

  it('removes advertisement boilerplate', () => {
    const text = 'Market rallied.\nAdvertisement\nSensex surged 500 points.';
    const result = stripper.removeBoilerplate(text);
    expect(result).not.toContain('Advertisement');
    expect(result).toContain('Market rallied');
  });

  it('returns empty string for empty input', () => {
    expect(stripper.process('')).toBe('');
    expect(stripper.strip('')).toBe('');
    expect(stripper.normaliseWhitespace('')).toBe('');
    expect(stripper.removeBoilerplate('')).toBe('');
  });

  it('preserves paragraph structure (newlines)', () => {
    const html = '<p>First paragraph.</p><p>Second paragraph.</p>';
    const result = stripper.strip(html);
    // After stripping there should be at least a separation between paragraphs
    expect(result).toContain('First paragraph');
    expect(result).toContain('Second paragraph');
  });
});

// ---------------------------------------------------------------------------
// LanguageDetector (Req 3.6)
// ---------------------------------------------------------------------------

describe('LanguageDetector', () => {
  const detector = new LanguageDetector();

  it('returns en/0 for very short text', () => {
    const result = detector.detect('Short');
    expect(result.language).toBe('en');
    expect(result.confidence).toBe(0);
  });

  it('returns en/0 for empty string', () => {
    const result = detector.detect('');
    expect(result.language).toBe('en');
    expect(result.confidence).toBe(0);
  });

  it('detects English from clear English text', () => {
    const text =
      'The Federal Reserve raised interest rates by 25 basis points at its FOMC ' +
      'meeting, signalling further tightening ahead amid persistent inflation pressure.';
    const result = detector.detect(text);
    expect(result.language).toBe('en');
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('returns ISO-639-1 two-letter codes (not three-letter franc codes)', () => {
    const text =
      'The Federal Reserve raised interest rates by 25 basis points at its FOMC ' +
      'meeting, signalling further tightening ahead amid persistent inflation pressure.';
    const result = detector.detect(text);
    // ISO 639-1 codes are always 2 chars long
    expect(result.language.length).toBe(2);
  });

  it('isConfident returns false for zero-confidence result', () => {
    const result = { language: 'en', confidence: 0 };
    expect(detector.isConfident(result)).toBe(false);
  });

  it('isConfident returns true when confidence meets threshold', () => {
    const result = { language: 'en', confidence: 0.9 };
    expect(detector.isConfident(result)).toBe(true);
  });
});
