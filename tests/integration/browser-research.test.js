import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let browser;
const validateUrl = (url) => new URL(url).hostname === 'example.com'
  ? { allow: true, status: 200 }
  : { allow: false, status: 403, reason: 'host not allowlisted' };

beforeAll(async () => {
  process.env.BROWSER_USER_DATA_DIR = path.join(os.tmpdir(), 'browser-research-' + Date.now());
  browser = (await import('../../browser/index.js')).default;
});
afterAll(async () => {
  if (browser) await browser.close();
});

describe('isolated browser research', () => {
  it('captures public page text, status and a SHA-256 evidence hash', async () => {
    const evidence = await browser.research('https://example.com/', { validateUrl });
    expect(evidence.finalUrl).toContain('example.com');
    expect(evidence.title.trim().length).toBeGreaterThan(0);
    expect(evidence.text.trim().length).toBeGreaterThan(0);
    expect(evidence.statusCode).toBe(200);
    expect(evidence.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.capturedAt).toBeTruthy();
  });

  it('keeps concurrent research requests in separate browser contexts', async () => {
    const [alpha, beta] = await Promise.all([
      browser.research('https://example.com/?tenant=alpha', { validateUrl }),
      browser.research('https://example.com/?tenant=beta', { validateUrl }),
    ]);
    expect(alpha.finalUrl).toContain('tenant=alpha');
    expect(beta.finalUrl).toContain('tenant=beta');
  });
});
