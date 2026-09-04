// tests/integration/final-e2e.test.js
// End-to-end smoke test: boots the dashboard + scheduler + DB together (as
// agent/main.js would), creates a scheduled task via the HTTP API, waits for
// the scheduler to run it, and confirms a successful run was recorded.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';

let migrate, closeDb, tasks, runs;
let startDashboard, stopDashboard, config;
let startScheduler, stopScheduler;
let browser;
let baseUrl;

beforeAll(async () => {
  process.env.AI_PROVIDER = 'stub';
  process.env.HUMAN_APPROVAL_REQUIRED = 'false';
  process.env.DATABASE_PATH = path.join(os.tmpdir(), `final-e2e-${Date.now()}.db`);
  process.env.BROWSER_USER_DATA_DIR = path.join(os.tmpdir(), `final-e2e-profile-${Date.now()}`);
  process.env.SCHEDULER_TICK_MS = '300';
  process.env.PORT = '8092';

  ({ migrate, closeDb, tasks, runs } = await import('../../database/index.js'));
  ({ startDashboard, stopDashboard } = await import('../../monitoring/dashboard.js'));
  ({ startScheduler, stopScheduler } = await import('../../scheduler/index.js'));
  ({ config } = await import('../../config/index.js'));
  browser = (await import('../../browser/index.js')).default;

  migrate();
  await startDashboard();
  startScheduler();
  baseUrl = `http://127.0.0.1:${config.dashboard.port}`;
});

afterAll(async () => {
  stopScheduler();
  stopDashboard();
  await browser.close();
  closeDb();
});

describe('final end-to-end smoke test', () => {
  it('creates a task via the API, lets the scheduler run it, and records success', async () => {
    const created = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'e2e-task',
        goal: 'Go to example.com and check the status code',
        cronExpression: '* * * * *',
      }),
    }).then((r) => r.json());

    tasks.setNextRun(created.id, new Date(Date.now() - 1000).toISOString());

    // Give the scheduler a few ticks to notice and run it.
    let finished = null;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const taskRuns = runs.listForTask(created.id);
      finished = taskRuns.find((r) => r.status === 'success' || r.status === 'failed');
      if (finished) break;
    }

    expect(finished).toBeTruthy();
    expect(finished.status).toBe('success');
  }, 30_000);

  it('exposes the run and its steps via the API', async () => {
    const list = await fetch(`${baseUrl}/api/runs?limit=5`).then((r) => r.json());
    expect(list.length).toBeGreaterThan(0);
    const stepsRes = await fetch(`${baseUrl}/api/runs/${list[0].id}/steps`).then((r) => r.json());
    expect(Array.isArray(stepsRes)).toBe(true);
  });
});
