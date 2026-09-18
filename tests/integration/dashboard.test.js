// tests/integration/dashboard.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';

let startDashboard, stopDashboard, migrate, closeDb, config;
let baseUrl;

beforeAll(async () => {
  process.env.DATABASE_PATH = path.join(os.tmpdir(), `dashboard-${Date.now()}.db`);
  process.env.WEBSITE_SAMPLES_DIR = path.join(os.tmpdir(), `dashboard-samples-${Date.now()}`);
  process.env.DASHBOARD_PORT = '0';
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

describe('website samples API (integration)', () => {
  it('GET /api/website-samples returns a list (empty or otherwise)', async () => {
    const res = await fetch(`${baseUrl}/api/website-samples`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it('GET /api/website-samples/:id returns 404 for an unknown but well-formed id', async () => {
    const res = await fetch(`${baseUrl}/api/website-samples/website_doesnotexist1`);
    expect(res.status).toBe(404);
  });

  it('GET /api/website-samples/:id returns 400 for a malformed id', async () => {
    const res = await fetch(`${baseUrl}/api/website-samples/${encodeURIComponent('../../etc/passwd')}`);
    expect(res.status).toBe(400);
  });

  it('GET /website-samples/:id/ rejects a path-traversal id with 400', async () => {
    const res = await fetch(`${baseUrl}/website-samples/${encodeURIComponent('website_../../etc/passwd')}/index.html`);
    expect([400, 404]).toContain(res.status);
  });

  it('GET /website-samples/:id/:file rejects a disallowed filename with 404', async () => {
    const res = await fetch(`${baseUrl}/website-samples/website_wellformed123/../../../etc/passwd`);
    expect([400, 404]).toContain(res.status);
  });

  it('serves a real generated sample end to end', async () => {
    const { generateWebsite } = await import('../../integrations/website-gen.js');
    const { websiteSamples } = await import('../../database/index.js');
    const result = generateWebsite({ prospectName: 'Dashboard Preview Test' });
    websiteSamples.create({
      id: result.sampleId,
      prospectName: 'Dashboard Preview Test',
      status: result.status,
      files: result.files,
      previewPath: result.previewPath,
    });

    const apiRes = await fetch(`${baseUrl}/api/website-samples/${result.sampleId}`);
    expect(apiRes.status).toBe(200);
    const body = await apiRes.json();
    expect(body.id).toBe(result.sampleId);

    const previewRes = await fetch(`${baseUrl}/website-samples/${result.sampleId}/`);
    expect(previewRes.status).toBe(200);
    const html = await previewRes.text();
    expect(html).toContain('SPECULATIVE SAMPLE');
  });
});

describe('dashboard home page UI', () => {
  it('GET / HTML includes task creation controls and Phase 4 sections', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Create New Task');
    expect(html).toContain('id="name"');
    expect(html).toContain('id="goal"');
    expect(html).toContain('id="schedule"');
    expect(html).toContain('id="timezone"');
    expect(html).toContain('Active Tasks');
    expect(html).toContain('Opportunities');
    expect(html).toContain('Pending Approvals');
    expect(html).toContain('Samples (Phase 4)');
    expect(html).toContain('Proposals (Phase 4)');
    expect(html).toContain('createTask');
    expect(html).toContain('runTask');
  });
});

describe('Phase 4 samples and proposals API (integration)', () => {
  it('GET /api/samples and GET /api/proposals return arrays', async () => {
    const samplesRes = await fetch(`${baseUrl}/api/samples`);
    expect(samplesRes.status).toBe(200);
    expect(Array.isArray(await samplesRes.json())).toBe(true);

    const proposalsRes = await fetch(`${baseUrl}/api/proposals`);
    expect(proposalsRes.status).toBe(200);
    expect(Array.isArray(await proposalsRes.json())).toBe(true);
  });

  it('GET /api/samples/:id and /api/proposals/:id return 404 for unknown ids', async () => {
    expect((await fetch(`${baseUrl}/api/samples/does-not-exist`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/proposals/does-not-exist`)).status).toBe(404);
  });
});

describe('Create Task form submission path', () => {
  it('rendered home page script is syntactically valid (no broken string newlines)', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    const match = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(match).toBeTruthy();
    const script = match[1];
    expect(script).not.toMatch(/finalGoal \+= "\n/);
    expect(script).toContain('async function createTask');
    expect(script).toContain('window.location.reload');
    expect(script).toContain('targetLocation');
    expect(() => new Function(script)).not.toThrow();
  });

  it('POST /api/tasks creates a task using the same fields the UI sends', async () => {
    const payload = {
      name: 'UI-shaped create test',
      goal: 'Find leads\n\nTarget Location: Dar es Salaam\nMaximum Results: 5',
      cronExpression: undefined,
      timezone: 'Africa/Dar_es_Salaam',
      metadata: {
        targetLocation: 'Dar es Salaam',
        maximumResults: 5,
        taskType: 'real_estate',
      },
    };
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.name).toBe('UI-shaped create test');
    expect(body.goal).toContain('Target Location: Dar es Salaam');
  });

  it('POST /api/tasks returns 400 when name or goal missing (error path)', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '', goal: '' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });
});
