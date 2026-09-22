// browser/index.js
// Thin wrapper around Playwright's Chromium, providing a stable, agent-facing
// API. Keeps a single persistent browser + context + page alive across many
// task runs (so cookies/sessions survive between tasks), with lazy launch and
// safe re-launch if the browser process dies.


import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { config } from '../config/index.js';


let browserInstance = null;
let contextInstance = null;
let pageInstance = null;
let launching = null;


async function ensureLaunched() {
  if (pageInstance && !pageInstance.isClosed()) return pageInstance;
  if (launching) return launching;


  launching = (async () => {
    fs.mkdirSync(config.browser.userDataDir, { recursive: true });


    if (browserInstance) {
      try { await browserInstance.close(); } catch {}
    }


    contextInstance = await chromium.launchPersistentContext(config.browser.userDataDir, {
      headless: config.browser.headless,
      viewport: { width: config.browser.viewportWidth, height: config.browser.viewportHeight },
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
      timeout: config.browser.launchTimeoutMs,
    });
    browserInstance = contextInstance.browser();
    pageInstance = contextInstance.pages()[0] || (await contextInstance.newPage());
    pageInstance.setDefaultTimeout(config.browser.actionTimeoutMs);


    contextInstance.on('close', () => {
      pageInstance = null;
      contextInstance = null;
      browserInstance = null;
    });


    return pageInstance;
  })();


  try {
    return await launching;
  } finally {
    launching = null;
  }
}


function resolveTarget(page, target) {
  if (/^e\d+$/.test(String(target || ''))) {
    return page.locator(`[data-agent-ref="${target}"]`);
  }
  return page.locator(target);
}

/**
 * Fail fast when a data-agent-ref is missing from the current DOM.
 * Refs are only valid after browser_snapshot on the current page; navigation
 * or DOM changes invalidate them. CSS selectors are left to Playwright waits.
 */
async function ensureTargetPresent(page, target) {
  const t = String(target || '');
  if (!t) throw new Error('Stale or missing target: empty target');
  if (/^e\d+$/.test(t)) {
    const count = await page.locator(`[data-agent-ref="${t}"]`).count();
    if (count === 0) {
      throw new Error(
        `Stale or missing ref "${t}". No element has data-agent-ref="${t}" on the current page. ` +
        'Call browser_snapshot to obtain current element refs, then use one of those refs. ' +
        'Do not reuse refs from a previous page.',
      );
    }
  }
}


async function withPage(fn) {
  const page = await ensureLaunched();
  return fn(page);
}


const api = {
  async navigate(url, { waitUntil = 'load', timeoutMs } = {}) {
    return withPage(async (page) => {
      await page.goto(url, { waitUntil, timeout: timeoutMs || config.browser.navigationTimeoutMs });
      return api.getPageInfo();
    });
  },


  async snapshot({ includeBoxes = false } = {}) {
    return withPage(async (page) => {
      const nodes = await page.evaluate((includeBoxes) => {
        const SEL = 'a,button,input,select,textarea,[role],[onclick],[tabindex]';
        const els = Array.from(document.querySelectorAll(SEL)).slice(0, 400);
        return els.map((el, i) => {
          const ref = `e${i}`;
          el.setAttribute('data-agent-ref', ref);
          const rect = includeBoxes ? el.getBoundingClientRect() : null;
          return {
            ref,
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role') || undefined,
            name: (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || '').trim().slice(0, 80),
            type: el.getAttribute('type') || undefined,
            href: el.getAttribute('href') || undefined,
            disabled: el.disabled || undefined,
            box: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } : undefined,
          };
        });
      }, includeBoxes);
      return { url: page.url(), title: await page.title(), elements: nodes };
    });
  },


  async click(target, { description, doubleClick = false, button = 'left' } = {}) {
    return withPage(async (page) => {
      await ensureTargetPresent(page, target);
      const loc = resolveTarget(page, target);
      if (doubleClick) await loc.dblclick({ button });
      else await loc.click({ button });
      return api.getPageInfo();
    });
  },


  async hover(target) {
    return withPage(async (page) => {
      await ensureTargetPresent(page, target);
      await resolveTarget(page, target).hover();
      return { ok: true };
    });
  },


  async type(target, text, { delayMs = 20 } = {}) {
    return withPage(async (page) => {
      await ensureTargetPresent(page, target);
      await resolveTarget(page, target).type(text, { delay: delayMs });
      return { ok: true };
    });
  },


  async fill(target, value) {
    return withPage(async (page) => {
      await ensureTargetPresent(page, target);
      await resolveTarget(page, target).fill(value);
      return { ok: true };
    });
  },


  async selectOption(target, value) {
    return withPage(async (page) => {
      await ensureTargetPresent(page, target);
      await resolveTarget(page, target).selectOption(value);
      return { ok: true };
    });
  },


  async press(key, { target } = {}) {
    return withPage(async (page) => {
      if (target) {
        await ensureTargetPresent(page, target);
        await resolveTarget(page, target).press(key);
      } else {
        await page.keyboard.press(key);
      }
      return { ok: true };
    });
  },


  async uploadFile(target, paths) {
    return withPage(async (page) => {
      await resolveTarget(page, target).setInputFiles(paths);
      return { ok: true };
    });
  },


  async drag(startTarget, endTarget) {
    return withPage(async (page) => {
      const start = resolveTarget(page, startTarget);
      const end = resolveTarget(page, endTarget);
      await start.dragTo(end);
      return { ok: true };
    });
  },


  async evaluate(fnString) {
    return withPage(async (page) => {
      const source = String(fnString || '').trim();
      if (!source) throw new Error('browser_evaluate requires a non-empty string `fn`');

      // Evaluate only in the browser page context. Running the source through
      // Node's Function constructor first breaks browser globals such as
      // document and window.
      const pageExpression = /^return\b/.test(source)
        ? `() => { ${source} }`
        : source;

      return page.evaluate(pageExpression);
    });
  },


  async getText(target) {
    return withPage(async (page) => {
      const text = await resolveTarget(page, target).innerText();
      return { text };
    });
  },


  async getPageInfo() {
    return withPage(async (page) => {
      const visibleText = await page.evaluate(() => (document.body?.innerText || '').slice(0, 8000));
      return { url: page.url(), title: await page.title(), visibleText };
    });
  },


  async screenshot({ fullPage = false } = {}) {
    return withPage(async (page) => {
      const buf = await page.screenshot({ fullPage });
      return { pngBase64: buf.toString('base64') };
    });
  },


  async tabs() {
    if (!contextInstance) return { tabs: [] };
    const pages = contextInstance.pages();
    return { tabs: pages.map((p, i) => ({ index: i, url: p.url() })) };
  },


  async newTab(url) {
    await ensureLaunched();
    const page = await contextInstance.newPage();
    pageInstance = page;
    if (url) await page.goto(url, { waitUntil: 'load', timeout: config.browser.navigationTimeoutMs });
    return api.getPageInfo();
  },


  async closeTab(index) {
    if (!contextInstance) return { ok: false };
    const pages = contextInstance.pages();
    const target = typeof index === 'number' ? pages[index] : pages[pages.length - 1];
    if (target) await target.close();
    pageInstance = contextInstance.pages()[0] || null;
    return { ok: true };
  },


  async waitFor(target, { state = 'visible', timeoutMs } = {}) {
    return withPage(async (page) => {
      if (/^e\d+$/.test(String(target || ''))) {
        await ensureTargetPresent(page, target);
      }
      await resolveTarget(page, target).waitFor({ state, timeout: timeoutMs || config.browser.actionTimeoutMs });
      return { ok: true };
    });
  },


  async waitForText(text, { timeoutMs } = {}) {
    return withPage(async (page) => {
      await page.waitForFunction(
        (t) => document.body && document.body.innerText.includes(t),
        text,
        { timeout: timeoutMs || config.browser.actionTimeoutMs },
      );
      return { ok: true };
    });
  },


  async waitMs(ms) {
    await new Promise((r) => setTimeout(r, ms));
    return { ok: true };
  },


  async close() {
    try { if (contextInstance) await contextInstance.close(); } catch {}
    pageInstance = null;
    contextInstance = null;
    browserInstance = null;
  },
};


export default api;
