// tests/unit/database.test.js
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tasks, runs, steps, migrate, closeDb;
let tmpDbPath;

beforeAll(async () => {
  tmpDbPath = path.join(os.tmpdir(), `agent-test-${Date.now()}.db`);
  process.env.DATABASE_PATH = tmpDbPath;
  ({ tasks, runs, steps, migrate, closeDb } = await import('../../database/index.js'));
  migrate();
});

afterAll(() => {
  closeDb();
  fs.rmSync(tmpDbPath, { force: true });
  fs.rmSync(tmpDbPath + '-wal', { force: true });
  fs.rmSync(tmpDbPath + '-shm', { force: true });
});

describe('database/tasks', () => {
  it('creates and retrieves a task', () => {
    const t = tasks.create({ name: 'Test task', goal: 'Do the thing' });
    expect(t.id).toBeTruthy();
    expect(t.status).toBe('idle');
    expect(tasks.get(t.id).name).toBe('Test task');
  });

  it('updates status and timestamps', () => {
    const t = tasks.create({ name: 'Status task', goal: 'Go' });
    tasks.setStatus(t.id, 'running');
    expect(tasks.get(t.id).status).toBe('running');
    tasks.setStatus(t.id, 'success', { lastStatus: 'success' });
    expect(tasks.get(t.id).last_status).toBe('success');
  });

  it('returns tasks due for run only when next_run_at has passed', () => {
    const t = tasks.create({ name: 'Cron task', goal: 'Go', cronExpression: '* * * * *' });
    tasks.setNextRun(t.id, new Date(Date.now() - 1000).toISOString());
    const due = tasks.dueForRun(new Date().toISOString());
    expect(due.map((r) => r.id)).toContain(t.id);
  });
});

describe('database/runs + steps', () => {
  it('tracks a run lifecycle with steps', () => {
    const t = tasks.create({ name: 'Run task', goal: 'Go' });
    const run = runs.start({ taskId: t.id });
    expect(run.status).toBe('running');

    const step = steps.create({ runId: run.id, seq: 1, action: { tool: 'browser_navigate', args: { url: 'https://example.com' } } });
    steps.start(step.id);
    steps.finish(step.id, { status: 'success', observation: { url: 'https://example.com' } });

    const stepRows = steps.listForRun(run.id);
    expect(stepRows).toHaveLength(1);
    expect(stepRows[0].status).toBe('success');

    runs.finish(run.id, { status: 'success', result: { result: 'done' } });
    expect(runs.get(run.id).status).toBe('success');
  });
});
