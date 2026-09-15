/**
 * IndianMarketImpactEngine — maps news events to potentially affected
 * Indian market instruments using rule-based heuristics.
 *
 * This is a sub-component of MarketImpactEngine.  It exclusively produces
 * RULE_BASED evidence-type impacts; upgrading evidence to HISTORICAL is
 * performed by the parent MarketImpactEngine after consulting
 * news_market_reactions records.
 *
 * Covered event-type → asset mappings (Req 10.2):
 *   MONETARY_POLICY  (RBI rate hike / rate cut)
 *   COMMODITY_SHOCK  (crude oil up/down, gold)
 *   GEOPOLITICAL     (risk-off regime)
 *   EARNINGS         (company-specific, keyword-driven)
 *
 * Requirements: Req 10.1, Req 10.2
 */

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

/** Directional impact on an asset. */
export type ImpactDirection = 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'UNCERTAIN';

/**
 * Time horizon over which the impact is expected to materialise.
 *
 * IMMEDIATE  ≤  5 min
 * INTRADAY   ≤  1 day
 * SHORT_TERM ≤  5 days
 * SWING      ≤ 20 days
 * LONG_TERM  >  20 days
 */
export type ImpactHorizon = 'IMMEDIATE' | 'INTRADAY' | 'SHORT_TERM' | 'SWING' | 'LONG_TERM';

/** Source of evidence backing the impact prediction. */
export type EvidenceType = 'HISTORICAL' | 'RULE_BASED' | 'MODEL';

/**
 * A single predicted impact record for one (event, asset) pair.
 *
 * `assetId` maps to `instrument_id` in the AlphaForge InstrumentMaster.
 * `sectorId` is populated for sectoral-index impacts and is null for
 * individual stock impacts.
 */
export interface AssetImpact {
  /** Instrument ID from InstrumentMaster (NSE/BSE symbol or index ticker). */
  assetId: string;
  /** NIFTY sector identifier, populated for sectoral indices. */
  sectorId?: string;
  direction: ImpactDirection;
  /** Predicted impact strength ∈ [0.0, 1.0]. */
  strength: number;
  /** Rule confidence ∈ [0.0, 1.0]. */
  confidence: number;
  expectedHorizon: ImpactHorizon;
  evidenceType: EvidenceType;
  /** Human-readable rationale for this impact assignment. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Internal rule helpers
// ---------------------------------------------------------------------------

/**
 * Normalises a string for keyword matching:
 * lower-case, collapse whitespace, strip punctuation.
 */
function normalise(text: string): string {
  return text.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Returns true if any of `keywords` appear in `haystack`. */
function containsAny(haystack: string, keywords: string[]): boolean {
  return keywords.some((kw) => haystack.includes(kw));
}

// ---------------------------------------------------------------------------
// Rule data tables
// ---------------------------------------------------------------------------

/** Asset IDs aligned with AlphaForge InstrumentMaster identifiers. */
const ASSETS = {
  NIFTY50: 'NIFTY50',
  BANKNIFTY: 'BANKNIFTY',
  HDFCBANK: 'HDFCBANK',
  ICICIBANK: 'ICICIBANK',
  AXISBANK: 'AXISBANK',
  SBIN: 'SBIN',
  ONGC: 'ONGC',
  IOC: 'IOC',
  BPCL: 'BPCL',
  INDIGO: 'INDIGO',
  SPICEJET: 'SPICEJET',
  ASIANPAINT: 'ASIANPAINT',
  BERGER: 'BERGER',
  GOLDIETFS: 'GOLDBEES',   // GOLDBEES — largest Gold ETF on NSE
  GOLD: 'GOLDBEES',
  NIFTYIT: 'NIFTY_IT',
  NIFTYAUTO: 'NIFTY_AUTO',
  NIFTYPHARMA: 'NIFTY_PHARMA',
  NIFTYMETAL: 'NIFTY_METAL',
  NIFTYFMCG: 'NIFTY_FMCG',
  NIFTYENERGY: 'NIFTY_ENERGY',
  NIFTYREALTY: 'NIFTY_REALTY',
} as const;

/** Sector IDs matching the NIFTY sectoral index taxonomy. */
const SECTORS = {
  BANK: 'NIFTY_BANK',
  IT: 'NIFTY_IT',
  FMCG: 'NIFTY_FMCG',
  AUTO: 'NIFTY_AUTO',
  PHARMA: 'NIFTY_PHARMA',
  ENERGY: 'NIFTY_ENERGY',
  METAL: 'NIFTY_METAL',
  REALTY: 'NIFTY_REALTY',
  AVIATION: 'NIFTY_AVIATION',
  PAINT: 'NIFTY_PAINT',
} as const;

// ---------------------------------------------------------------------------
// Keyword constants
// ---------------------------------------------------------------------------

const RBI_KEYWORDS = ['rbi', 'reserve bank of india', 'reserve bank'];
const RATE_HIKE_KEYWORDS = ['rate hike', 'hike rate', 'raises rate', 'raises repo', 'repo rate hike', 'tighten', 'tightening', 'hawkish'];
const RATE_CUT_KEYWORDS = ['rate cut', 'cuts rate', 'reduces repo', 'repo rate cut', 'easing', 'dovish', 'accommodative'];
const CRUDE_UP_KEYWORDS = ['crude rises', 'crude up', 'oil rises', 'oil up', 'oil surge', 'oil prices rise', 'brent up', 'wti up', 'crude surges', 'oil rally'];
const CRUDE_DOWN_KEYWORDS = ['crude falls', 'crude down', 'oil falls', 'oil down', 'oil drop', 'oil prices fall', 'brent down', 'wti down', 'crude slips', 'oil slides'];
const GOLD_KEYWORDS = ['gold', 'bullion', 'precious metal'];
const GEOPOLITICAL_KEYWORDS = ['war', 'conflict', 'military', 'sanction', 'tension', 'attack', 'invasion', 'geopolitical', 'crisis', 'ceasefire'];
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- reserved for future geopolitical scoring
void GEOPOLITICAL_KEYWORDS;

// Earnings-related company keywords (maps keyword → assetId)
const EARNINGS_COMPANY_MAP: ReadonlyArray<{ keywords: string[]; assetId: string }> = [
  { keywords: ['hdfc bank', 'hdfcbank', 'hdfc'], assetId: ASSETS.HDFCBANK },
  { keywords: ['icici bank', 'icicibank', 'icici'], assetId: ASSETS.ICICIBANK },
  { keywords: ['axis bank', 'axisbank'], assetId: ASSETS.AXISBANK },
  { keywords: ['state bank', 'sbi', 'sbin'], assetId: ASSETS.SBIN },
  { keywords: ['ongc', 'oil and natural gas'], assetId: ASSETS.ONGC },
  { keywords: ['indigo', 'interglobe aviation'], assetId: ASSETS.INDIGO },
  { keywords: ['spicejet'], assetId: ASSETS.SPICEJET },
  { keywords: ['asian paints', 'asianpaint'], assetId: ASSETS.ASIANPAINT },
  { keywords: ['berger paints', 'berger'], assetId: ASSETS.BERGER },
  { keywords: ['ioc', 'indian oil'], assetId: ASSETS.IOC },
  { keywords: ['bpcl', 'bharat petroleum'], assetId: ASSETS.BPCL },
];

// ---------------------------------------------------------------------------
// IndianMarketImpactEngine
// ---------------------------------------------------------------------------

/**
 * Maps a structured news event to the list of Indian market assets that are
 * likely to be affected, using static rule-based heuristics.
 *
 * Requirements: Req 10.2
 */
export class IndianMarketImpactEngine {
  /**
   * Returns rule-based heuristic impacts for the given event context.
   *
   * @param eventType  - Classified event type string (e.g. "MONETARY_POLICY").
   * @param actor      - Primary actor extracted from the news event (e.g. "RBI").
   * @param title      - Title of the source news article (used for keyword matching).
   * @returns          Array of `AssetImpact` records; empty when no rule fires.
   */
  getAffectedAssets(
    eventType: string,
    actor: string | null,
    title: string,
  ): AssetImpact[] {
    const normTitle = normalise(title);
    const normActor = actor ? normalise(actor) : '';

    switch (eventType) {
      case 'MONETARY_POLICY':
        return this.handleMonetaryPolicy(normActor, normTitle);

      case 'COMMODITY_SHOCK':
        return this.handleCommodityShock(normTitle);

      case 'GEOPOLITICAL':
        return this.handleGeopolitical();

      case 'EARNINGS':
        return this.handleEarnings(normTitle);

      default:
        return [];
    }
  }

  // -------------------------------------------------------------------------
  // Rule handlers — one per covered event type
  // -------------------------------------------------------------------------

  /**
   * MONETARY_POLICY rules.
   *
   * RBI rate hike  → NIFTY50 NEGATIVE, BANKNIFTY NEGATIVE, HDFCBANK NEGATIVE
   * RBI rate cut   → NIFTY50 POSITIVE, BANKNIFTY POSITIVE
   *
   * When the actor is not RBI the rule does not fire (other central banks have
   * different downstream effects handled by the cross-market engine).
   */
  private handleMonetaryPolicy(normActor: string, normTitle: string): AssetImpact[] {
    const isRbi =
      containsAny(normActor, ['rbi', 'reserve bank']) ||
      containsAny(normTitle, RBI_KEYWORDS);

    if (!isRbi) return [];

    const isRateHike = containsAny(normTitle, RATE_HIKE_KEYWORDS);
    const isRateCut = containsAny(normTitle, RATE_CUT_KEYWORDS);

    if (isRateHike) {
      return [
        {
          assetId: ASSETS.NIFTY50,
          direction: 'NEGATIVE',
          strength: 0.70,
          confidence: 0.80,
          expectedHorizon: 'INTRADAY',
          evidenceType: 'RULE_BASED',
          reason: 'RBI rate hike — higher borrowing costs weigh on broad market (NIFTY50).',
        },
        {
          assetId: ASSETS.BANKNIFTY,
          sectorId: SECTORS.BANK,
          direction: 'NEGATIVE',
          strength: 0.80,
          confidence: 0.82,
          expectedHorizon: 'INTRADAY',
          evidenceType: 'RULE_BASED',
          reason: 'RBI rate hike — NIM pressure and credit slowdown risk for banking sector.',
        },
        {
          assetId: ASSETS.HDFCBANK,
          direction: 'NEGATIVE',
          strength: 0.75,
          confidence: 0.78,
          expectedHorizon: 'INTRADAY',
          evidenceType: 'RULE_BASED',
          reason: 'RBI rate hike — large-cap private bank directly exposed to rate cycle.',
        },
      ];
    }

    if (isRateCut) {
      return [
        {
          assetId: ASSETS.NIFTY50,
          direction: 'POSITIVE',
          strength: 0.70,
          confidence: 0.80,
          expectedHorizon: 'INTRADAY',
          evidenceType: 'RULE_BASED',
          reason: 'RBI rate cut — lower borrowing costs support broad market (NIFTY50).',
        },
        {
          assetId: ASSETS.BANKNIFTY,
          sectorId: SECTORS.BANK,
          direction: 'POSITIVE',
          strength: 0.72,
          confidence: 0.78,
          expectedHorizon: 'INTRADAY',
          evidenceType: 'RULE_BASED',
          reason: 'RBI rate cut — improved credit demand and NIM recovery for banking sector.',
        },
      ];
    }

    // Generic RBI monetary policy event — direction uncertain
    return [
      {
        assetId: ASSETS.NIFTY50,
        direction: 'UNCERTAIN',
        strength: 0.40,
        confidence: 0.50,
        expectedHorizon: 'INTRADAY',
        evidenceType: 'RULE_BASED',
        reason: 'RBI monetary policy event — direction unclear without rate decision keyword.',
      },
      {
        assetId: ASSETS.BANKNIFTY,
        sectorId: SECTORS.BANK,
        direction: 'UNCERTAIN',
        strength: 0.40,
        confidence: 0.50,
        expectedHorizon: 'INTRADAY',
        evidenceType: 'RULE_BASED',
        reason: 'RBI monetary policy event — banking sector direction unclear pending rate decision.',
      },
    ];
  }

  /**
   * COMMODITY_SHOCK rules.
   *
   * Crude oil up   → AVIATION NEGATIVE, PAINT NEGATIVE, ONGC POSITIVE
   * Crude oil down → AVIATION POSITIVE, ONGC NEGATIVE
   * Gold           → GOLDBEES (Gold ETF) POSITIVE
   */
  private handleCommodityShock(normTitle: string): AssetImpact[] {
    const impacts: AssetImpact[] = [];
    const hasCrude = containsAny(normTitle, ['crude', 'oil', 'brent', 'wti', 'petroleum']);
    const hasGold = containsAny(normTitle, GOLD_KEYWORDS);

    if (hasCrude) {
      const crudeUp = containsAny(normTitle, CRUDE_UP_KEYWORDS);
      const crudeDown = containsAny(normTitle, CRUDE_DOWN_KEYWORDS);

      if (crudeUp) {
        impacts.push(
          {
            assetId: ASSETS.INDIGO,
            sectorId: SECTORS.AVIATION,
            direction: 'NEGATIVE',
            strength: 0.75,
            confidence: 0.80,
            expectedHorizon: 'SHORT_TERM',
            evidenceType: 'RULE_BASED',
            reason: 'Crude oil price increase — aviation fuel costs rise, margins compress.',
          },
          {
            assetId: ASSETS.ASIANPAINT,
            sectorId: SECTORS.PAINT,
            direction: 'NEGATIVE',
            strength: 0.65,
            confidence: 0.72,
            expectedHorizon: 'SHORT_TERM',
            evidenceType: 'RULE_BASED',
            reason: 'Crude oil price increase — crude derivatives are key raw material for paint sector.',
          },
          {
            assetId: ASSETS.ONGC,
            sectorId: SECTORS.ENERGY,
            direction: 'POSITIVE',
            strength: 0.80,
            confidence: 0.85,
            expectedHorizon: 'INTRADAY',
            evidenceType: 'RULE_BASED',
            reason: 'Crude oil price increase — higher realisation prices boost upstream oil producer revenues.',
          },
        );
      } else if (crudeDown) {
        impacts.push(
          {
            assetId: ASSETS.INDIGO,
            sectorId: SECTORS.AVIATION,
            direction: 'POSITIVE',
            strength: 0.75,
            confidence: 0.80,
            expectedHorizon: 'SHORT_TERM',
            evidenceType: 'RULE_BASED',
            reason: 'Crude oil price decline — aviation fuel costs fall, margin expansion expected.',
          },
          {
            assetId: ASSETS.ONGC,
            sectorId: SECTORS.ENERGY,
            direction: 'NEGATIVE',
            strength: 0.78,
            confidence: 0.83,
            expectedHorizon: 'INTRADAY',
            evidenceType: 'RULE_BASED',
            reason: 'Crude oil price decline — lower realisation prices reduce upstream oil producer revenues.',
          },
        );
      }
    }

    if (hasGold) {
      // Gold shock typically benefits Gold ETFs regardless of direction —
      // volatility in gold drives inflows.  Direction mirrors the title signal.
      const goldUp = containsAny(normTitle, ['gold rises', 'gold up', 'gold surge', 'gold rally', 'gold gains']);
      const goldDown = containsAny(normTitle, ['gold falls', 'gold down', 'gold drops', 'gold slips']);
      const direction: ImpactDirection = goldUp ? 'POSITIVE' : goldDown ? 'NEGATIVE' : 'POSITIVE';
      const reason = goldUp
        ? 'Gold price increase — Gold ETFs track spot price; positive impact on GOLDBEES.'
        : goldDown
          ? 'Gold price decline — negative for Gold ETFs tracking spot price.'
          : 'Gold commodity shock — investors typically move to Gold ETFs during gold volatility.';

      impacts.push({
        assetId: ASSETS.GOLDIETFS,
        direction,
        strength: 0.70,
        confidence: 0.75,
        expectedHorizon: 'INTRADAY',
        evidenceType: 'RULE_BASED',
        reason,
      });
    }

    return impacts;
  }

  /**
   * GEOPOLITICAL rules.
   *
   * Geopolitical events trigger risk-off sentiment:
   *   NIFTY50 NEGATIVE (FII outflows, risk aversion)
   *   GOLDBEES POSITIVE (safe-haven demand)
   */
  private handleGeopolitical(): AssetImpact[] {
    return [
      {
        assetId: ASSETS.NIFTY50,
        direction: 'NEGATIVE',
        strength: 0.65,
        confidence: 0.72,
        expectedHorizon: 'INTRADAY',
        evidenceType: 'RULE_BASED',
        reason: 'Geopolitical event — risk-off sentiment typically causes FII outflows from Indian equities.',
      },
      {
        assetId: ASSETS.GOLDIETFS,
        direction: 'POSITIVE',
        strength: 0.70,
        confidence: 0.76,
        expectedHorizon: 'INTRADAY',
        evidenceType: 'RULE_BASED',
        reason: 'Geopolitical event — safe-haven demand drives gold and Gold ETF inflows.',
      },
    ];
  }

  /**
   * EARNINGS rules — company-specific, keyword-driven from article title.
   *
   * Iterates the EARNINGS_COMPANY_MAP and emits an UNCERTAIN impact for
   * each matched company (sentiment direction is resolved by the parent
   * engine from news_sentiment data).
   */
  private handleEarnings(normTitle: string): AssetImpact[] {
    const impacts: AssetImpact[] = [];

    for (const entry of EARNINGS_COMPANY_MAP) {
      if (containsAny(normTitle, entry.keywords)) {
        // Beat / miss keywords improve confidence
        const isBeat = containsAny(normTitle, ['beat', 'beats', 'outperform', 'strong results', 'profit jumps', 'profit rises', 'net profit up']);
        const isMiss = containsAny(normTitle, ['miss', 'misses', 'disappoint', 'weak results', 'profit falls', 'loss widens', 'net profit down']);

        const direction: ImpactDirection = isBeat ? 'POSITIVE' : isMiss ? 'NEGATIVE' : 'UNCERTAIN';
        const strength = isBeat || isMiss ? 0.70 : 0.50;
        const confidence = isBeat || isMiss ? 0.72 : 0.55;

        impacts.push({
          assetId: entry.assetId,
          direction,
          strength,
          confidence,
          expectedHorizon: 'INTRADAY',
          evidenceType: 'RULE_BASED',
          reason: `Earnings event for ${entry.assetId}${isBeat ? ' — results beat expectations' : isMiss ? ' — results missed expectations' : ' — awaiting result confirmation'}.`,
        });
      }
    }

    return impacts;
  }
}
