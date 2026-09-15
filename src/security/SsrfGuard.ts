export class SsrfBlockedError extends Error {
  constructor(public readonly domain: string) {
    super(`SSRF guard: outbound URL to domain '${domain}' is not in the allowlist`);
    this.name = 'SsrfBlockedError';
  }
}

// Load allowed domains from ALLOWED_SOURCE_DOMAINS env var (comma-separated)
// Falls back to empty set if not configured (blocks ALL outbound requests)
const getAllowedDomains = (): Set<string> => {
  const raw = process.env['ALLOWED_SOURCE_DOMAINS'] ?? '';
  return new Set(
    raw.split(',')
       .map(d => d.trim().toLowerCase())
       .filter(d => d.length > 0)
  );
};

// The live allowlist — loaded once at startup but can be reloaded via reloadAllowlist()
let ALLOWED_DOMAINS: Set<string> = getAllowedDomains();

/**
 * Validates that the URL's hostname is in the configured SSRF allowlist.
 *
 * Throws SsrfBlockedError when the domain is not allowed.
 * Logs WARN with the rejected domain.
 *
 * Requirements: Req 30.4
 */
export function validateOutboundUrl(url: string): void {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    throw new SsrfBlockedError('(invalid URL)');
  }

  if (!ALLOWED_DOMAINS.has(hostname)) {
    console.warn(`[SsrfGuard] Blocked outbound request to domain: ${hostname}`);
    throw new SsrfBlockedError(hostname);
  }
}

/** Reloads the allowlist from ALLOWED_SOURCE_DOMAINS (useful in tests). */
export function reloadAllowlist(): void {
  ALLOWED_DOMAINS = getAllowedDomains();
}

/** Returns a copy of the current allowlist (for health checks / admin API). */
export function getAllowlist(): string[] {
  return [...ALLOWED_DOMAINS];
}
