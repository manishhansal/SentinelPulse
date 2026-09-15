/**
 * rss-parser.ts — Shared RSS 2.0 parsing utilities.
 *
 * Extracted from ReutersAdapter so that all RSS-based adapters
 * (Reuters, Moneycontrol, Economic Times) can share the same logic
 * without duplication.
 *
 * Exports:
 *   - RssItem           — shape of a parsed <item> element
 *   - parseRssItems()   — parses <item> blocks from an RSS 2.0 XML string
 *   - stripHtml()       — strips HTML tags, converts block elements to newlines
 *   - decodeHtmlEntities() — decodes common XML/HTML character entities
 *
 * Requirements: Req 1.2, Req 1.4, Req 1.5
 */

// ---------------------------------------------------------------------------
// RssItem shape
// ---------------------------------------------------------------------------

/** Parsed representation of an RSS 2.0 <item> element. */
export interface RssItem {
  guid: string;
  link: string;
  title: string;
  description: string;
  pubDate: string;
  author: string;
}

// ---------------------------------------------------------------------------
// RSS XML parser
// ---------------------------------------------------------------------------

/**
 * Parses the `<item>` elements from an RSS 2.0 XML string.
 *
 * Handles:
 *   - CDATA sections: `<![CDATA[...]]>`
 *   - Self-closing or empty elements
 *   - `<dc:creator>` as an alternative author field
 *   - `<author>` containing either a bare name or an RFC 5322 address
 *     (`email (Name)` or `Name <email>`)
 *
 * Returns an empty array if the XML cannot be parsed or contains no items.
 */
export function parseRssItems(xmlString: string): RssItem[] {
  if (!xmlString || typeof xmlString !== 'string') return [];

  // Extract all <item>...</item> blocks (non-greedy, handles multi-line)
  const itemPattern = /<item>([\s\S]*?)<\/item>/gi;
  const items: RssItem[] = [];
  let itemMatch: RegExpExecArray | null;

  while ((itemMatch = itemPattern.exec(xmlString)) !== null) {
    const itemXml = itemMatch[1] ?? '';

    items.push({
      guid: extractField(itemXml, 'guid'),
      link: extractField(itemXml, 'link'),
      title: extractField(itemXml, 'title'),
      description: extractField(itemXml, 'description'),
      pubDate: extractField(itemXml, 'pubDate'),
      author: extractAuthor(itemXml),
    });
  }

  return items;
}

// ---------------------------------------------------------------------------
// Field extractors (internal)
// ---------------------------------------------------------------------------

/**
 * Extracts the text content of the first occurrence of `<tagName>...</tagName>`
 * within `xml`, unwrapping any CDATA section and decoding HTML entities.
 *
 * Returns an empty string when the tag is not found.
 */
function extractField(xml: string, tagName: string): string {
  const pattern = new RegExp(
    `<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`,
    'i',
  );
  const match = pattern.exec(xml);
  if (!match || match[1] === undefined) return '';

  return unwrapAndDecode(match[1]);
}

/**
 * Extracts the article author from either `<author>` or `<dc:creator>`.
 * Prefers `<dc:creator>` which is more commonly used in news RSS feeds.
 */
function extractAuthor(itemXml: string): string {
  // Try <dc:creator> first (Dublin Core, used by many news RSS feeds)
  const dcCreator = extractField(itemXml, 'dc:creator');
  if (dcCreator) return dcCreator;

  // Fall back to <author> — may contain "email (Name)" RFC 5322 format
  const author = extractField(itemXml, 'author');
  if (!author) return '';

  // If the author looks like an RFC 5322 address (contains '@'), attempt to
  // extract just the display name portion.
  if (author.includes('@')) {
    // Format: "email@example.com (Display Name)"
    const parenMatch = /\(([^)]+)\)/.exec(author);
    if (parenMatch && parenMatch[1]) return parenMatch[1].trim();

    // Format: "Display Name <email@example.com>"
    const angleMatch = /^([^<]+)</.exec(author);
    if (angleMatch && angleMatch[1]) return angleMatch[1].trim();
  }

  return author;
}

/**
 * Strips a CDATA wrapper (if present) and decodes common HTML entities
 * from a raw XML text node.
 */
function unwrapAndDecode(raw: string): string {
  let text = raw.trim();

  // Unwrap CDATA: <![CDATA[...]]>
  const cdataMatch = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(text);
  if (cdataMatch && cdataMatch[1] !== undefined) {
    text = cdataMatch[1];
  }

  // Decode common XML / HTML entities
  return decodeHtmlEntities(text);
}

// ---------------------------------------------------------------------------
// HTML / entity utilities (exported for use by adapters and tests)
// ---------------------------------------------------------------------------

/**
 * Decodes common XML / HTML character entities.
 * Covers the five predefined XML entities plus the most common HTML ones.
 */
export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCharCode(parseInt(code, 10)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(/&nbsp;/gi, ' ')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&ldquo;/gi, '\u201C')
    .replace(/&rdquo;/gi, '\u201D')
    .replace(/&lsquo;/gi, '\u2018')
    .replace(/&rsquo;/gi, '\u2019')
    .replace(/&hellip;/gi, '…');
}

/**
 * Strips HTML tags from a string, converting block-level elements to
 * newlines to preserve paragraph structure (Req 3.4).
 *
 * Processing order:
 *   1. Replace block-level closing tags with newlines.
 *   2. Remove all remaining tags.
 *   3. Decode HTML entities.
 *   4. Collapse excessive blank lines (> 2 consecutive newlines).
 *   5. Trim leading/trailing whitespace.
 */
export function stripHtml(html: string): string {
  if (!html) return '';

  let text = html;

  // Replace block-level closing tags with a newline to preserve structure
  const blockTags =
    /(<\/(?:p|div|br|li|h[1-6]|blockquote|article|section|header|footer|nav|aside|pre|tr|td|th)[^>]*>)/gi;
  text = text.replace(blockTags, '\n');

  // Also replace self-closing <br /> with newlines
  text = text.replace(/<br\s*\/?>/gi, '\n');

  // Strip all remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode entities
  text = decodeHtmlEntities(text);

  // Collapse excessive blank lines (more than two consecutive newlines)
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}
