import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../browser/index.js', () => ({
  default: {
    research: vi.fn(),
    getPageInfo: vi.fn(),
    navigate: vi.fn(),
    snapshot: vi.fn(),
    screenshot: vi.fn(),
    click: vi.fn(),
    type: vi.fn(),
  },
}));

import browser from '../../browser/index.js';
import { browserTools } from '../../control/tools/browser.js';

describe('browser.extract URL research', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('CONTROL_BROWSER_ALLOWLIST', 'example.com');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('uses an isolated browser context and returns verifiable evidence', async () => {
    browser.research.mockResolvedValue({
      finalUrl: 'https://example.com/',
      title: 'Example Domain',
      description: 'Example description',
      text: 'Example Domain evidence',
      links: [],
      statusCode: 200,
      capturedAt: '2026-11-04T00:00:00.000Z',
      contentSha256: 'a'.repeat(64),
    });
    const result = await browserTools['browser.extract']({ url: 'https://example.com/', timeoutMs: 12000 });
    expect(browser.research).toHaveBeenCalledWith('https://example.com/', expect.objectContaining({
      waitUntil: 'domcontentloaded',
      timeoutMs: 12000,
      validateUrl: expect.any(Function),
    }));
    expect(result).toMatchObject({
      ok: true,
      finalUrl: 'https://example.com/',
      text: 'Example Domain evidence',
      contentSha256: 'a'.repeat(64),
      statusCode: 200,
    });
    const validator = browser.research.mock.calls[0][1].validateUrl;
    expect(validator('https://example.com/').allow).toBe(true);
    expect(validator('https://evil.test/').allow).toBe(false);
  });

  it('rejects a non-allowlisted URL before opening a browser context', async () => {
    await expect(browserTools['browser.extract']({ url: 'https://evil.test/' })).rejects.toMatchObject({ status: 403 });
    expect(browser.research).not.toHaveBeenCalled();
  });
});
