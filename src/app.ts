/**
 * Fastify application factory for SentinelPulse.
 *
 * Responsibilities:
 *  1. Register plugins — @fastify/cors, @fastify/rate-limit (Req 25.6, Req 30.5)
 *  2. Attach API key preHandler for all routes (Req 25.5)
 *  3. Configure AJV-backed schema validation with structured 400 responses (Req 25.7, Req 30.2)
 *  4. Register health / ready / metrics endpoints (Req 29.3)
 *  5. Register all /api/v1/* route groups (stubs for phases 31+)
 *  6. Wire a global error handler with a consistent response envelope
 *
 * Requirements: Req 25.5, Req 25.6, Req 25.7, Req 29.3, Req 30.2
 */

import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyReply,
  type FastifyError,
} from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';

import { apiKeyAuthHook } from './security/ApiKeyAuth.js';
import { metricsRegistry } from './observability/metrics.js';
import { registerAlphaForgeRoutes } from './api/alphaforge/index.js';
import { registerMlRoutes } from './api/ml/index.js';
import { registerAdminRoutes } from './api/admin/index.js';
import { registerNewsRoutes } from './api/news/index.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Consistent error response envelope used by the global error handler and
 * explicit error replies throughout the codebase.
 *
 *   { success: false, error: "<message>", meta: { timestamp: "<ISO8601>" } }
 */
function errorEnvelope(message: string): {
  success: false;
  error: string;
  meta: { timestamp: string };
} {
  return {
    success: false,
    error: message,
    meta: { timestamp: new Date().toISOString() },
  };
}

// ---------------------------------------------------------------------------
// DB + Redis probe helpers for /ready (Req 29.3)
// ---------------------------------------------------------------------------

/**
 * Returns true when a PostgreSQL round-trip completes within `timeoutMs`.
 * Uses a raw import so the prisma singleton is not required at module-load time.
 */
async function probePostgres(timeoutMs: number): Promise<boolean> {
  try {
    const { prisma } = await import('./db/prisma.js');
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('postgres timeout')), timeoutMs),
      ),
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns true when a Redis PING round-trip completes within `timeoutMs`.
 */
async function probeRedis(timeoutMs: number): Promise<boolean> {
  try {
    const ioredisModule = await import('ioredis');
    // ioredis ships a CJS default; handle both ESM-interop shapes
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const IORedis = (ioredisModule as any).default ?? ioredisModule;
    const redisUrl = process.env['REDIS_URL'];
    if (!redisUrl) return false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const redis: any = new IORedis(redisUrl, {
      lazyConnect: true,
      connectTimeout: timeoutMs,
      maxRetriesPerRequest: 0,
    });
    try {
      await Promise.race([
        redis.ping() as Promise<string>,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('redis timeout')), timeoutMs),
        ),
      ]);
      return true;
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      redis.disconnect();
    }
  } catch {
    return false;
  }
}

/**
 * Returns true when at least one Tier-1 source base URL responds with
 * any HTTP status within `timeoutMs`.  Requires only that the network
 * connection can be established — not that the feed is parseable.
 */
async function probeAtLeastOneTier1Source(timeoutMs: number): Promise<boolean> {
  const tier1EnvVars = [
    'NEWS_SOURCE_REUTERS_BASE_URL',
    'NEWS_SOURCE_MONEYCONTROL_BASE_URL',
    'NEWS_SOURCE_ECONOMICTIMES_BASE_URL',
  ];

  const urls = tier1EnvVars
    .map((key) => process.env[key])
    .filter((v): v is string => Boolean(v));

  if (urls.length === 0) return false;

  const { default: axios } = await import('axios');

  const probes = urls.map(async (url) => {
    try {
      await axios.head(url, {
        timeout: timeoutMs,
        validateStatus: () => true, // any HTTP status is fine
      });
      return true;
    } catch {
      return false;
    }
  });

  const results = await Promise.allSettled(probes);
  return results.some(
    (r) => r.status === 'fulfilled' && r.value === true,
  );
}

// ---------------------------------------------------------------------------
// buildApp — async factory
// ---------------------------------------------------------------------------

/**
 * Creates and fully configures the Fastify application instance.
 *
 * Call `await app.ready()` after this to finish plugin initialisation,
 * then `await app.listen({ port })` to accept connections.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const isDev = process.env['NODE_ENV'] !== 'production';

  const app = Fastify({
    logger: {
      level: process.env['LOG_LEVEL'] ?? 'info',
      transport: isDev ? { target: 'pino-pretty' } : undefined,
    },
    // AJV instance configuration — enable all formats and coerce types (Req 25.7, Req 30.2)
    ajv: {
      customOptions: {
        removeAdditional: false,
        coerceTypes: true,
        allErrors: true,           // collect ALL validation errors, not just the first
        useDefaults: true,
      },
    },
    // Generate a unique request ID for correlation (Req 29.2)
    genReqId: () => crypto.randomUUID(),
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Plugins
  // ─────────────────────────────────────────────────────────────────────────

  // CORS — open by default; tighten via ALLOWED_ORIGINS in production
  await app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // Rate limiting — default 300 RPM per API key (Req 25.6, Req 30.5)
  // The keyGenerator uses the validated api_key_id attached by apiKeyAuthHook,
  // falling back to the remote IP for unauthenticated public paths.
  await app.register(rateLimit, {
    max: parseInt(process.env['API_RATE_LIMIT_RPM'] ?? '300', 10),
    timeWindow: '1 minute',
    // Expose a Retry-After header in seconds (Req 25.6)
    addHeadersOnExceeding: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
    },
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
    },
    keyGenerator(request: FastifyRequest) {
      // Use the validated key identifier when present
      return (request as FastifyRequest & { api_key_id?: string }).api_key_id
        ?? request.ip;
    },
    errorResponseBuilder(_request: FastifyRequest, context) {
      // Retry-After is automatically added by @fastify/rate-limit.
      // Return our standard error envelope.
      return {
        success: false,
        error: `Rate limit exceeded. Please retry after ${context.after}.`,
        meta: {
          timestamp: new Date().toISOString(),
          retryAfter: context.after,
        },
      };
    },
    // Public health paths are excluded from rate limiting (Req 29.3)
    allowList(request: FastifyRequest) {
      const path = request.url.split('?')[0] ?? '';
      return path === '/health' || path === '/ready' || path === '/metrics';
    },
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Correlation ID propagation (Req 29.2)
  // ─────────────────────────────────────────────────────────────────────────

  app.addHook('onRequest', async (request) => {
    // Carry the Fastify-generated request ID through all log entries
    request.log = request.log.child({ correlationId: request.id });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // API key authentication — applied to all routes (Req 25.5)
  // ─────────────────────────────────────────────────────────────────────────

  app.addHook('preHandler', apiKeyAuthHook);

  // ─────────────────────────────────────────────────────────────────────────
  // 404 handler — consistent envelope for unknown routes
  // ─────────────────────────────────────────────────────────────────────────

  app.setNotFoundHandler((_request: FastifyRequest, reply: FastifyReply) => {
    return reply.status(404).send(errorEnvelope('Not found'));
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Schema validation error handler (Req 25.7, Req 30.2)
  //
  // Fastify calls setErrorHandler for all errors including AJV validation
  // failures (FST_ERR_VALIDATION).  We intercept those and return a 400
  // with a structured body listing each failing field — without echoing
  // raw input values (Req 30.2).
  // ─────────────────────────────────────────────────────────────────────────

  app.setErrorHandler(
    (error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
      const statusCode = error.statusCode ?? 500;

      // AJV schema validation errors → structured 400 (Req 25.7, Req 30.2)
      if (statusCode === 400 && error.validation) {
        const fields = error.validation.map((v) => ({
          field: Array.isArray(v.instancePath)
            ? v.instancePath.join('.')
            : (v.instancePath ?? '').replace(/^\//, '').replace(/\//g, '.'),
          message: v.message ?? 'invalid value',
        }));

        return reply.status(400).send({
          success: false,
          error: 'Validation failed',
          fields,
          meta: { timestamp: new Date().toISOString() },
        });
      }

      // 404 — handled by setNotFoundHandler above; this path is a fallback
      if (statusCode === 404) {
        return reply.status(404).send(errorEnvelope('Not found'));
      }

      // 429 — handled by @fastify/rate-limit's errorResponseBuilder above
      if (statusCode === 429) {
        return reply.status(429).send(error);
      }

      // 401 — propagate as-is (returned by apiKeyAuthHook)
      if (statusCode === 401) {
        return reply.status(401).send(error);
      }

      // 5xx — log and return generic message (never echo internals)
      _request.log.error({ err: error }, 'Unhandled error');
      return reply.status(statusCode >= 400 ? statusCode : 500).send(
        errorEnvelope('Internal server error'),
      );
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Health endpoints — public, no auth, no rate limit (Req 29.3)
  // ─────────────────────────────────────────────────────────────────────────

  /** GET /health — liveness probe: always 200 if the process is running */
  app.get('/health', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            timestamp: { type: 'string' },
          },
        },
      },
    },
  }, async () => ({
    status: 'alive',
    timestamp: new Date().toISOString(),
  }));

  /**
   * GET /ready — readiness probe (Req 29.3)
   *
   * Probes PostgreSQL, Redis, and at least one Tier-1 source within 2 s.
   * Returns 200 when all are reachable; 503 with per-check detail otherwise.
   */
  app.get('/ready', async (_request: FastifyRequest, reply: FastifyReply) => {
    const PROBE_TIMEOUT_MS = 2_000;

    const [postgres, redis, tier1] = await Promise.all([
      probePostgres(PROBE_TIMEOUT_MS),
      probeRedis(PROBE_TIMEOUT_MS),
      probeAtLeastOneTier1Source(PROBE_TIMEOUT_MS),
    ]);

    const checks = {
      postgres: postgres ? 'ok' : 'unreachable',
      redis: redis ? 'ok' : 'unreachable',
      tier1_sources: tier1 ? 'ok' : 'unreachable',
    };

    const allHealthy = postgres && redis && tier1;

    return reply.status(allHealthy ? 200 : 503).send(
      allHealthy
        ? { status: 'ready', checks, timestamp: new Date().toISOString() }
        : { status: 'not_ready', checks, timestamp: new Date().toISOString() },
    );
  });

  /**
   * GET /metrics — Prometheus text/plain scrape endpoint (Req 29.1, Req 29.3)
   */
  app.get('/metrics', async (_request: FastifyRequest, reply: FastifyReply) => {
    const payload = await metricsRegistry.metrics();
    return reply
      .header('Content-Type', metricsRegistry.contentType)
      .send(payload);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // API route stubs — full implementations in Phase 31
  // Each route group returns a minimal success envelope so the endpoints
  // exist and are accessible (for integration health checks) while their
  // handlers are built in subsequent phases.
  // ─────────────────────────────────────────────────────────────────────────

  // ── /api/v1/news/* (Req 25.1) — real implementations (Phase 31) ──────────
  await registerNewsRoutes(app);

  // ── /api/v1/alphaforge/* (Req 25.2) ──────────────────────────────────────
  await registerAlphaForgeRoutes(app);

  // ── /api/v1/ml/* (Req 25.3) ──────────────────────────────────────────────
  await registerMlRoutes(app);

  // ── /api/v1/admin/* (Req 25.4) ────────────────────────────────────────────
  await registerAdminRoutes(app);

  app.post('/api/v1/admin/backfill', async (_request, reply) =>
    reply.status(202).send({
      success: true,
      data: { jobId: null },
      meta: { timestamp: new Date().toISOString() },
    }),
  );

  app.post('/api/v1/admin/backfill/:jobId/pause', async () => ({
    success: true,
    meta: { timestamp: new Date().toISOString() },
  }));

  app.post('/api/v1/admin/backfill/:jobId/resume', async () => ({
    success: true,
    meta: { timestamp: new Date().toISOString() },
  }));

  app.post('/api/v1/admin/backfill/:jobId/cancel', async () => ({
    success: true,
    meta: { timestamp: new Date().toISOString() },
  }));

  return app;
}

export default buildApp;
