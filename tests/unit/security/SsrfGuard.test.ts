/**
 * Security unit tests — SsrfGuard, timeout, input validation.
 * Requirements: Req 30.2, 30.4, 30.6
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { validateOutboundUrl, reloadAllowlist, SsrfBlockedError } from '../../../src/security/SsrfGuard.js';

describe('SsrfGuard (Req 30.4)', () => {
  beforeEach(() => {
    process.env['ALLOWED_SOURCE_DOMAINS'] = 'feeds.reuters.com,moneycontrol.com';
    reloadAllowlist();
  });

  afterEach(() => {
    delete process.env['ALLOWED_SOURCE_DOMAINS'];
    reloadAllowlist();
  });

  it('allows URLs with domains on the allowlist', () => {
    expect(() => validateOutboundUrl('https://feeds.reuters.com/news')).not.toThrow();
    expect(() => validateOutboundUrl('https://moneycontrol.com/news')).not.toThrow();
  });

  it('throws SsrfBlockedError for domains not on the allowlist', () => {
    expect(() => validateOutboundUrl('https://evil.example.com/steal')).toThrow(SsrfBlockedError);
  });

  it('throws SsrfBlockedError for invalid URLs', () => {
    expect(() => validateOutboundUrl('not-a-url')).toThrow(SsrfBlockedError);
  });

  it('blocks all requests when ALLOWED_SOURCE_DOMAINS is empty', () => {
    process.env['ALLOWED_SOURCE_DOMAINS'] = '';
    reloadAllowlist();
    expect(() => validateOutboundUrl('https://feeds.reuters.com/news')).toThrow(SsrfBlockedError);
  });

  it('SsrfBlockedError includes the blocked domain', () => {
    try {
      validateOutboundUrl('https://attacker.com/steal');
    } catch (err) {
      expect(err).toBeInstanceOf(SsrfBlockedError);
      expect((err as SsrfBlockedError).domain).toBe('attacker.com');
    }
  });
});
