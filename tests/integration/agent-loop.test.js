// tests/integration/agent-loop.test.js
// Exercises the full plan → execute → observe loop against a real headless
// Chromium (via the stub AI provider so no external API calls are made).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';

let runAgent, browser, migrate, closeDb;

beforeAll(async () => {
  process.env.AI_PROVIDER = 'stub';
  process.env.DATABASE_PATH = path.join(os.tmpdir(), `agent-loop-${Date.now()}.db`);
  process.env.BROWSER_USER_DATA_DIR = path.join(os.tmpdir(), `agent-loop-profile-${Date.now()}`);
  process.env.HUMAN_APPROVAL_REQUIRED = 'false';
  ({ runAgent } = await import('../../agent/index.js'));
  ({ migrate, closeDb } = await import('../../database/index.js'));
  browser = (await import('../../browser/index.js')).default;
  migrate();
});

afterAll(async () => {
  await browser.close();
  closeDb();
});

describe('agent loop (integration)', () => {
  it('completes a simple navigation goal end to end', async () => {
    const result = await runAgent({
      goal: 'Go to example.com and check the status code',
    });
    expect(result.status).toBe('success');
    expect(result.runId).toBeTruthy();
  }, 60_000);

  it('fails safely instead of looping forever on a forced failure', async () => {
    const result = await runAgent({
      goal: 'force failure of the browser action',
    });
    expect(['failed']).toContain(result.status);
  }, 60_000);
});
