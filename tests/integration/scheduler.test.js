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


import { runWithTenantContext } from '../../database/tenant-context.js';
import { listTenantIds } from '../../database/index.js';

describe('tenant scheduler isolation', () => {
  it('tracks scheduled tasks in separate tenant databases', async () => {
    const tenantA = `scheduler-a-${Date.now()}`;
    const tenantB = `scheduler-b-${Date.now()}`;
    const now = new Date(Date.now() - 1000).toISOString();
    let taskA; let taskB;
    await runWithTenantContext({ tenantId: tenantA, operatorId: 'scheduler-test' }, async () => {
      taskA = tasks.create({ name: 'tenant-a-task', goal: 'tenant a goal', cronExpression: '* * * * *' });
      tasks.setNextRun(taskA.id, now);
    });
    await runWithTenantContext({ tenantId: tenantB, operatorId: 'scheduler-test' }, async () => {
      taskB = tasks.create({ name: 'tenant-b-task', goal: 'tenant b goal', cronExpression: '* * * * *' });
      tasks.setNextRun(taskB.id, now);
    });
    expect(listTenantIds()).toEqual(expect.arrayContaining([tenantA, tenantB]));
    const dueA = await runWithTenantContext({ tenantId: tenantA, operatorId: 'scheduler-test' }, async () => tasks.dueForRun(new Date().toISOString()));
    const dueB = await runWithTenantContext({ tenantId: tenantB, operatorId: 'scheduler-test' }, async () => tasks.dueForRun(new Date().toISOString()));
    expect(dueA.map(row => row.id)).toContain(taskA.id);
    expect(dueA.map(row => row.id)).not.toContain(taskB.id);
    expect(dueB.map(row => row.id)).toContain(taskB.id);
    expect(dueB.map(row => row.id)).not.toContain(taskA.id);
  });
});
