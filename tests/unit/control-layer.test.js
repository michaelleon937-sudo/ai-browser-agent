// tests/unit/control-layer.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FORBIDDEN_TOOLS, ALLOWED_TOOLS, evaluatePolicy, isForbiddenTool } from '../../control/policy.js';
import { sanitizeForAudit } from '../../control/audit.js';
import { canRetry, incrementAttempt, getOrCreateSession } from '../../control/repair.js';

let migrate, closeDb, tasks, runs, operatorAuditLog, controlIdempotency;
let createControlRouter;
let tmpDbPath;
let app;
let token;

async function request(method, url, { headers = {}, body } = {}) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

beforeAll(async () => {
  tmpDbPath = path.join(os.tmpdir(), `control-layer-${Date.now()}.db`);
  process.env.DATABASE_PATH = tmpDbPath;
  process.env.NODE_ENV = 'test';
  process.env.AI_PROVIDER = 'stub';
  token = 'test-control-token-phase5b';
  process.env.CONTROL_TOKEN = token;
  process.env.MAX_REPAIR_ATTEMPTS = '3';
  ({ migrate, closeDb, tasks, runs, operatorAuditLog, controlIdempotency } = await import('../../database/index.js'));
  migrate();
  ({ createControlRouter } = await import('../../control/index.js'));
  app = express();
  app.use(express.json());
  app.use('/api/control/v1', createControlRouter());
});

afterAll(() => {
  try { closeDb(); } catch {}
  try { fs.unlinkSync(tmpDbPath); } catch {}
});

describe('policy', () => {
  it('does not register forbidden tools', () => {
    for (const t of FORBIDDEN_TOOLS) {
      expect(ALLOWED_TOOLS.includes(t)).toBe(false);
      expect(isForbiddenTool(t)).toBe(true);
    }
  });
  it('blocks master writes and production deploy', () => {
    expect(evaluatePolicy({ toolName: 'github.modify_file', args: { branch: 'master', approved: true } }).allow).toBe(false);
    expect(evaluatePolicy({ toolName: 'render.deploy', args: { target: 'production', approved: true } }).allow).toBe(false);
  });
  it('requires approval for github.modify_file on repair/*', () => {
    const denied = evaluatePolicy({ toolName: 'github.modify_file', args: { branch: 'repair/abc' } });
    expect(denied.allow).toBe(false);
    const ok = evaluatePolicy({ toolName: 'github.modify_file', args: { branch: 'repair/abc', approved: true } });
    expect(ok.allow).toBe(true);
  });
});

describe('auth', () => {
  it('unauthorized → 401', async () => {
    const res = await request('POST', '/api/control/v1/tools/agent.health_check', { body: {} });
    expect(res.status).toBe(401);
  });
  it('wrong token → 401', async () => {
    const res = await request('POST', '/api/control/v1/tools/agent.health_check', {
      headers: { Authorization: 'Bearer wrong-token' }, body: {},
    });
    expect(res.status).toBe(401);
  });
  it('health check reports database', async () => {
    const res = await request('POST', '/api/control/v1/tools/agent.health_check', {
      headers: { Authorization: `Bearer ${token}` }, body: {},
    });
    expect(res.json.result.database.ok).toBe(true);
  });
  it('authorized works', async () => {
    const res = await request('POST', '/api/control/v1/tools/agent.health_check', {
      headers: { Authorization: `Bearer ${token}` }, body: {},
    });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
  });
});

describe('forbidden and idempotency', () => {
  it('outreach.send → 403', async () => {
    const res = await request('POST', '/api/control/v1/tools/outreach.send', {
      headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': 'x' }, body: {},
    });
    expect(res.status).toBe(403);
  });
  it('mutation without key rejected', async () => {
    const res = await request('POST', '/api/control/v1/tools/agent.create_task', {
      headers: { Authorization: `Bearer ${token}` },
      body: { name: 'A', goal: 'B' },
    });
    expect(res.status).toBe(400);
  });
  it('duplicate key does not create twice', async () => {
    const key = `dup-${Date.now()}`;
    const body = { name: 'Idempotent Task', goal: 'noop' };
    const first = await request('POST', '/api/control/v1/tools/agent.create_task', {
      headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': key }, body,
    });
    expect(first.status).toBe(200);
    const second = await request('POST', '/api/control/v1/tools/agent.create_task', {
      headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': key }, body,
    });
    expect(second.json.replayed).toBe(true);
    expect(second.json.result.task.id).toBe(first.json.result.task.id);
    expect(controlIdempotency.getByKey(key)).toBeTruthy();
  });
});

describe('agent + audit + repair', () => {
  it('create/get/run returns runId and audit has no token', async () => {
    const created = await request('POST', '/api/control/v1/tools/agent.create_task', {
      headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': `ct-${Date.now()}` },
      body: { name: 'Control probe', goal: 'Complete immediately' },
    });
    const taskId = created.json.result.task.id;
    const ran = await request('POST', '/api/control/v1/tools/agent.run_task', {
      headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': `run-${Date.now()}` },
      body: { taskId },
    });
    expect(ran.json.result.runId).toBeTruthy();
    const got = await request('POST', '/api/control/v1/tools/agent.get_task', {
      headers: { Authorization: `Bearer ${token}` }, body: { taskId },
    });
    expect(got.json.result.task.id).toBe(taskId);
    const gr = await request('POST', '/api/control/v1/tools/agent.get_run', {
      headers: { Authorization: `Bearer ${token}` }, body: { runId: ran.json.result.runId },
    });
    expect(gr.json.result.run.id).toBe(ran.json.result.runId);
    const logs = await request('POST', '/api/control/v1/tools/agent.get_logs', {
      headers: { Authorization: `Bearer ${token}` }, body: { runId: ran.json.result.runId },
    });
    expect(logs.json.result).toHaveProperty('steps');
    expect(logs.json.result).toHaveProperty('errors');
    expect(logs.json.result).toHaveProperty('notifications');
    const serialized = JSON.stringify(operatorAuditLog.listRecent({ limit: 20 }));
    expect(serialized).not.toContain(token);
    expect(sanitizeForAudit({ CONTROL_TOKEN: token }).CONTROL_TOKEN).toBe('[REDACTED]');
  });
  it('retry_run on failed run', async () => {
    const task = tasks.create({ name: 'retry-me', goal: 'fail' });
    const failed = runs.start({ taskId: task.id });
    runs.finish(failed.id, { status: 'failed', errorMessage: 'boom' });
    const res = await request('POST', '/api/control/v1/tools/agent.retry_run', {
      headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': `retry-${Date.now()}` },
      body: { runId: failed.id },
    });
    expect(res.status).toBe(200);
    expect(res.json.result.runId).not.toBe(failed.id);
  });
  it('stops after max attempts', () => {
    const session = getOrCreateSession({ taskId: 'task-limit', initialRunId: 'run-0', maxAttempts: 3 });
    incrementAttempt(session.id);
    incrementAttempt(session.id);
    const last = incrementAttempt(session.id);
    expect(last.attempt_count).toBe(3);
    expect(canRetry(last)).toBe(false);
  });
});

describe('github/render HTTP policy', () => {
  it('master modification blocked', async () => {
    const res = await request('POST', '/api/control/v1/tools/github.modify_file', {
      headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': `gh-${Date.now()}` },
      body: { branch: 'master', path: 'x.js', content: 'no', message: 'no', approved: true },
    });
    expect(res.status).toBe(403);
  });
  it('repair branch without approval blocked', async () => {
    const res = await request('POST', '/api/control/v1/tools/github.modify_file', {
      headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': `gh2-${Date.now()}` },
      body: { branch: 'repair/x', path: 'x.js', content: 'no', message: 'no' },
    });
    expect(res.status).toBe(403);
  });
  it('staging deploy without approval blocked', async () => {
    const res = await request('POST', '/api/control/v1/tools/render.deploy', {
      headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': `rd2-${Date.now()}` },
      body: { target: 'staging' },
    });
    expect(res.status).toBe(403);
  });
  it('production deploy blocked', async () => {
    const res = await request('POST', '/api/control/v1/tools/render.deploy', {
      headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': `rd-${Date.now()}` },
      body: { target: 'production', approved: true },
    });
    expect(res.status).toBe(403);
  });
});
