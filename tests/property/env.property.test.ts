/**
 * Properties 2 and 19: Source enable-state parsing and semver validation.
 *
 * Property 2: A source is enabled ONLY when its env var is exactly "true"
 *             (case-insensitive); any other value (including absent) disables it.
 * Property 19: FEATURE_VERSION and PIPELINE_VERSION must conform to semver
 *              (MAJOR.MINOR.PATCH) — any other format is rejected at startup.
 *
 * **Validates: Requirements 1.7, 1.8, 33.4**
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { semverSchema, sourceEnabledSchema } from '../../src/config/env.schema.js';

// ---------------------------------------------------------------------------
// Property 2: Source enable-state parsing (sourceEnabledSchema)
// ---------------------------------------------------------------------------

// Feature: sentinel-pulse
describe('Property 2: source enable-state parsing (env.schema)', () => {
  it('only "true" (case-insensitive) enables a source', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 20 }),
        (rawValue) => {
          const result = sourceEnabledSchema.parse(rawValue);
          const expected = rawValue.toLowerCase() === 'true';
          return result === expected;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('undefined enables value to false', () => {
    expect(sourceEnabledSchema.parse(undefined)).toBe(false);
  });

  it('"true" → true', () => {
    expect(sourceEnabledSchema.parse('true')).toBe(true);
  });

  it('"TRUE" → true', () => {
    expect(sourceEnabledSchema.parse('TRUE')).toBe(true);
  });

  it('"True" → true', () => {
    expect(sourceEnabledSchema.parse('True')).toBe(true);
  });

  it('"false" → false', () => {
    expect(sourceEnabledSchema.parse('false')).toBe(false);
  });

  it('"1" → false', () => {
    expect(sourceEnabledSchema.parse('1')).toBe(false);
  });

  it('"yes" → false', () => {
    expect(sourceEnabledSchema.parse('yes')).toBe(false);
  });

  it('empty string → false', () => {
    expect(sourceEnabledSchema.parse('')).toBe(false);
  });

  it('whitespace-only string → false', () => {
    expect(sourceEnabledSchema.parse('   ')).toBe(false);
  });

  it('returns boolean (never undefined)', () => {
    fc.assert(
      fc.property(
        fc.option(fc.string({ minLength: 0, maxLength: 20 }), { nil: undefined }),
        (rawValue) => {
          const result = sourceEnabledSchema.parse(rawValue);
          return typeof result === 'boolean';
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 19: Semver validation (semverSchema)
// ---------------------------------------------------------------------------

// Feature: sentinel-pulse
describe('Property 19: semver validation', () => {
  it('valid MAJOR.MINOR.PATCH strings pass validation', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 99 }),
        fc.integer({ min: 0, max: 99 }),
        fc.integer({ min: 0, max: 99 }),
        (major, minor, patch) => {
          const version = `${major}.${minor}.${patch}`;
          const result = semverSchema.safeParse(version);
          return result.success === true;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('strings with non-numeric parts fail validation', () => {
    const invalidVersions = [
      'v1.0.0',
      '1.0',
      '1',
      '1.0.0-alpha',
      '1.0.0.0',
      '1.0.a',
      '',
      'latest',
      '1.0.0-rc.1',
    ];
    for (const v of invalidVersions) {
      const result = semverSchema.safeParse(v);
      expect(result.success, `Expected "${v}" to fail semver validation`).toBe(false);
    }
  });

  it('parsed semver string is returned unchanged on success', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 999 }),
        fc.integer({ min: 0, max: 999 }),
        fc.integer({ min: 0, max: 999 }),
        (major, minor, patch) => {
          const version = `${major}.${minor}.${patch}`;
          const result = semverSchema.safeParse(version);
          if (!result.success) return false;
          return result.data === version;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('semver with leading zeros still passes (e.g., 1.0.0)', () => {
    expect(semverSchema.safeParse('1.0.0').success).toBe(true);
    expect(semverSchema.safeParse('0.0.0').success).toBe(true);
    expect(semverSchema.safeParse('10.20.30').success).toBe(true);
  });

  it('v-prefixed version strings are rejected', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 99 }),
        fc.integer({ min: 0, max: 99 }),
        fc.integer({ min: 0, max: 99 }),
        (major, minor, patch) => {
          const vPrefixed = `v${major}.${minor}.${patch}`;
          const result = semverSchema.safeParse(vPrefixed);
          return result.success === false;
        },
      ),
      { numRuns: 100 },
    );
  });
});
