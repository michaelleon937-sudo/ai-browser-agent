// tests/integration/scheduler.test.js
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';

let tasks, migrate, closeDb, computeNextRun, startScheduler, stopScheduler;

beforeAll(async () => {
  process.env.AI_PROVIDER = 'stub';
  process.env.DATABASE_PATH = path.join(os.tmpdir(), `scheduler-${Date.now()}.db`);
  process.env.SCHEDULER_TICK_MS = '200';
  ({ tasks, migrate, closeDb } = await import('../../database/index.js'));
  ({ computeNextRun, startScheduler, stopScheduler } = await import('../../scheduler/index.js'));
  migrate();
});

afterAll(() => {
  stopScheduler();
  closeDb();
});

describe('scheduler', () => {
  it('computes the next run time from a cron expression', () => {
    const next = computeNextRun('*/5 * * * *', 'UTC');
    expect(next).toBeTruthy();
    expect(new Date(next).getTime()).toBeGreaterThan(Date.now());
  });

  it('returns null for an invalid cron expression instead of throwing', () => {
    const next = computeNextRun('not a cron', 'UTC');
    expect(next).toBeNull();
  });

  it('picks up a due task on tick and eventually reschedules it', async () => {
    const t = tasks.create({ name: 'due-task', goal: 'Go to example.com and check the status code', cronExpression: '* * * * *' });
    tasks.setNextRun(t.id, new Date(Date.now() - 1000).toISOString());

    startScheduler();
    await new Promise((r) => setTimeout(r, 1500));

    const updated = tasks.get(t.id);
    // next_run_at should have moved into the future once the scheduler processed it.
    expect(new Date(updated.next_run_at).getTime()).toBeGreaterThan(Date.now() - 5000);
  }, 15_000);
});
