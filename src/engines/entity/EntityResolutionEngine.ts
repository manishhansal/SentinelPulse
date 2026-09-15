/**
 * EntityResolutionEngine — extracts named entities from article text and
 * resolves them to canonical AlphaForge InstrumentMaster entries.
 *
 * Pipeline position:
 *   news.deduplicated queue → EntityResolutionEngine → news.entities queue
 *
 * Entity extraction strategy:
 *   Pattern/dictionary-based NER using curated lists of known Indian market
 *   entities. No external ML model required.
 *   - Exact match (case-insensitive) → confidence 0.90
 *   - Partial / alias match → confidence 0.65
 *
 * Resolution:
 *   Each extracted entity is resolved via DataServiceClient.resolveInstrument().
 *   SentinelPulse is read-only w.r.t. InstrumentMaster (Req 5.3).
 *   Unresolved entities are stored with entity_id = null (Req 5.4).
 *
 * Confidence gate:
 *   asset/sector links are written only for mentions with confidence >= 0.50
 *   (Req 5.6).
 *
 * Reprocessing:
 *   On reprocessing the same article, existing news_entity_mentions,
 *   news_asset_links, and news_sector_links rows for the article_id are
 *   deleted before new records are inserted, producing an identical final
 *   state regardless of how many times the article is processed (Req 5.7).
 *
 * Queue publish:
 *   On success: publish article_id to news.entities queue (Req 5.8).
 *   On failure at any stage: do NOT publish; preserve any previously committed
 *   DB state unchanged (Req 5.9).
 *
 * Requirements: Req 5.1–5.9
 */

import { randomUUID } from 'crypto';
import { pino } from 'pino';
import type { Queue } from 'bullmq';
import { prisma } from '../../db/prisma.js';
import { DataServiceClient } from '../../integrations/data-service/DataServiceClient.js';
import type { InstrumentMasterEntry } from '../../integrations/data-service/DataServiceClient.js';
import { InstrumentIndex } from './InstrumentIndex.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger = pino({ name: 'EntityResolutionEngine' });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Confidence assigned to exact (case-insensitive) dictionary matches. */
const CONFIDENCE_EXACT = 0.90;

/** Confidence assigned to partial / alias dictionary matches. */
const CONFIDENCE_PARTIAL = 0.65;

/** Minimum confidence required before writing asset/sector links (Req 5.6). */
const MIN_LINK_CONFIDENCE = 0.50;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Entity types extracted by the engine (Req 5.1). */
export type EntityType =
  | 'Company'
  | 'Instrument'
  | 'Index'
  | 'Commodity'
  | 'Currency'
  | 'Country'
  | 'Institution';

/**
 * A raw named-entity mention produced by pattern-based extraction before
 * InstrumentMaster resolution.
 */
export interface ExtractedEntity {
  /** The text fragment that triggered the match (e.g. "Reliance", "NIFTY 50"). */
  surfaceForm: string;
  entityType: EntityType;
  /** 0.90 for exact match, 0.65 for partial / alias match. */
  confidence: number;
  /** 0-based sentence index within the concatenated article text. */
  sentencePos: number;
  /** 0-based character offset within the source field string. */
  charOffset: number;
  /** Which article field the mention came from. */
  fieldSource: 'title' | 'summary' | 'content';
}

/**
 * Minimum article payload accepted by EntityResolutionEngine.process().
 * Matches the shape of a NormalizedArticle row from news_articles.
 */
export interface ArticleInput {
  id: string;
  sourceId: string;
  externalId: string;
  title: string;
  summary: string | null;
  content: string | null;
  publishedAt: Date;
}

// ---------------------------------------------------------------------------
// Entity dictionaries
// ---------------------------------------------------------------------------

/**
 * Each dictionary entry maps a canonical surface form to:
 *  - aliases:    alternative spellings / tickers to match
 *  - entityType: classification
 *  - sectorId:   optional NIFTY sector index identifier for sector links
 *
 * Matching is case-insensitive. The canonical form is always checked first
 * (exact match → 0.90). Aliases are checked second (partial match → 0.65).
 */
interface DictionaryEntry {
  canonical: string;
  aliases: string[];
  entityType: EntityType;
  /** Optional sector identifier used when writing news_sector_links. */
  sectorId?: string;
}

const ENTITY_DICTIONARY: DictionaryEntry[] = [
  // =========================================================================
  // Indian Market Indices
  // =========================================================================
  {
    canonical: 'NIFTY 50',
    aliases: ['NIFTY50', 'NIFTY', 'CNX NIFTY', 'NSE NIFTY'],
    entityType: 'Index',
    sectorId: 'NIFTY50',
  },
  {
    canonical: 'SENSEX',
    aliases: ['BSE SENSEX', 'S&P BSE SENSEX', 'BSE 30'],
    entityType: 'Index',
    sectorId: 'SENSEX',
  },
  {
    canonical: 'BANK NIFTY',
    aliases: ['BANKNIFTY', 'NIFTY BANK', 'NIFTY BANKING'],
    entityType: 'Index',
    sectorId: 'BANKNIFTY',
  },
  {
    canonical: 'NIFTY IT',
    aliases: ['NIFTYIT', 'CNXIT', 'CNX IT', 'NIFTY IT INDEX'],
    entityType: 'Index',
    sectorId: 'NIFTYIT',
  },
  {
    canonical: 'NIFTY AUTO',
    aliases: ['NIFTYAUTO', 'CNX AUTO'],
    entityType: 'Index',
    sectorId: 'NIFTYAUTO',
  },
  {
    canonical: 'NIFTY PHARMA',
    aliases: ['NIFTYPHARMA', 'CNX PHARMA'],
    entityType: 'Index',
    sectorId: 'NIFTYPHARMA',
  },
  {
    canonical: 'NIFTY FMCG',
    aliases: ['NIFTYFMCG', 'CNX FMCG'],
    entityType: 'Index',
    sectorId: 'NIFTYFMCG',
  },
  {
    canonical: 'NIFTY ENERGY',
    aliases: ['NIFTYENERGY', 'CNX ENERGY'],
    entityType: 'Index',
    sectorId: 'NIFTYENERGY',
  },
  {
    canonical: 'NIFTY METAL',
    aliases: ['NIFTYMETAL', 'CNX METAL'],
    entityType: 'Index',
    sectorId: 'NIFTYMETAL',
  },
  {
    canonical: 'NIFTY REALTY',
    aliases: ['NIFTYREALTY', 'CNX REALTY'],
    entityType: 'Index',
    sectorId: 'NIFTYREALTY',
  },
  {
    canonical: 'NIFTY MIDCAP',
    aliases: ['NIFTYMIDCAP', 'NIFTY MIDCAP 100', 'NIFTY MIDCAP 150'],
    entityType: 'Index',
    sectorId: 'NIFTY_MIDCAP',
  },
  {
    canonical: 'NIFTY SMALLCAP',
    aliases: ['NIFTYSMALLCAP', 'NIFTY SMALLCAP 100', 'NIFTY SMALLCAP 250'],
    entityType: 'Index',
    sectorId: 'NIFTY_SMALLCAP',
  },

  // =========================================================================
  // Major Indian Companies
  // =========================================================================
  {
    canonical: 'Reliance Industries',
    aliases: ['Reliance', 'RIL', 'RELIANCE', 'Reliance Ind', 'Mukesh Ambani company'],
    entityType: 'Company',
    sectorId: 'NIFTYENERGY',
  },
  {
    canonical: 'Tata Consultancy Services',
    aliases: ['TCS', 'Tata Consultancy', 'Tata CS'],
    entityType: 'Company',
    sectorId: 'NIFTYIT',
  },
  {
    canonical: 'HDFC Bank',
    aliases: ['HDFCBANK', 'HDFC Bk', 'Housing Development Finance Bank'],
    entityType: 'Company',
    sectorId: 'BANKNIFTY',
  },
  {
    canonical: 'ICICI Bank',
    aliases: ['ICICIBANK', 'ICICI Bk', 'ICICI'],
    entityType: 'Company',
    sectorId: 'BANKNIFTY',
  },
  {
    canonical: 'Infosys',
    aliases: ['INFY', 'Infosys Ltd', 'Infosys Technologies'],
    entityType: 'Company',
    sectorId: 'NIFTYIT',
  },
  {
    canonical: 'Wipro',
    aliases: ['WIPRO', 'Wipro Ltd'],
    entityType: 'Company',
    sectorId: 'NIFTYIT',
  },
  {
    canonical: 'HCL Technologies',
    aliases: ['HCLTECH', 'HCL Tech', 'HCL Technologies Ltd'],
    entityType: 'Company',
    sectorId: 'NIFTYIT',
  },
  {
    canonical: 'Tech Mahindra',
    aliases: ['TECHM', 'Tech Mahindra Ltd'],
    entityType: 'Company',
    sectorId: 'NIFTYIT',
  },
  {
    canonical: 'ONGC',
    aliases: ['Oil and Natural Gas Corporation', 'Oil & Natural Gas', 'ONGC Ltd'],
    entityType: 'Company',
    sectorId: 'NIFTYENERGY',
  },
  {
    canonical: 'Bharti Airtel',
    aliases: ['Airtel', 'BHARTIARTL', 'Bharti Telecom'],
    entityType: 'Company',
  },
  {
    canonical: 'Hindustan Unilever',
    aliases: ['HUL', 'Hindustan Lever', 'HINDUNILVR'],
    entityType: 'Company',
    sectorId: 'NIFTYFMCG',
  },
  {
    canonical: 'ITC',
    aliases: ['ITC Ltd', 'ITC Limited', 'Imperial Tobacco Company'],
    entityType: 'Company',
    sectorId: 'NIFTYFMCG',
  },
  {
    canonical: 'Larsen & Toubro',
    aliases: ['L&T', 'LT', 'Larsen and Toubro', 'L and T', 'LARSENTUBRO'],
    entityType: 'Company',
  },
  {
    canonical: 'State Bank of India',
    aliases: ['SBI', 'State Bank', 'SBIN'],
    entityType: 'Company',
    sectorId: 'BANKNIFTY',
  },
  {
    canonical: 'Axis Bank',
    aliases: ['AXISBANK', 'UTI Bank'],
    entityType: 'Company',
    sectorId: 'BANKNIFTY',
  },
  {
    canonical: 'Kotak Mahindra Bank',
    aliases: ['Kotak Bank', 'KOTAKBANK', 'Kotak Mahindra'],
    entityType: 'Company',
    sectorId: 'BANKNIFTY',
  },
  {
    canonical: 'Bajaj Finance',
    aliases: ['BAJFINANCE', 'Bajaj Fin'],
    entityType: 'Company',
  },
  {
    canonical: 'Maruti Suzuki',
    aliases: ['Maruti', 'MARUTI', 'MARUTI SUZUKI', 'Maruti Udyog'],
    entityType: 'Company',
    sectorId: 'NIFTYAUTO',
  },
  {
    canonical: 'Tata Motors',
    aliases: ['TATAMOTORS', 'Tata Motor', 'Jaguar Land Rover'],
    entityType: 'Company',
    sectorId: 'NIFTYAUTO',
  },
  {
    canonical: 'Mahindra & Mahindra',
    aliases: ['M&M', 'Mahindra', 'MAHINDRA', 'M and M'],
    entityType: 'Company',
    sectorId: 'NIFTYAUTO',
  },
  {
    canonical: 'Dr. Reddy\'s Laboratories',
    aliases: ['Dr Reddy', 'DRREDDY', 'Dr Reddy Labs', 'DRL'],
    entityType: 'Company',
    sectorId: 'NIFTYPHARMA',
  },
  {
    canonical: 'Sun Pharmaceutical',
    aliases: ['Sun Pharma', 'SUNPHARMA', 'Sun Pharma Industries'],
    entityType: 'Company',
    sectorId: 'NIFTYPHARMA',
  },
  {
    canonical: 'Cipla',
    aliases: ['CIPLA', 'Cipla Ltd'],
    entityType: 'Company',
    sectorId: 'NIFTYPHARMA',
  },
  {
    canonical: 'Asian Paints',
    aliases: ['ASIANPAINT', 'Asian Paints Ltd'],
    entityType: 'Company',
  },
  {
    canonical: 'Nestle India',
    aliases: ['NESTLEIND', 'Nestle', 'Nestlé India'],
    entityType: 'Company',
    sectorId: 'NIFTYFMCG',
  },
  {
    canonical: 'Power Grid Corporation',
    aliases: ['Power Grid', 'POWERGRID', 'PGCIL'],
    entityType: 'Company',
    sectorId: 'NIFTYENERGY',
  },
  {
    canonical: 'NTPC',
    aliases: ['NTPC Ltd', 'National Thermal Power'],
    entityType: 'Company',
    sectorId: 'NIFTYENERGY',
  },
  {
    canonical: 'Tata Steel',
    aliases: ['TATASTEEL', 'Tata Steel Ltd'],
    entityType: 'Company',
    sectorId: 'NIFTYMETAL',
  },
  {
    canonical: 'JSW Steel',
    aliases: ['JSWSTEEL', 'JSW Steel Ltd'],
    entityType: 'Company',
    sectorId: 'NIFTYMETAL',
  },
  {
    canonical: 'Adani Enterprises',
    aliases: ['Adani', 'ADANIENT', 'Adani Group'],
    entityType: 'Company',
  },
  {
    canonical: 'Adani Ports',
    aliases: ['ADANIPORTS', 'Adani Port', 'Adani Ports SEZ'],
    entityType: 'Company',
  },
  {
    canonical: 'Wipro',
    aliases: ['WIPRO', 'Wipro Ltd'],
    entityType: 'Company',
    sectorId: 'NIFTYIT',
  },
  {
    canonical: 'IndusInd Bank',
    aliases: ['INDUSINDBK', 'IndusInd'],
    entityType: 'Company',
    sectorId: 'BANKNIFTY',
  },
  {
    canonical: 'UltraTech Cement',
    aliases: ['ULTRACEMCO', 'UltraTech'],
    entityType: 'Company',
  },
  {
    canonical: 'Hindustan Petroleum',
    aliases: ['HPCL', 'Hindustan Petroleum Corp'],
    entityType: 'Company',
    sectorId: 'NIFTYENERGY',
  },
  {
    canonical: 'Bharat Petroleum',
    aliases: ['BPCL', 'Bharat Petroleum Corp'],
    entityType: 'Company',
    sectorId: 'NIFTYENERGY',
  },
  {
    canonical: 'Indian Oil Corporation',
    aliases: ['IOC', 'Indian Oil', 'IndianOil', 'IOCL'],
    entityType: 'Company',
    sectorId: 'NIFTYENERGY',
  },
  {
    canonical: 'Coal India',
    aliases: ['COALINDIA', 'Coal India Ltd'],
    entityType: 'Company',
  },

  // =========================================================================
  // Commodities
  // =========================================================================
  {
    canonical: 'Gold',
    aliases: ['GOLD', 'XAU', 'XAU/USD', 'bullion', 'yellow metal', 'MCX Gold'],
    entityType: 'Commodity',
    sectorId: 'GOLD',
  },
  {
    canonical: 'Silver',
    aliases: ['SILVER', 'XAG', 'XAG/USD', 'MCX Silver'],
    entityType: 'Commodity',
  },
  {
    canonical: 'Crude Oil',
    aliases: [
      'Crude',
      'CRUDE OIL',
      'Brent',
      'Brent Crude',
      'WTI',
      'West Texas Intermediate',
      'oil prices',
      'MCX Crude',
    ],
    entityType: 'Commodity',
    sectorId: 'CRUDE_OIL',
  },
  {
    canonical: 'Natural Gas',
    aliases: ['NATGAS', 'NAT GAS', 'Natural gas prices', 'MCX Natural Gas'],
    entityType: 'Commodity',
  },
  {
    canonical: 'Copper',
    aliases: ['COPPER', 'MCX Copper', 'base metal'],
    entityType: 'Commodity',
    sectorId: 'NIFTYMETAL',
  },
  {
    canonical: 'Aluminium',
    aliases: ['ALUMINIUM', 'MCX Aluminium', 'Aluminum'],
    entityType: 'Commodity',
    sectorId: 'NIFTYMETAL',
  },
  {
    canonical: 'Zinc',
    aliases: ['ZINC', 'MCX Zinc'],
    entityType: 'Commodity',
    sectorId: 'NIFTYMETAL',
  },
  {
    canonical: 'Lead',
    aliases: ['LEAD', 'MCX Lead'],
    entityType: 'Commodity',
    sectorId: 'NIFTYMETAL',
  },
  {
    canonical: 'Nickel',
    aliases: ['NICKEL', 'MCX Nickel'],
    entityType: 'Commodity',
    sectorId: 'NIFTYMETAL',
  },
  {
    canonical: 'Cotton',
    aliases: ['COTTON', 'kapas'],
    entityType: 'Commodity',
  },
  {
    canonical: 'Wheat',
    aliases: ['WHEAT', 'grain prices'],
    entityType: 'Commodity',
  },
  {
    canonical: 'Soybean',
    aliases: ['SOYBEAN', 'soya', 'oilseed'],
    entityType: 'Commodity',
  },

  // =========================================================================
  // Currencies / FX
  // =========================================================================
  {
    canonical: 'USD/INR',
    aliases: ['USDINR', 'dollar-rupee', 'dollar rupee', 'INR/USD', 'rupee'],
    entityType: 'Currency',
  },
  {
    canonical: 'EUR/INR',
    aliases: ['EURINR', 'euro rupee'],
    entityType: 'Currency',
  },
  {
    canonical: 'GBP/INR',
    aliases: ['GBPINR', 'pound rupee'],
    entityType: 'Currency',
  },
  {
    canonical: 'JPY/INR',
    aliases: ['JPYINR', 'yen rupee'],
    entityType: 'Currency',
  },
  {
    canonical: 'USD Index',
    aliases: ['DXY', 'US Dollar Index', 'Dollar Index'],
    entityType: 'Currency',
  },
  {
    canonical: 'EUR/USD',
    aliases: ['EURUSD', 'euro dollar'],
    entityType: 'Currency',
  },
  {
    canonical: 'GBP/USD',
    aliases: ['GBPUSD', 'pound dollar', 'cable'],
    entityType: 'Currency',
  },
  {
    canonical: 'USD/JPY',
    aliases: ['USDJPY', 'dollar yen'],
    entityType: 'Currency',
  },
  {
    canonical: 'USD/CNY',
    aliases: ['USDCNY', 'dollar yuan', 'yuan', 'renminbi', 'RMB'],
    entityType: 'Currency',
  },

  // =========================================================================
  // Countries / Geographies
  // =========================================================================
  {
    canonical: 'India',
    aliases: ['Indian', 'Bharat', 'Republic of India'],
    entityType: 'Country',
  },
  {
    canonical: 'USA',
    aliases: ['United States', 'US', 'America', 'American', 'U.S.', 'U.S.A.'],
    entityType: 'Country',
  },
  {
    canonical: 'China',
    aliases: ['Chinese', "People's Republic of China", 'PRC'],
    entityType: 'Country',
  },
  {
    canonical: 'United Kingdom',
    aliases: ['UK', 'Britain', 'British', 'England', 'U.K.'],
    entityType: 'Country',
  },
  {
    canonical: 'European Union',
    aliases: ['EU', 'Eurozone', 'Euro area', 'Europe'],
    entityType: 'Country',
  },
  {
    canonical: 'Japan',
    aliases: ['Japanese'],
    entityType: 'Country',
  },
  {
    canonical: 'Germany',
    aliases: ['German', 'Deutschland'],
    entityType: 'Country',
  },
  {
    canonical: 'Russia',
    aliases: ['Russian', 'Russian Federation'],
    entityType: 'Country',
  },
  {
    canonical: 'Saudi Arabia',
    aliases: ['Saudi', 'KSA', 'Kingdom of Saudi Arabia'],
    entityType: 'Country',
  },
  {
    canonical: 'UAE',
    aliases: ['United Arab Emirates', 'Dubai', 'Abu Dhabi'],
    entityType: 'Country',
  },
  {
    canonical: 'Canada',
    aliases: ['Canadian'],
    entityType: 'Country',
  },
  {
    canonical: 'Australia',
    aliases: ['Australian', 'AUS'],
    entityType: 'Country',
  },
  {
    canonical: 'Singapore',
    aliases: ['Singaporean'],
    entityType: 'Country',
  },
  {
    canonical: 'South Korea',
    aliases: ['Korea', 'Korean', 'ROK'],
    entityType: 'Country',
  },
  {
    canonical: 'Brazil',
    aliases: ['Brazilian'],
    entityType: 'Country',
  },

  // =========================================================================
  // Institutions / Central Banks / Regulators
  // =========================================================================
  {
    canonical: 'RBI',
    aliases: [
      'Reserve Bank of India',
      'Reserve Bank',
      'RBI Monetary Policy',
      'RBI Governor',
      'Indian central bank',
    ],
    entityType: 'Institution',
  },
  {
    canonical: 'SEBI',
    aliases: [
      'Securities and Exchange Board of India',
      'Securities Exchange Board',
      'market regulator',
    ],
    entityType: 'Institution',
  },
  {
    canonical: 'Federal Reserve',
    aliases: ['FED', 'Fed', 'FOMC', 'US Federal Reserve', 'US Fed', 'Fed Reserve', 'Fed Chair'],
    entityType: 'Institution',
  },
  {
    canonical: 'ECB',
    aliases: [
      'European Central Bank',
      'ECB President',
      'Eurozone central bank',
    ],
    entityType: 'Institution',
  },
  {
    canonical: 'IMF',
    aliases: [
      'International Monetary Fund',
      'IMF forecasts',
      'IMF report',
    ],
    entityType: 'Institution',
  },
  {
    canonical: 'World Bank',
    aliases: ['IBRD', 'World Bank Group', 'World Bank report'],
    entityType: 'Institution',
  },
  {
    canonical: 'Bank of Japan',
    aliases: ['BOJ', 'BoJ', 'Japanese central bank'],
    entityType: 'Institution',
  },
  {
    canonical: "People's Bank of China",
    aliases: ['PBOC', 'PBC', 'Chinese central bank'],
    entityType: 'Institution',
  },
  {
    canonical: 'Bank of England',
    aliases: ['BOE', 'BoE', 'British central bank'],
    entityType: 'Institution',
  },
  {
    canonical: 'OPEC',
    aliases: [
      'Organization of the Petroleum Exporting Countries',
      'OPEC+',
      'OPEC meeting',
    ],
    entityType: 'Institution',
  },
  {
    canonical: 'NSE',
    aliases: ['National Stock Exchange', 'National Stock Exchange of India'],
    entityType: 'Institution',
  },
  {
    canonical: 'BSE',
    aliases: ['Bombay Stock Exchange', 'Bombay Stock Exchange Ltd'],
    entityType: 'Institution',
  },
  {
    canonical: 'NSDL',
    aliases: ['National Securities Depository', 'National Securities Depository Ltd'],
    entityType: 'Institution',
  },
  {
    canonical: 'CDSL',
    aliases: ['Central Depository Services'],
    entityType: 'Institution',
  },
  {
    canonical: 'Ministry of Finance',
    aliases: ['Finance Ministry', 'Indian Finance Ministry', 'Finance Minister'],
    entityType: 'Institution',
  },
  {
    canonical: 'NASSCOM',
    aliases: ['National Association of Software and Service Companies'],
    entityType: 'Institution',
  },
  {
    canonical: 'CII',
    aliases: ['Confederation of Indian Industry'],
    entityType: 'Institution',
  },
  {
    canonical: 'FICCI',
    aliases: ['Federation of Indian Chambers of Commerce'],
    entityType: 'Institution',
  },
];

// ---------------------------------------------------------------------------
// Pre-compiled lookup maps built from the dictionary
// ---------------------------------------------------------------------------

/** Result of a dictionary lookup — carries matched entry + which form matched. */
interface DictMatch {
  entry: DictionaryEntry;
  /** 'exact' when canonical matched; 'alias' when an alias matched. */
  matchType: 'exact' | 'alias';
}

/**
 * Build two lookup maps from the dictionary:
 *   exactMap  — lowercase(canonical) → DictionaryEntry
 *   aliasMap  — lowercase(alias)     → DictionaryEntry
 *
 * Both maps are computed once at module load time.
 */
function buildLookupMaps(entries: DictionaryEntry[]): {
  exactMap: Map<string, DictionaryEntry>;
  aliasMap: Map<string, DictionaryEntry>;
} {
  const exactMap = new Map<string, DictionaryEntry>();
  const aliasMap = new Map<string, DictionaryEntry>();

  for (const entry of entries) {
    const canonicalKey = entry.canonical.toLowerCase();
    if (!exactMap.has(canonicalKey)) {
      exactMap.set(canonicalKey, entry);
    }
    for (const alias of entry.aliases) {
      const aliasKey = alias.toLowerCase();
      if (!aliasMap.has(aliasKey)) {
        aliasMap.set(aliasKey, entry);
      }
    }
  }

  return { exactMap, aliasMap };
}

const { exactMap: EXACT_MAP, aliasMap: ALIAS_MAP } = buildLookupMaps(ENTITY_DICTIONARY);

// ---------------------------------------------------------------------------
// Text analysis helpers
// ---------------------------------------------------------------------------

/**
 * Split text into sentences using a simple rule-based splitter.
 * Splits on '. ', '! ', '? ', '\n', but avoids splitting common abbreviations.
 */
function splitIntoSentences(text: string): string[] {
  // Simple split: sentence boundary = period/exclamation/question followed by space+uppercase
  // or newline, or end of string.
  const sentences: string[] = [];
  const raw = text.split(/(?<=[.!?])\s+(?=[A-Z])|[\n]+/);
  for (const s of raw) {
    const trimmed = s.trim();
    if (trimmed.length > 0) sentences.push(trimmed);
  }
  return sentences.length > 0 ? sentences : [text];
}

/**
 * Look up a token in the dictionary.
 * Returns the best match (exact preferred over alias) or null.
 */
function lookupToken(token: string): DictMatch | null {
  const lower = token.toLowerCase();
  const exactEntry = EXACT_MAP.get(lower);
  if (exactEntry) return { entry: exactEntry, matchType: 'exact' };
  const aliasEntry = ALIAS_MAP.get(lower);
  if (aliasEntry) return { entry: aliasEntry, matchType: 'alias' };
  return null;
}

/**
 * Scan a single text field for entity mentions using a sliding n-gram window.
 *
 * Strategy:
 *   1. Split text into sentences.
 *   2. For each sentence, try n-grams of length 1..5 (longest match wins).
 *   3. Record offset relative to the start of the full field string.
 *
 * Deduplication within a single field: the same (surfaceForm, entityType)
 * pair is emitted at most once per field (the first / highest-confidence
 * occurrence is kept).
 */
function extractFromField(
  text: string,
  fieldSource: 'title' | 'summary' | 'content',
): ExtractedEntity[] {
  const sentences = splitIntoSentences(text);
  const results: ExtractedEntity[] = [];
  const seenKey = new Set<string>(); // `${surfaceForm}::${entityType}` per field

  let fieldOffset = 0; // running char offset within the full field text

  for (let sentIdx = 0; sentIdx < sentences.length; sentIdx++) {
    const sentence = sentences[sentIdx]!;
    // Tokenise by whitespace while keeping track of positions
    const tokenPattern = /\S+/g;
    const tokens: { text: string; offset: number }[] = [];
    let match: RegExpExecArray | null;
    while ((match = tokenPattern.exec(sentence)) !== null) {
      tokens.push({ text: match[0], offset: fieldOffset + match.index });
    }

    // Try n-grams longest-first (up to 5 tokens)
    const MAX_NGRAM = 5;
    let i = 0;
    while (i < tokens.length) {
      let matched = false;
      for (let n = Math.min(MAX_NGRAM, tokens.length - i); n >= 1; n--) {
        const gram = tokens
          .slice(i, i + n)
          .map((t) => t.text)
          .join(' ');
        // Strip trailing punctuation from gram before lookup
        const gramClean = gram.replace(/[.,;:!?'"()\[\]{}]+$/g, '');
        const dictMatch = lookupToken(gramClean);
        if (dictMatch) {
          const confidence =
            dictMatch.matchType === 'exact' ? CONFIDENCE_EXACT : CONFIDENCE_PARTIAL;
          const surfaceForm = gramClean;
          const key = `${surfaceForm.toLowerCase()}::${dictMatch.entry.entityType}`;
          if (!seenKey.has(key)) {
            seenKey.add(key);
            results.push({
              surfaceForm,
              entityType: dictMatch.entry.entityType,
              confidence,
              sentencePos: sentIdx,
              charOffset: tokens[i]!.offset,
              fieldSource,
            });
          }
          i += n; // advance past matched tokens
          matched = true;
          break;
        }
      }
      if (!matched) i++;
    }

    // Advance fieldOffset past this sentence + the separator (estimated as 1 char)
    fieldOffset += sentence.length + 1;
  }

  return results;
}

/**
 * Extract all entity mentions from an article's title, summary, and content.
 * Deduplication across fields is NOT applied — the same entity can appear in
 * multiple fields.
 */
function extractEntities(article: ArticleInput): ExtractedEntity[] {
  const mentions: ExtractedEntity[] = [];

  if (article.title.trim().length > 0) {
    mentions.push(...extractFromField(article.title, 'title'));
  }
  if (article.summary && article.summary.trim().length > 0) {
    mentions.push(...extractFromField(article.summary, 'summary'));
  }
  if (article.content && article.content.trim().length > 0) {
    mentions.push(...extractFromField(article.content, 'content'));
  }

  return mentions;
}

// ---------------------------------------------------------------------------
// EntityResolutionEngine
// ---------------------------------------------------------------------------

export class EntityResolutionEngine {
  private readonly dataServiceClient: DataServiceClient;
  private readonly instrumentIndex: InstrumentIndex;

  constructor(
    private readonly entitiesQueue: Queue,
    dataServiceClient?: DataServiceClient,
  ) {
    this.dataServiceClient = dataServiceClient ?? new DataServiceClient();
    // Use the singleton InstrumentIndex — populated from built-in alias map
    // immediately; sync from data-service is triggered externally at startup.
    this.instrumentIndex = InstrumentIndex.getInstance();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Processes a single article through entity extraction → InstrumentMaster
   * resolution → DB persistence → queue publish.
   *
   * On success: publishes article_id to news.entities queue (Req 5.8).
   * On failure: does NOT publish; preserves any prior DB state (Req 5.9).
   *
   * Requirements: Req 5.1–5.9
   */
  async process(article: ArticleInput): Promise<void> {
    logger.info({ articleId: article.id }, '[EntityResolutionEngine] Processing article');

    // Step 1: Extract entities from all text fields (Req 5.1)
    const rawMentions = extractEntities(article);
    logger.debug(
      { articleId: article.id, count: rawMentions.length },
      '[EntityResolutionEngine] Raw entity mentions extracted',
    );

    // Step 2: Resolve each entity to InstrumentMaster (Req 5.2, 5.3)
    const resolvedMentions = await this.resolveEntities(rawMentions);

    // Step 3: Persist — wrapped in a transaction (Req 5.7, 5.9)
    await this.persist(article, resolvedMentions);

    // Step 4: Publish to queue on success (Req 5.8)
    await this.publishToEntitiesQueue(article.id);

    logger.info(
      { articleId: article.id, mentionCount: resolvedMentions.length },
      '[EntityResolutionEngine] Article processed successfully',
    );
  }

  // -------------------------------------------------------------------------
  // Step 2: Resolve entities against InstrumentMaster
  // -------------------------------------------------------------------------

  /**
   * Resolve extracted entities against the AlphaForge InstrumentMaster.
   *
   * Resolution order (fastest to slowest):
   *   1. InstrumentIndex local lookup — O(1), covers ~200 built-in aliases +
   *      up to 34,459 instruments synced from data-service.
   *   2. DataServiceClient.resolveInstrument() — HTTP call, for entities
   *      not found in the local index (e.g. recently listed instruments).
   *
   * Resolution is best-effort: if both layers fail, the mention is kept as
   * unresolved (entity_id = null, Req 5.4).
   */
  private async resolveEntities(
    mentions: ExtractedEntity[],
  ): Promise<ResolvedMention[]> {
    // Deduplicate surface forms across the mentions list to avoid redundant
    // lookups.
    const surfaceForms = [...new Set(mentions.map((m) => m.surfaceForm))];
    const instrumentByForm = new Map<string, InstrumentMasterEntry | null>();

    for (const surfaceForm of surfaceForms) {
      // --- Layer 1: local InstrumentIndex (no network) ---
      const localId = this.instrumentIndex.resolve(surfaceForm);
      if (localId) {
        const localEntry = this.instrumentIndex.getById(localId);
        if (localEntry) {
          instrumentByForm.set(surfaceForm, {
            instrumentId: localEntry.instrumentId,
            symbol: localEntry.tradingSymbol,
            name: localEntry.displayName,
            exchange: localEntry.nseSymbol ? 'NSE' : 'BSE',
            aliases: [localEntry.tradingSymbol, localEntry.displayName].filter(Boolean),
            isActive: localEntry.isActive,
          });
          continue;
        }
        // instrumentId known but no full record — use minimal entry
        instrumentByForm.set(surfaceForm, {
          instrumentId: localId,
          symbol: surfaceForm,
          name: surfaceForm,
          exchange: localId.startsWith('BSE:') ? 'BSE' : 'NSE',
          aliases: [surfaceForm],
          isActive: true,
        });
        continue;
      }

      // --- Layer 2: data-service HTTP call ---
      try {
        const instrument = await this.dataServiceClient.resolveInstrument(surfaceForm);
        instrumentByForm.set(surfaceForm, instrument);

        // Back-populate the local index so subsequent articles benefit
        if (instrument) {
          // Trigger a warm-up of the index entry on the next sync cycle
          logger.debug(
            { surfaceForm, instrumentId: instrument.instrumentId },
            '[EntityResolutionEngine] Resolved via data-service — will be cached on next index sync',
          );
        }
      } catch (err) {
        // Data-service unavailability → treat as unresolved, do not abort
        logger.warn(
          { surfaceForm, err },
          '[EntityResolutionEngine] resolveInstrument failed — storing as unresolved',
        );
        instrumentByForm.set(surfaceForm, null);
      }
    }

    // Map back to the full mention list
    return mentions.map((mention) => {
      const instrument = instrumentByForm.get(mention.surfaceForm) ?? null;
      // Find dictionary entry for sector info
      const dictEntry = findDictionaryEntry(mention.surfaceForm);
      return {
        ...mention,
        instrumentId: instrument?.instrumentId ?? null,
        sectorId: dictEntry?.sectorId ?? null,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Step 3: Persist to DB
  // -------------------------------------------------------------------------

  /**
   * Persist entity mentions, asset links, and sector links.
   *
   * Reprocessing semantics (Req 5.7):
   *   Delete all existing records for the article_id before inserting new
   *   ones, so re-running always produces the same final state.
   *
   * The entire operation runs inside a single Prisma interactive transaction
   * to ensure atomicity (Req 5.9 — preserve prior state on failure).
   */
  private async persist(
    article: ArticleInput,
    mentions: ResolvedMention[],
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      // -----------------------------------------------------------------------
      // 1. Delete existing records for this article (Req 5.7)
      // -----------------------------------------------------------------------
      await tx.newsEntityMention.deleteMany({ where: { articleId: article.id } });
      await tx.newsAssetLink.deleteMany({ where: { articleId: article.id } });
      await tx.newsSectorLink.deleteMany({ where: { articleId: article.id } });

      logger.debug(
        { articleId: article.id },
        '[EntityResolutionEngine] Cleared existing entity records',
      );

      // -----------------------------------------------------------------------
      // 2. Upsert NewsEntity rows (canonical entity registry)
      //    UNIQUE(surface_form, entity_type) — create-or-retrieve.
      // -----------------------------------------------------------------------
      const entityIdByKey = new Map<string, string>();

      for (const mention of mentions) {
        const key = `${mention.surfaceForm.toLowerCase()}::${mention.entityType}`;
        if (entityIdByKey.has(key)) continue; // already upserted this session

        // Only upsert the canonical entity row if we have a resolved instrument
        // or the surface form came from our dictionary (i.e. it's a known entity).
        // Truly unknown surface forms skip the entity row and remain unresolved.
        const isDictionaryKnown = findDictionaryEntry(mention.surfaceForm) !== null;

        if (mention.instrumentId !== null || isDictionaryKnown) {
          const entity = await tx.newsEntity.upsert({
            where: {
              surfaceForm_entityType: {
                surfaceForm: mention.surfaceForm,
                entityType: mention.entityType,
              },
            },
            create: {
              id: randomUUID(),
              surfaceForm: mention.surfaceForm,
              entityType: mention.entityType,
              instrumentId: mention.instrumentId,
            },
            update: {
              // Update instrumentId if it was previously null and now resolved
              ...(mention.instrumentId !== null
                ? { instrumentId: mention.instrumentId }
                : {}),
            },
          });
          entityIdByKey.set(key, entity.id);
        }
      }

      // -----------------------------------------------------------------------
      // 3. Insert NewsEntityMention rows (Req 5.5)
      // -----------------------------------------------------------------------
      for (const mention of mentions) {
        const key = `${mention.surfaceForm.toLowerCase()}::${mention.entityType}`;
        const entityId = entityIdByKey.get(key) ?? null;

        await tx.newsEntityMention.create({
          data: {
            id: randomUUID(),
            articleId: article.id,
            entityId,
            surfaceForm: mention.surfaceForm,
            entityType: mention.entityType,
            confidence: mention.confidence,
            sentencePos: mention.sentencePos,
            charOffset: mention.charOffset,
          },
        });
      }

      // -----------------------------------------------------------------------
      // 4. Write asset / sector links for high-confidence mentions (Req 5.6)
      // -----------------------------------------------------------------------
      const seenAssets = new Set<string>();
      const seenSectors = new Set<string>();

      for (const mention of mentions) {
        if (mention.confidence < MIN_LINK_CONFIDENCE) continue;

        // Asset link — requires resolved instrumentId
        if (mention.instrumentId !== null && !seenAssets.has(mention.instrumentId)) {
          seenAssets.add(mention.instrumentId);
          await tx.newsAssetLink.create({
            data: {
              articleId: article.id,
              assetId: mention.instrumentId,
              confidence: mention.confidence,
              publishedAt: article.publishedAt,
            },
          });
        }

        // Sector link — uses dictionary-supplied sectorId
        if (mention.sectorId !== null && !seenSectors.has(mention.sectorId)) {
          seenSectors.add(mention.sectorId);
          await tx.newsSectorLink.create({
            data: {
              articleId: article.id,
              sectorId: mention.sectorId,
              confidence: mention.confidence,
              publishedAt: article.publishedAt,
            },
          });
        }
      }

      logger.debug(
        {
          articleId: article.id,
          mentions: mentions.length,
          assetLinks: seenAssets.size,
          sectorLinks: seenSectors.size,
        },
        '[EntityResolutionEngine] Persisted entity records',
      );
    });
  }

  // -------------------------------------------------------------------------
  // Step 4: Publish to news.entities queue
  // -------------------------------------------------------------------------

  /**
   * Publish article_id to news.entities queue (Req 5.8).
   *
   * On queue publish failure the error is surfaced to the caller, which
   * means the calling worker's retry mechanism will handle it. The DB
   * records already committed remain in place (Req 5.9 — prior state is
   * preserved; they'll be overwritten cleanly on reprocessing per Req 5.7).
   */
  private async publishToEntitiesQueue(articleId: string): Promise<void> {
    await this.entitiesQueue.add(
      'entity-resolved',
      { articleId },
      {
        jobId: `entity:${articleId}`,
        removeOnComplete: { age: 86_400 }, // 24 h
        removeOnFail: false,
      },
    );

    logger.debug(
      { articleId },
      '[EntityResolutionEngine] Published to news.entities queue',
    );
  }
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * An ExtractedEntity augmented with the result of InstrumentMaster resolution
 * and the dictionary-supplied sectorId (used for sector link writes).
 */
interface ResolvedMention extends ExtractedEntity {
  /** InstrumentMaster instrument_id, or null when unresolved. */
  instrumentId: string | null;
  /** Sector identifier from the dictionary, or null when not applicable. */
  sectorId: string | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Find the DictionaryEntry whose canonical form or any alias case-insensitively
 * matches the given surface form. Returns null when not found.
 */
function findDictionaryEntry(surfaceForm: string): DictionaryEntry | null {
  const lower = surfaceForm.toLowerCase();
  const exact = EXACT_MAP.get(lower);
  if (exact) return exact;
  const alias = ALIAS_MAP.get(lower);
  if (alias) return alias;
  return null;
}
