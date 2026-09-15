/**
 * Look-ahead leakage CI check (task 38.1).
 *
 * Scans all NewsFeature records tagged as EVENT_FEATURE_VECTOR and asserts
 * that no market-context feature has a source data timestamp (proxied by
 * `computedAt`) later than the associated event_timestamp.
 *
 * A violation means a FeatureVector was computed *after* the anchor event,
 * which would introduce look-ahead bias into any model trained on that vector.
 *
 * Exit codes:
 *   0 — No violations found. All FeatureVectors are point-in-time correct.
 *   1 — One or more violations found, or a fatal error occurred.
 *
 * Requirements: Req 21.3, Req 21.4, Req 31.4
 */

import { prisma } from '../../src/db/prisma.js';
import { LookAheadBiasError } from '../../src/engines/feature-engineering/LookAheadGuard.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Violation {
  featureId: string;
  eventId: string | null;
  featureName: string;
  recordTs: string;
  eventTs: string;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function runLookAheadCheck(): Promise<void> {
  console.log('[look-ahead-check] Starting look-ahead bias scan...');

  // Fetch up to 1,000,000 EVENT_FEATURE_VECTOR records.
  // For very large datasets this should be paginated; for CI the limit is
  // sufficient to catch accidental regressions.
  const features = await prisma.newsFeature.findMany({
    where: { featureType: 'EVENT_FEATURE_VECTOR' },
    select: {
      id: true,
      eventId: true,
      featureVector: true,
      computedAt: true,
      event: { select: { eventTimestamp: true } },
    },
    take: 1_000_000,
  });

  console.log(
    `[look-ahead-check] Scanning ${features.length} EVENT_FEATURE_VECTOR record(s)...`,
  );

  const violations: Violation[] = [];

  for (const f of features) {
    const eventTs = f.event?.eventTimestamp;
    if (!eventTs) {
      // Cannot validate without an anchor timestamp — skip gracefully.
      continue;
    }

    // `computedAt` acts as the proxy for when market-context data was sourced.
    // Any FeatureVector computed after the event timestamp is a potential
    // look-ahead leak (Req 21.3, Req 21.4).
    if (f.computedAt > eventTs) {
      violations.push({
        featureId: f.id,
        eventId: f.eventId ?? null,
        featureName: 'computedAt',
        recordTs: f.computedAt.toISOString(),
        eventTs: eventTs.toISOString(),
      });

      // Construct a LookAheadBiasError for its canonical message format —
      // used to confirm the error type is importable and coherent.
      const _err = new LookAheadBiasError(
        'computedAt',
        f.computedAt,
        eventTs,
      );
      // Log but do not throw — we want to collect ALL violations first.
      console.error(`[look-ahead-check] Violation: ${_err.message}`);
    }
  }

  if (violations.length > 0) {
    console.error(
      `\n[look-ahead-check] FAILED: ${violations.length} look-ahead violation(s) found:\n`,
    );

    for (const v of violations) {
      console.error(
        `  featureId=${v.featureId}  eventId=${v.eventId ?? 'null'}` +
          `  feature=${v.featureName}` +
          `  recordTs=${v.recordTs}  eventTs=${v.eventTs}`,
      );
    }

    await prisma.$disconnect();
    process.exit(1);
  }

  console.log(
    `[look-ahead-check] PASSED: ${features.length} FeatureVector(s) checked, 0 violations.`,
  );

  await prisma.$disconnect();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

void runLookAheadCheck().catch((err: unknown) => {
  console.error(
    '[look-ahead-check] Fatal error:',
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
