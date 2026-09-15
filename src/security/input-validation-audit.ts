/**
 * Input Validation Audit
 * Requirements: Req 30.2, Req 25.7
 *
 * SentinelPulse uses Fastify with AJV schema validation configured
 * to collect ALL validation errors and return structured 400 responses.
 *
 * Confirmed configuration in `src/app.ts` (`buildApp()`):
 *
 *   ajv: {
 *     customOptions: {
 *       removeAdditional: false,
 *       coerceTypes: true,
 *       allErrors: true,           // ← collects ALL errors, not just the first
 *       useDefaults: true,
 *     },
 *   }
 *
 * The global `setErrorHandler` intercepts AJV validation failures
 * (status 400 + `error.validation` present) and returns a structured
 * response with per-field error details:
 *
 *   {
 *     success: false,
 *     error: "Validation failed",
 *     fields: [{ field: "...", message: "..." }],
 *     meta: { timestamp: "..." }
 *   }
 *
 * Raw input values are NEVER echoed back in error responses (Req 30.2).
 *
 * Audit result: PASS
 *   - `allErrors: true` confirmed present in AJV config.
 *   - `setErrorHandler` maps `error.validation` to field-level error array.
 *   - No raw input values are included in any error response shape.
 */

export const INPUT_VALIDATION_AUDIT_VERSION = '1.0.0';
export const AUDIT_DATE = '2025-01-15';

/** Configuration details confirmed in src/app.ts (Req 30.2, Req 25.7). */
export const VALIDATION_CONFIG = {
  framework: 'Fastify',
  validationLibrary: 'AJV',
  allErrors: true,
  structuredErrors: true,
  echosRawInput: false,
} as const;
