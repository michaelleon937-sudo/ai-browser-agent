// tests/integration/browser-actions.test.js
// Exercises browser/index.js directly against a real headless Chromium instance.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';

let browser;

beforeAll(async () => {
  process.env.BROWSER_USER_DATA_DIR = path.join(os.tmpdir(), `browser-actions-${Date.now()}`);
  browser = (await import('../../browser/index.js')).default;
});

afterAll(async () => {
  await browser.close();
});

describe('browser primitives (integration)', () => {
  it('navigates and reports page info', async () => {
    const info = await browser.navigate('https://example.com');
    expect(info.url).toContain('example.com');
    expect(info.title.length).toBeGreaterThan(0);
  }, 30_000);

  it('takes an accessibility snapshot with element refs', async () => {
    await browser.navigate('https://example.com');
    const snap = await browser.snapshot({});
    expect(Array.isArray(snap.elements)).toBe(true);
  }, 30_000);

  it('reads visible text from the page', async () => {
    await browser.navigate('https://example.com');
    const info = await browser.getPageInfo();
    expect(info.visibleText.toLowerCase()).toContain('example domain');
  }, 30_000);

  it('opens and closes a new tab', async () => {
    await browser.newTab('https://example.com');
    const { tabs } = await browser.tabs();
    expect(tabs.length).toBeGreaterThanOrEqual(1);
    await browser.closeTab();
  }, 30_000);

  it('waits for text to appear on the page', async () => {
    await browser.navigate('https://example.com');
    await expect(browser.waitForText('Example Domain', { timeoutMs: 5000 })).resolves.toEqual({ ok: true });
  }, 15_000);
});
