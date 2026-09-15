/**
 * API key authentication middleware for Fastify.
 *
 * Validates `Authorization: Bearer {api_key}` on all inbound requests.
 * - Skips auth for /health, /ready, and /metrics endpoints.
 * - Validates the key against the SENTINEL_API_KEY environment variable.
 *   (In a multi-key setup the key list can be extended to an in-memory set.)
 * - On missing or invalid key → HTTP 401 with a structured error envelope.
 * - Attaches `api_key_id` to the Fastify request for downstream rate limiting.
 *
 * Requirements: Req 25.5
 */

import type { FastifyRequest, FastifyReply } from 'fastify';

// ---------------------------------------------------------------------------
// Public paths — auth is intentionally skipped for these (Req 29.3)
// ---------------------------------------------------------------------------

const PUBLIC_PATHS = new Set(['/health', '/ready', '/metrics']);

// ---------------------------------------------------------------------------
// Type augmentation — add api_key_id to Fastify request
// ---------------------------------------------------------------------------

declare module 'fastify' {
  interface FastifyRequest {
    /** Identifier of the validated API key (used downstream for rate limiting). */
    api_key_id?: string;
  }
}

// ---------------------------------------------------------------------------
// Validation helper
// ---------------------------------------------------------------------------

/**
 * Returns the validated API key identifier when the supplied key is
 * authorised, or `null` when it is not.
 *
 * Currently validates against `SENTINEL_API_KEY` only.  To support multiple
 * keys, extend this function to check an in-memory `Set<string>` populated
 * from a comma-separated `SENTINEL_API_KEYS` env var or a secrets store.
 */
function resolveApiKey(key: string): string | null {
  const master = process.env['SENTINEL_API_KEY'];
  if (master && key === master) {
    // Use a stable identifier so the rate-limiter can key off it without
    // echoing the raw secret in logs or metrics.
    return 'default';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fastify preHandler hook
// ---------------------------------------------------------------------------

/**
 * Fastify `preHandler` hook that enforces API key authentication.
 *
 * Usage:
 *   app.addHook('preHandler', apiKeyAuthHook);
 */
export async function apiKeyAuthHook(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // Skip auth for public health / metrics endpoints
  const pathname = request.url.split('?')[0] ?? '';
  if (PUBLIC_PATHS.has(pathname)) {
    return;
  }

  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.status(401).send({
      success: false,
      error: 'Unauthorized',
      message: 'Invalid or missing API key',
      meta: { timestamp: new Date().toISOString() },
    });
  }

  const rawKey = authHeader.slice(7).trim();
  const keyId = resolveApiKey(rawKey);

  if (!keyId) {
    return reply.status(401).send({
      success: false,
      error: 'Unauthorized',
      message: 'Invalid or missing API key',
      meta: { timestamp: new Date().toISOString() },
    });
  }

  // Attach key identifier so rate-limiter can use it as the keyGenerator source
  request.api_key_id = keyId;
}
