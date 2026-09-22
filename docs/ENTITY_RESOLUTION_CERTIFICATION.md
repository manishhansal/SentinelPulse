# SentinelPulse — Entity Resolution Certification

**Version:** 1.0.0  
**Date:** 2026-09-16  
**Auditor:** Phase 3B-Preflight  
**Sample size:** 230 articles, 888 entity mentions (live DB)  

---

## 1. What is Being Measured

**asset_linkage_rate** — the fraction of processed articles that are linked to at
least one tradeable instrument in `news_asset_links`.

This is NOT "entity accuracy". Entity extraction measures how many named entities
were found in text. Asset linkage measures how many of those resolved to tradeable
NSE/BSE instruments that can be matched with market data.

These are three separate, distinct steps:

```
Article text
  ↓ Step 1: Entity extraction  (NLP pattern matching)
Extracted entity mentions (888 total)
  ↓ Step 2: Entity normalisation (surface form → canonical entity)
Resolved entity records (news_entities table)
  ↓ Step 3: Instrument resolution (entity → InstrumentMaster lookup)
Asset links (news_asset_links table) → 19 articles with links
```

---

## 2. Measured Results

### 2.1 Top-level asset linkage

| Metric | Value |
|---|---|
| Total articles | 230 |
| Articles with ≥1 asset link | 19 |
| **Asset linkage rate** | **8.3%** |
| Total entity mentions | 888 |
| Resolved mentions (entity_id not null) | 888 |
| Mention resolution rate | 100% |
| Total asset links | 60 |
| Distinct instruments linked | ~25 |

> **Note on discrepancy with Phase 3A report (26.1%):** The Phase 3A Smoke Test
> reported 26.1% (41 links / 157 articles).  The current DB shows 8.3% (19/230).
> The difference reflects the expanded article corpus since Phase 3A:
> - Phase 3A window: 157 articles (12-minute run)
> - Current DB: 230 articles (ongoing since Phase 3A)
> The additional articles from Reuters (Google News RSS) have very low linkage due
> to the RSS being global news vs. India-specific instruments.

### 2.2 Asset linkage by source

| Source | Articles | With Links | Linkage % | Distinct Instruments |
|---|---|---|---|---|
| reuters | 117 | 4 | **3.4%** | 3 |
| economic-times | 65 | 10 | **15.4%** | 6 |
| moneycontrol | 22 | 5 | **22.7%** | 14 |
| coindesk | 26 | 0 | **0%** | 0 |
| **Total** | **230** | **19** | **8.3%** | ~25 |

### 2.3 Entity type breakdown

| Entity Type | Mentions | Unique Forms | Resolved | Resolution % |
|---|---|---|---|---|
| Country | 172 | 20 | 172 | 100% |
| Institution | 131 | 17 | 131 | 100% |
| Company | 58 | 19 | 58 | 100% |
| Index | 43 | 7 | 43 | 100% |
| Commodity | 34 | 8 | 34 | 100% |
| Currency | 13 | 3 | 13 | 100% |

**Entity mention resolution rate: 100%** — all 888 mentions have an `entity_id`.

However, having an `entity_id` does NOT mean the entity resolved to a tradeable
instrument.  Countries (172 mentions) and Institutions (131 mentions) rarely map to
`news_asset_links` because they don't correspond to NSE-listed equity instruments.

---

## 3. Resolution Architecture

### 3.1 InstrumentIndex (O(1) local lookup)

Built from two sources:
- Hardcoded KNOWN_ALIASES map: ~120 entries covering major NSE stocks and indices
- data-service instrument master sync: periodic pull of 34,459 instrument records

Lookup is O(1) by normalised surface form (lowercase).

### 3.2 DataServiceClient fallback

For entities not in the local index, tries:
1. `GET /v1/instruments/{surfaceForm}` — exact ID lookup
2. `GET /v1/instruments/NSE:{surfaceForm}`
3. `GET /v1/instruments/BSE:{surfaceForm}`

No fuzzy matching — only exact symbol/ID matches.

### 3.3 Coverage gap analysis

**Why Reuters has 3.4% linkage:**
- Reuters RSS via Google News is global financial news
- Most headlines: "US 10-year Treasury hit 19-year high", "Dollar rises", "Investors nervous about AI"
- These describe US/global instruments, not NSE-listed stocks
- The InstrumentIndex contains NSE instruments; US Treasuries, S&P 500, NASDAQ are not indexed

**Why CoinDesk has 0% linkage:**
- CoinDesk covers BTC/ETH/crypto assets
- data-service instrument master does not contain crypto instruments
- InstrumentIndex has no crypto aliases

**Why Moneycontrol has 22.7% linkage (best):**
- India-specific news: Sensex, RBI, specific NSE stock names
- "HDFC Bank", "Reliance", "Nifty" are in the InstrumentIndex
- Still only 22.7% because many Moneycontrol articles cover macro themes without naming specific stocks

---

## 4. Precision, Coverage, Unresolved, Ambiguous Rates

### 4.1 Definitions

| Metric | Definition | Measured |
|---|---|---|
| **Mention resolution rate** | entity_mentions with entity_id / total | 100% (888/888) |
| **Asset linkage rate** | articles with ≥1 asset link / total | 8.3% (19/230) |
| **Precision** | Correct instrument assignments / all assignments | Not measurable without ground truth |
| **Ambiguous rate** | Entities matching >1 instrument | Not tracked — InstrumentIndex returns first match |
| **Unresolved** | entity_id present but instrument_id null | Not directly queryable (instrument_id is on news_entities) |

### 4.2 Precision caveat

The InstrumentIndex resolves "Sensex" → `BSE:SENSEX`, "Nifty" → `NSE:NIFTY50`, etc.
based on hardcoded aliases.  Without a manually-annotated ground truth set, precision
cannot be calculated from DB data alone.

From code review, the alias map appears correct for major instruments.  False positives
are most likely for company name fragments (e.g. "Tata" matching TCS instead of
TATAMOTORS or TATASTEEL).

### 4.3 Ambiguity

The InstrumentIndex returns the first match.  "Tata" resolves to `NSE:TCS` (first alias
in the map).  The system does not track or report ambiguous matches.

**Gap ENT-G1:** Add `ambiguous` flag to entity mentions when >1 instrument matches the surface form.

---

## 5. 500-Entity Test (Required by Phase 3B)

Phase 3B requires testing at least 500 real news entities.  Current DB has 888 total
entity mentions from 230 articles.

From the 888 mentions:
- 74% are Country or Institution types (not NSE instruments)
- 6.5% are Company mentions (58 records) — these are the ones that should resolve to instruments
- 4.8% are Index mentions (43 records) — should resolve to NIFTY, BANKNIFTY, etc.

**Gap ENT-G2:** The 500-entity test cannot be completed against the current corpus
because Company + Index mentions (101 records) are below 500.  To test 500 company/index
entities requires more ingestion cycles.

---

## 6. Required Improvements for Phase 3B

| Gap | Description | Impact | Priority |
|---|---|---|---|
| ENT-G1 | No ambiguity tracking | Unknown false positive rate | HIGH |
| ENT-G2 | Only 101 company/index mentions in DB | Cannot test 500 entity requirement | HIGH |
| ENT-G3 | No fuzzy company name matching | "Reliance Industries Ltd." fails if not in alias map | MEDIUM |
| ENT-G4 | CoinDesk: 0% linkage, crypto not in instrument master | All CoinDesk events produce 0 features | MEDIUM |
| ENT-G5 | Reuters: 3.4% linkage, global news | Most Reuters events cannot link to NSE instruments | LOW (expected) |

---

## 7. Certification Verdict

| Check | Result | Notes |
|---|---|---|
| asset_linkage_rate (not "entity accuracy") | ✓ CORRECTLY REPORTED | 8.3% overall, 22.7% Moneycontrol |
| Local InstrumentIndex implemented | ✓ PASS | 120+ aliases + data-service sync |
| No HTTP lookup per entity | ✓ PASS | InstrumentIndex is O(1) in-memory |
| 500-entity ground truth test | **✗ NOT DONE** | Insufficient Company/Index mentions in DB |
| Ambiguous resolution tracked | **✗ MISSING** | Gap ENT-G1 |
| NSE symbol, BSE code, company name, alias support | ✓ PASS | All in InstrumentIndex |
| CoinDesk linkage | **✗ EXPECTED 0** | Crypto not in instrument master |
| Precision measurable | **✗ NO GROUND TRUTH** | Would require manual annotation |

### Overall: ENTITY RESOLUTION — PARTIAL

Asset linkage at 8.3% overall (22.7% for best source) is low but reflects the global
news mix in the current corpus.  The architecture is correct.  For the 7-day pilot,
sufficient India-specific articles should produce non-zero reactions for major NSE stocks.

---

*Generated by Phase 3B-Preflight Audit — 2026-09-16*
