/**
 * seed-sources.ts — Idempotent seeder for news_sources table.
 *
 * Inserts (or updates) the canonical set of news sources.
 * Safe to run multiple times — uses upsert on the primary key (id).
 *
 * Usage:
 *   npx tsx src/scripts/seed-sources.ts
 *
 * The sourceReliability values reflect:
 *   - Tier-1 sources default to 0.9 (high reliability, well-known editorial standard)
 *   - Content-quality adjustments are applied downstream by ImportanceEngine
 *     using content_quality_score, NOT by inflating source_reliability here.
 *
 * Phase 3A: CoinDesk is seeded but enabled=false (toggle via env or admin API).
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// Source definitions
// ---------------------------------------------------------------------------

const SOURCES = [
  {
    id: 'reuters',
    name: 'Reuters',
    tier: 1,
    enabled: process.env['NEWS_SOURCE_REUTERS_ENABLED'] !== 'false',
    baseUrl:
      process.env['NEWS_SOURCE_REUTERS_BASE_URL'] ??
      'https://news.google.com/rss/search?q=site:reuters.com+finance+markets&hl=en-IN&gl=IN&ceid=IN:en',
    // Reuters is Tier-1 but content arrives as HEADLINE_ONLY via Google News RSS.
    // The 0.9 source_reliability reflects editorial credibility; the actual
    // extraction confidence is reduced by content_quality_score (0.25) in
    // ImportanceEngine.computeSourceConfidence().
    sourceReliability: 0.9,
    adapterVersion: '2.0.0',
  },
  {
    id: 'moneycontrol',
    name: 'Moneycontrol',
    tier: 1,
    enabled: process.env['NEWS_SOURCE_MONEYCONTROL_ENABLED'] !== 'false',
    baseUrl:
      process.env['NEWS_SOURCE_MONEYCONTROL_BASE_URL'] ??
      'https://www.moneycontrol.com',
    sourceReliability: 0.85,
    adapterVersion: '1.0.0',
  },
  {
    id: 'economic-times',
    name: 'Economic Times',
    tier: 1,
    enabled: process.env['NEWS_SOURCE_ECONOMICTIMES_ENABLED'] !== 'false',
    baseUrl:
      process.env['NEWS_SOURCE_ECONOMICTIMES_BASE_URL'] ??
      'https://economictimes.indiatimes.com',
    sourceReliability: 0.85,
    adapterVersion: '1.0.0',
  },
  {
    id: 'coindesk',
    name: 'CoinDesk',
    tier: 2,
    // CoinDesk enabled separately — crypto coverage is supplemental
    enabled: process.env['NEWS_SOURCE_COINDESK_ENABLED'] === 'true',
    baseUrl:
      process.env['NEWS_SOURCE_COINDESK_BASE_URL'] ??
      'https://www.coindesk.com/arc/outboundfeeds/rss/',
    sourceReliability: 0.8,
    adapterVersion: '1.0.0',
  },
  {
    id: 'bloomberg',
    name: 'Bloomberg',
    tier: 1,
    // Bloomberg requires an API key — disabled until configured
    enabled: (process.env['NEWS_SOURCE_BLOOMBERG_ENABLED'] === 'true') &&
             Boolean(process.env['NEWS_SOURCE_BLOOMBERG_API_KEY']),
    baseUrl:
      process.env['NEWS_SOURCE_BLOOMBERG_BASE_URL'] ?? 'https://www.bloomberg.com',
    sourceReliability: 0.95,
    adapterVersion: '1.0.0',
  },
  {
    id: 'financial-times',
    name: 'Financial Times',
    tier: 1,
    // FT requires an API key — disabled until configured
    enabled: (process.env['NEWS_SOURCE_FINANCIALTIMES_ENABLED'] === 'true') &&
             Boolean(process.env['NEWS_SOURCE_FINANCIALTIMES_API_KEY']),
    baseUrl:
      process.env['NEWS_SOURCE_FINANCIALTIMES_BASE_URL'] ?? 'https://www.ft.com',
    sourceReliability: 0.95,
    adapterVersion: '1.0.0',
  },
] as const;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('[seed-sources] Starting idempotent source seed...');

  for (const source of SOURCES) {
    const result = await prisma.newsSource.upsert({
      where: { id: source.id },
      create: {
        id: source.id,
        name: source.name,
        tier: source.tier,
        enabled: source.enabled,
        baseUrl: source.baseUrl,
        sourceReliability: source.sourceReliability,
        failureCounter: 0,
        adapterVersion: source.adapterVersion,
      },
      update: {
        name: source.name,
        tier: source.tier,
        enabled: source.enabled,
        baseUrl: source.baseUrl,
        sourceReliability: source.sourceReliability,
        adapterVersion: source.adapterVersion,
        // Do NOT reset failureCounter or disabledUntil on re-seed
      },
    });

    const action = result.createdAt.getTime() === result.updatedAt.getTime()
      ? 'CREATED'
      : 'UPDATED';

    console.log(
      `  [${action}] ${source.id} (${source.name}) — enabled=${source.enabled}, tier=${source.tier}, reliability=${source.sourceReliability}`,
    );
  }

  console.log(`\n[seed-sources] Done. Seeded ${SOURCES.length} sources.`);
}

main()
  .catch((err) => {
    console.error('[seed-sources] FATAL:', err);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
