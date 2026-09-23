// tests/unit/control-dashboard-routes.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let migrate, closeDb, tasks, runs;
let tmpDbPath;

beforeAll(async () => {
  tmpDbPath = path.join(os.tmpdir(), `control-dash-${Date.now()}.db`);
  process.env.DATABASE_PATH = tmpDbPath;
  process.env.NODE_ENV = 'test';
  process.env.AI_PROVIDER = 'stub';
  process.env.CONTROL_TOKEN = 'dash-token';
  ({ migrate, closeDb, tasks, runs } = await import('../../database/index.js'));
  migrate();
});

afterAll(() => {
  try { closeDb(); } catch {}
  try { fs.unlinkSync(tmpDbPath); } catch {}
});

describe('GET completeness helpers', () => {
  it('tasks.get and runs.get work for new routes', () => {
    const task = tasks.create({ name: 'one', goal: 'goal' });
    expect(tasks.get(task.id).name).toBe('one');
    const run = runs.start({ taskId: task.id });
    expect(runs.get(run.id).task_id).toBe(task.id);
  });
});
