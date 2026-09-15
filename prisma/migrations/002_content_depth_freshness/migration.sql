-- Migration 002: content_depth + content_quality_score
-- Phase 3A: Source content quality model
--
-- Adds two columns to news_articles:
--   content_depth        TEXT    NOT NULL DEFAULT 'SUMMARY'
--   content_quality_score FLOAT  NOT NULL DEFAULT 0.5
--
-- These columns allow downstream engines (ImportanceEngine, FeatureEngineeringEngine)
-- to adjust confidence based on the actual depth of content available from the
-- source adapter (Reuters RSS = HEADLINE_ONLY, Moneycontrol = SUMMARY, etc.)

ALTER TABLE news_articles
  ADD COLUMN IF NOT EXISTS content_depth TEXT NOT NULL DEFAULT 'SUMMARY',
  ADD COLUMN IF NOT EXISTS content_quality_score FLOAT NOT NULL DEFAULT 0.5;

-- Index for quality-filtered queries
CREATE INDEX IF NOT EXISTS idx_news_articles_content_depth
  ON news_articles (content_depth, published_at DESC);

COMMENT ON COLUMN news_articles.content_depth IS
  'FULL_ARTICLE (≥500 words) | SUMMARY (100–499 words) | HEADLINE_ONLY (<100 words or source override)';

COMMENT ON COLUMN news_articles.content_quality_score IS
  'Composite quality score [0,1]: depth weight × timestamp confidence × truncation penalty';
