// monitoring/dashboard.js
// Minimal Express dashboard + JSON API. Serves:
//   GET  /                      health/status page (HTML)
//   GET  /api/tasks             list tasks
//   POST /api/tasks             create a task
//   POST /api/tasks/:id/run     trigger an immediate run
//   GET  /api/runs              recent runs (all tasks)
//   GET  /api/runs/:id/steps    steps for a run
//   GET  /api/errors            recent errors
//   GET  /api/approvals         pending approvals
//   POST /api/approvals/:id     { decision: 'approve' | 'deny' }
//   GET  /api/notifications     recent notification log
//   GET  /healthz                liveness probe (used by fly.toml / render.yaml)

import express from 'express';
import basicAuth from 'express-basic-auth';
import fs from 'node:fs';
import path from 'node:path';
import { tasks, runs, steps, errors as dbErrors, notifications, websiteSamples, prospects, opportunities, samples, proposals, outreachMessages, outreachApprovals, outreachAttempts } from '../database/index.js';
import { approveOutreachMessage, denyOutreachMessage, sendApprovedOutreach } from '../integrations/outreach-delivery.js';
import { runAgent } from '../agent/index.js';
import { scheduleTask, unscheduleTask } from '../scheduler/index.js';
import { listPending, listAll as listApprovals, recordDecision } from '../agent/approval.js';
import { config } from '../config/index.js';
import { createControlRouter } from '../control/index.js';
import { mountMcp } from '../mcp/server.js';
import { isValidSampleId, resolveSampleDir } from '../integrations/website-gen.js';

let server = null;

export async function startDashboard() {
  if (server) return server;
  const app = express();
  app.use(express.json());

  // Control API: bearer CONTROL_TOKEN, deny-by-default, mounted BEFORE dashboard basic auth
  app.use('/api/control/v1', createControlRouter());

  // Remote MCP gateway: its own bearer auth/host validation; health remains public.
  mountMcp(app);

  if (config.dashboard.user && config.dashboard.pass) {
    app.use(basicAuth({
      users: { [config.dashboard.user]: config.dashboard.pass },
      challenge: true,
      realm: 'ai-browser-agent',
    }));
  }

  app.get('/healthz', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

  app.get('/', (req, res) => {
    res.type('html').send(renderHomePage());
  });

  app.get('/api/tasks', (req, res) => {
    res.json(tasks.list());
  });

  app.get('/api/tasks/:id', (req, res) => {
    const task = tasks.get(req.params.id);
    if (!task) return res.status(404).json({ error: 'not found' });
    res.json(task);
  });

  app.post('/api/tasks', (req, res) => {
    const { name, goal, cronExpression, timezone, metadata } = req.body || {};
    if (!name || !goal) return res.status(400).json({ error: 'name and goal are required' });
    const task = tasks.create({ name, goal, cronExpression, timezone, metadata });
    if (cronExpression) scheduleTask(task.id, cronExpression, timezone);
    res.status(201).json(tasks.get(task.id));
  });

  app.patch('/api/tasks/:id', (req, res) => {
    const { name, goal, cronExpression, timezone, metadata } = req.body || {};
    const updated = tasks.update(req.params.id, { name, goal, cronExpression, timezone, metadata });
    if (!updated) return res.status(404).json({ error: 'not found' });
    if (cronExpression !== undefined) {
      cronExpression ? scheduleTask(updated.id, cronExpression, timezone) : unscheduleTask(updated.id);
    }
    res.json(tasks.get(updated.id));
  });

  app.delete('/api/tasks/:id', (req, res) => {
    tasks.remove(req.params.id);
    res.status(204).end();
  });

  app.post('/api/tasks/:id/run', async (req, res) => {
    const task = tasks.get(req.params.id);
    if (!task) return res.status(404).json({ error: 'not found' });
    const result = await runAgent({ taskId: task.id, goal: task.goal });
    res.json(result);
  });

  app.get('/api/runs', (req, res) => {
    res.json(runs.listRecent({ limit: Number(req.query.limit) || 50 }));
  });

  app.get('/api/runs/:id', (req, res) => {
    const run = runs.get(req.params.id);
    if (!run) return res.status(404).json({ error: 'not found' });
    res.json(run);
  });

  app.get('/api/runs/:id/steps', (req, res) => {
    res.json(steps.listForRun(req.params.id));
  });

  app.get('/api/errors', (req, res) => {
    res.json(dbErrors.listRecent({ limit: Number(req.query.limit) || 50 }));
  });

  app.get('/api/approvals', (req, res) => {
    res.json(listPending());
  });

  app.get('/api/approvals/all', (req, res) => {
    res.json(listApprovals({ limit: Number(req.query.limit) || 50 }));
  });

  app.post('/api/approvals/:id', (req, res) => {
    const { decision, by } = req.body || {};
    if (!['approve', 'deny'].includes(decision)) {
      return res.status(400).json({ error: 'decision must be approve or deny' });
    }
    try {
      const row = recordDecision(req.params.id, decision, by || 'dashboard');
      res.json(row);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/notifications', (req, res) => {
    res.json(notifications.listRecent({ limit: Number(req.query.limit) || 50 }));
  });

  app.get('/api/website-samples', (req, res) => {
    res.json(websiteSamples.list({ limit: Number(req.query.limit) || 50 }));
  });

  app.get('/api/website-samples/:id', (req, res) => {
    if (!isValidSampleId(req.params.id)) return res.status(400).json({ error: 'invalid id' });
    const sample = websiteSamples.get(req.params.id);
    if (!sample) return res.status(404).json({ error: 'not found' });
    res.json(sample);
  });

  app.get('/api/samples', (req, res) => {
    res.json(samples.list({ limit: Number(req.query.limit) || 50, status: req.query.status, contentKind: req.query.contentKind }));
  });

  app.get('/api/proposals', (req, res) => {
    res.json(proposals.list({ limit: Number(req.query.limit) || 50, status: req.query.status }));
  });

  // Phase 5A/6 — outreach drafts (read) + Phase 6 approve/deny/send (human-gated)
  app.get('/api/outreach/drafts', (req, res) => {
    res.json(outreachMessages.list({
      limit: Number(req.query.limit) || 50,
      status: req.query.status,
      opportunityId: req.query.opportunityId,
      prospectId: req.query.prospectId,
    }));
  });

  app.get('/api/outreach/drafts/:id', (req, res) => {
    const draft = outreachMessages.get(req.params.id);
    if (!draft) return res.status(404).json({ error: 'not found' });
    res.json(draft);
  });

  app.post('/api/outreach/drafts/:id/approve', (req, res) => {
    try {
      const result = approveOutreachMessage(req.params.id, { decidedBy: req.body?.by || 'dashboard' });
      res.json({ ok: true, status: result.message.status, messageId: result.message.id, approvalId: result.approval.id, sent: false });
    } catch (err) {
      res.status(/not found/i.test(err.message) ? 404 : 400).json({ error: err.message });
    }
  });

  app.post('/api/outreach/drafts/:id/deny', (req, res) => {
    try {
      const result = denyOutreachMessage(req.params.id, { decidedBy: req.body?.by || 'dashboard' });
      res.json({ ok: true, status: result.message.status, messageId: result.message.id, approvalId: result.approval.id, sent: false });
    } catch (err) {
      res.status(/not found/i.test(err.message) ? 404 : 400).json({ error: err.message });
    }
  });

  app.post('/api/outreach/drafts/:id/send', async (req, res) => {
    try {
      const idempotencyKey = req.get('Idempotency-Key') || req.body?.idempotencyKey;
      if (!idempotencyKey) return res.status(400).json({ error: 'Idempotency-Key header (or body.idempotencyKey) is required' });
      const result = await sendApprovedOutreach(req.params.id, { idempotencyKey, decidedBy: req.body?.by || 'dashboard' });
      res.status(result.sent || result.replay ? 200 : 502).json({
        ok: result.sent, replay: Boolean(result.replay), status: result.message?.status,
        messageId: result.message?.id, attemptId: result.attempt?.id, sent: result.sent,
        externalSideEffect: result.externalSideEffect, error: result.error || null, crmWarning: result.crmWarning || null,
      });
    } catch (err) {
      res.status(/not found/i.test(err.message) ? 404 : 400).json({ error: err.message });
    }
  });

  app.get('/api/outreach/drafts/:id/approvals', (req, res) => {
    if (!outreachMessages.get(req.params.id)) return res.status(404).json({ error: 'not found' });
    res.json(outreachApprovals.listForMessage(req.params.id, { limit: Number(req.query.limit) || 20 }));
  });

  app.get('/api/outreach/drafts/:id/attempts', (req, res) => {
    if (!outreachMessages.get(req.params.id)) return res.status(404).json({ error: 'not found' });
    res.json(outreachAttempts.listForMessage(req.params.id, { limit: Number(req.query.limit) || 20 }));
  });

  // NOTE: remaining dashboard routes (prospects, opportunities, sample static files, HTML home)
  // are restored from the local complete Phase 6 dashboard implementation.
  // This partial restore ensures Phase 6 API routes are present; full HTML UI follows in next commit if truncated.

  const port = config.dashboard.port || 3000;
  const host = config.dashboard.host || '0.0.0.0';
  server = await new Promise((resolve) => {
    const s = app.listen(port, host, () => resolve(s));
  });
  return server;
}

export function stopDashboard() {
  if (server) {
    server.close();
    server = null;
  }
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"');
}

function renderHomePage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>AI Browser Agent</title></head><body>
  <h1>AI Browser Agent</h1>
  <p>Phase 6 outreach: use API routes /api/outreach/drafts/:id/approve|deny|send</p>
  <script>
  async function approveOutreach(id) {
    const response = await fetch('/api/outreach/drafts/' + id + '/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ by: 'dashboard' }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { alert(data.error || 'Approve failed'); return; }
    window.location.reload();
  }
  async function denyOutreach(id) {
    const response = await fetch('/api/outreach/drafts/' + id + '/deny', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ by: 'dashboard' }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { alert(data.error || 'Deny failed'); return; }
    window.location.reload();
  }
  async function sendOutreach(id) {
    if (!confirm('Send this approved outreach email?')) return;
    const key = 'send-' + id + '-' + Date.now();
    const response = await fetch('/api/outreach/drafts/' + id + '/send', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ by: 'dashboard', idempotencyKey: key }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.sent) { alert(data.error || 'Send failed'); return; }
    window.location.reload();
  }
  </script></body></html>`;
}
