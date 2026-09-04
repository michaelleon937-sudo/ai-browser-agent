// tests/integration/prod-boot.test.js
// Guards against regressions in the production boot path (agent/main.js
// composition), without actually calling process.exit or attaching real
// OS signal handlers repeatedly across the test run.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';

let ensureDirs, config, migrate, closeDb, startDashboard, stopDashboard;
let browser;

beforeAll(async () => {
  process.env.DATA_DIR = path.join(os.tmpdir(), `prod-boot-${Date.now()}`);
  process.env.DATABASE_PATH = path.join(process.env.DATA_DIR, 'agent.db');
  process.env.PORT = '8093';
  process.env.AI_PROVIDER = 'stub';

  ({ ensureDirs, config } = await import('../../config/index.js'));
  ({ migrate, closeDb } = await import('../../database/index.js'));
  ({ startDashboard, stopDashboard } = await import('../../monitoring/dashboard.js'));
  browser = (await import('../../browser/index.js')).default;
});

afterAll(async () => {
  stopDashboard();
  await browser.close();
  closeDb();
});

describe('production boot sequence', () => {
  it('ensureDirs() creates the data/browser-profile/screenshot directories', async () => {
    const fs = await import('node:fs');
    ensureDirs();
    expect(fs.existsSync(config.browser.userDataDir)).toBe(true);
    expect(fs.existsSync(config.browser.screenshotDir)).toBe(true);
  });

  it('migrate() is idempotent and can run multiple times without error', () => {
    expect(() => { migrate(); migrate(); }).not.toThrow();
  });

  it('the dashboard boots and responds to /healthz', async () => {
    await startDashboard();
    const res = await fetch(`http://127.0.0.1:${config.dashboard.port}/healthz`);
    expect(res.status).toBe(200);
  });
});
