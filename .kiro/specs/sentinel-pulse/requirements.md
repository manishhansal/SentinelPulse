# Requirements Document

## Introduction

SentinelPulse is a production-grade market intelligence and news impact engine for AlphaForge. Its core responsibility is to transform raw financial news from multiple sources into structured, evidence-backed market intelligence that feeds both the AlphaForge signal engine and the ml-service.

The transformation pipeline is:

```
Raw News → Clean Article → Deduplicated Event → Entity Recognition
→ Asset/Sector Mapping → Sentiment → Event Classification → Importance
→ Market Impact → Historical Reaction → Cross-Market Relationships
→ ML Features → AlphaForge Signal Inputs
```

SentinelPulse is a supporting factor in a multi-factor signal model. It does **not** autonomously generate trading decisions. Every derived score carries a timestamp, confidence level, pipeline version, and traceable source evidence.

---

## Glossary

- **SentinelPulse**: The market intelligence and news impact service described in this document.
- **AlphaForge**: The parent trading signal platform that consumes SentinelPulse outputs.
- **data-service**: The existing AlphaForge service that owns all market price, OHLCV, and instrument master data. SentinelPulse consumes but never duplicates it.
- **ml-service**: The AlphaForge machine-learning service that consumes structured features produced by SentinelPulse.
- **NewsSourceAdapter**: A pluggable interface encapsulating all logic for connecting to and normalising output from a single news source.
- **NormalizedArticle**: The canonical in-memory and database representation of a cleaned, structured news article.
- **NewsCluster**: A group of articles from multiple sources that cover the same underlying real-world event.
- **NewsEvent**: A structured, machine-readable event extracted from one or more articles (e.g., a rate decision, an earnings surprise).
- **Entity**: A named real-world object extracted from article text — company, instrument, index, commodity, currency, country, or institution.
- **InstrumentMaster**: The authoritative list of tradeable instruments maintained by AlphaForge's data-service.
- **ImportanceScore**: A normalised 0–1 score reflecting the market significance of a NewsEvent.
- **NewsImpactScore**: A composite score normalised to −100 → +100 representing the expected directional effect of a news event on a specific asset.
- **MarketRegime**: A discrete classification of the current market environment (e.g., TRENDING_BULL, HIGH_VOLATILITY, RISK_OFF).
- **HistoricalReaction**: Recorded price/volume/volatility changes in the data-service following past similar events.
- **FeatureVector**: A point-in-time correct numerical representation of a news event and its context, used as input to ml-service.
- **TrainingSample**: A labelled FeatureVector where labels are future market returns computed after the event timestamp.
- **BackfillJob**: A scheduled or manually triggered job that reprocesses historical articles through the full pipeline.
- **EventGraph**: A directed graph linking related NewsEvents through second-order effect chains.
- **Scrapling**: The primary web scraping and extraction framework used where official feeds are unavailable.
- **BullMQ**: The Redis-backed job queue framework used for worker orchestration.
- **pgvector**: The PostgreSQL extension used for semantic embedding storage and similarity search.
- **CircuitBreaker**: A fault-tolerance pattern that opens (halts calls) after repeated failures and closes (resumes calls) after a recovery timeout.
- **DeadLetterQueue**: A BullMQ queue that receives jobs that have exhausted all retry attempts, preserving them for inspection and manual replay.
- **Tier-1 Source**: Reuters, Moneycontrol, Economic Times — highest priority sources.
- **Tier-2 Source**: Bloomberg, Financial Times, CoinDesk — secondary priority sources.
- **EARS**: Easy Approach to Requirements Syntax — the pattern system used for all acceptance criteria in this document.
- **Look-Ahead Bias**: The illegal use of future market data when computing features or labels for a past event timestamp.
- **Point-in-Time Correct**: A dataset or feature computation that uses only information available at or before the event timestamp.

---

## Requirements

---

### Requirement 1: Pluggable News Source Adapter Framework

**User Story:** As a platform engineer, I want a uniform, pluggable interface for every news source, so that I can add, disable, or replace sources without changing any pipeline code.

#### Acceptance Criteria

1. THE SentinelPulse SHALL define a `NewsSourceAdapter` interface exposing the following methods: `healthCheck(): Promise<HealthStatus>`, `fetchLatest(options: FetchOptions): Promise<RawArticle[]>`, `fetchHistorical(options: HistoricalFetchOptions): Promise<RawArticle[]>`, `normalize(raw: RawArticle): NormalizedArticle`, and `getRateLimit(): RateLimitConfig`.
2. THE SentinelPulse SHALL provide a concrete adapter implementation for each of the following sources: Reuters, Moneycontrol, Economic Times, Bloomberg, Financial Times, and CoinDesk.
3. WHEN a source is configured as a Tier-1 source (Reuters, Moneycontrol, Economic Times), THE IngestionEngine SHALL prioritise polling that source before Tier-2 sources within each scheduling cycle, and SHALL NOT begin polling any Tier-2 source until all enabled Tier-1 sources have been polled or have returned a non-healthy status in that cycle.
4. WHERE an official RSS feed or public API is available for a source, THE corresponding NewsSourceAdapter SHALL use that feed or API as the primary fetch mechanism instead of HTML scraping.
5. WHERE HTML scraping is required and no official feed is available, THE corresponding NewsSourceAdapter SHALL use Scrapling as the extraction framework and SHALL comply with the source's robots.txt, published rate limits, and Terms of Service.
6. WHEN a source's healthCheck returns a non-healthy status, THE IngestionEngine SHALL log the failure with the source name and timestamp, increment the source's failure counter, and continue polling all remaining enabled sources in the current scheduling cycle without interruption.
7. THE SentinelPulse SHALL read each source's enabled state from an environment variable following the naming convention NEWS_SOURCE_{SOURCE_NAME_UPPER}_ENABLED (e.g., NEWS_SOURCE_REUTERS_ENABLED=true), and SHALL treat any value other than the string "true" (case-insensitive) as disabled.
8. WHEN a source's enabled environment variable is set to false, THE IngestionEngine SHALL skip that source entirely during fetch cycles without throwing an error.
9. THE SentinelPulse SHALL read each source's base URL, API key, and polling interval from source-specific environment variables, allowing each source to be independently reconfigured without code changes.
10. IF a fetchLatest call to any source throws an unhandled exception, THEN THE IngestionEngine SHALL catch the exception, log it with the source name and stack trace, and return an empty article list for that source — it SHALL NOT propagate the exception to the calling scheduler.
11. IF a source-specific environment variable for base URL or polling interval is absent or empty at startup, THEN THE SentinelPulse SHALL log a warning identifying the missing variable and the affected source, and SHALL disable that source for the current process lifetime without terminating the application.
12. IF a source's failure counter reaches 5 consecutive non-healthy healthCheck responses within a single process lifetime, THEN THE IngestionEngine SHALL automatically disable that source for a back-off period of 300 seconds before re-attempting a healthCheck, and SHALL log the automatic disable event with the source name and scheduled re-enable timestamp.

---

### Requirement 2: Fault-Tolerant Ingestion Engine

**User Story:** As a platform engineer, I want the ingestion engine to be resilient to transient source failures, so that temporary outages do not cause data loss or pipeline stalls.

#### Acceptance Criteria

1. THE IngestionEngine SHALL implement a CircuitBreaker per source with a configurable failure threshold (default: 5 consecutive failures, valid range: 1-100) and a configurable recovery timeout (default: 60 seconds, valid range: 1-3600 seconds), with configuration applied at startup.
2. WHEN a source's CircuitBreaker is in the open state, THE IngestionEngine SHALL skip that source's fetch calls until the recovery timeout elapses, then transition to half-open and execute a single probe fetch; IF the probe fetch succeeds, THEN THE IngestionEngine SHALL transition the CircuitBreaker to closed; IF the probe fetch fails, THEN THE IngestionEngine SHALL return the CircuitBreaker to the open state and reset the recovery timeout.
3. IF a fetch attempt for a source returns an HTTP 5xx response or a network timeout, THEN THE IngestionEngine SHALL retry using exponential backoff with a configurable base delay (default: 1 second, valid range: 0.1-60 seconds), a configurable multiplier (default: 2, valid range: 1-10), a maximum per-attempt delay cap of 300 seconds, and a configurable maximum retry count (default: 3, valid range: 1-10).
4. THE IngestionEngine SHALL enforce per-source rate limiting by reading the requests-per-minute limit from each adapter via getRateLimit() and enforcing a minimum interval of floor(60000 / RPM) milliseconds between consecutive requests to that source; IF getRateLimit() returns null, zero, or a negative value, THEN THE IngestionEngine SHALL apply no rate limiting for that source.
5. WHEN a job exhausts all retry attempts without success, THE IngestionEngine SHALL move the job to the news.raw.deadletter DeadLetterQueue with the original payload, error message, retry history, and a UTC timestamp.
6. WHEN a raw article is successfully fetched from a source, THE IngestionEngine SHALL publish it as a job on the news.raw BullMQ queue containing the raw article payload and source metadata (source_id, source_name, fetched_at UTC timestamp, and adapter version).
7. THE IngestionEngine SHALL be stateless — all job state SHALL be stored in BullMQ/Redis, not in process memory — so that IngestionEngine instances can be horizontally scaled or restarted without data loss.
8. WHEN a fetch cycle completes for a source, THE IngestionEngine SHALL record an ingestion run record (source_id, started_at, completed_at, articles_fetched, articles_failed, status) in the news_ingestion_runs table, where status is one of: "success" (all fetches succeeded), "partial_failure" (at least one article failed but at least one succeeded), or "failed" (no articles were successfully fetched).

---

### Requirement 3: Article Normalization Engine

**User Story:** As a pipeline engineer, I want every article from every source to be converted into a canonical NormalizedArticle format, so that all downstream engines operate on a uniform data structure regardless of source.

#### Acceptance Criteria

1. THE NormalizationEngine SHALL produce a NormalizedArticle for every raw article consumed from the news.raw queue, containing at minimum: id (UUID v4), sourceId, sourceName, externalId, canonicalUrl, title, summary, content, author, language (ISO 639-1), publishedAt (UTC ISO 8601), scrapedAt (UTC ISO 8601), category, contentHash (SHA-256 of full content), and titleHash (SHA-256 of normalised title); any optional field absent from the raw article SHALL be set to null in the NormalizedArticle.
2. THE NormalizationEngine SHALL store all timestamps in UTC regardless of the timezone published by the source.
3. WHEN a raw article is missing a publishedAt field, THE NormalizationEngine SHALL substitute the scrapedAt timestamp and set a timestampInferred: true flag on the NormalizedArticle.
4. THE NormalizationEngine SHALL strip HTML tags, inline ads, navigation elements, cookie banners, and author boilerplate from article content before populating the content field; content stripping SHALL preserve paragraph structure by converting block-level HTML elements to newline characters before tag removal.
5. THE NormalizationEngine SHALL truncate article content to a maximum of 50,000 characters after stripping and SHALL set a contentTruncated: true flag on the NormalizedArticle when truncation occurs; truncation SHALL occur on a complete word boundary at or before the 50,000-character limit.
6. THE NormalizationEngine SHALL detect article language using the stripped content text of at least 20 characters and populate the language field using ISO 639-1 codes; IF the stripped content contains fewer than 20 characters or language detection confidence is below 0.8, THEN THE NormalizationEngine SHALL set language to "en" and record the actual confidence score (or 0 if undetectable) in a languageConfidence field on the NormalizedArticle.
7. THE NormalizationEngine SHALL compute contentHash as the SHA-256 hash of the stripped, whitespace-normalised content string (collapsing all consecutive whitespace characters to a single space and trimming leading and trailing whitespace), and titleHash as the SHA-256 hash of the lowercased, punctuation-stripped, whitespace-normalised title string; both hashes SHALL be represented as 64-character lowercase hexadecimal strings.
8. WHEN normalization of an article fails due to a parsing or extraction error, THE NormalizationEngine SHALL publish an error record to the news_processing_errors table with article source, external ID, error type, error message, and UTC timestamp, and SHALL NOT re-enqueue the article.
9. IF the news_processing_errors table is unavailable when a normalization failure occurs, THEN THE NormalizationEngine SHALL retain the failed article metadata in memory for up to 60 seconds and reattempt the error record write up to 3 times at 20-second intervals before discarding the record.
10. THE NormalizationEngine SHALL publish each NormalizedArticle as a job on the news.normalized BullMQ queue upon successful normalization; IF the news.normalized queue is unavailable, THEN THE NormalizationEngine SHALL reattempt publishing up to 3 times at 5-second intervals before publishing an error record to the news_processing_errors table and discarding the article.

---

### Requirement 4: Deduplication Engine

**User Story:** As a data engineer, I want the pipeline to detect and collapse duplicate news articles — whether exact or near-duplicate — into single canonical events, so that downstream engines process each real-world event exactly once.

#### Acceptance Criteria

1. THE DeduplicationEngine SHALL detect exact duplicates by checking the incoming article's canonicalUrl, externalId, contentHash, and titleHash against existing records in news_articles.
2. WHEN an exact duplicate is detected by any of the four exact-match signals, THE DeduplicationEngine SHALL increment the duplicate counter on the existing article record by 1, discard the incoming article, and NOT enqueue it downstream.
3. THE DeduplicationEngine SHALL detect near-duplicate titles by computing the Jaro-Winkler similarity between the incoming article's normalised title and titles of articles published within a configurable time window (default: 24 hours, minimum: 1 hour, maximum: 168 hours); a similarity score at or above a configurable threshold (default: 0.92, minimum: 0.80, maximum: 1.00) SHALL be treated as a near-duplicate.
4. THE DeduplicationEngine SHALL detect near-duplicate content by computing the cosine similarity between the incoming article's content embedding and embeddings of articles published within the same configurable time window; a similarity score at or above a configurable threshold (default: 0.90, minimum: 0.80, maximum: 1.00) SHALL be treated as a near-duplicate.
5. WHEN a near-duplicate is detected, THE DeduplicationEngine SHALL group the incoming article into the existing NewsCluster with the highest similarity score among all candidates and SHALL update that cluster's source_count, source_diversity, and consensus_score fields.
6. IF a near-duplicate check matches more than one candidate cluster at or above the configured threshold, THEN THE DeduplicationEngine SHALL select the cluster with the highest similarity score; if two candidates share the same highest score, the cluster with the earlier created_at timestamp SHALL be selected.
7. WHEN no matching cluster exists for an article, THE DeduplicationEngine SHALL create a new NewsCluster record with the article as its canonical member, initialising source_count to 1 and source_diversity to 1.
8. THE DeduplicationEngine SHALL compute consensus_score as: (sum of weights of distinct tiers represented in the cluster) divided by (sum of weights of all defined tiers), where Tier-1 sources contribute weight 2 and Tier-2 sources contribute weight 1, normalised to 0.00-1.00 rounded to two decimal places.
9. IF the consensus_score computation references a source whose tier assignment is absent from the system configuration, THEN THE DeduplicationEngine SHALL treat that source as Tier-2 and include a log entry indicating the unrecognised source identifier.
10. THE DeduplicationEngine SHALL be idempotent — processing the same article payload multiple times SHALL produce the same cluster state as processing it once.
11. THE DeduplicationEngine SHALL publish each deduplicated article (with its cluster assignment and the similarity scores) as a job on the news.deduplicated BullMQ queue; if the enqueue operation fails, THE DeduplicationEngine SHALL retry up to 3 times with a 1-second delay between attempts before marking the article as failed and preserving its cluster assignment in news_articles.

---

### Requirement 5: Entity Extraction and Resolution Engine

**User Story:** As an analyst, I want every news article to have its mentioned companies, instruments, indices, commodities, currencies, countries, and institutions extracted and resolved to canonical AlphaForge entity IDs, so that I can query news by asset or sector without manual disambiguation.

#### Acceptance Criteria

1. THE EntityResolutionEngine SHALL extract named entities of the following types from each article's title, summary, and content: Company, Instrument, Index, Commodity, Currency, Country, and Institution.
2. THE EntityResolutionEngine SHALL resolve each extracted entity to a canonical entry in the AlphaForge InstrumentMaster — surface forms that refer to the same real-world entity SHALL all resolve to the same instrument_id.
3. THE EntityResolutionEngine SHALL NOT create new InstrumentMaster entries or modify existing canonical mappings; its role is read-only consumption of the InstrumentMaster.
4. WHEN an extracted entity cannot be resolved to any InstrumentMaster entry, THE EntityResolutionEngine SHALL store the entity as an unresolved mention with its raw surface form and entity type, and SHALL NOT discard the article.
5. THE EntityResolutionEngine SHALL record each entity mention in the news_entity_mentions table with: article_id, entity_id (null if unresolved), surface_form, entity_type, confidence (0.00-1.00), sentence_position (non-negative integer index), and character_offset (non-negative integer index relative to the field start).
6. THE EntityResolutionEngine SHALL record resolved entity-to-asset links in news_asset_links and entity-to-sector links in news_sector_links only for mentions whose confidence score is >= 0.50.
7. WHEN an article is reprocessed, THE EntityResolutionEngine SHALL delete all existing news_entity_mentions, news_asset_links, and news_sector_links records for that article_id before inserting new records, such that the final stored state is identical to a first-time processing of the same article.
8. WHEN entity processing for an article completes successfully, THE EntityResolutionEngine SHALL publish the article_id as a job on the news.entities BullMQ queue.
9. IF entity processing for an article fails at any stage, THEN THE EntityResolutionEngine SHALL not publish a job to the news.entities queue for that article, and SHALL preserve any previously committed records for that article_id unchanged.

---

### Requirement 6: Event Detection Engine

**User Story:** As a signal engineer, I want structured market events extracted from articles, so that the impact and feature engines can reason about event type, actor, and surprise factor rather than raw text.

#### Acceptance Criteria

1. THE EventDetectionEngine SHALL extract one or more NewsEvent records from each article, where each NewsEvent contains: eventType, actor, action, targetEntities, quantitativeValue (if present), expectedValue (if present), surpriseDirection (BEAT/MISS/IN_LINE/UNKNOWN), importance (preliminary 0-1), confidence (0-1), and eventTimestamp (UTC).
2. THE EventDetectionEngine SHALL classify each detected event into one of the following event types: MONETARY_POLICY, EARNINGS, ECONOMIC_DATA, COMMODITY_SHOCK, GEOPOLITICAL, REGULATORY, CORPORATE_ACTION, MACRO_DATA, CREDIT_EVENT, NATURAL_DISASTER, TRADE_POLICY, CURRENCY_EVENT, SECTOR_ROTATION, or UNCLASSIFIED.
3. WHEN an article contains quantitative data (e.g., a reported interest rate, an EPS figure, a GDP print), THE EventDetectionEngine SHALL populate quantitativeValue and SHALL attempt to populate expectedValue from the article text or from consensus data if available.
4. WHEN quantitativeValue deviates from expectedValue by more than a configurable threshold per event type, THE EventDetectionEngine SHALL set surpriseDirection to BEAT or MISS accordingly.
5. IF expectedValue cannot be determined from the article text or external consensus data, THEN THE EventDetectionEngine SHALL set surpriseDirection to UNKNOWN and record expectedValueSource as null.
6. WHEN quantitativeValue does not deviate from expectedValue beyond the configured threshold, THE EventDetectionEngine SHALL set surpriseDirection to IN_LINE.
7. THE EventDetectionEngine SHALL store each extracted NewsEvent in the news_events table and link it to its source article via news_article_event_links.
8. THE EventDetectionEngine SHALL be idempotent — reprocessing the same article SHALL NOT create duplicate NewsEvent records.
9. IF NewsEvent persistence fails, THEN THE EventDetectionEngine SHALL NOT publish the job to the news.events queue, and SHALL surface the storage error to the calling worker for retry handling.
10. WHEN NewsEvent persistence succeeds, THE EventDetectionEngine SHALL publish the article_id and extracted event_id list as a job on the news.events BullMQ queue.

---

### Requirement 7: News Taxonomy and Categorisation

**User Story:** As a consumer of the news API, I want every article tagged with a structured taxonomy, so that I can filter news by Indian market, global market, central bank, commodity, crypto, or thematic category.

#### Acceptance Criteria

1. THE NormalizationEngine SHALL assign one primary category and zero or more secondary categories (maximum 5) to each NormalizedArticle from the following taxonomy:
   - Indian Market: NIFTY50, SENSEX, BANKNIFTY, NIFTY_MIDCAP, NIFTY_SMALLCAP, SEBI, FII_DII_FLOWS, INDIA_MACRO
   - Global Market: US_MARKET, EUROPE_MARKET, ASIA_MARKET, GLOBAL_MACRO, FED_POLICY, ECB_POLICY
   - Commodities: CRUDE_OIL, GOLD, SILVER, NATURAL_GAS, AGRI_COMMODITIES, METALS
   - Crypto: BITCOIN, ETHEREUM, CRYPTO_REGULATION, CRYPTO_MARKET
   - Company Events: EARNINGS, MERGERS_ACQUISITIONS, IPO, DIVIDENDS, BUYBACKS, MANAGEMENT_CHANGE
   - Geopolitical: MIDDLE_EAST, RUSSIA_UKRAINE, US_CHINA, INDIA_CHINA, GLOBAL_SANCTIONS
   - Central Banks: RBI, FED, ECB, BOJ, PBC
2. WHEN a category cannot be determined from article content with confidence above 0.6, THE NormalizationEngine SHALL assign the category UNCLASSIFIED and set the categoryConfidence field to the highest confidence value observed during classification.
3. THE SentinelPulse SHALL support filtering articles by primary category, secondary category, and minimum category confidence through the news REST API; WHEN multiple filter conditions are provided simultaneously, THE RestAPI SHALL apply all filters with AND logic.

---

### Requirement 8: Multi-Dimensional Sentiment Engine

**User Story:** As a signal engineer, I want news sentiment computed across multiple financial dimensions rather than as a single score, so that the AlphaForge signal engine can apply sentiment selectively by asset type and context.

#### Acceptance Criteria

1. WHEN an article or NewsEvent is enqueued on the news.sentiment queue, THE SentimentEngine SHALL compute the following sentiment dimensions: sentimentScore (overall), marketSentiment, companySentiment, macroSentiment, and riskSentiment; each dimension SHALL be a floating-point value in the range -1.0 to +1.0, rounded to four decimal places.
2. THE SentimentEngine SHALL compute a confidence value in the range 0.0 to 1.0 for each sentiment dimension, reflecting the model's certainty about that dimension's score.
3. THE SentimentEngine SHALL classify each article into one or more qualitative sentiment signals from the set: UNCERTAINTY, FEAR, HAWKISH, DOVISH, RISK_ON, RISK_OFF, OPTIMISM, PANIC, NEUTRAL; an article SHALL receive the NEUTRAL signal when no other signal meets the model's confidence threshold.
4. THE SentimentEngine SHALL upsert sentiment results into the news_sentiment table using (article_id, model_version) as the unique key, with fields: article_id, event_id (nullable), sentiment_score, market_sentiment, company_sentiment, macro_sentiment, risk_sentiment, qualitative_signals (array), confidence, model_version, and computed_at (UTC).
5. WHEN a new model_version produces different sentiment scores for the same article_id, THE SentimentEngine SHALL insert a new row rather than updating the existing row, preserving the prior model version's scores.
6. WHEN the SentimentEngine completes processing for an article or event, THE SentimentEngine SHALL publish the article_id and model_version as a job on the news.sentiment BullMQ output queue.

---

### Requirement 9: Importance Score Engine

**User Story:** As a signal engineer, I want each news event scored for market importance on a 0-1 scale, so that the AlphaForge system can discard noise and focus on events with genuine market-moving potential.

#### Acceptance Criteria

1. THE ImportanceEngine SHALL compute an importance_score in the range 0.0 to 1.0 for each NewsEvent by combining the following weighted sub-scores: source_reliability, event_severity, affected_asset_weight (count multiplied by market-cap weight), affected_sector_count, historical_impact_magnitude (from HistoricalReaction records), novelty (inverse of similar-event frequency in the past 7 days), surprise_factor (from EventDetectionEngine), geopolitical_significance, and macro_significance.
2. THE ImportanceEngine SHALL store each sub-score, its weight, and the final importance_score in the news_importance table, providing a fully traceable audit trail.
3. THE ImportanceEngine SHALL assign a source_reliability_score per source based on a configurable per-source weight: Tier-1 sources default to 1.0; Tier-2 sources default to 0.8; the score SHALL be stored in the news_sources table and updatable by an operator without code change.
4. WHEN an event has no HistoricalReaction data available, THE ImportanceEngine SHALL use a configurable prior (default: 0.5) for the historical_impact_magnitude sub-score and SHALL set historical_data_available: false in the news_importance record.
5. THE ImportanceEngine SHALL upsert results in the news_importance table using event_id as the unique key, with fields: event_id, importance_score, sub_scores (JSON), model_version, computed_at (UTC).
6. THE ImportanceEngine SHALL publish each processed event_id as a job on the news.impact BullMQ queue upon successful upsert.

---

### Requirement 10: Market Impact Engine

**User Story:** As a signal engineer, I want each high-importance news event mapped to specific affected assets, sectors, and indices with directional impact predictions, so that AlphaForge can incorporate event-level market impact into multi-factor signal computation.

#### Acceptance Criteria

1. WHEN a NewsEvent is received by the MarketImpactEngine, THE MarketImpactEngine SHALL compute a NewsMarketImpact record for each combination of (NewsEvent, affected asset/sector/index), containing: asset_id or sector_id, direction (POSITIVE/NEGATIVE/NEUTRAL/UNCERTAIN), strength (0.0-1.0), confidence (0.0-1.0), expected_horizon (IMMEDIATE <=5 min, INTRADAY <=1 day, SHORT_TERM <=5 days, SWING <=20 days, LONG_TERM >20 days), and evidence_type (HISTORICAL/RULE_BASED/MODEL).
2. THE MarketImpactEngine SHALL maintain an IndianMarketImpactEngine sub-component that maps events to: NIFTY50, BANKNIFTY, NIFTY sectoral indices (IT, BANK, FMCG, AUTO, PHARMA, ENERGY, METAL, REALTY), and individual NSE/BSE listed stocks in the InstrumentMaster.
3. WHEN computing impact, THE MarketImpactEngine SHALL prefer evidence from HistoricalReaction records over rule-based heuristics, and SHALL set evidence_type to HISTORICAL when HistoricalReaction records with a minimum sample_size of 10 support the prediction.
4. THE MarketImpactEngine SHALL NOT use a cross-market relationship from news_event_relationships unless the record has confidence >= 0.2 and sample_size >= 30; WHERE a relationship is used, the MarketImpactEngine SHALL record the news_event_relationships.id in the news_market_impacts record for traceability.
5. THE MarketImpactEngine SHALL upsert impact records in news_market_impacts using (event_id, asset_id) as the unique key, with fields: article_id, event_id, asset_id or sector_id, direction, strength, confidence, expected_horizon, evidence_type, impact_computation_version, computed_at (UTC).
6. THE MarketImpactEngine SHALL compute a composite NewsImpactScore per (event, asset) pair as: Sentiment x Importance x SourceReliability x EntityRelevance x HistoricalImpact x MarketRegimeCompatibility x Confidence, where EntityRelevance is the entity-mention confidence for the asset in the source article, normalised to the range -100 to +100.
7. THE MarketImpactEngine SHALL store the NewsImpactScore and each multiplicative component in the news_market_impacts table for full traceability.
8. THE MarketImpactEngine SHALL be idempotent — reprocessing the same event SHALL update existing impact records in place using the (event_id, asset_id) unique key.

---

### Requirement 11: Cross-Market Intelligence Engine

**User Story:** As a market analyst, I want known cross-market relationships stored with historical correlation data and confidence scores, so that the system applies these relationships evidence-backed rather than assumption-based.

#### Acceptance Criteria

1. THE CrossMarketEngine SHALL maintain a news_event_relationships table with records containing: source_entity_id, target_entity_id, relationship_type (POSITIVE_CORRELATION, NEGATIVE_CORRELATION, CAUSAL_INDICATOR, or SECTOR_ROTATION), historical_correlation (-1.0 to +1.0), confidence (0.0-1.0), regime_dependency (array of MarketRegime values where relationship holds), sample_size (non-negative integer), and last_updated (UTC).
2. THE CrossMarketEngine SHALL update historical_correlation, confidence, and sample_size by joining HistoricalReaction records with computed_at > the record's last_updated timestamp with existing relationship records on a configurable schedule (default: daily); after the update, last_updated SHALL be set to the UTC timestamp of the update run.
3. WHEN sample_size falls below a configurable minimum (default: 30), THE CrossMarketEngine SHALL set confidence to 0.2, retain the existing historical_correlation value, and flag the record with low_sample: true; THE MarketImpactEngine SHALL NOT use relationships flagged with low_sample: true unless explicitly overridden by operator configuration.
4. THE CrossMarketEngine SHALL seed initial relationships from a configurable static YAML reference file at startup; empirically derived updates SHALL override the seeded values as HistoricalReaction data accumulates.
5. THE CrossMarketEngine SHALL respond to queries for relationships by source_entity_id, filtered by relationship_type and minimum confidence threshold, within 200 milliseconds at the 95th percentile.

---

### Requirement 12: Historical Market Reaction Engine

**User Story:** As a data scientist, I want the system to measure actual historical market price and volume reactions following past news events, so that impact predictions are grounded in evidence rather than heuristics.

#### Acceptance Criteria

1. THE HistoricalReactionEngine SHALL, for each NewsEvent, query the data-service for OHLCV data for all linked assets at the following offsets relative to eventTimestamp: -15 min, -5 min (pre-event baseline), +1 min, +5 min, +15 min, +30 min, +1 hour, +4 hours, and +1 day; all data-service queries SHALL use an asOf parameter <= the offset timestamp.
2. THE HistoricalReactionEngine SHALL compute and store in news_market_reactions: return_1m, return_5m, return_15m, return_30m, return_1h, return_4h, return_1d (each as a floating-point percentage), volume_change_ratio, volatility_change_ratio, and high_impact_flag (boolean: |return_15m| > configurable threshold, default 0.5%).
3. WHEN market data is not available for a specific offset, THE HistoricalReactionEngine SHALL record null for that offset's return field and set market_open to false — it SHALL NOT extrapolate, interpolate, or substitute adjacent data points.
4. IF the data-service does not respond to a query within 10 seconds, THEN THE HistoricalReactionEngine SHALL record null for all return fields at that offset, set data_service_timeout: true, and proceed to the next offset without retrying.
5. THE HistoricalReactionEngine SHALL store records in news_market_reactions with: event_id, asset_id, all return fields, volume_change_ratio, volatility_change_ratio, market_open, data_service_timeout, data_service_snapshot_version, and computed_at (UTC).

---

### Requirement 13: Market Regime Awareness

**User Story:** As a signal engineer, I want the system to track and apply the current market regime to all impact and feature computations, so that the same news event is interpreted differently in bull vs. bear or high-volatility vs. low-volatility regimes.

#### Acceptance Criteria

1. THE SentinelPulse SHALL maintain a current MarketRegime record per major market (India, US, Global), classified as one of: TRENDING_BULL, TRENDING_BEAR, SIDEWAYS, HIGH_VOLATILITY, LOW_VOLATILITY, RISK_ON, RISK_OFF, EVENT_DRIVEN, PANIC, RECOVERY.
2. THE SentinelPulse SHALL update market regime classifications by consuming signals from the data-service on a configurable schedule (default: every 15 minutes) and storing regime records in the news_market_regimes table with: market_id, regime, confidence, valid_from (UTC), valid_to (UTC, null if current); WHEN a new regime is recorded, THE prior record's valid_to SHALL be set to the new record's valid_from.
3. WHEN the current regime for a market changes, THE SentinelPulse SHALL delete cached impact score entries from Redis for all active NewsEvents with importance_score > 0.7 linked to that market, forcing recomputation on the next cache miss.
4. THE MarketImpactEngine SHALL read the current regime from the news_market_regimes table (the record with valid_to = null for the market) and SHALL apply regime_dependency filters from news_event_relationships when computing cross-market impacts.
5. THE SentinelPulse SHALL cache the current regime for each market in Redis under the key news:regime:{market_id} with a TTL of 20 minutes; IF the data-service is unavailable during a regime update cycle, THE SentinelPulse SHALL retain the existing cached regime and log a WARN-level entry.

---

### Requirement 14: Event Surprise Score Engine

**User Story:** As a quantitative analyst, I want a surprise score for each news event that compares reported values against consensus expectations, so that the signal engine can weight unexpected events more heavily than anticipated ones.

#### Acceptance Criteria

1. THE EventDetectionEngine SHALL compute a surprise_score for each event that carries a non-null quantitativeValue and a non-zero expectedValue, defined as (quantitativeValue - expectedValue) / |expectedValue|, capped to the range -5.0 to +5.0 and rounded to four decimal places; IF expectedValue is zero, THEN surprise_score SHALL be set to null with a surprise_score_error: "division_by_zero" field.
2. WHEN expectedValue is not available for an event, THE EventDetectionEngine SHALL set surprise_score to null and surprise_direction to UNKNOWN — it SHALL NOT substitute a default numerical surprise score.
3. THE SentinelPulse SHALL store surprise_score, surprise_direction, quantitativeValue, and expectedValue in the news_events table.
4. THE ImportanceEngine SHALL apply a non-null surprise_score as a multiplier on the event's importance_score: the multiplier SHALL be 1 + (|surprise_score| / 5.0), capping the multiplied importance at 1.0.

---

### Requirement 15: News Velocity and Momentum Engine

**User Story:** As a signal engineer, I want real-time velocity metrics tracking how quickly news is arriving about a specific asset, sector, or theme, so that a sudden spike in news volume can itself act as a market signal input.

#### Acceptance Criteria

1. THE SentinelPulse SHALL compute news velocity metrics at a per-asset and per-sector level for the following rolling windows: articles-per-minute (trailing 1-minute window) and articles-per-5-minutes (trailing 5-minute window); both metrics SHALL be recomputed every 60 seconds.
2. THE SentinelPulse SHALL compute news momentum as the ratio of current velocity to baseline velocity, where baseline is the rolling 7-day average computed at the same clock-hour and clock-minute; momentum SHALL be stored per asset, per sector, per market, per commodity, per country, and per thematic category; IF baseline velocity is zero, THEN momentum SHALL be set to null.
3. THE SentinelPulse SHALL update velocity and momentum metrics every 60 seconds and cache the results in Redis under news:velocity:{entity_type}:{entity_id} with a TTL of 90 seconds.
4. THE SentinelPulse SHALL store velocity snapshots in the news_features table with: feature_type = "VELOCITY", entity_type, entity_id, window (1m or 5m), value (float), baseline (float or null), momentum (float or null), and computed_at (UTC).
5. WHEN news velocity for any tracked asset exceeds 3x its 7-day baseline within a 5-minute window, THE AlertEngine SHALL generate a velocity spike alert for that asset; IF baseline is null, THE AlertEngine SHALL NOT generate a velocity spike alert.

---

### Requirement 16: News Breadth Metrics

**User Story:** As a market analyst, I want breadth metrics showing how many assets and sectors are receiving positive, negative, or neutral news simultaneously, so that I can gauge broad market sentiment rather than single-stock risk.

#### Acceptance Criteria

1. THE SentinelPulse SHALL compute news breadth at the market level (India, Global) as three integer counts: positive_asset_count (articles with marketSentiment > +0.3), negative_asset_count (articles with marketSentiment < -0.3), and neutral_asset_count (articles with marketSentiment in [-0.3, +0.3]) — computed over articles published in the most recent 4-hour rolling window.
2. THE SentinelPulse SHALL compute the same breadth counts at the sector level for each of the NIFTY sectoral indices tracked by the system.
3. THE SentinelPulse SHALL update breadth metrics every 5 minutes and store snapshots in the news_features table with feature_type = "BREADTH", market or sector identifier, the three counts, the 4-hour window start and end timestamps, and computed_at (UTC).
4. THE SentinelPulse SHALL cache the latest India market breadth under news:breadth:india and global breadth under news:breadth:global in Redis with a TTL of 6 minutes; IF no articles have been published in the trailing 4-hour window, THEN all three counts SHALL be set to 0.

---

### Requirement 17: Event Clustering and EventGraph Engine

**User Story:** As a data scientist, I want related news events grouped into thematic clusters with second-order effect chains, so that the ML model can reason about compound macro events rather than isolated data points.

#### Acceptance Criteria

1. THE EventClusteringEngine SHALL group NewsEvents into a cluster when at least 2 of the following 4 signals are present between them: (a) overlapping entity mentions (at least 1 shared resolved entity_id), (b) same event_type, (c) semantic embedding cosine similarity >= 0.85, (d) same primary taxonomy category; events MUST have been published within a configurable time window (default: 48 hours, minimum: 1 hour, maximum: 336 hours) to be eligible for grouping.
2. THE EventClusteringEngine SHALL maintain an EventGraph as a directed graph stored in news_event_relationships, where edges represent second-order causal chains with a chain_order field (1 = direct, 2 = second-order, etc.); edges SHALL NOT be created for chain_order > 3.
3. THE EventClusteringEngine SHALL compute a cluster_importance score as the weighted mean of member event importance_scores, where each event's weight equals the source_diversity value of its contributing NewsCluster.
4. THE EventClusteringEngine SHALL be idempotent — re-running clustering on the same set of events SHALL produce the same cluster assignments and SHALL NOT create duplicate cluster records or duplicate edges.
5. THE EventClusteringEngine SHALL expose event cluster data through the REST API at GET /api/v1/news/events/:eventId; IF the eventId does not exist, THE RestAPI SHALL return HTTP 404; WHEN the eventId exists, the response SHALL include the cluster's member event_ids and EventGraph edges.

---

### Requirement 18: Semantic Search and Embedding Engine

**User Story:** As an analyst, I want to query historical events using natural language, so that I can find historical analogues without knowing exact keywords or dates.

#### Acceptance Criteria

1. THE EmbeddingEngine SHALL generate a dense vector embedding for each NormalizedArticle, NewsEvent, and resolved Entity upon creation, using a configurable embedding model (default dimension: 1536); IF the embedding service is unavailable, THEN THE EmbeddingEngine SHALL enqueue the entity for retry using a dedicated BullMQ queue with exponential backoff.
2. THE EmbeddingEngine SHALL store all embeddings in the news_embeddings table using the pgvector PostgreSQL extension, with columns: entity_type (article/event/entity), entity_id, embedding (vector(1536)), model_version, created_at (UTC).
3. THE SentinelPulse SHALL expose a semantic search endpoint at GET /api/v1/news/search that accepts a natural-language query string, generates an embedding using the current model, and returns the top-K (configurable, default: 20, maximum: 100) most similar articles or events ranked by cosine similarity.
4. WHEN a semantic search query is issued, THE EmbeddingEngine SHALL execute the similarity search using a pgvector approximate nearest-neighbour index (HNSW or IVFFlat) and SHALL return results within 500 milliseconds at the 95th percentile for a corpus of up to 1 million embeddings.
5. WHEN the embedding model changes, THE EmbeddingEngine SHALL mark existing embeddings with the prior model_version rather than deleting them, and SHALL enqueue new embedding generation for all existing entities asynchronously; the system SHALL serve search results using the latest model_version embeddings only.

---

### Requirement 19: Historical Analogue Engine

**User Story:** As a quantitative analyst, I want to find historically similar events to any current event and retrieve the historical market reactions, so that I can estimate the likely range of outcomes with empirical backing.

#### Acceptance Criteria

1. THE HistoricalAnalogueEngine SHALL, for any given NewsEvent, retrieve the top-N (configurable, default: 10, minimum: 1, maximum: 100) most semantically similar historical NewsEvents using embedding cosine similarity from news_embeddings, returning only analogues with a similarity score >= 0.5.
2. THE HistoricalAnalogueEngine SHALL enrich each analogue result with: similarity_score (float, 0.0-1.0), event_date, event_description, market_reaction (from news_market_reactions), and market_regime_at_time (from news_market_regimes); IF any enrichment field is unavailable, THEN the field SHALL be set to null and the analogue SHALL NOT be excluded.
3. THE HistoricalAnalogueEngine SHALL compute aggregate statistics across all returned analogues: median return per horizon (1m/5m/15m/30m/1h/4h/1d), mean return per horizon, win rate (float 0.0-1.0), max adverse excursion, and max favorable excursion; IF fewer than 2 analogues have data for a given horizon, THEN the aggregate value for that horizon SHALL be set to null.
4. WHEN regime_filter = true is set in the query and fewer than 2 analogues match the current regime after filtering, THE HistoricalAnalogueEngine SHALL return the filtered results with a regime_filter_warning: true flag.
5. THE HistoricalAnalogueEngine SHALL respond to GET /api/v1/news/events/similar and GET /api/v1/alphaforge/high-impact-events within 2000 milliseconds at the 95th percentile; IF the response cannot be computed within 5000 milliseconds, THEN THE HistoricalAnalogueEngine SHALL return an error response indicating timeout and SHALL NOT return a partial result.

---

### Requirement 20: ML Feature Engineering Engine

**User Story:** As a machine-learning engineer, I want a structured, point-in-time correct feature vector generated for each significant news event, so that the ml-service can train models without manual feature construction or look-ahead bias.

#### Acceptance Criteria

1. THE FeatureEngineeringEngine SHALL generate a FeatureVector for each NewsEvent with importance_score > 0.3, containing: article features (sentiment_score, market_sentiment, company_sentiment, macro_sentiment, risk_sentiment, importance_score, novelty_score, surprise_score, qualitative_signal_flags as one-hot encoded integers), event features (event_type as one-hot encoded integers, event_severity, velocity_at_event_time, cluster_size, cluster_importance, surprise_direction as an encoded integer), asset features (asset_mention_count, asset_news_momentum, asset_news_breadth_positive, asset_news_breadth_negative), macro features (crude_oil_news_score, gold_news_score, usd_inr_news_score, fed_policy_score, rbi_policy_score), cross-market features (active_cross_market_relationships as integer count, dominant_cross_market_direction as an encoded integer), temporal features (hour_of_day as integer 0-23, day_of_week as integer 0-6, days_to_rbi_meeting as integer, days_to_fed_meeting as integer, days_to_earnings as integer for the primary entity), and market context features from the data-service at event_timestamp (OHLCV, ATR, VWAP, Open Interest, VIX for the primary asset).
2. THE FeatureEngineeringEngine SHALL enforce point-in-time correctness: ALL features SHALL use only data with a record timestamp <= event_timestamp; IF any feature computation requires data with a timestamp > event_timestamp, THEN THE FeatureEngineeringEngine SHALL raise a LookAheadBiasError, abort computation, and SHALL NOT persist a partial FeatureVector.
3. THE FeatureEngineeringEngine SHALL store completed FeatureVectors in the news_features table with: event_id, asset_id, feature_vector (JSON), feature_version, pipeline_version, and computed_at (UTC); IF storage fails, THEN THE FeatureEngineeringEngine SHALL retry up to 3 times with a 1-second delay before raising a storage error.
4. WHEN the feature schema changes, THE FeatureEngineeringEngine SHALL increment feature_version and enqueue a backfill job to recompute historical events under the new version asynchronously, without modifying or deleting records stored under prior feature_version values.
5. THE FeatureEngineeringEngine SHALL be idempotent: reprocessing the same event_id at the same feature_version SHALL overwrite the existing record without creating a duplicate row.
6. THE FeatureEngineeringEngine SHALL publish each completed FeatureVector as a job on the news.features BullMQ queue within 500 milliseconds of successful storage; IF the queue is unavailable, THEN THE FeatureEngineeringEngine SHALL raise a queue publish error and SHALL NOT silently drop the job.

---

### Requirement 21: Look-Ahead Bias Prevention

**User Story:** As a machine-learning engineer, I want the system to enforce look-ahead bias prevention at every stage of feature and label generation, so that models trained on SentinelPulse data are not inadvertently trained on future information.

#### Acceptance Criteria

1. THE FeatureEngineeringEngine SHALL validate that all market context features retrieved from the data-service use an asOf parameter set to a timestamp <= event_timestamp; IF any retrieved data has a timestamp > event_timestamp, THEN THE FeatureEngineeringEngine SHALL raise a LookAheadBiasError, abort feature computation for that event, and SHALL NOT persist the FeatureVector.
2. THE MLDatasetGenerator SHALL compute each forward-return label using only market data at the timestamp event_timestamp + label_horizon, and SHALL store the label_cutoff_timestamp (UTC) alongside each label; IF market data at event_timestamp + label_horizon is unavailable, THEN THE MLDatasetGenerator SHALL set that label to null rather than using an earlier or later data point.
3. THE SentinelPulse CI pipeline SHALL include a look-ahead leakage check that scans all FeatureVector records and asserts that no market context feature has a source data timestamp > the associated event_timestamp; the check SHALL complete within 10 minutes for a dataset of up to 1,000,000 records.
4. WHEN the look-ahead CI check detects a violation, THE SentinelPulse CI pipeline SHALL fail the build, SHALL report the offending record IDs and feature names in the build output, and SHALL NOT proceed to subsequent pipeline stages.

---

### Requirement 22: ML Training Dataset Generator

**User Story:** As a machine-learning engineer, I want a structured, labelled training dataset generated from historical news events with traceable provenance, so that the ml-service can train and evaluate models reproducibly.

#### Acceptance Criteria

1. THE MLDatasetGenerator SHALL generate TrainingSample records by joining FeatureVectors from news_features with forward returns computed from data-service OHLCV data at the following label horizons: future_return_5m, future_return_15m, future_return_30m, future_return_1h, future_return_4h, future_return_1d; IF OHLCV data is unavailable at a required horizon timestamp, THEN THE MLDatasetGenerator SHALL set that label to null and SHALL NOT interpolate or substitute adjacent data points.
2. THE MLDatasetGenerator SHALL assign a directional label to each TrainingSample per horizon using configurable thresholds (defaults: STRONG_BULLISH return > +1%, BULLISH return in (0%, +1%], NEUTRAL |return| <= 0.2%, BEARISH return in [-1%, 0%), STRONG_BEARISH return < -1%); IF a return value falls in a gap between configured thresholds, THEN THE MLDatasetGenerator SHALL assign the label of the nearest threshold boundary.
3. THE MLDatasetGenerator SHALL store each TrainingSample in news_training_samples with: event_id, asset_id, article_ids (array), feature_vector_id, label per horizon, label_cutoff_timestamp per horizon (UTC), feature_version, pipeline_version, market_data_snapshot_version, and created_at (UTC); IF storage fails, THEN THE MLDatasetGenerator SHALL retry up to 3 times with a 1-second delay before raising a storage error.
4. IF any forward-return label for a TrainingSample uses market data with a timestamp <= event_timestamp, THEN THE MLDatasetGenerator SHALL raise a LookAheadBiasError and SHALL NOT persist that TrainingSample.
5. THE MLDatasetGenerator SHALL respond to GET /api/v1/ml/training/samples and GET /api/v1/ml/training/events with support for the following query filters: feature_version (exact match), date range (ISO 8601 UTC start and end), asset (asset_id), event_type, and minimum importance_score (float); requests returning more than 10,000 records SHALL be paginated with a maximum page size of 1,000 records per response.

---

### Requirement 23: Backfill Engine

**User Story:** As a data engineer, I want to backfill historical news articles through the full pipeline with checkpoint/resume support, so that I can reconstruct the feature store from historical data without restarting from zero after failures.

#### Acceptance Criteria

1. THE BackfillEngine SHALL accept the following configuration parameters per backfill job: startDate (ISO 8601 UTC), endDate (ISO 8601 UTC), sources (array of source name strings, 1-50 entries), categories (array of taxonomy category strings), assets (array of asset ID strings), and batchSize (integer, minimum: 1, maximum: 1000, default: 100); IF startDate >= endDate, THEN THE BackfillEngine SHALL reject the job with an error indicating an invalid date range.
2. THE BackfillEngine SHALL persist checkpoint state to PostgreSQL after each successfully processed batch, recording: job_id, current_date_cursor (UTC), articles_processed (integer), articles_failed (integer), and last_checkpoint_at (UTC); checkpoint persistence SHALL complete within 2 seconds of batch completion, otherwise the batch SHALL be retried.
3. WHEN a BackfillEngine process is interrupted and restarted with the same job_id, THE BackfillEngine SHALL resume from the last persisted checkpoint's current_date_cursor rather than restarting from startDate, and SHALL NOT reprocess articles already recorded as processed.
4. THE BackfillEngine SHALL support pause, resume, and cancel operations via the admin API at POST /api/v1/admin/backfill/{jobId}/pause, /resume, and /cancel; a pause or cancel command SHALL take effect within 1 batch cycle of the command being received.
5. THE BackfillEngine SHALL process each batch through the full pipeline stages (normalization, deduplication, entity extraction, event detection, sentiment, impact, feature engineering) and SHALL enforce point-in-time correctness throughout, raising a LookAheadBiasError and skipping the offending article if any stage uses data with a timestamp > the article's event_timestamp.
6. THE BackfillEngine SHALL publish all backfill jobs to the news.backfill BullMQ queue with a concurrency limit configurable between 1 and 20 workers (default: 2); WHILE backfill jobs are running, THE BackfillEngine SHALL NOT consume more than 20% of the total BullMQ worker concurrency available to the live ingestion queues.

---

### Requirement 24: Alert Engine

**User Story:** As a trader using AlphaForge, I want configurable alerts when high-importance events occur or news velocity spikes, so that I am notified of potential market-moving developments without constant monitoring.

#### Acceptance Criteria

1. THE AlertEngine SHALL generate an alert when any of the following trigger conditions is met: (a) a NewsEvent with importance_score exceeding a configurable threshold (default: 0.8, range: 0.0-1.0) is detected for a tracked asset; (b) news velocity for a tracked asset exceeds 3x its 7-day rolling baseline; (c) market sentiment for a tracked asset changes sign with confidence > 0.7 within a rolling 30-minute window.
2. THE AlertEngine SHALL enforce a per-asset, per-trigger-type cooldown period (configurable, default: 10 minutes, minimum: 1 minute, maximum: 1440 minutes) such that no second alert of the same trigger type for the same asset is generated until the cooldown period has elapsed.
3. THE AlertEngine SHALL deduplicate alerts triggered by articles belonging to the same NewsCluster: for a given cluster_id, trigger condition, and cooldown window, at most one alert SHALL be generated; subsequent articles from the same cluster SHALL NOT produce additional alerts until the cooldown window expires.
4. THE AlertEngine SHALL publish each generated alert to all configured output channels with: alert_type, trigger_reason, asset_id, event_id, importance_score (float 0.0-1.0), computed_at (UTC), and a human-readable description of at most 500 characters; IF delivery to a channel fails, THEN THE AlertEngine SHALL retry delivery up to 3 times with a 5-second delay before recording delivery_status as "failed".
5. THE AlertEngine SHALL store all generated alerts in the news_alerts table with: alert_id, alert_type, trigger_reason, asset_id, event_id, importance_score, computed_at (UTC), payload (JSON), and delivery_status per configured output channel; IF the storage operation fails, THEN THE AlertEngine SHALL retry up to 3 times with a 1-second delay before raising a storage error.

---

### Requirement 25: REST API Layer

**User Story:** As a consumer service (AlphaForge signal engine, ml-service, frontend dashboard), I want a well-defined REST API to retrieve news intelligence, features, and context, so that I can integrate SentinelPulse without coupling to internal database schemas.

#### Acceptance Criteria

1. THE RestAPI SHALL expose the following news intelligence endpoints: GET /api/v1/news/latest (paginated, max 50 per page, with filters: source, category, language, min_importance, date_from, date_to; response includes total_count and next_page cursor), GET /api/v1/news/assets/:assetId, GET /api/v1/news/market/india, GET /api/v1/news/events/:eventId, GET /api/v1/news/events/similar, GET /api/v1/news/impact/:assetId, GET /api/v1/news/regime, GET /api/v1/news/signal/:assetId, and GET /api/v1/news/search.
2. THE RestAPI SHALL expose the following AlphaForge integration endpoints: GET /api/v1/alphaforge/news-context/:instrument (target: <100ms p95, Redis-served; returns HTTP 404 if instrument does not exist), GET /api/v1/alphaforge/context/market, /index/:index, /sector/:sector, /asset/:asset, and GET /api/v1/alphaforge/high-impact-events (events with importance_score > 0.7, sorted by recency).
3. THE RestAPI SHALL expose the following ML/data endpoints: GET /api/v1/ml/features/market, /asset/:assetId, /sector/:sector, GET /api/v1/ml/training/events and /samples (paginated, max 1,000 records per page), GET /api/v1/ml/historical-reactions, and GET /api/v1/ml/training/samples/:sampleId/lineage.
4. THE RestAPI SHALL expose the following admin endpoints: GET /api/v1/admin/sources, GET /api/v1/admin/ingestion, GET /api/v1/admin/queues, and GET /api/v1/admin/data-quality.
5. IF a request is missing the Authorization: Bearer {api_key} header or presents an invalid API key, THEN THE RestAPI SHALL return HTTP 401 with an error body indicating the authentication failure and SHALL NOT process the request further.
6. THE RestAPI SHALL enforce rate limiting per API key at a configurable requests-per-minute limit (default: 300); IF a caller exceeds their limit, THEN THE RestAPI SHALL return HTTP 429 with a Retry-After header specifying the number of seconds until the limit resets.
7. WHEN a request contains one or more invalid query parameters or path parameters, THE RestAPI SHALL return HTTP 400 with a structured error body identifying each invalid field by name and the reason for rejection.
8. THE RestAPI SHALL cache responses for GET /api/v1/alphaforge/news-context/:instrument in Redis under news:signal:{instrument} with a TTL of 30 seconds; IF the cached value is present and unexpired, THE RestAPI SHALL serve the cached response without querying PostgreSQL, targeting p95 < 100ms under 100 concurrent requests.

---

### Requirement 26: Worker and Queue Architecture

**User Story:** As a platform engineer, I want each processing stage isolated as an independently scalable BullMQ worker, so that I can scale bottleneck stages without over-provisioning the entire pipeline.

#### Acceptance Criteria

1. THE SentinelPulse SHALL implement the following independent BullMQ workers, each consuming from its designated queue: news-fetch-worker (news.raw), news-normalize-worker (news.normalized), news-dedup-worker (news.deduplicated), news-entity-worker (news.entities), news-event-worker (news.events), news-sentiment-worker (news.sentiment), news-impact-worker (news.impact), news-feature-worker (news.features).
2. THE SentinelPulse SHALL scale each worker independently via a configurable WORKER_{WORKER_NAME}_CONCURRENCY environment variable; IF the environment variable is not set, THEN THE worker SHALL default to a concurrency of 1.
3. WHEN a worker job is executed with the same job payload as a previously completed job, THE worker SHALL produce the same output state as the first execution, leaving no duplicate records or conflicting state changes in PostgreSQL.
4. WHEN a worker job fails and exhausts its retry policy (default: 3 attempts with exponential backoff starting at 1 second), THE worker SHALL move the job to the news.{stage}.deadletter queue rather than discarding it, preserving the original job payload and all error details.
5. THE SentinelPulse SHALL expose queue metrics (queue depth, throughput jobs-per-minute, error rate, DLQ count) per queue via the admin API at GET /api/v1/admin/queues.
6. IF a worker's designated input queue has been empty for 60 consecutive seconds, THEN THE worker SHALL remain running in an idle state and SHALL resume processing within 2 seconds of a new job arriving, without requiring a process restart.

---

### Requirement 27: Redis Caching Architecture

**User Story:** As a performance engineer, I want a well-defined Redis caching strategy with explicit TTLs and cache invalidation rules, so that hot-path queries are served from memory without database round trips.

#### Acceptance Criteria

1. THE SentinelPulse SHALL maintain the following Redis cache keys with the specified TTLs: news:latest:india (60s), news:latest:global (60s), news:asset:{assetId} (30s), news:signal:{instrument} (30s), news:impact:{instrument} (30s), news:regime (20 minutes), news:hot-events (60s), news:velocity:{entity_type}:{entity_id} (90s), news:breadth:india (6 minutes), news:breadth:global (6 minutes).
2. THE SentinelPulse SHALL treat Redis as a cache layer only — the authoritative state SHALL always reside in PostgreSQL; Redis SHALL NOT be the primary write target for any pipeline output.
3. WHEN a cache key expires or is explicitly invalidated, THE SentinelPulse SHALL serve the next inbound request from PostgreSQL and SHALL asynchronously repopulate the corresponding Redis cache key.
4. WHEN a Redis connection is unavailable, THE SentinelPulse SHALL fall back to direct PostgreSQL queries, log a WARN-level entry recording the cache miss and reason for unavailability, and SHALL return the query result to the caller without returning an error.
5. IF a pipeline stage writes a new result to PostgreSQL that supersedes the value held under a Redis cache key, THEN THE SentinelPulse SHALL invalidate the corresponding cache key within 5 seconds of the PostgreSQL write completing.

---

### Requirement 28: Database Schema and Performance

**User Story:** As a database engineer, I want a well-structured schema with appropriate indexes for time-series news queries, so that hot retrieval paths meet sub-100ms performance targets.

#### Acceptance Criteria

1. THE SentinelPulse database SHALL contain the following tables: news_sources, news_articles, news_article_versions, news_clusters, news_events, news_entities, news_entity_mentions, news_asset_links, news_sector_links, news_event_relationships, news_sentiment, news_importance, news_market_impacts, news_market_reactions, news_market_regimes, news_features, news_embeddings, news_training_samples, news_source_metrics, news_ingestion_runs, news_processing_errors, and news_alerts.
2. THE SentinelPulse SHALL create composite indexes on: (asset_id, published_at DESC) in news_asset_links, (event_type, published_at DESC) in news_events, and (importance_score DESC, published_at DESC) in news_importance.
3. THE SentinelPulse SHALL meet the following performance targets: GET /api/v1/news/assets/:assetId under a cache-miss condition SHALL complete within 100ms at the p95 percentile under 100 concurrent requests; GET /api/v1/alphaforge/news-context/:instrument SHALL complete within 100ms at p95 under cache-hit conditions.
4. ALL timestamp columns across all tables SHALL be stored as TIMESTAMPTZ in UTC; IF a value is inserted without an explicit timezone, THEN THE database SHALL reject the insert with a constraint violation error.
5. THE SentinelPulse SHALL version database migrations using the project's ORM migration tool (Prisma or equivalent) and SHALL NOT apply schema changes without a versioned, reversible migration file; each migration file SHALL include both an up migration and a down rollback script.
6. IF any query on the indexed columns returns more than 1,000 rows, THEN THE SentinelPulse SHALL apply a server-side result limit of 1,000 rows and include a truncated: true indicator in the API response.

---

### Requirement 29: Observability and Health Monitoring

**User Story:** As a platform operator, I want structured metrics, logs, and health endpoints so that I can monitor SentinelPulse pipeline health, diagnose incidents, and detect data quality issues in production.

#### Acceptance Criteria

1. THE SentinelPulse SHALL expose the following Prometheus-compatible metrics at GET /metrics: sentinel_articles_fetched_total (counter, labels: source), sentinel_articles_failed_total (counter, labels: source, error_type), sentinel_events_detected_total (counter, labels: event_type), sentinel_processing_latency_seconds (histogram, labels: stage), sentinel_queue_depth (gauge, labels: queue_name), sentinel_cache_hit_rate (gauge, labels: cache_key_pattern), sentinel_source_health (gauge 0/1, labels: source_name).
2. THE SentinelPulse SHALL produce structured JSON logs for all pipeline stages using a consistent schema: timestamp (UTC ISO 8601), level (DEBUG/INFO/WARN/ERROR), service ("sentinel-pulse"), stage, correlationId, message, and metadata (key-value pairs); each log entry for a request or job SHALL carry the same correlationId across all stages.
3. THE SentinelPulse SHALL expose: GET /health (liveness — returns HTTP 200 if process is alive), GET /ready (readiness — returns HTTP 200 only if PostgreSQL, Redis, and at least one Tier-1 source are reachable within a 2-second probe timeout; returns HTTP 503 otherwise), and GET /metrics (Prometheus text/plain format).
4. THE SentinelPulse SHALL report data quality scores via GET /api/v1/admin/data-quality, including: percentage of articles with resolved entities, percentage of articles with computed sentiment, percentage of events with importance scores, and percentage of high-importance events (importance_score > 0.7) with historical reaction data; each percentage SHALL be computed over the trailing 24-hour window and rounded to two decimal places.
5. IF sentinel_source_health for any Tier-1 source transitions from 1 to 0 and remains at 0 for more than 5 consecutive minutes, THEN THE SentinelPulse SHALL emit a WARN-level structured log entry identifying the source name and the duration of unavailability.

---

### Requirement 30: Security and Input Safety

**User Story:** As a security engineer, I want all network inputs, secrets, and external URLs validated and sandboxed, so that SentinelPulse cannot be exploited as a vector for injection, SSRF, or secret leakage.

#### Acceptance Criteria

1. THE SentinelPulse SHALL load all secrets exclusively from environment variables or a secrets manager — secrets SHALL NOT appear in source code, configuration files, version control history, or log output.
2. IF HTTP request validation fails for any path, query, or body parameter, THEN THE RestAPI SHALL return HTTP 400 with a structured error body identifying each field that failed validation and the reason for rejection, without echoing raw input values.
3. THE SentinelPulse SHALL protect all database queries from SQL injection by using only parameterised queries or the ORM's query builder — raw SQL string interpolation from user-controlled input SHALL NOT appear in the codebase.
4. THE SentinelPulse SHALL enforce SSRF protection on all outbound HTTP requests: URLs SHALL be validated against a configurable allowlist of approved source domains before any outbound request is made; IF a URL fails allowlist validation, THEN THE adapter SHALL log a WARN-level entry recording the rejected URL's domain and abort the request without fetching.
5. THE SentinelPulse SHALL enforce rate limiting on all REST API endpoints; IF a caller exceeds their per-minute limit, THEN THE RestAPI SHALL return HTTP 429 with a Retry-After header specifying the number of seconds until the limit window resets.
6. IF an outbound HTTP request from a NewsSourceAdapter does not receive a response within 10 seconds, THEN THE adapter SHALL abort the request, log a WARN-level entry with the target domain and elapsed time, and treat the fetch as a failed attempt subject to the retry policy.

---

### Requirement 31: Testing and Quality Assurance

**User Story:** As an engineering team, I want comprehensive automated testing — including unit tests, integration tests, failure simulation tests, and look-ahead leakage CI checks — so that regressions and data integrity violations are caught before production.

#### Acceptance Criteria

1. THE SentinelPulse test suite SHALL include unit tests for each engine (NormalizationEngine, DeduplicationEngine, EntityResolutionEngine, EventDetectionEngine, SentimentEngine, ImportanceEngine, MarketImpactEngine, HistoricalReactionEngine, FeatureEngineeringEngine) achieving at minimum 80% line coverage per engine as measured by the project's configured coverage tool.
2. THE SentinelPulse test suite SHALL include integration tests for each NewsSourceAdapter that mock HTTP responses and verify correct handling of: successful fetch, HTTP 429 rate-limit response, HTTP 500 server error, malformed response body, and network timeout (simulated as no response within 10 seconds).
3. THE SentinelPulse SHALL include a failure simulation test that disables all Tier-1 sources and verifies that the pipeline continues processing Tier-2 source articles without errors and without producing any ERROR-level log entries attributable to the Tier-1 outage.
4. THE SentinelPulse CI pipeline SHALL include a look-ahead leakage check that scans all FeatureVector records in the test dataset and fails the build if any market context feature timestamp exceeds the associated event_timestamp by more than 0 seconds.
5. THE SentinelPulse SHALL include performance tests verifying pipeline throughput at 10, 100, 500, and 1,000 articles/minute, asserting that p95 processing latency from fetchLatest to news_features insertion does not exceed 30 seconds at 1,000 articles/minute against a dataset of at least 1,000 pre-seeded articles.
6. THE SentinelPulse SHALL run the full test suite in CI on every pull request and SHALL block merges when test coverage drops below 80% line coverage for any modified engine.

---

### Requirement 32: AlphaForge Signal Integration Contract

**User Story:** As the AlphaForge signal engine, I want a well-defined integration contract specifying how news intelligence is combined with other factors, so that news is treated as one evidence source in a multi-factor system and never as an autonomous trading signal.

#### Acceptance Criteria

1. THE SentinelPulse SHALL expose a news_context bundle for each instrument via GET /api/v1/alphaforge/news-context/:instrument containing: news_impact_score (numeric, 0.0-1.0), sentiment_summary (per dimension), velocity_metrics, regime_context, top_contributing_events (maximum 5, ordered by importance_score descending), active_cross_market_signals, and historical_analogue_summary.
2. THE RestAPI response for GET /api/v1/alphaforge/news-context/:instrument SHALL include an explainability block containing: the top-3 contributing news events with titles, importance scores (0.0-1.0), and sentiment directions (positive/negative/neutral); the top-3 active cross-market relationships; and the single most relevant historical analogue with its reaction summary.
3. THE SentinelPulse documentation SHALL explicitly state that news_impact_score is an input factor — not a standalone signal — and that the final AlphaForge signal is computed externally as: News Score + Technical + Smart Money + Volume + Open Interest + Market Regime + Macro -> ML Probability -> Final Signal.
4. THE SentinelPulse SHALL NOT expose any endpoint that directly recommends a trading action (BUY/SELL/HOLD) — such decisions reside in AlphaForge's signal computation layer.
5. IF a requested instrument identifier does not exist in the SentinelPulse database, THEN THE RestAPI SHALL return HTTP 404 with an error body indicating that no news context is available for the given instrument.

---

### Requirement 33: Data Retention and Reproducibility

**User Story:** As a data engineer, I want explicit data retention policies and full traceability from training sample to source article, so that I can audit, reproduce, and debug ML model behaviour.

#### Acceptance Criteria

1. THE SentinelPulse SHALL enforce the following data retention policies, configurable per environment: raw article content (default: 90 days), NormalizedArticle records (default: 365 days), NewsEvent and NewsMarketImpact records (default: 730 days), TrainingSample and FeatureVector records (default: indefinite until explicit deletion), embedding vectors (default: retained until the associated model_version is marked deprecated plus 90 days); IF a record's age exceeds its configured retention period, THEN THE SentinelPulse SHALL delete it during the next scheduled retention sweep, which SHALL run at most once every 24 hours.
2. EVERY TrainingSample record SHALL contain foreign key references to: source article IDs, event IDs, feature_vector_id, feature_version, pipeline_version, market_data_snapshot_version, and model_version; IF any of these foreign key references cannot be resolved at TrainingSample creation time, THEN THE SentinelPulse SHALL reject the record and log an ERROR-level entry identifying the missing reference.
3. THE SentinelPulse SHALL expose a traceability API at GET /api/v1/ml/training/samples/:sampleId/lineage returning the provenance chain: TrainingSample -> FeatureVector -> NewsEvent -> NormalizedArticle -> RawArticle metadata; IF the sampleId does not exist, THEN THE RestAPI SHALL return HTTP 404.
4. THE SentinelPulse SHALL enforce that pipeline_version and feature_version are expressed as semantic version strings (MAJOR.MINOR.PATCH format); IF a version string does not conform to this format, THEN THE SentinelPulse SHALL refuse to start and SHALL log an ERROR-level entry identifying the malformed version field.

---

### Requirement 34: Documentation

**User Story:** As an engineer onboarding to SentinelPulse, I want comprehensive documentation covering architecture, data model, API reference, source adapters, ML features, AlphaForge integration, backfill, operations, and troubleshooting, so that I can understand, operate, and extend the system without tribal knowledge.

#### Acceptance Criteria

1. THE SentinelPulse repository SHALL contain the following Markdown documentation files in the sentinel-pulse/docs/ directory: README.md, ARCHITECTURE.md, DATA_MODEL.md, API.md, SOURCE_ADAPTERS.md, ML_FEATURES.md, ALPHAFORGE_INTEGRATION.md, BACKFILL.md, OPERATIONS.md, and TROUBLESHOOTING.md; the presence of each file SHALL be verified by a CI check that fails the build if any listed file is absent.
2. THE ARCHITECTURE.md SHALL include a narrative description of the transformation pipeline, a component diagram (text-based or Mermaid), and the worker/queue topology.
3. THE ML_FEATURES.md SHALL enumerate every feature in the FeatureVector with its name, type, derivation formula, and point-in-time correctness guarantee.
4. THE ALPHAFORGE_INTEGRATION.md SHALL document the news-context API contract, the multi-factor signal formula, and explicitly state that SentinelPulse does not generate autonomous trading signals.
5. WHEN a new NewsSourceAdapter is added, THE corresponding SOURCE_ADAPTERS.md SHALL be updated to document the source's official feed URL or scraping approach, rate limits, authentication method, and known limitations before the adapter is merged; the CI pipeline SHALL verify that a SOURCE_ADAPTERS.md diff is present in any pull request that adds a new adapter file, and SHALL block the merge if the documentation update is absent.
