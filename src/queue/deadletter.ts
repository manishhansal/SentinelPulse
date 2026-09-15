import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

/** Dead-letter queue name suffix. */
export const DLQ_SUFFIX = '.deadletter';

/** Generates the DLQ name for a given pipeline stage queue name. */
export function dlqName(queueName: string): string {
  return `${queueName}${DLQ_SUFFIX}`;
}

export const DLQ_NAMES = {
  RAW: 'news.raw.deadletter',
  NORMALIZED: 'news.normalized.deadletter',
  DEDUPLICATED: 'news.deduplicated.deadletter',
  ENTITIES: 'news.entities.deadletter',
  EVENTS: 'news.events.deadletter',
  SENTIMENT: 'news.sentiment.deadletter',
  IMPACT: 'news.impact.deadletter',
  FEATURES: 'news.features.deadletter',
  EMBEDDINGS: 'news.embeddings.deadletter',
  BACKFILL: 'news.backfill.deadletter',
} as const;

export type DLQName = (typeof DLQ_NAMES)[keyof typeof DLQ_NAMES];

/**
 * Creates and returns all dead-letter queues.
 * DLQ jobs are never removed on failure (removeOnFail: false by default).
 */
export function createDeadLetterQueues(connection: Redis): Record<DLQName, Queue> {
  const makeDLQ = (name: DLQName) =>
    new Queue(name, {
      connection,
      defaultJobOptions: {
        attempts: 1,         // DLQ jobs are terminal — no retries
        removeOnComplete: { age: 7 * 86400 },  // keep 7 days
        removeOnFail: false,
      },
    });

  return {
    [DLQ_NAMES.RAW]: makeDLQ(DLQ_NAMES.RAW),
    [DLQ_NAMES.NORMALIZED]: makeDLQ(DLQ_NAMES.NORMALIZED),
    [DLQ_NAMES.DEDUPLICATED]: makeDLQ(DLQ_NAMES.DEDUPLICATED),
    [DLQ_NAMES.ENTITIES]: makeDLQ(DLQ_NAMES.ENTITIES),
    [DLQ_NAMES.EVENTS]: makeDLQ(DLQ_NAMES.EVENTS),
    [DLQ_NAMES.SENTIMENT]: makeDLQ(DLQ_NAMES.SENTIMENT),
    [DLQ_NAMES.IMPACT]: makeDLQ(DLQ_NAMES.IMPACT),
    [DLQ_NAMES.FEATURES]: makeDLQ(DLQ_NAMES.FEATURES),
    [DLQ_NAMES.EMBEDDINGS]: makeDLQ(DLQ_NAMES.EMBEDDINGS),
    [DLQ_NAMES.BACKFILL]: makeDLQ(DLQ_NAMES.BACKFILL),
  };
}
