// tests/unit/database.test.js
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tasks, runs, steps, migrate, closeDb, websiteSamples, prospects;
let tmpDbPath;

beforeAll(async () => {
  tmpDbPath = path.join(os.tmpdir(), `agent-test-${Date.now()}.db`);
  process.env.DATABASE_PATH = tmpDbPath;
  ({ tasks, runs, steps, migrate, closeDb, websiteSamples, prospects } = await import('../../database/index.js'));
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

describe('database/websiteSamples', () => {
  it('creates and retrieves a website sample record', () => {
    const t = tasks.create({ name: 'Website task', goal: 'Generate a sample' });
    const run = runs.start({ taskId: t.id });

    const created = websiteSamples.create({
      id: 'website_test123',
      taskId: t.id,
      runId: run.id,
      prospectName: 'Example Property Tanzania',
      status: 'SPECULATIVE_SAMPLE',
      businessType: 'Real Estate Agency',
      location: 'Dar es Salaam',
      websiteGoal: 'Generate inquiries',
      style: 'modern',
      files: ['index.html', 'styles.css', 'script.js'],
      previewPath: '/website-samples/website_test123/',
    });

    expect(created.id).toBe('website_test123');
    expect(created.status).toBe('SPECULATIVE_SAMPLE');
    expect(JSON.parse(created.files_json)).toEqual(['index.html', 'styles.css', 'script.js']);

    const fetched = websiteSamples.get('website_test123');
    expect(fetched.prospect_name).toBe('Example Property Tanzania');
    expect(fetched.task_id).toBe(t.id);
    expect(fetched.run_id).toBe(run.id);
  });

  it('lists website samples most-recent first', () => {
    websiteSamples.create({ id: 'website_list_a', prospectName: 'A', files: [] });
    websiteSamples.create({ id: 'website_list_b', prospectName: 'B', files: [] });
    const list = websiteSamples.list({ limit: 10 });
    expect(list.map((r) => r.id)).toContain('website_list_a');
    expect(list.map((r) => r.id)).toContain('website_list_b');
  });

  it('returns undefined for an unknown sample id', () => {
    expect(websiteSamples.get('website_does_not_exist')).toBeUndefined();
  });
});

describe('database/prospects', () => {
  it('creates a prospect with default status NEW', () => {
    const created = prospects.create({
      businessName: 'Example Realty Co',
      websiteUrl: 'https://example-realty.com',
      location: 'Dar es Salaam',
      contactEmail: 'info@example-realty.com',
      socialProfiles: [{ platform: 'facebook', url: 'https://facebook.com/example' }],
      serviceGaps: ['No HTTPS'],
      sourceUrl: 'https://example-realty.com',
    });
    expect(created.status).toBe('NEW');
    expect(created.business_name).toBe('Example Realty Co');
    expect(JSON.parse(created.social_profiles_json)).toEqual([{ platform: 'facebook', url: 'https://facebook.com/example' }]);
    expect(JSON.parse(created.service_gaps_json)).toEqual(['No HTTPS']);
  });

  it('retrieves a prospect by id', () => {
    const created = prospects.create({ businessName: 'Retrieve Me Realty' });
    const fetched = prospects.get(created.id);
    expect(fetched.business_name).toBe('Retrieve Me Realty');
  });

  it('lists prospects, most-recent first, optionally filtered by status', () => {
    prospects.create({ businessName: 'List A' });
    const b = prospects.create({ businessName: 'List B' });
    prospects.updateStatus(b.id, 'CONTACTED');

    const all = prospects.list({ limit: 10 });
    expect(all.map((p) => p.business_name)).toContain('List A');

    const contacted = prospects.list({ status: 'CONTACTED', limit: 10 });
    expect(contacted.every((p) => p.status === 'CONTACTED')).toBe(true);
    expect(contacted.map((p) => p.id)).toContain(b.id);
  });

  it('updates a prospect status', () => {
    const created = prospects.create({ businessName: 'Status Change Realty' });
    const updated = prospects.updateStatus(created.id, 'ANALYZED');
    expect(updated.status).toBe('ANALYZED');
  });

  it('returns undefined for an unknown prospect id', () => {
    expect(prospects.get('does-not-exist')).toBeUndefined();
  });
});
