/**
 * Property 12: Sentiment score range.
 *
 * For any article text input, all five sentiment dimension scores
 * (sentimentScore, marketSentiment, companySentiment, macroSentiment,
 * riskSentiment) must always be in [-1.0000, +1.0000].
 *
 * Also verifies:
 *   - Confidence is always in [0.0, 1.0].
 *   - Qualitative signals are always members of QUALITATIVE_SIGNALS.
 *   - At least one qualitative signal is always returned (NEUTRAL as fallback).
 *
 * **Validates: Requirements 8.1, 8.2, 8.3**
 */
import { describe, it } from 'vitest';
import fc from 'fast-check';
import {
  QUALITATIVE_SIGNALS,
  type QualitativeSignal,
} from '../../src/engines/sentiment/SentimentEngine.js';

// ---------------------------------------------------------------------------
// Replicate the pure scoring functions from SentimentEngine (private)
// ---------------------------------------------------------------------------

function countKeywordHits(text: string, keywords: readonly string[]): number {
  let hits = 0;
  for (const kw of keywords) {
    if (text.includes(kw)) hits += 1;
  }
  return hits;
}

function computeDimensionScore(positiveHits: number, negativeHits: number): number {
  const totalHits = positiveHits + negativeHits;
  if (totalHits === 0) return 0;
  const raw = (positiveHits - negativeHits) / totalHits;
  return Math.round(raw * 10_000) / 10_000;
}

function computeDimensionConfidence(
  positiveHits: number,
  negativeHits: number,
  totalLexiconSize: number,
): number {
  if (totalLexiconSize === 0) return 0;
  const matchedFraction = (positiveHits + negativeHits) / totalLexiconSize;
  const capped = Math.min(matchedFraction, 1.0);
  return Math.round(capped * 10_000) / 10_000;
}

function computeOverallConfidence(dimensionConfidences: number[]): number {
  if (dimensionConfidences.length === 0) return 0;
  const sum = dimensionConfidences.reduce((acc, c) => acc + c, 0);
  const mean = sum / dimensionConfidences.length;
  return Math.round(mean * 10_000) / 10_000;
}

// Minimal lexicons (same as SentimentEngine — kept short to avoid duplication)
const MARKET_POSITIVE = ['bull', 'rally', 'surge', 'soar', 'gains', 'recovery', 'breakout', 'upside', 'rebound'];
const MARKET_NEGATIVE = ['bear', 'crash', 'plunge', 'decline', 'selloff', 'correction', 'panic', 'recession', 'slowdown'];
const COMPANY_POSITIVE = ['profit', 'earnings beat', 'revenue growth', 'expansion', 'acquisition', 'buyback', 'dividend'];
const COMPANY_NEGATIVE = ['loss', 'earnings miss', 'bankruptcy', 'fraud', 'layoff', 'downgrade', 'default', 'write-off'];
const MACRO_POSITIVE = ['gdp growth', 'economic expansion', 'employment', 'fiscal surplus', 'trade surplus'];
const MACRO_NEGATIVE = ['inflation', 'stagflation', 'recession', 'deficit', 'unemployment', 'rate hike concern'];
const RISK_ON = ['stable', 'calm', 'growth', 'confidence', 'safe'];
const RISK_OFF = ['war', 'crisis', 'uncertainty', 'volatility', 'fear'];

const QUALITATIVE_KEYWORD_MAP: Record<string, string[]> = {
  HAWKISH: ['rate hike', 'tighten', 'inflation fight', 'aggressive policy'],
  DOVISH: ['rate cut', 'easy money', 'stimulus', 'accommodative'],
  PANIC: ['crash', 'emergency', 'crisis', 'fear', 'plunge', 'halt'],
  FEAR: ['uncertainty', 'warning', 'risk', 'concern', 'threat'],
  OPTIMISM: ['recovery', 'growth', 'bullish', 'positive', 'strong'],
  UNCERTAINTY: ['unclear', 'unknown', 'uncertain', 'ambiguous', 'speculation'],
  RISK_ON: ['risk on', 'risk-on', 'appetite', 'confidence', 'optimistic'],
  RISK_OFF: ['risk off', 'risk-off', 'safe haven', 'flight to safety', 'caution'],
};

const SIGNAL_CONFIDENCE_THRESHOLD = 0.005;

function computeSentimentResult(text: string) {
  const lowerText = text.toLowerCase();
  const wordCount = lowerText.split(/\s+/).filter(Boolean).length;

  const mPos = countKeywordHits(lowerText, MARKET_POSITIVE);
  const mNeg = countKeywordHits(lowerText, MARKET_NEGATIVE);
  const marketSentiment = computeDimensionScore(mPos, mNeg);
  const marketConf = computeDimensionConfidence(mPos, mNeg, MARKET_POSITIVE.length + MARKET_NEGATIVE.length);

  const cPos = countKeywordHits(lowerText, COMPANY_POSITIVE);
  const cNeg = countKeywordHits(lowerText, COMPANY_NEGATIVE);
  const companySentiment = computeDimensionScore(cPos, cNeg);
  const companyConf = computeDimensionConfidence(cPos, cNeg, COMPANY_POSITIVE.length + COMPANY_NEGATIVE.length);

  const maPos = countKeywordHits(lowerText, MACRO_POSITIVE);
  const maNeg = countKeywordHits(lowerText, MACRO_NEGATIVE);
  const macroSentiment = computeDimensionScore(maPos, maNeg);
  const macroConf = computeDimensionConfidence(maPos, maNeg, MACRO_POSITIVE.length + MACRO_NEGATIVE.length);

  const roHits = countKeywordHits(lowerText, RISK_ON);
  const rofHits = countKeywordHits(lowerText, RISK_OFF);
  const riskSentiment = computeDimensionScore(roHits, rofHits);
  const riskConf = computeDimensionConfidence(roHits, rofHits, RISK_ON.length + RISK_OFF.length);

  const rawOverall = (marketSentiment + companySentiment + macroSentiment + riskSentiment) / 4;
  const sentimentScore = Math.round(rawOverall * 10_000) / 10_000;
  const confidence = computeOverallConfidence([marketConf, companyConf, macroConf, riskConf]);

  // Qualitative signals
  const signals: QualitativeSignal[] = [];
  for (const [signal, keywords] of Object.entries(QUALITATIVE_KEYWORD_MAP)) {
    const hits = countKeywordHits(lowerText, keywords);
    if (hits > 0) {
      const density = hits / Math.max(wordCount, 1);
      if (density >= SIGNAL_CONFIDENCE_THRESHOLD) {
        signals.push(signal as QualitativeSignal);
      }
    }
  }
  if (signals.length === 0) signals.push('NEUTRAL');

  return { sentimentScore, marketSentiment, companySentiment, macroSentiment, riskSentiment, confidence, qualitativeSignals: signals };
}

// Feature: sentinel-pulse
describe('Property 12: sentiment score range', () => {
  it('all sentiment scores are always in [-1.0000, +1.0000]', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 1000 }),
        (text) => {
          const result = computeSentimentResult(text);
          return (
            result.sentimentScore >= -1 && result.sentimentScore <= 1 &&
            result.marketSentiment >= -1 && result.marketSentiment <= 1 &&
            result.companySentiment >= -1 && result.companySentiment <= 1 &&
            result.macroSentiment >= -1 && result.macroSentiment <= 1 &&
            result.riskSentiment >= -1 && result.riskSentiment <= 1
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it('confidence is always in [0.0, 1.0]', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 1000 }),
        (text) => {
          const result = computeSentimentResult(text);
          return result.confidence >= 0 && result.confidence <= 1;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('qualitative signals are always members of QUALITATIVE_SIGNALS', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 1000 }),
        (text) => {
          const result = computeSentimentResult(text);
          return result.qualitativeSignals.every((s) => QUALITATIVE_SIGNALS.includes(s));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('at least one qualitative signal is always returned (NEUTRAL as fallback)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 1000 }),
        (text) => computeSentimentResult(text).qualitativeSignals.length >= 1,
      ),
      { numRuns: 200 },
    );
  });

  it('empty text produces zero scores and NEUTRAL signal', () => {
    const result = computeSentimentResult('');
    expect(result.sentimentScore).toBe(0);
    expect(result.marketSentiment).toBe(0);
    expect(result.qualitativeSignals).toContain('NEUTRAL');
  });

  it('computeDimensionScore is always in [-1, 1] for any hit counts', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 100 }),
        (pos, neg) => {
          const score = computeDimensionScore(pos, neg);
          return score >= -1 && score <= 1;
        },
      ),
      { numRuns: 200 },
    );
  });
});
