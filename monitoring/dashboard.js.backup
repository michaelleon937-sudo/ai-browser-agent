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
import { tasks, runs, steps, errors as dbErrors, notifications } from '../database/index.js';
import { runAgent } from '../agent/index.js';
import { scheduleTask, unscheduleTask } from '../scheduler/index.js';
import { listPending, listAll as listApprovals, recordDecision } from '../agent/approval.js';
import { config } from '../config/index.js';


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
    // Respond immediately; run proceeds asynchronously.
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
  const recentTasks = tasks.list({ limit: 10 });
  const rows = recentTasks.map((t) => `
    <tr>
      <td>${escapeHtml(t.name)}</td>
      <td>${t.status}</td>
      <td>${t.cron_expression || '—'}</td>
      <td>${t.last_run_at || '—'}</td>
      <td>${t.next_run_at || '—'}</td>
    </tr>`).join('\n');


  return `<!doctype html>
<html><head><meta charset="utf-8"><title>AI Browser Agent</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; background:#0b0d12; color:#e5e7eb; }
  h1 { font-size: 1.25rem; }
  table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
  th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #23262f; font-size: 0.9rem; }
  th { color: #9ca3af; font-weight: 600; }
  .pill { padding: 2px 8px; border-radius: 999px; font-size: 0.75rem; }
</style>
</head>
<body>
  <h1>🤖 AI Browser Agent — Dashboard</h1>
  <p>Uptime: ${Math.round(process.uptime())}s · Provider: <code>${config.ai.provider}</code></p>
  <table>
    <thead><tr><th>Task</th><th>Status</th><th>Cron</th><th>Last run</th><th>Next run</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5">No tasks yet.</td></tr>'}</tbody>
  </table>
  <p style="margin-top:2rem;color:#6b7280;font-size:0.8rem;">
    JSON API: /api/tasks, /api/runs, /api/errors, /api/approvals, /api/notifications
  </p>
</body></html>`;
}


function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
