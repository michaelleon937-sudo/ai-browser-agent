// tests/integration/dashboard.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';

let startDashboard, stopDashboard, migrate, closeDb, config;
let baseUrl;

beforeAll(async () => {
  process.env.DATABASE_PATH = path.join(os.tmpdir(), `dashboard-${Date.now()}.db`);
  process.env.DASHBOARD_PORT = '0'; // let express-style tests hit a fixed test port instead
  process.env.PORT = '8091';
  process.env.DASHBOARD_USER = '';
  process.env.DASHBOARD_PASS = '';
  ({ migrate, closeDb } = await import('../../database/index.js'));
  ({ startDashboard, stopDashboard } = await import('../../monitoring/dashboard.js'));
  ({ config } = await import('../../config/index.js'));
  migrate();
  await startDashboard();
  baseUrl = `http://127.0.0.1:${config.dashboard.port}`;
});

afterAll(() => {
  stopDashboard();
  closeDb();
});

describe('dashboard HTTP API (integration)', () => {
  it('GET /healthz reports ok', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('POST /api/tasks creates a task and GET /api/tasks lists it', async () => {
    const created = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'via-api', goal: 'Go to example.com' }),
    }).then((r) => r.json());
    expect(created.id).toBeTruthy();

    const list = await fetch(`${baseUrl}/api/tasks`).then((r) => r.json());
    expect(list.some((t) => t.id === created.id)).toBe(true);
  });

  it('returns 404 for an unknown task on PATCH', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/does-not-exist`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(res.status).toBe(404);
  });

  it('rejects an invalid approval decision', async () => {
    const res = await fetch(`${baseUrl}/api/approvals/whatever`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'maybe' }),
    });
    expect(res.status).toBe(400);
  });
});
