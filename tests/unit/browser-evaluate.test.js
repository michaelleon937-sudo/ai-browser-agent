// tests/unit/browser-evaluate.test.js
// Validates the page-context evaluation strategy used by browser.evaluate.
// (Playwright page.evaluate is mocked at the strategy level — no Chromium required.)

import { describe, it, expect } from 'vitest';

/**
 * Mirrors the in-page function body in browser/index.js evaluate().
 * Playwright delivers `source` into the page; this is what runs there.
 */
function pageContextEval(source, pageGlobals = {}) {
  const trimmed = String(source).trim();
  if (!trimmed) {
    throw new Error('browser_evaluate requires a non-empty string `fn` (JS expression or function source to run in the page)');
  }
  // Bind page globals (document, etc.) for the duration of eval.
  const keys = Object.keys(pageGlobals);
  const values = keys.map((k) => pageGlobals[k]);
  try {
    // eslint-disable-next-line no-new-func
    const expr = new Function(...keys, `return (${trimmed})`);
    const value = expr(...values);
    return typeof value === 'function' ? value() : value;
  } catch (e1) {
    try {
      // eslint-disable-next-line no-new-func
      const body = new Function(...keys, trimmed);
      return body(...values);
    } catch (e2) {
      throw new Error('browser_evaluate failed in page context: ' + (e1 && e1.message ? e1.message : String(e1)));
    }
  }
}

describe('browser_evaluate page-context strategy', () => {
  const document = {
    body: { textContent: 'Phone: (914) 999-4700' },
    querySelectorAll: (sel) => {
      if (sel === 'a') return [{ textContent: 'DETAILS', href: 'https://example.com/office' }];
      return [];
    },
  };

  it('D: expression using document runs without Node "document is not defined"', () => {
    const result = pageContextEval(
      `Array.from(document.querySelectorAll('a')).map(a => ({ text: a.textContent, href: a.href }))`,
      { document },
    );
    expect(result).toEqual([{ text: 'DETAILS', href: 'https://example.com/office' }]);
  });

  it('D: IIFE form used in production also works', () => {
    const result = pageContextEval(
      `(() => { const text = document.body.textContent; const match = text.match(/\\([0-9]{3}\\)/); return match ? match[0] : null; })()`,
      { document },
    );
    expect(result).toBe('(914)');
  });

  it('D: empty fn throws a clear actionable error', () => {
    expect(() => pageContextEval('')).toThrow(/non-empty string/);
  });

  it('D: invalid source throws page-context error, not Node ReferenceError', () => {
    expect(() => pageContextEval('this is not valid js {{{', { document })).toThrow(
      /browser_evaluate failed in page context/,
    );
  });
});
