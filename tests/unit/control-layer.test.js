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
  process.env.DATA_DIR = path.dirname(tmpDbPath);
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
      expect(ALLOWED_TOOLS.has(t)).toBe(false);
      expect(isForbiddenTool(t)).toBe(true);
    }
  });

  it('deny-by-default for unknown tools', () => {
    const r = evaluatePolicy({ toolName: 'not.a.real.tool', args: {} });
    expect(r.allow).toBe(false);
  });
});

describe('auth', () => {
  it('rejects missing bearer token', async () => {
    const res = await request('GET', '/api/control/v1/tools');
    expect(res.status).toBe(401);
  });

  it('rejects invalid bearer token', async () => {
    const res = await request('GET', '/api/control/v1/tools', {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  it('accepts valid CONTROL_TOKEN', async () => {
    const res = await request('GET', '/api/control/v1/tools', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json.tools) || Array.isArray(res.json)).toBe(true);
  });
});

describe('idempotency', () => {
  it('requires Idempotency-Key for mutating tools', async () => {
    const res = await request('POST', '/api/control/v1/tools/agent.create_task', {
      headers: { Authorization: `Bearer ${token}` },
      body: { goal: 'test' },
    });
    expect([400, 422]).toContain(res.status);
  });
});

describe('audit sanitize', () => {
  it('redacts authorization-like fields', () => {
    const out = sanitizeForAudit({ authorization: 'Bearer secret', token: 'abc', ok: true });
    expect(JSON.stringify(out)).not.toMatch(/Bearer secret/);
    expect(out.ok).toBe(true);
  });
});

describe('repair sessions', () => {
  it('creates and tracks retry attempts', () => {
    const session = getOrCreateSession({ taskId: 't1', runId: 'r1' });
    expect(session).toBeTruthy();
    const next = incrementAttempt(session.id || session.sessionId || session);
    expect(canRetry(typeof next === 'object' ? next : session)).toBeDefined();
  });
});
