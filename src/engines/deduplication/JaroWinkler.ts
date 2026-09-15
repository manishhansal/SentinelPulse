/**
 * Jaro-Winkler string similarity for near-duplicate title detection.
 *
 * Exports:
 *   - `JaroWinklerConfig`   — configuration interface
 *   - `jaroSimilarity`      — pure Jaro similarity function
 *   - `jaroWinklerSimilarity` — Jaro-Winkler similarity function (p = 0.1)
 *   - `normaliseTitle`      — lowercase + punctuation-strip + whitespace-collapse
 *   - `JaroWinklerMatcher`  — high-level matcher that wraps the above
 *
 * Requirements: Req 4.3
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface JaroWinklerConfig {
  /**
   * Similarity threshold above which titles are considered near-duplicates.
   * Default: 0.92, range [0.80, 1.00]
   * Requirements: Req 4.3
   */
  threshold: number;
  /**
   * Time window in hours for near-duplicate detection.
   * Default: 24, range [1, 168]
   */
  windowHours: number;
}

// ---------------------------------------------------------------------------
// Jaro similarity
// ---------------------------------------------------------------------------

/**
 * Computes the Jaro similarity between two strings.
 * Returns a value in [0, 1] where 1 = identical.
 *
 * Algorithm:
 *   - Two characters from s1 and s2 are considered "matching" if they are
 *     the same and are not further than floor(max(len1, len2) / 2) - 1
 *     characters apart.
 *   - jaro = (m/|s1| + m/|s2| + (m-t)/m) / 3
 *     where m = number of matching characters, t = half the number of
 *     transpositions.
 */
export function jaroSimilarity(s1: string, s2: string): number {
  if (s1 === s2) return 1;

  const len1 = s1.length;
  const len2 = s2.length;

  if (len1 === 0 || len2 === 0) return 0;

  // Maximum distance for a character to be considered matching
  const matchDistance = Math.floor(Math.max(len1, len2) / 2) - 1;

  const s1Matched = new Uint8Array(len1);
  const s2Matched = new Uint8Array(len2);

  let matches = 0;
  let transpositions = 0;

  // Find matching characters
  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, len2);

    for (let j = start; j < end; j++) {
      if (s2Matched[j] || s1[i] !== s2[j]) continue;
      s1Matched[i] = 1;
      s2Matched[j] = 1;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0;

  // Count transpositions
  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (!s1Matched[i]) continue;
    while (!s2Matched[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  return (
    (matches / len1 + matches / len2 + (matches - transpositions / 2) / matches) / 3
  );
}

// ---------------------------------------------------------------------------
// Jaro-Winkler similarity
// ---------------------------------------------------------------------------

/** Standard Jaro-Winkler prefix scaling factor (must be ≤ 0.25). */
const WINKLER_P = 0.1;

/**
 * Computes the Jaro-Winkler similarity between two strings.
 * Jaro-Winkler gives additional weight to strings that share a common prefix.
 * Returns a value in [0, 1] where 1 = identical.
 * Uses standard prefix scaling factor p = 0.1.
 *
 * jw = jaro + l * p * (1 - jaro)
 *   where l = length of common prefix (max 4), p = 0.1
 */
export function jaroWinklerSimilarity(s1: string, s2: string): number {
  const jaro = jaroSimilarity(s1, s2);

  // Common prefix length (up to 4 characters)
  let prefixLen = 0;
  const maxPrefix = Math.min(4, s1.length, s2.length);
  while (prefixLen < maxPrefix && s1[prefixLen] === s2[prefixLen]) {
    prefixLen++;
  }

  return jaro + prefixLen * WINKLER_P * (1 - jaro);
}

// ---------------------------------------------------------------------------
// Title normalisation
// ---------------------------------------------------------------------------

/**
 * Normalises a title string for comparison:
 * - Lowercase
 * - Remove punctuation
 * - Collapse whitespace
 * - Trim
 */
export function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s]/g, '') // remove all non-word, non-space characters
    .replace(/\s+/g, ' ')    // collapse consecutive whitespace
    .trim();
}

// ---------------------------------------------------------------------------
// JaroWinklerMatcher
// ---------------------------------------------------------------------------

export class JaroWinklerMatcher {
  constructor(private readonly config: JaroWinklerConfig) {}

  /**
   * Returns true when the similarity between normalised versions of
   * title1 and title2 is >= config.threshold.
   */
  isNearDuplicate(title1: string, title2: string): boolean {
    return this.similarity(title1, title2) >= this.config.threshold;
  }

  /**
   * Returns the similarity score between two titles (0.0 to 1.0).
   */
  similarity(title1: string, title2: string): number {
    const n1 = normaliseTitle(title1);
    const n2 = normaliseTitle(title2);
    return jaroWinklerSimilarity(n1, n2);
  }
}
