// control/tools/browser.js
import browser from '../../browser/index.js';
import { checkBrowserHost } from '../policy.js';

function assertAllowlistedUrl(url) {
  if (!url) return;
  const result = checkBrowserHost(url);
  if (!result.allow) {
    const err = new Error(result.reason);
    err.status = result.status;
    throw err;
  }
}

export async function open(args = {}) {
  assertAllowlistedUrl(args.url);
  if (!args.url) {
    const err = new Error('url is required');
    err.status = 400;
    throw err;
  }
  const info = await browser.navigate(args.url, { waitUntil: args.waitUntil });
  return { ok: true, page: { url: info.url, title: info.title } };
}

export async function inspect() {
  const snap = await browser.snapshot({});
  return { ok: true, url: snap.url, title: snap.title, elements: snap.elements };
}

export async function screenshot(args = {}) {
  const shot = await browser.screenshot({ fullPage: !!args.fullPage });
  return { ok: true, pngBase64: shot.pngBase64 };
}

export async function extract() {
  const info = await browser.getPageInfo();
  return { ok: true, url: info.url, title: info.title, text: info.visibleText };
}

export async function click(args = {}) {
  if (!args.approved) {
    const err = new Error('browser.click requires approved=true (human approval)');
    err.status = 403;
    throw err;
  }
  if (!args.target) {
    const err = new Error('target is required');
    err.status = 400;
    throw err;
  }
  const info = await browser.click(args.target);
  return { ok: true, page: { url: info.url, title: info.title } };
}

export async function type(args = {}) {
  if (!args.approved) {
    const err = new Error('browser.type requires approved=true (human approval)');
    err.status = 403;
    throw err;
  }
  if (!args.target || args.text == null) {
    const err = new Error('target and text are required');
    err.status = 400;
    throw err;
  }
  await browser.type(args.target, args.text);
  return { ok: true };
}

export const browserTools = {
  'browser.open': open,
  'browser.inspect': inspect,
  'browser.screenshot': screenshot,
  'browser.extract': extract,
  'browser.click': click,
  'browser.type': type,
};
