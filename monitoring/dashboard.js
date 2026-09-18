// monitoring/dashboard.js
// Minimal Express dashboard + JSON API.

import express from 'express';
import basicAuth from 'express-basic-auth';
import fs from 'node:fs';
import path from 'node:path';
import { tasks, runs, steps, errors as dbErrors, notifications, websiteSamples, prospects, opportunities, samples, proposals } from '../database/index.js';
import { runAgent } from '../agent/index.js';
import { scheduleTask, unscheduleTask } from '../scheduler/index.js';
import { listPending, listAll as listApprovals, recordDecision } from '../agent/approval.js';
import { config } from '../config/index.js';
import { isValidSampleId, resolveSampleDir } from '../integrations/website-gen.js';

let server = null;

export async function startDashboard() {
  if (server) return server;
  const app = express();
  app.use(express.json());

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
    res.status(202).json({ started: true });
    runAgent({ taskId: task.id }).catch((err) => console.error('[dashboard] run failed:', err));
  });

  app.get('/api/runs', (req, res) => {
    res.json(runs.listRecent({ limit: Number(req.query.limit) || 50 }));
  });

  app.get('/api/tasks/:id/runs', (req, res) => {
    res.json(runs.listForTask(req.params.id, { limit: Number(req.query.limit) || 20 }));
  });

  app.get('/api/runs/:id/steps', (req, res) => {
    res.json(steps.listForRun(req.params.id));
  });

  app.get('/api/errors', (req, res) => {
    res.json(dbErrors.listRecent({ limit: Number(req.query.limit) || 50 }));
  });

  app.get('/api/approvals', (req, res) => {
    res.json(req.query.all ? listApprovals() : listPending());
  });

  app.post('/api/approvals/:id', (req, res) => {
    const { decision } = req.body || {};
    if (!['approve', 'deny'].includes(decision)) {
      return res.status(400).json({ error: 'decision must be "approve" or "deny"' });
    }
    res.json(recordDecision(req.params.id, decision, req.body?.by || 'dashboard'));
  });

  app.get('/api/notifications', (req, res) => {
    res.json(notifications.listRecent({ limit: Number(req.query.limit) || 50 }));
  });

  // ── Website Engine (Phase 1) ────────────────────────────────────
  app.get('/api/website-samples', (req, res) => {
    res.json(websiteSamples.list({ limit: Number(req.query.limit) || 50 }));
  });

  app.get('/api/website-samples/:id', (req, res) => {
    if (!isValidSampleId(req.params.id)) return res.status(400).json({ error: 'invalid sample id' });
    const sample = websiteSamples.get(req.params.id);
    if (!sample) return res.status(404).json({ error: 'not found' });
    res.json(sample);
  });

  // ── Prospects (Phase 2) ─────────────────────────────────────────
  app.get('/api/prospects', (req, res) => {
    res.json(prospects.list({ limit: Number(req.query.limit) || 50, status: req.query.status }));
  });

  app.get('/api/prospects/:id', (req, res) => {
    const prospect = prospects.get(req.params.id);
    if (!prospect) return res.status(404).json({ error: 'not found' });
    res.json(prospect);
  });

  // ── Opportunities (Phase 3) ───────────────────────────────────────
  app.get('/api/opportunities', (req, res) => {
    const minScore = req.query.minScore !== undefined ? Number(req.query.minScore) : undefined;
    res.json(opportunities.listOpportunities({
      limit: Number(req.query.limit) || 50,
      status: req.query.status,
      priority: req.query.priority,
      minScore,
    }));
  });

  app.get('/api/opportunities/:id', (req, res) => {
    const opp = opportunities.getOpportunity(req.params.id);
    if (!opp) return res.status(404).json({ error: 'not found' });
    res.json(opp);
  });

  app.get('/api/prospects/:id/opportunities', (req, res) => {
    const prospect = prospects.get(req.params.id);
    if (!prospect) return res.status(404).json({ error: 'not found' });
    res.json(opportunities.getOpportunitiesForProspect(req.params.id, { limit: Number(req.query.limit) || 20 }));
  });

  // ── Samples & Proposals (Phase 4) ─────────────────────────────────
  app.get('/api/samples', (req, res) => {
    res.json(samples.list({
      limit: Number(req.query.limit) || 50,
      status: req.query.status,
      contentKind: req.query.contentKind,
      sampleType: req.query.sampleType,
      opportunityId: req.query.opportunityId,
    }));
  });

  app.get('/api/samples/:id', (req, res) => {
    const sample = samples.get(req.params.id);
    if (!sample) return res.status(404).json({ error: 'not found' });
    res.json(sample);
  });

  app.get('/api/opportunities/:id/samples', (req, res) => {
    const opp = opportunities.getOpportunity(req.params.id);
    if (!opp) return res.status(404).json({ error: 'not found' });
    res.json(samples.getForOpportunity(req.params.id, { limit: Number(req.query.limit) || 20 }));
  });

  app.get('/api/proposals', (req, res) => {
    res.json(proposals.list({
      limit: Number(req.query.limit) || 50,
      status: req.query.status,
      opportunityId: req.query.opportunityId,
    }));
  });

  app.get('/api/proposals/:id', (req, res) => {
    const proposal = proposals.get(req.params.id);
    if (!proposal) return res.status(404).json({ error: 'not found' });
    res.json(proposal);
  });

  app.get('/api/opportunities/:id/proposals', (req, res) => {
    const opp = opportunities.getOpportunity(req.params.id);
    if (!opp) return res.status(404).json({ error: 'not found' });
    res.json(proposals.getForOpportunity(req.params.id, { limit: Number(req.query.limit) || 20 }));
  });

  const PREVIEW_FILES = {
    'index.html': 'text/html; charset=utf-8',
    'styles.css': 'text/css; charset=utf-8',
    'script.js': 'application/javascript; charset=utf-8',
    'metadata.json': 'application/json; charset=utf-8',
  };
  app.get('/website-samples/:id/:file?', (req, res) => {
    const { id } = req.params;
    const file = req.params.file || 'index.html';
    if (!isValidSampleId(id) || !Object.prototype.hasOwnProperty.call(PREVIEW_FILES, file)) {
      return res.status(404).send('Not found');
    }
    let dir;
    try {
      dir = resolveSampleDir(id);
    } catch {
      return res.status(400).send('Invalid sample id');
    }
    const filePath = path.join(dir, file);
    fs.readFile(filePath, (err, data) => {
      if (err) return res.status(404).send('Not found');
      res.type(PREVIEW_FILES[file]).send(data);
    });
  });

  return new Promise((resolve) => {
    server = app.listen(config.dashboard.port, config.dashboard.host, () => {
      console.log(`[dashboard] listening on http://${config.dashboard.host}:${config.dashboard.port}`);
      resolve(server);
    });
  });
}

export function stopDashboard() {
  if (server) { server.close(); server = null; }
}

function renderHomePage() {
  const recentTasks = tasks.list({ limit: 20 });
  const rows = recentTasks.map((t) => `
    <tr>
      <td><strong>${escapeHtml(t.name)}</strong></td>
      <td><span class="status">${escapeHtml(t.status)}</span></td>
      <td>${escapeHtml(t.cron_expression || 'Run once')}</td>
      <td>${escapeHtml(t.last_run_at || '—')}</td>
      <td><button onclick="runTask('${escapeHtml(t.id)}')">Run</button></td>
    </tr>
  `).join('');

  const recentOpportunities = opportunities.listOpportunities({ limit: 20 });
  const opportunityRows = recentOpportunities.map((o) => {
    const prospect = prospects.get(o.prospect_id);
    return `
    <tr>
      <td><strong>${escapeHtml(prospect?.business_name || o.prospect_id)}</strong></td>
      <td>${escapeHtml(String(o.score))}</td>
      <td>${escapeHtml(o.priority)}</td>
      <td>${escapeHtml(o.opportunity_type || '—')}</td>
      <td>${escapeHtml(o.recommended_sample_type || '—')}</td>
      <td>${escapeHtml(o.confidence || '—')}</td>
      <td><span class="status">${escapeHtml(o.status)}</span></td>
    </tr>
  `;
  }).join('');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Real Estate Automation</title>
<style>
* { box-sizing:border-box; }
body { margin:0; font-family:Inter,system-ui,sans-serif; background:#080b12; color:#f3f4f6; }
.container { max-width:1200px; margin:auto; padding:40px 24px 60px; }
.header { display:flex; justify-content:space-between; align-items:center; margin-bottom:32px; }
h1 { margin:0; font-size:30px; }
.card { background:#111621; border:1px solid #252b38; border-radius:16px; padding:24px; margin-bottom:24px; }
table { width:100%; border-collapse:collapse; }
th, td { padding:14px 10px; border-bottom:1px solid #252b38; text-align:left; font-size:14px; }
button { border:0; border-radius:10px; padding:11px 17px; background:#f3f4f6; color:#090b10; font-weight:700; cursor:pointer; }
.status { display:inline-block; padding:5px 9px; border-radius:999px; background:#1d2939; color:#dbeafe; font-size:12px; }
</style>
</head>
<body>
<div class="container">
  <div class="header"><div><h1>AI Real Estate Automation</h1></div>
  <button onclick="location.reload()">Refresh</button></div>
  <div class="card"><h2>Active Tasks</h2>
    <table><thead><tr><th>Task</th><th>Status</th><th>Schedule</th><th>Last Run</th><th>Action</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5">No tasks yet.</td></tr>'}</tbody></table>
  </div>
  <div class="card"><h2>Opportunities</h2>
    <table><thead><tr><th>Prospect</th><th>Score</th><th>Priority</th><th>Type</th><th>Sample</th><th>Confidence</th><th>Status</th></tr></thead>
    <tbody>${opportunityRows || '<tr><td colspan="7">No opportunities yet.</td></tr>'}</tbody></table>
  </div>
</div>
<script>
async function runTask(id) {
  try { await fetch('/api/tasks/' + id + '/run', { method:'POST' }); location.reload(); }
  catch(e) { alert(e.message); }
}
</script>
</body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&', '<': '<', '>': '>', '"': '"', "'": '&#39;' }[c]));
}
