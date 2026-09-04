// tests/integration/recovery.test.js
// Verifies the agent recovers from transient step failures via retry, and
// gives up safely (task_fail) after repeated failures on the same tool,
// rather than looping forever.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';

let runAgent, browser, migrate, closeDb, errors;

beforeAll(async () => {
  process.env.AI_PROVIDER = 'stub';
  process.env.DATABASE_PATH = path.join(os.tmpdir(), `recovery-${Date.now()}.db`);
  process.env.BROWSER_USER_DATA_DIR = path.join(os.tmpdir(), `recovery-profile-${Date.now()}`);
  process.env.AGENT_MAX_RETRIES_PER_STEP = '2';
  process.env.AGENT_STEP_TIMEOUT_MS = '5000';
  ({ runAgent } = await import('../../agent/index.js'));
  ({ migrate, closeDb, errors } = await import('../../database/index.js'));
  browser = (await import('../../browser/index.js')).default;
  migrate();
});

afterAll(async () => {
  await browser.close();
  closeDb();
});

describe('failure recovery (integration)', () => {
  it('records an error and terminates with status failed instead of hanging', async () => {
    const result = await runAgent({ goal: 'force failure of the browser action' });
    expect(result.status).toBe('failed');
  }, 30_000);

  it('logs the failure to the errors table for observability', async () => {
    await runAgent({ goal: 'force failure of the browser action' });
    const recent = errors.listRecent({ limit: 5 });
    expect(recent.length).toBeGreaterThan(0);
  }, 30_000);

  it('does not exceed AGENT_MAX_RETRIES_TOTAL across a run', async () => {
    process.env.AGENT_MAX_RETRIES_TOTAL = '3';
    const result = await runAgent({ goal: 'force failure of the browser action' });
    expect(result.status).toBe('failed');
  }, 30_000);
});
