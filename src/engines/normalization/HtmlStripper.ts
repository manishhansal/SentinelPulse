/**
 * HtmlStripper.ts — HTML stripping and content cleaning for the NormalizationEngine.
 *
 * Builds on top of the shared `stripHtml` and `decodeHtmlEntities` utilities
 * from `src/adapters/base/rss-parser.ts`, adding boilerplate removal and a
 * full-pipeline `process()` method.
 *
 * Requirements: Req 3.4
 */

import {
  stripHtml,
  decodeHtmlEntities,
} from '../../adapters/base/rss-parser.js';

// Re-export the shared utilities so callers of HtmlStripper don't need to
// depend on the adapter layer directly.
export { stripHtml, decodeHtmlEntities };

// ---------------------------------------------------------------------------
// Boilerplate patterns
// ---------------------------------------------------------------------------

/**
 * Common boilerplate fragments found in scraped news articles.
 *
 * Each pattern is applied in order to the plain-text content after HTML
 * stripping. We use case-insensitive matching and trim surrounding whitespace
 * after each replacement to prevent stacking blank lines.
 *
 * Covers (Req 3.4):
 *   - Inline ad labels and "Advertisement" markers
 *   - Navigation fragments ("Home / Markets / ...")
 *   - Cookie consent banners
 *   - Newsletter subscription prompts
 *   - Author boilerplate lines ("Written by …", "By …", at end of content)
 *   - Social-share prompts ("Share this article", "Follow us on …")
 *   - Paywall / subscription walls ("Subscribe to read the full story")
 */
const BOILERPLATE_PATTERNS: RegExp[] = [
  // Advertisement / Sponsored blocks
  /^\s*(?:advertisement|sponsored content|sponsored|ad\b)[^\n]*$/gim,

  // Cookie / tracking banners
  /^\s*(?:we use cookies|this site uses cookies|accept cookies|cookie policy)[^\n]*$/gim,

  // Newsletter / subscription prompts
  /^\s*(?:subscribe(?:\s+to(?:\s+(?:our|the))?\s+newsletter)?|sign up for our newsletter|get the latest news)[^\n]*$/gim,

  // Social-share / follow-us prompts
  /^\s*(?:share this (?:article|story|post)|follow us on|like us on facebook|follow on twitter)[^\n]*$/gim,

  // "Read more" / "Also read" navigation fragments
  /^\s*(?:read more|also read|see also|related[:\s])[^\n]*$/gim,

  // Paywall / metered content notices
  /^\s*(?:subscribe to read|subscribe for full access|this article is for subscribers)[^\n]*$/gim,

  // Navigation breadcrumb lines (Home > Section > …)
  /^\s*home\s*[>\/|]\s*[^\n]*$/gim,

  // Inline image captions with "(Photo:" or "Image:" prefix only lines
  /^\s*(?:photo|image|caption)[:]\s*[^\n]*$/gim,
];

// ---------------------------------------------------------------------------
// HtmlStripper class
// ---------------------------------------------------------------------------

/**
 * Strips HTML and removes boilerplate from raw article content.
 *
 * Usage:
 * ```ts
 * const stripper = new HtmlStripper();
 * const cleanText = stripper.process(rawHtml);
 * ```
 */
export class HtmlStripper {
  /**
   * Strips HTML from article content.
   *
   * Processing steps (Req 3.4):
   *   1. Converts block-level closing tags (`<p>`, `<div>`, `<br>`, `<h1>`–`<h6>`, `<li>`,
   *      plus `<blockquote>`, `<article>`, `<section>`, `<tr>`, `<td>`, `<th>`) to `\n`.
   *   2. Removes all remaining HTML tags.
   *   3. Decodes HTML entities.
   *   4. Collapses consecutive whitespace (spaces, tabs) to a single space per line.
   *   5. Trims leading/trailing whitespace from the result.
   *
   * Returns the stripped content string. An empty string is returned for
   * falsy input.
   */
  strip(html: string): string {
    if (!html) return '';
    // stripHtml from rss-parser handles steps 1–3 and collapses excessive
    // blank lines. We then normalise intra-line whitespace.
    const stripped = stripHtml(html);
    return this._normaliseLines(stripped);
  }

  /**
   * Normalises whitespace in a plain-text string:
   *   - Replaces all runs of spaces and tabs (not newlines) within each line
   *     with a single space.
   *   - Trims leading/trailing whitespace from the entire string.
   *
   * Newlines are preserved so paragraph structure is not destroyed.
   */
  normaliseWhitespace(text: string): string {
    if (!text) return '';
    // Collapse horizontal whitespace on each line, then trim the whole string.
    return text
      .split('\n')
      .map((line) => line.replace(/[ \t]+/g, ' ').trim())
      .join('\n')
      .trim();
  }

  /**
   * Removes inline ads, navigation boilerplate, cookie banners, and
   * author-boilerplate fragments from plain text using pattern matching.
   *
   * Expects plain text (HTML already stripped). Returns the cleaned string
   * with excessive blank lines collapsed.
   */
  removeBoilerplate(text: string): string {
    if (!text) return '';

    let result = text;
    for (const pattern of BOILERPLATE_PATTERNS) {
      // Reset lastIndex for global regexes before each use.
      pattern.lastIndex = 0;
      result = result.replace(pattern, '');
    }

    // Collapse runs of more than two consecutive newlines introduced by
    // boilerplate removal.
    result = result.replace(/\n{3,}/g, '\n\n');

    return result.trim();
  }

  /**
   * Full processing pipeline:
   *   1. `strip(html)` — strip HTML tags and decode entities
   *   2. `removeBoilerplate(text)` — remove common boilerplate fragments
   *   3. `normaliseWhitespace(text)` — collapse consecutive whitespace to single space
   *
   * This is the method that the NormalizationEngine calls when processing
   * article content (Req 3.4).
   */
  process(html: string): string {
    if (!html) return '';
    const stripped = this.strip(html);
    const clean = this.removeBoilerplate(stripped);
    return this.normaliseWhitespace(clean);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Collapses horizontal whitespace (spaces/tabs) within each line while
   * preserving newlines. Does NOT perform a full trim yet so that
   * multi-paragraph structure survives intermediate processing steps.
   */
  private _normaliseLines(text: string): string {
    return text
      .split('\n')
      .map((line) => line.replace(/[ \t]+/g, ' ').trim())
      .join('\n')
      .trim();
  }
}
