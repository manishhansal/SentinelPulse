/**
 * backfill-status.ts — Show status of a running or completed backfill job.
 *
 * Reads the checkpoint from the news_features table (written by BackfillEngine)
 * and prints a human-readable summary.
 *
 * Usage:
 *   JOB_ID=<uuid> npx tsx src/scripts/backfill-status.ts
 *   # or via make:
 *   make backfill-status JOB_ID=<uuid>
 *   make backfill-status            # lists all checkpoint jobs
 */

import { prisma } from '../db/prisma.js';

const CHECKPOINT_FEATURE_TYPE = 'BACKFILL_CHECKPOINT';

async function main(): Promise<void> {
  const jobId = process.env['JOB_ID'];

  if (!jobId) {
    // List all known jobs
    const rows = await prisma.newsFeature.findMany({
      where: { featureType: CHECKPOINT_FEATURE_TYPE },
      orderBy: { computedAt: 'desc' },
      take: 20,
      select: { entityId: true, featureVector: true, computedAt: true },
    });

    if (rows.length === 0) {
      console.log('No backfill jobs found.');
      console.log('Start one with: make backfill');
      return;
    }

    console.log('\nKnown backfill jobs (most recent first):');
    console.log('─────────────────────────────────────────────────────────');
    for (const row of rows) {
      const v = row.featureVector as Record<string, unknown>;
      const pct = v['articlesProcessed'] != null && v['endDate']
        ? '(processing)'
        : '';
      console.log(
        `  ${v['jobId'] as string}  status=${v['status']}  ` +
        `processed=${v['articlesProcessed']}  failed=${v['articlesFailed']}  ` +
        `cursor=${(v['currentDateCursor'] as string).slice(0, 10)}  ` +
        `last_checkpoint=${row.computedAt.toISOString().slice(0, 19)}`,
      );
    }
    console.log('');
    console.log('Show detail: JOB_ID=<id> npx tsx src/scripts/backfill-status.ts');
    return;
  }

  const row = await prisma.newsFeature.findFirst({
    where: { featureType: CHECKPOINT_FEATURE_TYPE, entityId: jobId },
    orderBy: { computedAt: 'desc' },
    select: { featureVector: true, computedAt: true },
  });

  if (!row) {
    console.error(`No checkpoint found for job ID: ${jobId}`);
    process.exit(1);
  }

  const v = row.featureVector as Record<string, unknown>;
  const startDate = new Date(v['startDate'] as string);
  const endDate = new Date(v['endDate'] as string);
  const cursor = new Date(v['currentDateCursor'] as string);
  const totalDays = (endDate.getTime() - startDate.getTime()) / 86400000;
  const processedDays = (cursor.getTime() - startDate.getTime()) / 86400000;
  const pctDone = totalDays > 0 ? Math.round((processedDays / totalDays) * 100) : 0;

  console.log('');
  console.log('SentinelPulse Backfill Status');
  console.log('═══════════════════════════════════════');
  console.log(`  Job ID:             ${v['jobId'] as string}`);
  console.log(`  Status:             ${v['status'] as string}`);
  console.log(`  Date range:         ${(v['startDate'] as string).slice(0, 10)} → ${(v['endDate'] as string).slice(0, 10)}`);
  console.log(`  Current cursor:     ${cursor.toISOString().slice(0, 10)}`);
  console.log(`  Progress:           ~${pctDone}% (${Math.round(processedDays)} / ${Math.round(totalDays)} days)`);
  console.log(`  Articles processed: ${v['articlesProcessed'] as number}`);
  console.log(`  Articles failed:    ${v['articlesFailed'] as number}`);
  console.log(`  Last checkpoint:    ${row.computedAt.toISOString()}`);
  console.log('');
}

void main()
  .catch((err) => { console.error('Fatal:', err); process.exit(1); })
  .finally(() => void prisma.$disconnect());
