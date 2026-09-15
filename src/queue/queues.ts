import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

export const QUEUE_NAMES = {
  RAW: 'news.raw',
  NORMALIZED: 'news.normalized',
  DEDUPLICATED: 'news.deduplicated',
  ENTITIES: 'news.entities',
  EVENTS: 'news.events',
  SENTIMENT: 'news.sentiment',
  IMPACT: 'news.impact',
  FEATURES: 'news.features',
  EMBEDDINGS: 'news.embeddings',
  BACKFILL: 'news.backfill',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 } as const,
  removeOnComplete: { age: 86400 },  // keep 24h
  removeOnFail: false,               // keep failed jobs for DLQ inspection
} as const;

/**
 * Creates and returns all BullMQ queues.
 * Inject the Redis connection from the app's shared ioredis client.
 */
export function createQueues(connection: Redis): Record<QueueName, Queue> {
  const makeQueue = (name: QueueName) =>
    new Queue(name, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });

  return {
    [QUEUE_NAMES.RAW]: makeQueue(QUEUE_NAMES.RAW),
    [QUEUE_NAMES.NORMALIZED]: makeQueue(QUEUE_NAMES.NORMALIZED),
    [QUEUE_NAMES.DEDUPLICATED]: makeQueue(QUEUE_NAMES.DEDUPLICATED),
    [QUEUE_NAMES.ENTITIES]: makeQueue(QUEUE_NAMES.ENTITIES),
    [QUEUE_NAMES.EVENTS]: makeQueue(QUEUE_NAMES.EVENTS),
    [QUEUE_NAMES.SENTIMENT]: makeQueue(QUEUE_NAMES.SENTIMENT),
    [QUEUE_NAMES.IMPACT]: makeQueue(QUEUE_NAMES.IMPACT),
    [QUEUE_NAMES.FEATURES]: makeQueue(QUEUE_NAMES.FEATURES),
    [QUEUE_NAMES.EMBEDDINGS]: makeQueue(QUEUE_NAMES.EMBEDDINGS),
    [QUEUE_NAMES.BACKFILL]: makeQueue(QUEUE_NAMES.BACKFILL),
  };
}
