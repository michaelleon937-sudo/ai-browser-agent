// tests/unit/stale-target.test.js
// Regression: production burned 8 retries on Playwright locator timeouts and
// missing data-agent-ref values after navigation. Stale targets must be
// classified separately and must not consume the global retry budget.
import { describe, it, expect } from 'vitest';
import { isStaleTargetError, classifyError } from '../../agent/index.js';

describe('isStaleTargetError', () => {
  it('detects ensureTargetPresent missing-ref messages', () => {
    expect(isStaleTargetError(
      'Stale or missing ref "e0". No element has data-agent-ref="e0" on the current page. Call browser_snapshot to obtain current element refs, then use one of those refs. Do not reuse refs from a previous page.',
    )).toBe(true);
  });

  it('detects empty target', () => {
    expect(isStaleTargetError('Stale or missing target: empty target')).toBe(true);
  });

  it('detects Playwright locator timeout shapes seen in production', () => {
    const samples = [
      'locator.click: Timeout 15000ms exceeded.\nCall log:\n  - waiting for locator(\'[data-agent-ref="e0"]\')',
      'Timeout 30000ms exceeded',
      'waiting for locator("#sb_form_q")',
      'waiting for selector("input[name=q]")',
      'page.click: Timeout 15000ms exceeded',
      'Locator.fill: Timeout 15000ms exceeded',
      'element(s) not found',
      'strict mode violation: locator resolved to 2 elements',
    ];
    for (const msg of samples) {
      expect(isStaleTargetError(msg), msg).toBe(true);
    }
  });

  it('does not treat network/DNS failures as stale targets', () => {
    expect(isStaleTargetError('net::ERR_NAME_NOT_RESOLVED')).toBe(false);
    expect(isStaleTargetError('getaddrinfo ENOTFOUND example.invalid')).toBe(false);
    expect(isStaleTargetError('AI provider failed: rate limited')).toBe(false);
  });
});

describe('classifyError with stale targets', () => {
  it('returns stale_target for locator timeouts', () => {
    expect(classifyError('locator.click: Timeout 15000ms exceeded')).toBe('stale_target');
  });

  it('returns permanent for DNS failures', () => {
    expect(classifyError('net::ERR_NAME_NOT_RESOLVED at https://bad.example')).toBe('permanent');
  });

  it('returns transient for generic errors', () => {
    expect(classifyError('something went wrong')).toBe('transient');
  });
});
