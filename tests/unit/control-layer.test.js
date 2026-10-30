// tests/unit/control-layer.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { signClaims } from '../../control/tenant-auth.js';
import { verifyAndConsumeApprovalContract } from '../../control/approval-contract.js';
import { hashRequest } from '../../control/idempotency.js';
import { runWithTenantContext } from '../../control/tenant-context.js';
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
let sharedSecret;
let originalSharedSecret;

async function request(method, url, { headers = {}, body } = {}) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.CONTROL_TOKEN}`, ...headers },
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
  process.env.DATA_DIR = path.dirname(tmpDbPath);
  process.env.NODE_ENV = 'test';
  process.env.CONTROL_TOKEN = 'unit-control-bearer-token';
  process.env.AI_PROVIDER = 'stub';
  originalSharedSecret = process.env.NEXORA_AGENT_SHARED_SECRET;
  sharedSecret = 'unit-test-control-shared-secret-at-least-32-bytes';
  process.env.NEXORA_AGENT_SHARED_SECRET = sharedSecret;
  const now = Math.floor(Date.now() / 1000);
  token = signClaims({ iss: 'nexora-intelligence', aud: 'ai-browser-agent-control', typ: 'tenant', tenantId: 'control-test-tenant', sub: 'control-test-operator', iat: now, exp: now + 300 }, sharedSecret);
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
  if (originalSharedSecret === undefined) delete process.env.NEXORA_AGENT_SHARED_SECRET; else process.env.NEXORA_AGENT_SHARED_SECRET = originalSharedSecret;
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
    const ok = evaluatePolicy({ toolName: 'github.modify_file', args: { branch: 'repair/abc' }, approvalVerified: true });
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
      headers: { 'x-nexora-tenant-token': 'wrong-token' }, body: {},
    });
    expect(res.status).toBe(401);
  });
  it('health check reports database', async () => {
    const res = await request('POST', '/api/control/v1/tools/agent.health_check', {
      headers: { 'x-nexora-tenant-token': token }, body: {},
    });
    expect(res.json.result.database.ok).toBe(true);
  });
  it('authorized works', async () => {
    const res = await request('POST', '/api/control/v1/tools/agent.health_check', {
      headers: { 'x-nexora-tenant-token': token }, body: {},
    });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
  });
});

describe('forbidden and idempotency', () => {
  it('outreach.send → 403', async () => {
    const res = await request('POST', '/api/control/v1/tools/outreach.send', {
      headers: { 'x-nexora-tenant-token': token, 'Idempotency-Key': 'x' }, body: {},
    });
    expect(res.status).toBe(403);
  });
  it('mutation without key rejected', async () => {
    const res = await request('POST', '/api/control/v1/tools/agent.create_task', {
      headers: { 'x-nexora-tenant-token': token },
      body: { name: 'A', goal: 'B' },
    });
    expect(res.status).toBe(400);
  });
  it('duplicate key does not create twice', async () => {
    const key = `dup-${Date.now()}`;
    const body = { name: 'Idempotent Task', goal: 'noop' };
    const first = await request('POST', '/api/control/v1/tools/agent.create_task', {
      headers: { 'x-nexora-tenant-token': token, 'Idempotency-Key': key }, body,
    });
    expect(first.status).toBe(200);
    const second = await request('POST', '/api/control/v1/tools/agent.create_task', {
      headers: { 'x-nexora-tenant-token': token, 'Idempotency-Key': key }, body,
    });
    expect(second.json.replayed).toBe(true);
    expect(second.json.result.task.id).toBe(first.json.result.task.id);
    expect(controlIdempotency.getByKey(key, 'control-operator')).toBeTruthy();
  });
  it('rejects reuse of the same key with a different payload', async () => {
    const key = `mismatch-${Date.now()}`;
    const first = await request('POST', '/api/control/v1/tools/agent.create_task', {
      headers: { 'x-nexora-tenant-token': token, 'Idempotency-Key': key },
      body: { name: 'Original task', goal: 'original' },
    });
    expect(first.status).toBe(200);
    const second = await request('POST', '/api/control/v1/tools/agent.create_task', {
      headers: { 'x-nexora-tenant-token': token, 'Idempotency-Key': key },
      body: { name: 'Changed task', goal: 'different' },
    });
    expect(second.status).toBe(409);
    expect(second.json.code).toBe('idempotency_payload_mismatch');
  });
  it('scopes idempotency keys to operator identity', () => {
    const key = `operator-scope-${Date.now()}`;
    controlIdempotency.create({ idempotencyKey: key, operatorId: 'tenant-a-user-a', toolName: 'agent.create_task', requestHash: 'a'.repeat(64), status: 'completed', result: { ok: true } });
    controlIdempotency.create({ idempotencyKey: key, operatorId: 'tenant-a-user-b', toolName: 'agent.create_task', requestHash: 'b'.repeat(64), status: 'completed', result: { ok: true } });
    expect(controlIdempotency.getByKey(key, 'tenant-a-user-a').request_hash).toBe('a'.repeat(64));
    expect(controlIdempotency.getByKey(key, 'tenant-a-user-b').request_hash).toBe('b'.repeat(64));
  });
});

describe('agent + audit + repair', () => {
  it('create/get/run returns runId and audit has no token', async () => {
    const created = await request('POST', '/api/control/v1/tools/agent.create_task', {
      headers: { 'x-nexora-tenant-token': token, 'Idempotency-Key': `ct-${Date.now()}` },
      body: { name: 'Control probe', goal: 'Complete immediately' },
    });
    const taskId = created.json.result.task.id;
    const ran = await request('POST', '/api/control/v1/tools/agent.run_task', {
      headers: { 'x-nexora-tenant-token': token, 'Idempotency-Key': `run-${Date.now()}` },
      body: { taskId },
    });
    expect(ran.json.result.runId).toBeTruthy();
    const got = await request('POST', '/api/control/v1/tools/agent.get_task', {
      headers: { 'x-nexora-tenant-token': token }, body: { taskId },
    });
    expect(got.json.result.task.id).toBe(taskId);
    const gr = await request('POST', '/api/control/v1/tools/agent.get_run', {
      headers: { 'x-nexora-tenant-token': token }, body: { runId: ran.json.result.runId },
    });
    expect(gr.json.result.run.id).toBe(ran.json.result.runId);
    const logs = await request('POST', '/api/control/v1/tools/agent.get_logs', {
      headers: { 'x-nexora-tenant-token': token }, body: { runId: ran.json.result.runId },
    });
    expect(logs.json.result).toHaveProperty('steps');
    expect(logs.json.result).toHaveProperty('errors');
    expect(logs.json.result).toHaveProperty('notifications');
    const serialized = JSON.stringify(operatorAuditLog.listRecent({ limit: 20 }));
    expect(serialized).not.toContain(token);
    expect(sanitizeForAudit({ CONTROL_TOKEN: token }).CONTROL_TOKEN).toBe('[REDACTED]');
  });
  it('retry_run on failed run', async () => {
    const task = tasks.create({ name: 'retry-me', goal: 'fail', tenantId: 'control-test-tenant', operatorId: 'control-test-operator' });
    const failed = runs.start({ taskId: task.id, tenantId: 'control-test-tenant', operatorId: 'control-test-operator' });
    runs.finish(failed.id, { status: 'failed', errorMessage: 'boom' });
    const res = await request('POST', '/api/control/v1/tools/agent.retry_run', {
      headers: { 'x-nexora-tenant-token': token, 'Idempotency-Key': `retry-${Date.now()}` },
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
      headers: { 'x-nexora-tenant-token': token, 'Idempotency-Key': `gh-${Date.now()}` },
      body: { branch: 'master', path: 'x.js', content: 'no', message: 'no', approved: true },
    });
    expect(res.status).toBe(403);
  });
  it('repair branch without approval blocked', async () => {
    const res = await request('POST', '/api/control/v1/tools/github.modify_file', {
      headers: { 'x-nexora-tenant-token': token, 'Idempotency-Key': `gh2-${Date.now()}` },
      body: { branch: 'repair/x', path: 'x.js', content: 'no', message: 'no' },
    });
    expect(res.status).toBe(403);
  });
  it('staging deploy without approval blocked', async () => {
    const res = await request('POST', '/api/control/v1/tools/render.deploy', {
      headers: { 'x-nexora-tenant-token': token, 'Idempotency-Key': `rd2-${Date.now()}` },
      body: { target: 'staging' },
    });
    expect(res.status).toBe(403);
  });
  it('production deploy blocked', async () => {
    const res = await request('POST', '/api/control/v1/tools/render.deploy', {
      headers: { 'x-nexora-tenant-token': token, 'Idempotency-Key': `rd-${Date.now()}` },
      body: { target: 'production', approved: true },
    });
    expect(res.status).toBe(403);
  });
});


describe('single-use Nexora approval contract', () => {
  it('binds tenant, approver, tool and canonical payload, and rejects replay', async () => {
    const secret = 'unit-test-shared-secret-at-least-32-bytes-long';
    const tenantId = 'tenant-unit-a'; const operatorId = 'member-unit-a';
    const toolName = 'composio.hubspot.create_contact'; const args = { email: 'a@example.com', firstname: 'A' };
    const now = Math.floor(Date.now() / 1000);
    const token = signClaims({ iss: 'nexora-intelligence', aud: 'ai-browser-agent', typ: 'approval', tenantId, sub: operatorId, toolName, oneTime: true, approvalId: 'approval-unit-a', jti: `jti-${Date.now()}-${Math.random()}`, argsHash: hashRequest(toolName, args), iat: now, exp: now + 240 }, secret);
    await runWithTenantContext({ tenantId, operatorId }, async () => {
      expect(() => verifyAndConsumeApprovalContract(token, { tenantId, operatorId, toolName, args, secret })).not.toThrow();
      expect(() => verifyAndConsumeApprovalContract(token, { tenantId, operatorId, toolName, args, secret })).toThrow(/already been consumed/);
      expect(() => verifyAndConsumeApprovalContract(token, { tenantId, operatorId: 'other-user', toolName, args, secret })).toThrow(/does not authorize/);
    });
  });
});


describe('tenant database isolation', () => {
  it('isolates task rows between verified tenant contexts', async () => {
    const { getDb } = await import('../../database/index.js');
    const tenantA = 'db-isolation-a'; const tenantB = 'db-isolation-b';
    await runWithTenantContext({ tenantId: tenantA, operatorId: 'a' }, async () => {
      const now = new Date().toISOString();
      getDb().prepare("INSERT INTO tasks (id,name,goal,status,created_at,updated_at) VALUES ('tenant-private-row','private','private','idle',?,?)").run(now,now);
    });
    await runWithTenantContext({ tenantId: tenantB, operatorId: 'b' }, async () => {
      expect(getDb().prepare("SELECT id FROM tasks WHERE id='tenant-private-row'").get()).toBeUndefined();
    });
  });
});
