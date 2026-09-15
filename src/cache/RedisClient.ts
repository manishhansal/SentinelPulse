/**
 * Typed Redis client wrapper for SentinelPulse.
 *
 * Features:
 * - Connection from REDIS_URL env var
 * - Typed get<T>() / set() / del() / scan() / delPattern() wrappers
 * - Graceful fallback to null on connection unavailability (Req 27.4)
 * - Silent no-op on write errors — Redis is cache-only, never the write target
 *
 * Requirements: Req 27.4
 */

import { Redis } from 'ioredis';
import { pino } from 'pino';

const logger = pino({ name: 'redis-client' });

export class RedisClient {
  private readonly client: Redis;
  private isConnected = false;

  constructor(url?: string) {
    const redisUrl = url ?? process.env['REDIS_URL'] ?? 'redis://localhost:6379';
    this.client = new Redis(redisUrl, {
      enableOfflineQueue: false, // fail fast — don't queue commands when disconnected
      lazyConnect: true,
      retryStrategy: (times) => Math.min(times * 1000, 30_000),
    });

    this.client.on('connect', () => {
      this.isConnected = true;
      logger.info('Redis connection established');
    });

    this.client.on('error', (err: unknown) => {
      if (this.isConnected) {
        this.isConnected = false;
      }
      logger.warn({ err }, 'Redis connection error');
    });
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async disconnect(): Promise<void> {
    await this.client.quit();
  }

  /**
   * Get a typed value from cache.
   * Returns null when the key doesn't exist or on any error (Req 27.4).
   * Caller should fall back to PostgreSQL on null.
   */
  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.client.get(key);
      if (raw === null) return null;
      return JSON.parse(raw) as T;
    } catch (err) {
      logger.warn({ key, err }, 'Redis get failed — returning null');
      return null;
    }
  }

  /**
   * Set a value with TTL in seconds.
   * Silently no-ops on error — Redis is cache-only (Req 27.2).
   */
  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (err) {
      logger.warn({ key, err }, 'Redis set failed');
    }
  }

  /**
   * Delete a single key.
   * Silently no-ops on error.
   */
  async del(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch (err) {
      logger.warn({ key, err }, 'Redis del failed');
    }
  }

  /**
   * Scan for keys matching a glob pattern and return them.
   * Returns an empty array on error (Req 27.4 — graceful fallback).
   */
  async scan(pattern: string): Promise<string[]> {
    try {
      const keys: string[] = [];
      let cursor = '0';
      do {
        const [nextCursor, batch] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        keys.push(...batch);
        cursor = nextCursor;
      } while (cursor !== '0');
      return keys;
    } catch (err) {
      logger.warn({ pattern, err }, 'Redis scan failed — returning empty array');
      return [];
    }
  }

  /**
   * Delete all keys matching a glob pattern.
   * Uses SCAN to avoid blocking the server on large key sets.
   */
  async delPattern(pattern: string): Promise<void> {
    try {
      const keys = await this.scan(pattern);
      if (keys.length > 0) {
        await this.client.del(...keys);
      }
    } catch (err) {
      logger.warn({ pattern, err }, 'Redis delPattern failed');
    }
  }

  /** Expose the underlying ioredis instance for BullMQ and pipeline usage. */
  getClient(): Redis {
    return this.client;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: RedisClient | null = null;

export function getRedisClient(): RedisClient {
  if (!_instance) {
    _instance = new RedisClient();
  }
  return _instance;
}
