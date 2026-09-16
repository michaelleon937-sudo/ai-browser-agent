// tests/unit/agent-loop-guards.test.js
//
// Regression tests for the production incidents:
//   - "Total retries exceeded (8)" caused by permanent DNS failures being
//     retried identically to transient ones, and each local retry attempt
//     incrementing the same global budget used for the terminal check.
//   - "Max steps exceeded (40)" caused by no protection against the AI
//     issuing the exact same successful-but-non-progressing action
//     repeatedly.
import { describe, it, expect } from 'vitest';
import { classifyError, detectStuckLoop, actionSignature } from '../../agent/index.js';

describe('agent/index.js — classifyError', () => {
  it('classifies DNS resolution failures as permanent', () => {
    expect(classifyError('page.goto: net::ERR_NAME_NOT_RESOLVED at https://www.estate.com.tz/')).toBe('permanent');
  });

  it('classifies ENOTFOUND as permanent', () => {
    expect(classifyError('getaddrinfo ENOTFOUND does-not-exist.invalid')).toBe('permanent');
  });

  it('classifies DNS_PROBE_FINISHED_NXDOMAIN as permanent', () => {
    expect(classifyError('net::DNS_PROBE_FINISHED_NXDOMAIN')).toBe('permanent');
  });

  it('classifies connection refused as permanent', () => {
    expect(classifyError('net::ERR_CONNECTION_REFUSED')).toBe('permanent');
  });

  it('classifies a generic timeout as transient', () => {
    expect(classifyError('Step timed out after 30000 ms')).toBe('transient');
  });

  it('classifies an unrecognized error as transient by default', () => {
    expect(classifyError('Some unexpected application error')).toBe('transient');
  });
});

describe('agent/index.js — actionSignature', () => {
  it('produces the same signature for the same tool+args regardless of key order', () => {
    const a = actionSignature({ tool: 'browser_navigate', args: { url: 'https://x.com', waitUntil: 'load' } });
    const b = actionSignature({ tool: 'browser_navigate', args: { waitUntil: 'load', url: 'https://x.com' } });
    expect(a).toBe(b);
  });

  it('produces different signatures for different args', () => {
    const a = actionSignature({ tool: 'browser_navigate', args: { url: 'https://a.com' } });
    const b = actionSignature({ tool: 'browser_navigate', args: { url: 'https://b.com' } });
    expect(a).not.toBe(b);
  });
});

describe('agent/index.js — detectStuckLoop', () => {
  function stepOf(tool, args, status = 'success') {
    return { tool, action: { tool, args }, status };
  }

  it('flags the exact same non-observational action repeated 2 times in a row (3rd would be the loop)', () => {
    const history = [
      stepOf('browser_navigate', { url: 'https://dead-site.tz' }, 'failed'),
      stepOf('browser_navigate', { url: 'https://dead-site.tz' }, 'failed'),
    ];
    const next = { tool: 'browser_navigate', args: { url: 'https://dead-site.tz' } };
    const result = detectStuckLoop(history, next);
    expect(result).toBeTruthy();
    expect(result.reason).toMatch(/Repeated identical action/);
  });

  it('does NOT flag different URLs tried in sequence — this is legitimate exploration', () => {
    const history = [
      stepOf('browser_navigate', { url: 'https://dead-site-1.tz' }, 'failed'),
      stepOf('browser_navigate', { url: 'https://dead-site-2.tz' }, 'failed'),
    ];
    const next = { tool: 'browser_navigate', args: { url: 'https://dead-site-3.tz' } };
    expect(detectStuckLoop(history, next)).toBeNull();
  });

  it('does NOT flag interleaved different actions even if the same tool recurs', () => {
    const history = [
      stepOf('browser_navigate', { url: 'https://a.com' }, 'success'),
      stepOf('browser_snapshot', {}, 'success'),
      stepOf('browser_navigate', { url: 'https://b.com' }, 'success'),
    ];
    const next = { tool: 'browser_navigate', args: { url: 'https://a.com' } };
    // Not consecutive — a different action happened in between — so this is fine.
    expect(detectStuckLoop(history, next)).toBeNull();
  });

  it('gives observational tools (browser_snapshot etc.) a more generous threshold', () => {
    const history = [
      stepOf('browser_snapshot', {}, 'success'),
      stepOf('browser_snapshot', {}, 'success'),
      stepOf('browser_snapshot', {}, 'success'),
    ];
    const next = { tool: 'browser_snapshot', args: {} };
    // 3 in a row is still fine for an observational tool (threshold is 5).
    expect(detectStuckLoop(history, next)).toBeNull();
  });

  it('still eventually flags an observational tool that never progresses', () => {
    const history = Array.from({ length: 5 }, () => stepOf('browser_snapshot', {}, 'success'));
    const next = { tool: 'browser_snapshot', args: {} };
    expect(detectStuckLoop(history, next)).toBeTruthy();
  });

  it('does not flag the first occurrence of any action', () => {
    expect(detectStuckLoop([], { tool: 'browser_navigate', args: { url: 'https://x.com' } })).toBeNull();
  });
});
