/**
 * LanguageDetector.ts — Language detection for the NormalizationEngine.
 *
 * Uses `franc-min` to detect the language of stripped article text and maps
 * ISO 639-3 codes (returned by franc) to ISO 639-1 two-letter codes required
 * by the NormalizedArticle schema.
 *
 * Requirements: Req 3.6
 */

import { francAll } from 'franc-min';

// ---------------------------------------------------------------------------
// ISO 639-3 → ISO 639-1 mapping
// ---------------------------------------------------------------------------

/**
 * Map of ISO 639-3 trigram codes returned by franc to the ISO 639-1 two-letter
 * codes required by Req 3.6.
 *
 * Indian language codes are specifically listed per the task specification.
 * Additional common codes are included for robustness.
 */
const ISO_639_3_TO_1: Readonly<Record<string, string>> = {
  // English
  eng: 'en',
  // Hindi
  hin: 'hi',
  // Tamil
  tam: 'ta',
  // Telugu
  tel: 'te',
  // Bengali
  ben: 'bn',
  // Marathi
  mar: 'mr',
  // Kannada
  kan: 'kn',
  // Malayalam
  mal: 'ml',
  // Gujarati
  guj: 'gu',
  // Punjabi / Gurmukhi
  pan: 'pa',
  // Urdu
  urd: 'ur',
  // Spanish
  spa: 'es',
  // French
  fra: 'fr',
  // German
  deu: 'de',
  // Portuguese
  por: 'pt',
  // Italian
  ita: 'it',
  // Dutch
  nld: 'nl',
  // Russian
  rus: 'ru',
  // Arabic
  ara: 'ar',
  // Chinese (Simplified / Mandarin)
  cmn: 'zh',
  zho: 'zh',
  // Japanese
  jpn: 'ja',
  // Korean
  kor: 'ko',
  // Turkish
  tur: 'tr',
  // Indonesian
  ind: 'id',
  // Vietnamese
  vie: 'vi',
  // Thai
  tha: 'th',
  // Persian / Farsi
  fas: 'fa',
  // Polish
  pol: 'pl',
  // Ukrainian
  ukr: 'uk',
  // Swedish
  swe: 'sv',
  // Danish
  dan: 'da',
  // Finnish
  fin: 'fi',
  // Norwegian
  nor: 'no',
  nob: 'nb',
  nno: 'nn',
  // Czech
  ces: 'cs',
  // Slovak
  slk: 'sk',
  // Romanian
  ron: 'ro',
  // Hungarian
  hun: 'hu',
  // Hebrew
  heb: 'he',
};

/** Minimum text length (in characters) required for reliable detection (Req 3.6). */
const MIN_DETECTION_LENGTH = 20;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Result returned by LanguageDetector.detect(). */
export interface LanguageDetectionResult {
  /** ISO 639-1 two-letter language code (e.g. "en", "hi"). */
  language: string;
  /**
   * Confidence score in [0.0, 1.0].
   * 0 indicates the text was too short or the language was undetectable.
   */
  confidence: number;
}

// ---------------------------------------------------------------------------
// LanguageDetector class
// ---------------------------------------------------------------------------

/**
 * Detects the natural language of plain-text article content.
 *
 * Behaviour (Req 3.6):
 *   - Text shorter than 20 characters → `{ language: 'en', confidence: 0 }`
 *   - Detection confidence below `confidenceThreshold` → `{ language: 'en', confidence: <actual> }`
 *   - Otherwise → detected ISO 639-1 code + actual confidence score
 *   - `'und'` (franc's "undetermined") → treated as confidence 0
 */
export class LanguageDetector {
  private readonly confidenceThreshold: number;

  /**
   * @param confidenceThreshold Minimum confidence required to trust the
   *   detected language. Must be in [0, 1]. Default: 0.8 (Req 3.6).
   */
  constructor(confidenceThreshold = 0.8) {
    this.confidenceThreshold = Math.max(0, Math.min(1, confidenceThreshold));
  }

  /**
   * Detects the language of `text`.
   *
   * Returns `{ language: 'en', confidence: 0 }` when:
   *   - `text` is shorter than 20 characters, OR
   *   - franc returns `'und'` (undetectable), OR
   *   - detected confidence is below the configured threshold.
   *
   * When confidence meets or exceeds the threshold, returns the detected
   * ISO 639-1 language code and the actual confidence score.
   */
  detect(text: string): LanguageDetectionResult {
    // Req 3.6: text shorter than 20 chars → default to English with 0 confidence
    if (!text || text.length < MIN_DETECTION_LENGTH) {
      return { language: 'en', confidence: 0 };
    }

    // francAll returns an array of [iso639-3, score] tuples, sorted by
    // descending confidence (higher score = better match). The first tuple
    // is the best candidate.
    const results = francAll(text);
    const topResult = results[0];

    // Guard: franc should always return at least [['und', 1]] but be defensive.
    if (!topResult) {
      return { language: 'en', confidence: 0 };
    }

    const [detectedCode, score] = topResult;

    // 'und' means franc couldn't determine the language at all → confidence 0
    if (detectedCode === 'und') {
      return { language: 'en', confidence: 0 };
    }

    // Map ISO 639-3 → ISO 639-1. Fall back to the 3-letter code when unknown.
    const iso1Code = ISO_639_3_TO_1[detectedCode] ?? detectedCode;

    // Confidence below threshold → fall back to English but record actual score
    if (score < this.confidenceThreshold) {
      return { language: 'en', confidence: score };
    }

    return { language: iso1Code, confidence: score };
  }

  /**
   * Returns `true` when the detection result's confidence meets or exceeds
   * the configured `confidenceThreshold`.
   *
   * Note: a result with `language: 'en'` and `confidence: 0` (the short-text
   * or undetermined fallback) will return `false` unless the threshold is 0.
   */
  isConfident(result: LanguageDetectionResult): boolean {
    return result.confidence >= this.confidenceThreshold;
  }
}
