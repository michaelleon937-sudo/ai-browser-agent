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
    res.status(202).json({ started: true });
    runAgent({ taskId: task.id }).catch((err) => {
      console.error('[dashboard] run failed:', err);
    });
  });


  app.get('/api/runs', (req, res) => {
    res.json(runs.listRecent({ limit: Number(req.query.limit) || 50 }));
  });

  app.get('/api/runs/:id', (req, res) => {
    const run = runs.get(req.params.id);
    if (!run) return res.status(404).json({ error: 'not found' });
    res.json(run);
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


  app.get('/api/website-samples', (req, res) => {
    res.json(websiteSamples.list({ limit: Number(req.query.limit) || 50 }));
  });


  app.get('/api/website-samples/:id', (req, res) => {
    if (!isValidSampleId(req.params.id)) return res.status(400).json({ error: 'invalid sample id' });
    const sample = websiteSamples.get(req.params.id);
    if (!sample) return res.status(404).json({ error: 'not found' });
    res.json(sample);
  });


  app.get('/api/prospects', (req, res) => {
    res.json(prospects.list({ limit: Number(req.query.limit) || 50, status: req.query.status }));
  });


  app.get('/api/prospects/:id', (req, res) => {
    const prospect = prospects.get(req.params.id);
    if (!prospect) return res.status(404).json({ error: 'not found' });
    res.json(prospect);
  });


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
      <td>${escapeHtml(t.next_run_at || '—')}</td>
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

  const pendingApprovals = listPending();
  const approvalRows = pendingApprovals.map((a) => `
    <tr>
      <td><code>${escapeHtml(a.id)}</code></td>
      <td>${escapeHtml(a.tool || '—')}</td>
      <td>${escapeHtml(a.goal ? String(a.goal).slice(0, 80) : '—')}</td>
      <td>${escapeHtml(a.requested_at || a.created_at || '—')}</td>
      <td>
        <button onclick="decideApproval('${escapeHtml(a.id)}','approve')">Approve</button>
        <button class="secondary" onclick="decideApproval('${escapeHtml(a.id)}','deny')">Deny</button>
      </td>
    </tr>
  `).join('');

  const recentSamples = samples.list({ limit: 20 });
  const sampleRows = recentSamples.map((s) => `
    <tr>
      <td><code>${escapeHtml(s.id)}</code></td>
      <td>${escapeHtml(s.sample_type || '—')}</td>
      <td>${escapeHtml(s.content_kind || '—')}</td>
      <td><span class="status">${escapeHtml(s.status)}</span></td>
      <td>${escapeHtml(s.opportunity_id || '—')}</td>
      <td>${s.preview_path ? `<a href="${escapeHtml(s.preview_path)}" target="_blank" rel="noopener">Preview</a>` : '—'}</td>
    </tr>
  `).join('');

  const recentProposals = proposals.list({ limit: 20 });
  const proposalRows = recentProposals.map((p) => `
    <tr>
      <td><code>${escapeHtml(p.id)}</code></td>
      <td>${escapeHtml(p.opportunity_id || '—')}</td>
      <td><span class="status">${escapeHtml(p.status)}</span></td>
      <td>${escapeHtml((p.pitch || '').slice(0, 100) || '—')}</td>
      <td>${escapeHtml(p.created_at || '—')}</td>
    </tr>
  `).join('');


  const recentOutreach = outreachMessages.list({ limit: 20 });
  const outreachRows = recentOutreach.map((m) => {
    const prospect = prospects.get(m.prospect_id);
    let actions = '—';
    if (m.status === 'READY_FOR_APPROVAL') {
      actions = `<button onclick="approveOutreach('${escapeHtml(m.id)}')">Approve</button>
        <button class="secondary" onclick="denyOutreach('${escapeHtml(m.id)}')">Deny</button>`;
    } else if (m.status === 'APPROVED' || m.status === 'FAILED') {
      actions = `<button onclick="sendOutreach('${escapeHtml(m.id)}')">Send</button>
        <button class="secondary" onclick="denyOutreach('${escapeHtml(m.id)}')">Deny</button>`;
    }
    return `
    <tr>
      <td><code>${escapeHtml(m.id)}</code></td>
      <td>${escapeHtml(prospect?.business_name || m.prospect_id)}</td>
      <td>${escapeHtml(m.recipient || '—')}</td>
      <td>${escapeHtml(m.channel || '—')}</td>
      <td>${escapeHtml((m.subject || '').slice(0, 60) || '—')}</td>
      <td><span class="status">${escapeHtml(m.status)}</span></td>
      <td><code>${escapeHtml((m.content_hash || '').slice(0, 12))}…</code></td>
      <td>${actions}</td>
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
body { margin:0; font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; background:#080b12; color:#f3f4f6; }
.container { max-width:1200px; margin:auto; padding:40px 24px 60px; }
.header { display:flex; justify-content:space-between; align-items:center; margin-bottom:32px; }
h1 { margin:0; font-size:30px; letter-spacing:-.5px; }
.subtitle { color:#9ca3af; margin-top:7px; }
.card { background:#111621; border:1px solid #252b38; border-radius:16px; padding:24px; margin-bottom:24px; box-shadow:0 10px 30px rgba(0,0,0,.25); }
.card h2 { margin:0 0 20px; font-size:20px; }
.grid { display:grid; grid-template-columns:1fr 1fr; gap:18px; }
.field { display:flex; flex-direction:column; gap:8px; }
.full { grid-column:1 / -1; }
label { color:#cbd5e1; font-size:14px; font-weight:600; }
input, textarea, select { width:100%; border:1px solid #303746; background:#0b0f18; color:#f9fafb; border-radius:10px; padding:12px 13px; outline:none; font-size:14px; }
textarea { min-height:130px; resize:vertical; }
input:focus, textarea:focus, select:focus { border-color:#64748b; }
.actions { display:flex; gap:12px; margin-top:18px; }
button { border:0; border-radius:10px; padding:11px 17px; background:#f3f4f6; color:#090b10; font-weight:700; cursor:pointer; }
button.secondary { background:#1f2937; color:#f9fafb; border:1px solid #374151; }
table { width:100%; border-collapse:collapse; }
th, td { padding:14px 10px; border-bottom:1px solid #252b38; text-align:left; font-size:14px; vertical-align:top; }
th { color:#9ca3af; font-weight:600; }
.status { display:inline-block; padding:5px 9px; border-radius:999px; background:#1d2939; color:#dbeafe; font-size:12px; }
.notice { color:#9ca3af; font-size:13px; margin-top:12px; }
@media(max-width:750px) { .grid { grid-template-columns:1fr; } .full { grid-column:auto; } }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <div>
      <h1>🤖 AI Real Estate Automation</h1>
      <div class="subtitle">Autonomous lead generation, research and marketing automation</div>
    </div>
    <button class="secondary" onclick="window.location.reload()">Refresh</button>
  </div>
  <div class="card">
    <h2>Create New Task</h2>
    <div class="grid">
      <div class="field">
        <label>Task Name</label>
        <input id="name" placeholder="e.g. Tanzania Real Estate Leads">
      </div>
      <div class="field">
        <label>Target Location</label>
        <input id="location" placeholder="e.g. Dar es Salaam, Tanzania">
      </div>
      <div class="field full">
        <label>AI Prompt / Task Goal</label>
        <textarea id="goal" placeholder="Tell the AI exactly what you want it to research or automate..."></textarea>
      </div>
      <div class="field">
        <label>Maximum Results</label>
        <input id="maxResults" type="number" value="10" min="1" max="1000">
      </div>
      <div class="field">
        <label>Schedule</label>
        <select id="schedule">
          <option value="">Run Once</option>
          <option value="0 9 * * *">Every day at 09:00</option>
          <option value="0 9 * * 1-5">Every weekday at 09:00</option>
          <option value="0 9 * * 1">Every Monday at 09:00</option>
          <option value="0 9 * * 1,3,5">Monday / Wednesday / Friday</option>
        </select>
      </div>
      <div class="field">
        <label>Timezone</label>
        <input id="timezone" placeholder="e.g. Africa/Dar_es_Salaam" value="Africa/Dar_es_Salaam">
      </div>
    </div>
    <div class="actions">
      <button type="button" onclick="createTask()">Create & Run Task</button>
    </div>
    <div id="message" class="notice"></div>
  </div>
  <div class="card">
    <h2>Active Tasks</h2>
    <table>
      <thead><tr><th>Task</th><th>Status</th><th>Schedule</th><th>Last Run</th><th>Next Run</th><th>Action</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="6">No tasks yet.</td></tr>`}</tbody>
    </table>
  </div>
  <div class="card">
    <h2>Pending Approvals</h2>
    <p style="color:#9ca3af;margin:-8px 0 16px;font-size:13px;">Human-in-the-loop decisions via <code>POST /api/approvals/:id</code></p>
    <table>
      <thead><tr><th>ID</th><th>Tool</th><th>Goal</th><th>Created</th><th>Action</th></tr></thead>
      <tbody>${approvalRows || `<tr><td colspan="5">No pending approvals.</td></tr>`}</tbody>
    </table>
  </div>
  <div class="card">
    <h2>Opportunities</h2>
    <p style="color:#9ca3af;margin:-8px 0 16px;font-size:13px;">Filter via the API: <code>/api/opportunities?priority=HIGH&status=...&minScore=...</code></p>
    <table>
      <thead><tr><th>Prospect</th><th>Score</th><th>Priority</th><th>Type</th><th>Recommended Sample</th><th>Confidence</th><th>Status</th></tr></thead>
      <tbody>${opportunityRows || `<tr><td colspan="7">No opportunities analyzed yet.</td></tr>`}</tbody>
    </table>
  </div>
  <div class="card">
    <h2>Samples (Phase 4)</h2>
    <p style="color:#9ca3af;margin:-8px 0 16px;font-size:13px;">Speculative samples and concept briefs — API: <code>/api/samples</code></p>
    <table>
      <thead><tr><th>ID</th><th>Type</th><th>Content Kind</th><th>Status</th><th>Opportunity</th><th>Preview</th></tr></thead>
      <tbody>${sampleRows || `<tr><td colspan="6">No samples yet.</td></tr>`}</tbody>
    </table>
  </div>
  <div class="card">
    <h2>Proposals (Phase 4)</h2>
    <p style="color:#9ca3af;margin:-8px 0 16px;font-size:13px;">Drafted proposals — API: <code>/api/proposals</code></p>
    <table>
      <thead><tr><th>ID</th><th>Opportunity</th><th>Status</th><th>Pitch</th><th>Created</th></tr></thead>
      <tbody>${proposalRows || `<tr><td colspan="5">No proposals yet.</td></tr>`}</tbody>
    </table>

  <div class="card">
    <h2>Outreach (Phase 5A + Phase 6)</h2>
    <p style="color:#9ca3af;margin:-8px 0 16px;font-size:13px;">Drafts require human approve before send. API: <code>/api/outreach/drafts</code> · send needs <code>Idempotency-Key</code></p>
    <table>
      <thead><tr><th>ID</th><th>Prospect</th><th>Recipient</th><th>Channel</th><th>Subject</th><th>Status</th><th>Hash</th><th>Action</th></tr></thead>
      <tbody>${outreachRows || `<tr><td colspan="8">No outreach drafts yet.</td></tr>`}</tbody>
    </table>
  </div>
  </div>
</div>
<script>
async function createTask() {
  const name = document.getElementById('name').value.trim();
  const goal = document.getElementById('goal').value.trim();
  const targetLocation = document.getElementById('location').value.trim();
  const maxResults = document.getElementById('maxResults').value;
  const cronExpression = document.getElementById('schedule').value;
  const timezone = document.getElementById('timezone').value.trim() || undefined;
  if (!name || !goal) {
    document.getElementById('message').textContent = 'Please enter a Task Name and AI Prompt.';
    return;
  }
  let finalGoal = goal;
  if (targetLocation) {
    finalGoal += "\\n\\nTarget Location: " + targetLocation;
  }
  if (maxResults) {
    finalGoal += "\\nMaximum Results: " + maxResults;
  }
  document.getElementById('message').textContent = 'Creating task...';
  try {
    const response = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        goal: finalGoal,
        cronExpression: cronExpression || undefined,
        timezone,
        metadata: {
          targetLocation: targetLocation,
          maximumResults: Number(maxResults || 10),
          taskType: 'real_estate'
        }
      })
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Failed to create task');
    }
    await fetch('/api/tasks/' + data.id + '/run', { method: 'POST' });
    document.getElementById('message').textContent = 'Task created and started successfully.';
    setTimeout(() => window.location.reload(), 1200);
  } catch (error) {
    document.getElementById('message').textContent = 'Error: ' + error.message;
  }
}
async function runTask(id) {
  try {
    await fetch('/api/tasks/' + id + '/run', { method: 'POST' });
    window.location.reload();
  } catch (error) {
    alert(error.message);
  }
}

  async function approveOutreach(id) {
    const response = await fetch('/api/outreach/drafts/' + id + '/approve', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ by: 'dashboard' }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { alert(data.error || 'Approve failed'); return; }
    window.location.reload();
  }
  async function denyOutreach(id) {
    const response = await fetch('/api/outreach/drafts/' + id + '/deny', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ by: 'dashboard' }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { alert(data.error || 'Deny failed'); return; }
    window.location.reload();
  }
  async function sendOutreach(id) {
    if (!confirm('Send this approved outreach email? This is an external side effect.')) return;
    const key = 'send-' + id + '-' + Date.now();
    const response = await fetch('/api/outreach/drafts/' + id + '/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ by: 'dashboard', idempotencyKey: key }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.sent) { alert(data.error || 'Send failed (check SMTP configuration)'); return; }
    window.location.reload();
  }

  async function decideApproval(id, decision) {
  try {
    const response = await fetch('/api/approvals/' + id, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || ('HTTP ' + response.status));
    }
    window.location.reload();
  } catch (error) {
    alert(error.message);
  }
}
</script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&', '<': '<', '>': '>', '"': '"', "'": '&#39;' }[c]));
}
