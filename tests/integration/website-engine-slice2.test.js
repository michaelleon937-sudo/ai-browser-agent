import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createWebsiteSlice2Spec, renderWebsiteSlice2Html, evaluateWebsiteRuntimeQa } from '../../website-engine/slice2.js';
import browser from '../../browser/index.js';

let server;
let port;

beforeAll(async () => {
  const html = renderWebsiteSlice2Html(createWebsiteSlice2Spec({ title: 'A6 Browser E2E' }));
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

afterAll(async () => {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

describe('A6 Website Engine Slice 2 browser E2E', () => {
  it('renders the generated site in real Chromium and executes the Three.js runtime', async () => {
    const info = await browser.navigate(`http://127.0.0.1:${port}/`);
    expect(info.url).toContain(`127.0.0.1:${port}`);
    await browser.waitForText('Premium components', { timeoutMs: 10000 });
    await browser.waitFor('body', { timeoutMs: 10000 });

    let runtime;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      runtime = await browser.evaluate(`return ({ready: window.__A6_READY__, three: !!window.__A6_THREE__, gltf: !!window.__A6_GLTF_LOADER__, error: window.__A6_RUNTIME_ERROR__ || null, width: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, missingAlt: [...document.images].filter(i => !i.alt).length, missingLabels: [...document.querySelectorAll('input,select,textarea')].filter(e => !e.labels?.length).length, threeReady: document.body.dataset.threeReady === 'true'});`);
      if (runtime.ready) break;
      await browser.waitMs(1000);
    }

    expect(runtime.ready, runtime.error || 'A6 runtime did not become ready within 30 seconds').toBe(true);
    expect(runtime.three, runtime.error || 'Three.js runtime did not initialize').toBe(true);
    expect(runtime.gltf, runtime.error || 'GLTFLoader did not initialize').toBe(true);
    expect(runtime.error).toBeNull();
    expect(runtime.width).toBeLessThanOrEqual(runtime.clientWidth + 1);
    const qa = evaluateWebsiteRuntimeQa({ overflow: runtime.width > runtime.clientWidth + 1, missingAlt: runtime.missingAlt, missingLabels: runtime.missingLabels, contrastPass: true, motionPass: true, threeDPass: runtime.threeReady, lcpMs: 2000, cls: 0.05 });
    expect(qa.passed).toBe(true);
  }, 60000);
});
