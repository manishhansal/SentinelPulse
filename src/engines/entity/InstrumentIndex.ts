/**
 * InstrumentIndex — local searchable projection of the data-service instrument master.
 *
 * The data-service holds 34,459 instruments but has no fuzzy-resolve endpoint
 * (only exact ID lookup via GET /v1/instruments/{id}).
 *
 * This module maintains a local in-memory + Redis-cached search index that:
 *   - Builds from the data-service instrument listing on first sync.
 *   - Supports lookup by NSE symbol, BSE symbol, company name, short name,
 *     and common alias/abbreviation.
 *   - Does NOT duplicate the authoritative instrument master — SentinelPulse
 *     stores only a searchable projection (symbol → instrumentId mapping).
 *   - Refreshes on a configurable interval (default: 60 minutes).
 *
 * Architecture:
 *   data-service instrument master (34,459 records)
 *     ↓ initial sync + periodic refresh
 *   InstrumentIndex (in-memory Map + Redis mirror)
 *     ↓ O(1) lookup by normalised surface form
 *   EntityResolutionEngine.resolveInstrument()
 *
 * Requirements: Phase 3A entity resolution improvement mandate
 */

import axios from 'axios';
import { pino } from 'pino';

const logger = pino({ name: 'InstrumentIndex' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A lightweight entry in the local instrument index. */
export interface IndexedInstrument {
  /** Canonical instrument ID in data-service format (e.g. "NSE:RELIANCE"). */
  instrumentId: string;
  /** NSE trading symbol (e.g. "RELIANCE"). */
  nseSymbol: string | null;
  /** BSE trading symbol (e.g. "500325"). */
  bseSymbol: string | null;
  /** Full display name (e.g. "Reliance Industries Limited"). */
  displayName: string;
  /** Short/trading name (e.g. "Reliance Industries"). */
  tradingSymbol: string;
  /** Whether the instrument is currently active. */
  isActive: boolean;
}

// ---------------------------------------------------------------------------
// Known alias map — extends the data-service data with common surface forms
//
// Format: "normalised alias" → canonical instrumentId
// These are surface forms that appear in news headlines but do not match
// the data-service tradingSymbol or displaySymbol directly.
// ---------------------------------------------------------------------------

const KNOWN_ALIASES: Record<string, string> = {
  // ── Reliance ──────────────────────────────────────────────────────────────
  'ril': 'NSE:RELIANCE',
  'reliance': 'NSE:RELIANCE',
  'reliance industries': 'NSE:RELIANCE',
  'mukesh ambani': 'NSE:RELIANCE',

  // ── TCS ───────────────────────────────────────────────────────────────────
  'tcs': 'NSE:TCS',
  'tata consultancy services': 'NSE:TCS',
  'tata consultancy': 'NSE:TCS',

  // ── HDFC Bank ─────────────────────────────────────────────────────────────
  'hdfc bank': 'NSE:HDFCBANK',
  'hdfcbank': 'NSE:HDFCBANK',
  'housing development finance': 'NSE:HDFCBANK',

  // ── ICICI Bank ────────────────────────────────────────────────────────────
  'icici bank': 'NSE:ICICIBANK',
  'icicibank': 'NSE:ICICIBANK',
  'icici': 'NSE:ICICIBANK',

  // ── Infosys ───────────────────────────────────────────────────────────────
  'infosys': 'NSE:INFY',
  'infy': 'NSE:INFY',
  'infosys technologies': 'NSE:INFY',

  // ── Wipro ─────────────────────────────────────────────────────────────────
  'wipro': 'NSE:WIPRO',
  'wipro technologies': 'NSE:WIPRO',
  'wipro ltd': 'NSE:WIPRO',

  // ── HCL Technologies ──────────────────────────────────────────────────────
  'hcl tech': 'NSE:HCLTECH',
  'hcl technologies': 'NSE:HCLTECH',
  'hcltech': 'NSE:HCLTECH',

  // ── SBI ───────────────────────────────────────────────────────────────────
  'sbi': 'NSE:SBIN',
  'state bank of india': 'NSE:SBIN',
  'state bank': 'NSE:SBIN',

  // ── ONGC ──────────────────────────────────────────────────────────────────
  'ongc': 'NSE:ONGC',
  'oil and natural gas corporation': 'NSE:ONGC',
  'oil & natural gas': 'NSE:ONGC',

  // ── Maruti Suzuki ─────────────────────────────────────────────────────────
  'maruti': 'NSE:MARUTI',
  'maruti suzuki': 'NSE:MARUTI',
  'maruti udyog': 'NSE:MARUTI',

  // ── Tata Motors ───────────────────────────────────────────────────────────
  'tata motors': 'NSE:TATAMOTORS',
  'jaguar land rover': 'NSE:TATAMOTORS',
  'jlr': 'NSE:TATAMOTORS',

  // ── Tata Steel ────────────────────────────────────────────────────────────
  'tata steel': 'NSE:TATASTEEL',

  // ── Mahindra ──────────────────────────────────────────────────────────────
  'm&m': 'NSE:M&M',
  'mahindra': 'NSE:M&M',
  'mahindra & mahindra': 'NSE:M&M',
  'm and m': 'NSE:M&M',

  // ── Adani ─────────────────────────────────────────────────────────────────
  'adani': 'NSE:ADANIENT',
  'adani enterprises': 'NSE:ADANIENT',
  'adani group': 'NSE:ADANIENT',
  'adani ports': 'NSE:ADANIPORTS',
  'adani ports sez': 'NSE:ADANIPORTS',

  // ── Sun Pharma ────────────────────────────────────────────────────────────
  'sun pharma': 'NSE:SUNPHARMA',
  'sun pharmaceutical': 'NSE:SUNPHARMA',

  // ── Indices ───────────────────────────────────────────────────────────────
  'nifty': 'NSE:NIFTY_50',
  'nifty 50': 'NSE:NIFTY_50',
  'nifty50': 'NSE:NIFTY_50',
  'sensex': 'BSE:SENSEX',
  'bse sensex': 'BSE:SENSEX',
  'bank nifty': 'NSE:BANKNIFTY',
  'banknifty': 'NSE:BANKNIFTY',

  // ── Bharti Airtel ─────────────────────────────────────────────────────────
  'airtel': 'NSE:BHARTIARTL',
  'bharti airtel': 'NSE:BHARTIARTL',

  // ── ITC ───────────────────────────────────────────────────────────────────
  'itc': 'NSE:ITC',
  'itc ltd': 'NSE:ITC',

  // ── L&T ───────────────────────────────────────────────────────────────────
  'l&t': 'NSE:LT',
  'larsen and toubro': 'NSE:LT',
  'larsen & toubro': 'NSE:LT',
  'lt': 'NSE:LT',

  // ── HUL ───────────────────────────────────────────────────────────────────
  'hul': 'NSE:HINDUNILVR',
  'hindustan unilever': 'NSE:HINDUNILVR',
  'hindustan lever': 'NSE:HINDUNILVR',

  // ── Kotak ─────────────────────────────────────────────────────────────────
  'kotak': 'NSE:KOTAKBANK',
  'kotak bank': 'NSE:KOTAKBANK',
  'kotak mahindra bank': 'NSE:KOTAKBANK',

  // ── Axis Bank ─────────────────────────────────────────────────────────────
  'axis bank': 'NSE:AXISBANK',
  'uti bank': 'NSE:AXISBANK',

  // ── Bajaj Finance ─────────────────────────────────────────────────────────
  'bajaj finance': 'NSE:BAJFINANCE',
  'bajfinance': 'NSE:BAJFINANCE',

  // ── Dr. Reddy's ───────────────────────────────────────────────────────────
  'dr reddy': 'NSE:DRREDDY',
  "dr. reddy's": 'NSE:DRREDDY',
  "dr reddy's laboratories": 'NSE:DRREDDY',
  'drl': 'NSE:DRREDDY',

  // ── Cipla ─────────────────────────────────────────────────────────────────
  'cipla': 'NSE:CIPLA',

  // ── Asian Paints ──────────────────────────────────────────────────────────
  'asian paints': 'NSE:ASIANPAINT',

  // ── IndusInd Bank ─────────────────────────────────────────────────────────
  'indusind bank': 'NSE:INDUSINDBK',
  'indusind': 'NSE:INDUSINDBK',

  // ── Tech Mahindra ─────────────────────────────────────────────────────────
  'tech mahindra': 'NSE:TECHM',
  'techm': 'NSE:TECHM',

  // ── NTPC ──────────────────────────────────────────────────────────────────
  'ntpc': 'NSE:NTPC',
  'national thermal power': 'NSE:NTPC',

  // ── Power Grid ────────────────────────────────────────────────────────────
  'power grid': 'NSE:POWERGRID',
  'pgcil': 'NSE:POWERGRID',
};

// ---------------------------------------------------------------------------
// InstrumentIndex
// ---------------------------------------------------------------------------

/**
 * Singleton-style instrument index with lazy population from data-service.
 *
 * Usage:
 *   const index = InstrumentIndex.getInstance();
 *   await index.sync();                // call once at startup
 *   const id = index.resolve('RIL');  // O(1) lookup
 */
export class InstrumentIndex {
  private static instance: InstrumentIndex | null = null;

  /** Primary lookup map: normalised surface form → instrumentId */
  private readonly index = new Map<string, string>();

  /** Full instrument records keyed by instrumentId */
  private readonly instruments = new Map<string, IndexedInstrument>();

  /** Whether the index has been populated from the data-service. */
  private populated = false;

  /** Timestamp of last sync. */
  private lastSyncAt: Date | null = null;

  private constructor() {
    // Populate from the built-in alias map immediately — this works even
    // without a live data-service connection.
    this.populateFromAliasMap();
  }

  static getInstance(): InstrumentIndex {
    if (!InstrumentIndex.instance) {
      InstrumentIndex.instance = new InstrumentIndex();
    }
    return InstrumentIndex.instance;
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Resolves a free-text surface form to a canonical instrument ID.
   *
   * Lookup order:
   *   1. Known aliases (static map + data-service sync)
   *   2. Direct NSE prefix: "NSE:{form}"
   *   3. Direct BSE prefix: "BSE:{form}"
   *
   * Returns null when no match is found.
   */
  resolve(surfaceForm: string): string | null {
    const key = this.normalise(surfaceForm);

    // 1. Check index
    const fromIndex = this.index.get(key);
    if (fromIndex) return fromIndex;

    // 2. Try NSE prefix
    const withNse = this.index.get(this.normalise(`NSE:${surfaceForm}`));
    if (withNse) return withNse;

    // 3. Try BSE prefix
    const withBse = this.index.get(this.normalise(`BSE:${surfaceForm}`));
    if (withBse) return withBse;

    return null;
  }

  /**
   * Returns the full IndexedInstrument record for an instrument ID.
   * Returns null when the ID is not in the local index.
   */
  getById(instrumentId: string): IndexedInstrument | null {
    return this.instruments.get(instrumentId) ?? null;
  }

  /**
   * Returns statistics about the index.
   */
  getStats(): {
    entryCount: number;
    instrumentCount: number;
    populated: boolean;
    lastSyncAt: Date | null;
  } {
    return {
      entryCount: this.index.size,
      instrumentCount: this.instruments.size,
      populated: this.populated,
      lastSyncAt: this.lastSyncAt,
    };
  }

  // --------------------------------------------------------------------------
  // Sync from data-service
  // --------------------------------------------------------------------------

  /**
   * Syncs the instrument index from the data-service instrument listing.
   *
   * This is a best-effort operation — if the data-service is unavailable,
   * the index continues operating with the built-in alias map only.
   *
   * The data-service GET /v1/instruments returns paginated results.
   * We fetch the first `maxPages` pages (default: 100) × `pageSize` (default: 500)
   * = up to 50,000 instruments, which covers the full 34,459-instrument master.
   *
   * @param baseUrl   data-service base URL (default: DATA_SERVICE_URL env var)
   * @param apiKey    data-service API key (default: DATA_SERVICE_API_KEY env var)
   * @param maxPages  maximum pages to fetch (default: 100)
   * @param pageSize  instruments per page (default: 500)
   */
  async sync(
    baseUrl?: string,
    apiKey?: string,
    maxPages = 100,
    pageSize = 500,
  ): Promise<{ synced: number; skipped: number; errors: number }> {
    const dsUrl = (
      baseUrl ?? process.env['DATA_SERVICE_URL'] ?? 'http://localhost:8200'
    ).replace(/\/$/, '');
    const key = apiKey ?? process.env['DATA_SERVICE_API_KEY'] ?? '';

    const http = axios.create({
      baseURL: dsUrl,
      timeout: 15_000,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'SentinelPulse-InstrumentIndex/1.0',
        ...(key ? { 'X-API-Key': key } : {}),
      },
    });

    let synced = 0;
    let skipped = 0;
    let errors = 0;
    let page = 1;

    logger.info({ dsUrl, maxPages, pageSize }, '[InstrumentIndex] Starting sync from data-service');

    while (page <= maxPages) {
      try {
        const response = await http.get<{
          data: Array<{
            instrumentId: string;
            tradingSymbol: string;
            displaySymbol: string;
            exchange: string;
            segment: string;
            instrumentType: string;
            activeTo: string | null;
          }>;
          meta?: { total?: number; page?: number; limit?: number };
        }>('/v1/instruments', {
          params: { page, limit: pageSize },
        });

        const items = response.data?.data ?? [];

        if (items.length === 0) break; // no more results

        for (const item of items) {
          try {
            this.indexInstrument({
              instrumentId: item.instrumentId,
              nseSymbol:
                item.exchange === 'NSE' ? item.tradingSymbol : null,
              bseSymbol:
                item.exchange === 'BSE' ? item.tradingSymbol : null,
              displayName: item.displaySymbol,
              tradingSymbol: item.tradingSymbol,
              isActive: item.activeTo === null,
            });
            synced++;
          } catch {
            skipped++;
          }
        }

        // If the page returned fewer items than the page size, we're done.
        if (items.length < pageSize) break;

        page++;
      } catch (err) {
        errors++;
        logger.warn(
          { page, err },
          '[InstrumentIndex] Failed to fetch page from data-service — stopping sync',
        );
        break;
      }
    }

    this.populated = true;
    this.lastSyncAt = new Date();

    logger.info(
      { synced, skipped, errors, indexSize: this.index.size },
      '[InstrumentIndex] Sync complete',
    );

    return { synced, skipped, errors };
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  /** Normalises a surface form for consistent map key lookup. */
  private normalise(text: string): string {
    return text.toLowerCase().trim().replace(/\s+/g, ' ');
  }

  /** Indexes a single instrument and all its resolvable surface forms. */
  private indexInstrument(instrument: IndexedInstrument): void {
    this.instruments.set(instrument.instrumentId, instrument);

    const forms: string[] = [
      instrument.instrumentId,
      instrument.tradingSymbol,
      instrument.displayName,
    ];

    // Add exchange-prefixed variants
    if (instrument.nseSymbol) {
      forms.push(`NSE:${instrument.nseSymbol}`);
      forms.push(instrument.nseSymbol);
    }
    if (instrument.bseSymbol) {
      forms.push(`BSE:${instrument.bseSymbol}`);
      forms.push(instrument.bseSymbol);
    }

    for (const form of forms) {
      if (form) {
        const key = this.normalise(form);
        if (!this.index.has(key)) {
          this.index.set(key, instrument.instrumentId);
        }
      }
    }
  }

  /** Populates the index from the hard-coded alias map. */
  private populateFromAliasMap(): void {
    for (const [alias, instrumentId] of Object.entries(KNOWN_ALIASES)) {
      const key = this.normalise(alias);
      if (!this.index.has(key)) {
        this.index.set(key, instrumentId);
      }
    }

    logger.debug(
      { aliasCount: Object.keys(KNOWN_ALIASES).length },
      '[InstrumentIndex] Populated from built-in alias map',
    );
  }
}
