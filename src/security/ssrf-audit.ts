/**
 * SSRF Guard Integration Audit
 * Requirements: Req 30.4
 *
 * This file documents which modules call `validateOutboundUrl()` from
 * `src/security/SsrfGuard.ts` before making any outbound HTTP request.
 *
 * All three outbound HTTP call-sites have been audited and confirmed to
 * include SSRF guard integration:
 *
 * 1. `src/adapters/base/NewsSourceAdapter.ts`
 *    - Loads SsrfGuard lazily via `loadSsrfGuard()` (dynamic import).
 *    - `fetchLatest()` calls `guardUrl(this.baseUrl)` before delegating to
 *      `fetchLatestImpl()` (line ~320).
 *    - `fetchHistorical()` calls `guardUrl(this.baseUrl)` before delegating
 *      to `fetchHistoricalImpl()` (line ~335).
 *    - All six concrete adapters inherit this protection automatically.
 *
 * 2. `src/integrations/data-service/DataServiceClient.ts`
 *    - Imports `validateOutboundUrl` directly from `../../security/SsrfGuard.js`.
 *    - `getOHLCV()`, `getMarketContextSnapshot()`, `resolveInstrument()`,
 *      `getInstrumentById()`, `getRegimeSignals()`, and `healthCheck()` all
 *      call `validateOutboundUrl(this.baseUrl)` before the Axios HTTP call.
 *
 * 3. `src/integrations/scrapling/ScraplingClient.ts`
 *    - Imports `validateOutboundUrl` directly from `../../security/SsrfGuard.js`.
 *    - `scrape()` calls `validateOutboundUrl(this.baseUrl)` before the Axios
 *      POST to the Scrapling sidecar.
 *
 * SsrfGuard implementation (`src/security/SsrfGuard.ts`):
 *   - Reads the allowlist from `ALLOWED_SOURCE_DOMAINS` (comma-separated).
 *   - Throws `SsrfBlockedError` for any domain not in the allowlist.
 *   - An empty / absent `ALLOWED_SOURCE_DOMAINS` blocks ALL outbound requests.
 *
 * Audit result: PASS — all three outbound HTTP call-sites are protected.
 */

export const SSRF_AUDIT_VERSION = '1.0.0' as const;
export const AUDIT_DATE = '2025-01-15' as const;

/**
 * Files confirmed to have SSRF guard integration.
 * Validated: Req 30.4
 */
export const SSRF_PROTECTED_FILES = [
  'src/adapters/base/NewsSourceAdapter.ts',
  'src/integrations/data-service/DataServiceClient.ts',
  'src/integrations/scrapling/ScraplingClient.ts',
] as const;
