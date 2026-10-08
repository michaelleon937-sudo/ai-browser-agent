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
import { tasks, runs, steps, errors as dbErrors, notifications, websiteSamples, prospects, opportunities, samples, proposals, outreachMessages, outreachApprovals, outreachAttempts, companies, contacts, conversations, inboundMessages, clientMemory, conversationInsights, invoices, payments, projects, relationshipStates, clientTimelineEvents, followUpRecommendations, clientRevenueSnapshots, clientDeliveries } from '../database/index.js';
import { quotes, ledger, receipts, paymentReminders, refundRecords, ensureCommercialSchema } from '../database/commercial-store.js';
import { toCommercialState } from '../integrations/commercial/payment-machine.js';
import { approveOutreachMessage, denyOutreachMessage, sendApprovedOutreach } from '../integrations/outreach-delivery.js';
import { runAgent } from '../agent/index.js';
import { scheduleTask, unscheduleTask } from '../scheduler/index.js';
import { listPending, listAll as listApprovals, recordDecision } from '../agent/approval.js';
import { config } from '../config/index.js';
import { createControlRouter } from '../control/index.js';
import { mountMcp } from '../mcp/server.js';
import { mountPaymentWebhooks } from '../integrations/payments/webhooks.js';
import { isValidSampleId, resolveSampleDir } from '../integrations/website-gen.js';
import { ingestWebsiteLead } from '../integrations/website-leads.js';


let server = null;


export async function startDashboard() {
  if (server) return server;
  const app = express();
  app.use(express.json());


  // Control API: bearer CONTROL_TOKEN, deny-by-default, mounted BEFORE dashboard basic auth
  app.use('/api/control/v1', createControlRouter());

  // Remote MCP gateway: its own bearer auth/host validation; health remains public.
  mountMcp(app);
  mountPaymentWebhooks(app);

  if (config.dashboard.user && config.dashboard.pass) {
    app.use(basicAuth({
      users: { [config.dashboard.user]: config.dashboard.pass },
      challenge: true,
      realm: 'ai-browser-agent',
    }));
  }


  app.get('/healthz', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

  app.get('/api/dashboard/summary', (req, res) => { const rows=tasks.list({limit:200}); const rs=runs.listRecent({limit:100}); const aps=listPending(); const es=dbErrors.listRecent({limit:100}); const ps=prospects.list({limit:200}); const os=opportunities.listOpportunities({limit:200}); const pr=proposals.list({limit:200}); const om=outreachMessages.list({limit:200}); const cs=companies.list({limit:200}); const ct=contacts.list({limit:200}); const cv=conversations.list({limit:200}); const inv=invoices.list({limit:200}); const pay=payments.list({limit:200}); const proj=projects.list({limit:200}); const q=quotes.list({limit:200}); const rec=receipts.list({limit:200}); const rem=paymentReminders.list({limit:200}); const ref=refundRecords.list({limit:200}); const del=clientDeliveries.list({limit:200}); const sm=samples.list({limit:200}); const ws=websiteSamples.list({limit:200}); const norm=v=>String(v||'').toUpperCase(); const count=(a,p)=>a.filter(p).length; const good=r=>['SUCCESS','SUCCEEDED','COMPLETED','DONE','PASS'].includes(norm(r.status)); const bad=r=>['FAILED','ERROR','FAIL','CANCELLED','TIMEOUT'].includes(norm(r.status)); const settled=p=>['PAID','SUCCEEDED','SUCCESS','COMPLETED','SETTLED'].includes(norm(p.status)); const amount=x=>{const n=Number(x?.amount??x?.total??x?.value??0);return Number.isFinite(n)?n:0}; const ok=count(rs,good); res.json({generatedAt:new Date().toISOString(),agent:{status:'online',uptimeSeconds:process.uptime()},tasks:{total:rows.length,active:count(rows,t=>!['DISABLED','PAUSED','COMPLETED'].includes(norm(t.status))),scheduled:count(rows,t=>Boolean(t.cron_expression)),rows:rows.slice(0,12)},runs:{total:rs.length,active:count(rs,r=>['RUNNING','IN_PROGRESS','STARTED'].includes(norm(r.status))),successful:ok,failed:count(rs,bad),successRate:rs.length?Math.round(ok/rs.length*100):0,rows:rs.slice(0,12)},approvals:{pending:aps.length,rows:aps.slice(0,12)},errors:{count:es.length,rows:es.slice(0,12)},pipeline:{prospects:ps.length,opportunities:os.length,highPriority:count(os,o=>['HIGH','URGENT','CRITICAL'].includes(norm(o.priority))),proposals:pr.length,outreachDrafts:om.length,outreachReady:count(om,m=>['READY_FOR_APPROVAL','APPROVED'].includes(norm(m.status)))},clients:{companies:cs.length,contacts:ct.length,conversations:cv.length},commercial:{invoices:inv.length,payments:pay.length,settledPayments:count(pay,settled),recordedRevenue:pay.filter(settled).reduce((sum,p)=>sum+amount(p),0),quotes:q.length,receipts:rec.length,reminders:rem.length,refunds:ref.length,projects:proj.length,deliveries:del.length},creative:{samples:sm.length,websiteSamples:ws.length,proposals:pr.length}}); });


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



  app.post('/api/website/leads', (req, res) => {
    try {
      const result = ingestWebsiteLead(req.body || {});
      res.status(result.ok ? 201 : 400).json(result);
    } catch (err) {
      res.status(Number(err.status) || 400).json({ ok: false, error: String(err.message || err) });
    }
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

  app.get('/api/crm/companies', (req, res) => {
    res.json(companies.list({ limit: Number(req.query.limit) || 50 }));
  });
  app.get('/api/crm/companies/:id', (req, res) => {
    const row = companies.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  });
  app.get('/api/crm/contacts', (req, res) => {
    res.json(contacts.list({ limit: Number(req.query.limit) || 50, companyId: req.query.companyId, prospectId: req.query.prospectId }));
  });
  app.get('/api/crm/contacts/:id', (req, res) => {
    const row = contacts.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  });
  app.get('/api/crm/conversations', (req, res) => {
    res.json(conversations.list({ limit: Number(req.query.limit) || 50, status: req.query.status, contactId: req.query.contactId, companyId: req.query.companyId, prospectId: req.query.prospectId }));
  });
  app.get('/api/crm/conversations/:id', (req, res) => {
    const row = conversations.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json({ conversation: row, messages: inboundMessages.list({ conversationId: row.id, limit: Number(req.query.limit) || 50 }) });
  });
  
  
  app.get('/api/crm/invoices', (req, res) => {
    res.json(invoices.list({ limit: Number(req.query.limit) || 50, status: req.query.status, companyId: req.query.companyId }));
  });
  app.get('/api/crm/invoices/:id', (req, res) => {
    const row = invoices.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  });
  app.get('/api/crm/payments', (req, res) => {
    res.json(payments.list({ limit: Number(req.query.limit) || 50, status: req.query.status, invoiceId: req.query.invoiceId }));
  });
  app.get('/api/crm/payments/:id', (req, res) => {
    const row = payments.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  });
  app.get('/api/crm/projects', (req, res) => {
    res.json(projects.list({ limit: Number(req.query.limit) || 50, status: req.query.status, companyId: req.query.companyId }));
  });
  app.get('/api/crm/projects/:id', (req, res) => {
    const row = projects.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  });

  app.get('/api/crm/memory', (req, res) => {
    res.json(clientMemory.list({
      limit: Number(req.query.limit) || 50,
      companyId: req.query.companyId,
      contactId: req.query.contactId,
      prospectId: req.query.prospectId,
      key: req.query.key,
    }));
  });
  app.get('/api/crm/conversations/:id/insight', (req, res) => {
    const row = conversationInsights.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  });

  app.get('/api/crm/messages', (req, res) => {
    res.json(inboundMessages.list({ limit: Number(req.query.limit) || 50, conversationId: req.query.conversationId, contactId: req.query.contactId, prospectId: req.query.prospectId, classification: req.query.classification }));
  });
  app.get('/api/crm/messages/:id', (req, res) => {
    const row = inboundMessages.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  });



// Phase 7 BI — read-only business intelligence visibility
  app.get('/api/bi/relationship', (req, res) => {
    const { companyId, contactId, prospectId } = req.query;
    if (!companyId && !contactId && !prospectId) return res.status(400).json({ error: 'companyId, contactId, or prospectId required' });
    const current = relationshipStates.getCurrent({ companyId, contactId, prospectId });
    const history = relationshipStates.listHistory({ companyId, contactId, prospectId, limit: Number(req.query.limit) || 50 });
    res.json({ current, history });
  });
  app.get('/api/bi/timeline', (req, res) => {
    const { companyId, contactId, prospectId, eventType } = req.query;
    if (!companyId && !contactId && !prospectId) return res.status(400).json({ error: 'companyId, contactId, or prospectId required' });
    res.json(clientTimelineEvents.list({ companyId, contactId, prospectId, eventType, limit: Number(req.query.limit) || 100 }));
  });
  app.get('/api/bi/followups', (req, res) => {
    const { companyId, contactId, prospectId, status } = req.query;
    res.json(followUpRecommendations.list({
      companyId, contactId, prospectId, status,
      limit: Number(req.query.limit) || 50,
    }));
  });
  app.get('/api/bi/revenue', (req, res) => {
    const { companyId, contactId, prospectId } = req.query;
    if (!companyId && !contactId && !prospectId) return res.status(400).json({ error: 'companyId, contactId, or prospectId required' });
    const latest = clientRevenueSnapshots.getLatest({ companyId, contactId, prospectId });
    res.json({ latest });
  });
  app.get('/api/bi/dormant', (req, res) => {
    const limit = Number(req.query.limit) || 50;
    const out = [];
    for (const c of companies.list({ limit: 200 })) {
      const rel = relationshipStates.getCurrent({ companyId: c.id });
      if (rel && rel.state === 'DORMANT') out.push({ companyId: c.id, companyName: c.name, relationship: rel });
      if (out.length >= limit) break;
    }
    res.json({ dormant: out });
  });


  // Phase 8 — commercial visibility (read-only; no create/charge/refund/send)
  app.get('/api/commercial/quotes', (req, res) => {
    ensureCommercialSchema();
    res.json(quotes.list({ limit: Number(req.query.limit) || 50, status: req.query.status, companyId: req.query.companyId }));
  });
  app.get('/api/commercial/ledger', (req, res) => {
    ensureCommercialSchema();
    res.json(ledger.list({ invoiceId: req.query.invoiceId, paymentId: req.query.paymentId, limit: Number(req.query.limit) || 50 }));
  });
  app.get('/api/commercial/receipts', (req, res) => {
    ensureCommercialSchema();
    res.json(receipts.list({ invoiceId: req.query.invoiceId, limit: Number(req.query.limit) || 50 }));
  });
  app.get('/api/commercial/reminders', (req, res) => {
    ensureCommercialSchema();
    res.json(paymentReminders.list({ invoiceId: req.query.invoiceId, status: req.query.status, limit: Number(req.query.limit) || 50 }));
  });
  app.get('/api/commercial/refunds', (req, res) => {
    ensureCommercialSchema();
    res.json(refundRecords.list({ paymentId: req.query.paymentId, limit: Number(req.query.limit) || 50 }));
  });
  app.get('/api/commercial/payments/:id', (req, res) => {
    ensureCommercialSchema();
    const row = payments.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json({
      payment: row,
      commercialState: toCommercialState(row.status),
      receipt: receipts.getByPayment(row.id) || null,
    });
  });

// Phase A1 — client deliveries (read-only visibility)
  app.get('/api/crm/deliveries', (req, res) => {
    res.json(clientDeliveries.list({
      limit: Number(req.query.limit) || 50,
      status: req.query.status,
      conversationId: req.query.conversationId,
      invoiceId: req.query.invoiceId,
      companyId: req.query.companyId,
      contactId: req.query.contactId,
    }));
  });
  app.get('/api/crm/deliveries/:id', (req, res) => {
    const row = clientDeliveries.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
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
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#f5f7fb">
<title>AI Business OS — Command Center</title>
<style>
:root{--bg:#f5f7fb;--surface:#fff;--surface2:#f8fafc;--line:#e6eaf0;--text:#0f172a;--muted:#64748b;--primary:#2563eb;--ice:#e8f1ff;--success:#15803d;--successbg:#ecfdf3;--warning:#b45309;--warningbg:#fff7ed;--danger:#b91c1c;--dangerbg:#fef2f2;--shadow:0 12px 36px rgba(15,23,42,.07)}
[data-theme=dark]{--bg:#080d16;--surface:#101827;--surface2:#0d1420;--line:#243044;--text:#f8fafc;--muted:#94a3b8;--primary:#60a5fa;--ice:#12233e;--success:#4ade80;--successbg:#0c2818;--warning:#fbbf24;--warningbg:#2a2108;--danger:#f87171;--dangerbg:#2a1114;--shadow:0 12px 36px rgba(0,0,0,.22)}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}button,input,textarea,select{font:inherit}button{cursor:pointer}a{color:inherit;text-decoration:none}
.app{min-height:100vh}.sidebar{position:fixed;inset:0 auto 0 0;width:248px;background:var(--surface);border-right:1px solid var(--line);padding:22px 14px;display:flex;flex-direction:column;z-index:20}.brand{display:flex;align-items:center;gap:11px;padding:4px 10px 22px}.brand-mark{width:38px;height:38px;border-radius:12px;background:linear-gradient(135deg,#2563eb,#60a5fa);display:grid;place-items:center;color:#fff;font-weight:900}.brand-name{font-weight:800}.brand-sub{font-size:11px;color:var(--muted);margin-top:2px}.nav{display:grid;gap:5px}.nav a{display:flex;align-items:center;gap:10px;padding:10px 11px;border-radius:10px;color:var(--muted);font-size:13px;font-weight:650}.nav a:hover,.nav a.active{background:var(--ice);color:var(--primary)}.nav-icon{width:20px;text-align:center}.sidebar-foot{margin-top:auto;border-top:1px solid var(--line);padding:14px 8px 0;color:var(--muted);font-size:11px}
.main{margin-left:248px;width:calc(100% - 248px)}.topbar{height:68px;position:sticky;top:0;z-index:15;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(12px);border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;padding:0 28px}.topbar-left{display:flex;align-items:center;gap:10px}.eyebrow{font-size:12px;color:var(--muted)}.live{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;color:var(--success)}.dot{width:7px;height:7px;border-radius:50%;background:var(--success)}.top-actions{display:flex;gap:8px}.icon-btn,.btn{border:1px solid var(--line);background:var(--surface);color:var(--text);border-radius:10px;padding:9px 12px;font-weight:700;font-size:12px}.btn.primary{background:var(--primary);color:#fff;border-color:var(--primary)}.btn.danger{background:var(--dangerbg);color:var(--danger);border-color:var(--line)}
.content{max-width:1440px;margin:auto;padding:30px}.hero{display:flex;justify-content:space-between;gap:22px;align-items:flex-end;margin-bottom:24px}.hero h1{margin:0;font-size:31px;letter-spacing:-.8px}.hero p{margin:8px 0 0;color:var(--muted);font-size:14px}.attention{background:linear-gradient(135deg,var(--surface),var(--ice));border:1px solid var(--line);border-radius:18px;padding:20px;box-shadow:var(--shadow);margin-bottom:22px}.attention-head{display:flex;justify-content:space-between;gap:15px;align-items:center}.attention h2{font-size:16px;margin:0}.attention p{color:var(--muted);margin:6px 0 0;font-size:13px}.attention-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:16px}.attention-item{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:13px}.attention-item strong{display:block;font-size:18px}.attention-item span{font-size:11px;color:var(--muted)}
.section{margin-top:28px;scroll-margin-top:88px}.section-head{display:flex;justify-content:space-between;align-items:end;margin-bottom:12px}.section-title{font-size:17px;font-weight:800}.section-note{font-size:11px;color:var(--muted)}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.stat{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:16px;box-shadow:var(--shadow)}.stat-label{font-size:11px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.06em}.stat-value{font-size:25px;font-weight:850;margin-top:7px}.stat-meta{font-size:11px;color:var(--muted);margin-top:5px}.grid-2{display:grid;grid-template-columns:1.35fr .9fr;gap:14px}.grid-3{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.panel{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:18px;box-shadow:var(--shadow)}.panel h3{margin:0 0 5px;font-size:14px}.panel-sub{font-size:11px;color:var(--muted);margin-bottom:14px}.kpi-row{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.mini{background:var(--surface2);border:1px solid var(--line);border-radius:11px;padding:12px}.mini strong{display:block;font-size:19px}.mini span{font-size:11px;color:var(--muted)}.list{display:grid;gap:8px}.list-item{display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid var(--line);background:var(--surface2);border-radius:10px;padding:11px 12px}.list-main{min-width:0}.list-title{font-size:12px;font-weight:750;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.list-meta{font-size:10px;color:var(--muted);margin-top:3px}.list-actions{display:flex;gap:5px;flex-shrink:0}.badge{display:inline-flex;align-items:center;border-radius:999px;padding:4px 8px;font-size:10px;font-weight:800;background:var(--ice);color:var(--primary)}.badge.success{background:var(--successbg);color:var(--success)}.badge.warning{background:var(--warningbg);color:var(--warning)}.badge.danger{background:var(--dangerbg);color:var(--danger)}
.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:12px}.table{width:100%;border-collapse:collapse;min-width:720px}.table th,.table td{padding:11px 12px;border-bottom:1px solid var(--line);text-align:left;font-size:11px;vertical-align:top}.table th{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.05em}.table tr:last-child td{border-bottom:0}.form-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}.field{display:flex;flex-direction:column;gap:6px}.field.full{grid-column:1/-1}.field label{font-size:11px;font-weight:750;color:var(--muted)}.field input,.field textarea,.field select{width:100%;border:1px solid var(--line);background:var(--surface2);color:var(--text);border-radius:9px;padding:10px 11px;outline:none}.field textarea{min-height:100px;resize:vertical}.field input:focus,.field textarea:focus,.field select:focus{border-color:var(--primary)}.empty{padding:18px;text-align:center;color:var(--muted);font-size:12px}.notice{font-size:11px;color:var(--muted);margin-top:9px}
.mobile-nav{display:none}@media(max-width:1050px){.sidebar{width:210px}.main{margin-left:210px;width:calc(100% - 210px)}.stats{grid-template-columns:repeat(2,1fr)}.grid-2{grid-template-columns:1fr}.grid-3{grid-template-columns:1fr 1fr}}@media(max-width:760px){.sidebar{display:none}.main{margin-left:0;width:100%}.topbar{padding:0 16px}.content{padding:20px 14px 72px}.hero{align-items:flex-start;flex-direction:column}.hero h1{font-size:25px}.attention-grid,.stats,.grid-3,.kpi-row{grid-template-columns:1fr}.form-grid{grid-template-columns:1fr}.mobile-nav{display:flex;position:fixed;bottom:0;left:0;right:0;height:58px;background:var(--surface);border-top:1px solid var(--line);z-index:30;justify-content:space-around}.mobile-nav a{font-size:9px;color:var(--muted);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px}.mobile-nav a.active{color:var(--primary)}.mobile-nav span:first-child{font-size:16px}}
</style></head>
<body>
<div class="app">
<aside class="sidebar"><div class="brand"><div class="brand-mark">AI</div><div><div class="brand-name">AI Business OS</div><div class="brand-sub">Command Center</div></div></div>
<nav class="nav">
<a class="active" href="#overview"><span class="nav-icon">⌂</span>Command Center</a><a href="#objectives"><span class="nav-icon">◎</span>Objectives & Work</a><a href="#clients"><span class="nav-icon">♙</span>Clients & Pipeline</a><a href="#revenue"><span class="nav-icon">◈</span>Revenue & Commercial</a><a href="#communications"><span class="nav-icon">◌</span>Communications</a><a href="#creative"><span class="nav-icon">✦</span>Creative & Websites</a><a href="#operations"><span class="nav-icon">↻</span>Automations</a><a href="#governance"><span class="nav-icon">◇</span>Governance</a>
</nav><div class="sidebar-foot">Production control surface<br>Policy • Approval • Audit • Idempotency</div></aside>
<main class="main">
<header class="topbar"><div class="topbar-left"><span class="eyebrow">Production / AI Business Operating System</span><span class="live"><span class="dot"></span>Live</span></div><div class="top-actions"><button class="icon-btn" id="themeBtn" title="Toggle theme">☾</button><button class="icon-btn" onclick="loadDashboard()">↻ Refresh</button></div></header>
<div class="content">
<section id="overview" class="hero"><div><h1>Command Center</h1><p>Supervise objectives, business outcomes, approvals and autonomous work from one place.</p></div><button class="btn primary" onclick="document.getElementById('create-task').scrollIntoView({behavior:'smooth'})">＋ New Objective</button></section>
<section class="attention"><div class="attention-head"><div><h2>What needs your attention?</h2><p>Intervention first, reporting second.</p></div><span id="agent-status" class="badge success">Agent online</span></div><div class="attention-grid"><div class="attention-item"><strong id="attention-approvals">0</strong><span>Approvals waiting</span></div><div class="attention-item"><strong id="attention-failures">0</strong><span>Recent failed runs</span></div><div class="attention-item"><strong id="attention-errors">0</strong><span>Recent errors</span></div></div></section>
<section class="stats"><div class="stat"><div class="stat-label">Revenue recorded</div><div class="stat-value" id="stat-revenue">0</div><div class="stat-meta">Settled payment records</div></div><div class="stat"><div class="stat-label">Pipeline opportunities</div><div class="stat-value" id="stat-opps">0</div><div class="stat-meta">Identified opportunities</div></div><div class="stat"><div class="stat-label">Agent success</div><div class="stat-value" id="stat-success">0%</div><div class="stat-meta">Recent execution sample</div></div><div class="stat"><div class="stat-label">Pending approvals</div><div class="stat-value" id="stat-approvals">0</div><div class="stat-meta">Human decisions required</div></div></section>

<section id="objectives" class="section"><div class="section-head"><div><div class="section-title">Objectives & Live Work</div><div class="section-note">What the agent is doing now and what completed recently.</div></div></div><div class="grid-2"><div class="panel"><h3>Live activity</h3><div class="panel-sub">Current runs, outcomes and execution state.</div><div id="runs-list" class="list"><div class="empty">Loading…</div></div></div><div class="panel"><h3>Next decisions</h3><div class="panel-sub">Approval queue for consequential actions.</div><div id="approval-list" class="list"><div class="empty">Loading…</div></div></div></div></section>

<section id="clients" class="section"><div class="section-head"><div><div class="section-title">Clients & Pipeline Intelligence</div><div class="section-note">CRM, client and opportunity signals already produced by the agent.</div></div></div><div class="stats"><div class="stat"><div class="stat-label">Prospects</div><div class="stat-value" id="clients-prospects">0</div><div class="stat-meta">Known prospects</div></div><div class="stat"><div class="stat-label">Companies</div><div class="stat-value" id="clients-companies">0</div><div class="stat-meta">CRM companies</div></div><div class="stat"><div class="stat-label">Contacts</div><div class="stat-value" id="clients-contacts">0</div><div class="stat-meta">CRM contacts</div></div><div class="stat"><div class="stat-label">High priority</div><div class="stat-value" id="clients-high">0</div><div class="stat-meta">Opportunities requiring focus</div></div></div><div class="panel" style="margin-top:14px"><h3>Opportunity queue</h3><div class="panel-sub">Prioritized commercial opportunities.</div><div id="opportunity-table"></div></div></section>

<section id="revenue" class="section"><div class="section-head"><div><div class="section-title">Revenue & Commercial</div><div class="section-note">Quotes, invoices, payments, receipts, reminders and projects.</div></div></div><div class="grid-2"><div class="panel"><h3>Revenue pulse</h3><div class="panel-sub">Read-only commercial visibility.</div><div class="kpi-row"><div class="mini"><strong id="rev-invoices">0</strong><span>Invoices</span></div><div class="mini"><strong id="rev-payments">0</strong><span>Payments</span></div><div class="mini"><strong id="rev-settled">0</strong><span>Settled</span></div></div><div class="kpi-row" style="margin-top:10px"><div class="mini"><strong id="rev-quotes">0</strong><span>Quotes</span></div><div class="mini"><strong id="rev-receipts">0</strong><span>Receipts</span></div><div class="mini"><strong id="rev-projects">0</strong><span>Projects</span></div></div></div><div class="panel"><h3>Commercial controls</h3><div class="panel-sub">Operational records that may need attention.</div><div class="list"><div class="list-item"><div class="list-main"><div class="list-title">Payment reminders</div><div class="list-meta">Outstanding reminder records</div></div><span class="badge warning" id="rev-reminders">0</span></div><div class="list-item"><div class="list-main"><div class="list-title">Refund records</div><div class="list-meta">Recorded refund activity</div></div><span class="badge" id="rev-refunds">0</span></div><div class="list-item"><div class="list-main"><div class="list-title">Client deliveries</div><div class="list-meta">Delivery records across projects</div></div><span class="badge success" id="rev-deliveries">0</span></div></div></div></div></section>

<section id="communications" class="section"><div class="section-head"><div><div class="section-title">Communications</div><div class="section-note">Customer conversations, outreach drafts and human-gated sends.</div></div></div><div class="stats"><div class="stat"><div class="stat-label">Conversations</div><div class="stat-value" id="comm-conversations">0</div><div class="stat-meta">CRM conversations</div></div><div class="stat"><div class="stat-label">Outreach drafts</div><div class="stat-value" id="comm-drafts">0</div><div class="stat-meta">Prepared messages</div></div><div class="stat"><div class="stat-label">Ready / approved</div><div class="stat-value" id="comm-ready">0</div><div class="stat-meta">Awaiting next action</div></div><div class="stat"><div class="stat-label">Channel model</div><div class="stat-value">Multi</div><div class="stat-meta">CRM + email/WhatsApp/Telegram surfaces</div></div></div></section>

<section id="creative" class="section"><div class="section-head"><div><div class="section-title">Creative & Websites</div><div class="section-note">Design, website and proposal production surfaces.</div></div></div><div class="grid-3"><div class="panel"><h3>Creative samples</h3><div class="panel-sub">Generated concepts and sample assets.</div><div class="stat-value" id="creative-samples">0</div></div><div class="panel"><h3>Website samples</h3><div class="panel-sub">Generated website previews.</div><div class="stat-value" id="creative-websites">0</div></div><div class="panel"><h3>Proposals</h3><div class="panel-sub">Commercial proposals prepared.</div><div class="stat-value" id="creative-proposals">0</div></div></div></section>

<section id="operations" class="section"><div class="section-head"><div><div class="section-title">Automations & Scheduler</div><div class="section-note">Recurring tasks and direct execution controls.</div></div></div><div class="grid-2"><div class="panel"><h3>Active Tasks</h3><div class="panel-sub">Scheduled or manually triggered work.</div><div id="task-table"></div></div><div class="panel" id="create-task"><h3>Create New Task</h3><div class="panel-sub">Give the agent a business objective or recurring operational goal.</div><div class="form-grid"><div class="field"><label>Task / Objective Name</label><input id="name" placeholder="e.g. Qualify new hospitality leads"></div><div class="field"><label>Target Location</label><input id="location" placeholder="e.g. Tanzania / East Africa"></div><div class="field full"><label>Objective / Goal</label><textarea id="goal" placeholder="Describe the outcome you want the agent to achieve…"></textarea></div><div class="field"><label>Maximum Results</label><input id="maxResults" type="number" value="10" min="1" max="1000"></div><div class="field"><label>Schedule</label><select id="schedule"><option value="">Run Once</option><option value="0 9 * * *">Every day at 09:00</option><option value="0 9 * * 1-5">Every weekday at 09:00</option><option value="0 9 * * 1">Every Monday at 09:00</option><option value="0 9 * * 1,3,5">Mon / Wed / Fri</option></select></div><div class="field full"><label>Timezone</label><input id="timezone" value="Africa/Dar_es_Salaam"></div></div><div style="margin-top:12px;display:flex;justify-content:flex-end"><button class="btn primary" type="button" onclick="createTask()">Create & Run</button></div><div id="message" class="notice"></div></div></div></section>

<section id="governance" class="section"><div class="section-head"><div><div class="section-title">Governance, Reliability & Audit</div><div class="section-note">Control visibility without exposing secrets or hidden chain-of-thought.</div></div></div><div class="grid-2"><div class="panel"><h3>Reliability</h3><div class="panel-sub">Recent execution health.</div><div class="kpi-row"><div class="mini"><strong id="gov-success">0%</strong><span>Run success</span></div><div class="mini"><strong id="gov-failed">0</strong><span>Failed runs</span></div><div class="mini"><strong id="gov-errors">0</strong><span>Errors</span></div></div></div><div class="panel"><h3>Safety boundary</h3><div class="panel-sub">Consequential actions remain governed by the control layer.</div><div class="list"><div class="list-item"><div class="list-main"><div class="list-title">Policy</div><div class="list-meta">Deny-by-default control gateway</div></div><span class="badge success">Active</span></div><div class="list-item"><div class="list-main"><div class="list-title">Approval</div><div class="list-meta">Human decision surface</div></div><span class="badge success">Active</span></div><div class="list-item"><div class="list-main"><div class="list-title">Idempotency</div><div class="list-meta">Replay protection</div></div><span class="badge success">Active</span></div><div class="list-item"><div class="list-main"><div class="list-title">Audit</div><div class="list-meta">Structured action evidence</div></div><span class="badge success">Active</span></div></div></div></div><div class="panel" style="margin-top:14px"><h3>Recent errors</h3><div class="panel-sub">Investigate before they become operational debt.</div><div id="error-table"></div></div></section>

<section class="section"><div class="section-head"><div><div class="section-title">Recent Execution Record</div><div class="section-note">Historical runs remain available for operational review.</div></div></div><div class="panel"><div id="run-table"></div></div></section>
</div></main>
<nav class="mobile-nav"><a class="active" href="#overview"><span>⌂</span>Home</a><a href="#objectives"><span>◎</span>Work</a><a href="#clients"><span>♙</span>Clients</a><a href="#revenue"><span>◈</span>Revenue</a><a href="#governance"><span>◇</span>Control</a></nav>
</div>
<script>
(function(){const t=localStorage.getItem('ai-business-os-theme');if(t)document.documentElement.dataset.theme=t;const b=document.getElementById('themeBtn');if(b){b.addEventListener('click',function(){const n=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=n;localStorage.setItem('ai-business-os-theme',n);this.textContent=n==='dark'?'☀':'☾'});if(t==='dark')b.textContent='☀'}})();
const esc=v=>String(v??'—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const cls=v=>{const s=String(v||'').toUpperCase();if(['SUCCESS','SUCCEEDED','COMPLETED','DONE','PASS','APPROVED','PAID','SETTLED'].includes(s))return'success';if(['FAILED','ERROR','FAIL','CANCELLED','TIMEOUT','DENIED','REJECTED'].includes(s))return'danger';if(['RUNNING','IN_PROGRESS','STARTED','PENDING','READY_FOR_APPROVAL'].includes(s))return'warning';return''};const money=v=>{const n=Number(v||0);return Number.isFinite(n)?new Intl.NumberFormat(undefined,{maximumFractionDigits:2}).format(n):'0'};const set=(id,v)=>{const e=document.getElementById(id);if(e)e.textContent=v};const api=async(p,o)=>{const r=await fetch(p,o),d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||('HTTP '+r.status));return d};
function renderRuns(rs){const e=document.getElementById('runs-list');if(!rs?.length){e.innerHTML='<div class="empty">No recent runs.</div>';return}e.innerHTML=rs.slice(0,8).map(r=>'<div class="list-item"><div class="list-main"><div class="list-title">'+esc(r.task_id||r.id)+'</div><div class="list-meta">'+esc(r.started_at||r.created_at||'')+'</div></div><span class="badge '+cls(r.status)+'">'+esc(r.status)+'</span></div>').join('')}
function renderApprovals(rs){const e=document.getElementById('approval-list');if(!rs?.length){e.innerHTML='<div class="empty">No approvals waiting. You are clear.</div>';return}e.innerHTML=rs.slice(0,8).map(a=>'<div class="list-item"><div class="list-main"><div class="list-title">'+esc(a.tool||'Controlled action')+'</div><div class="list-meta">'+esc(a.goal||a.requested_at||'Decision required')+'</div></div><div class="list-actions"><button class="btn primary" onclick="decideApproval(\\''+esc(a.id)+'\\',\\'approve\\')">Approve</button><button class="btn danger" onclick="decideApproval(\\''+esc(a.id)+'\\',\\'deny\\')">Deny</button></div></div>').join('')}
function renderOpp(rs){const e=document.getElementById('opportunity-table');if(!rs?.length){e.innerHTML='<div class="empty">No opportunities yet.</div>';return}e.innerHTML='<div class="table-wrap"><table class="table"><thead><tr><th>Prospect</th><th>Score</th><th>Priority</th><th>Type</th><th>Confidence</th><th>Status</th></tr></thead><tbody>'+rs.slice(0,12).map(o=>'<tr><td><strong>'+esc(o.business_name||o.prospect_id)+'</strong></td><td>'+esc(o.score)+'</td><td><span class="badge '+(String(o.priority).toUpperCase()==='HIGH'?'warning':'')+'">'+esc(o.priority)+'</span></td><td>'+esc(o.opportunity_type)+'</td><td>'+esc(o.confidence)+'</td><td><span class="badge '+cls(o.status)+'">'+esc(o.status)+'</span></td></tr>').join('')+'</tbody></table></div>'}
function renderTasks(rs){const e=document.getElementById('task-table');if(!rs?.length){e.innerHTML='<div class="empty">No tasks yet. Create the first objective.</div>';return}e.innerHTML='<div class="table-wrap"><table class="table"><thead><tr><th>Task</th><th>Status</th><th>Schedule</th><th>Last run</th><th>Action</th></tr></thead><tbody>'+rs.slice(0,12).map(t=>'<tr><td><strong>'+esc(t.name)+'</strong><div class="list-meta">'+esc(t.goal)+'</div></td><td><span class="badge '+cls(t.status)+'">'+esc(t.status)+'</span></td><td>'+esc(t.cron_expression||'Run once')+'</td><td>'+esc(t.last_run_at)+'</td><td><button class="btn" onclick="runTask(\\''+esc(t.id)+'\\')">Run</button></td></tr>').join('')+'</tbody></table></div>'}
function renderErrors(rs){const e=document.getElementById('error-table');if(!rs?.length){e.innerHTML='<div class="empty">No recent errors recorded.</div>';return}e.innerHTML='<div class="table-wrap"><table class="table"><thead><tr><th>Time</th><th>Error</th><th>Context</th></tr></thead><tbody>'+rs.slice(0,12).map(x=>'<tr><td>'+esc(x.created_at||x.timestamp)+'</td><td><span class="badge danger">'+esc(x.error_code||x.code||'ERROR')+'</span><div style="margin-top:5px">'+esc(x.message||x.error)+'</div></td><td>'+esc(x.tool||x.task_id||'—')+'</td></tr>').join('')+'</tbody></table></div>'}
function renderRunTable(rs){const e=document.getElementById('run-table');if(!rs?.length){e.innerHTML='<div class="empty">No execution history.</div>';return}e.innerHTML='<div class="table-wrap"><table class="table"><thead><tr><th>Run</th><th>Task</th><th>Status</th><th>Started</th><th>Finished</th></tr></thead><tbody>'+rs.slice(0,20).map(r=>'<tr><td><code>'+esc(r.id)+'</code></td><td>'+esc(r.task_id)+'</td><td><span class="badge '+cls(r.status)+'">'+esc(r.status)+'</span></td><td>'+esc(r.started_at||r.created_at)+'</td><td>'+esc(r.finished_at||r.completed_at)+'</td></tr>').join('')+'</tbody></table></div>'}
async function loadDashboard(){try{const d=await api('/api/dashboard/summary');set('attention-approvals',d.approvals.pending);set('attention-failures',d.runs.failed);set('attention-errors',d.errors.count);set('stat-revenue',money(d.commercial.recordedRevenue));set('stat-opps',d.pipeline.opportunities);set('stat-success',(d.runs.successRate||0)+'%');set('stat-approvals',d.approvals.pending);set('clients-prospects',d.pipeline.prospects);set('clients-companies',d.clients.companies);set('clients-contacts',d.clients.contacts);set('clients-high',d.pipeline.highPriority);set('rev-invoices',d.commercial.invoices);set('rev-payments',d.commercial.payments);set('rev-settled',d.commercial.settledPayments);set('rev-quotes',d.commercial.quotes);set('rev-receipts',d.commercial.receipts);set('rev-projects',d.commercial.projects);set('rev-reminders',d.commercial.reminders);set('rev-refunds',d.commercial.refunds);set('rev-deliveries',d.commercial.deliveries);set('comm-conversations',d.clients.conversations);set('comm-drafts',d.pipeline.outreachDrafts);set('comm-ready',d.pipeline.outreachReady);set('creative-samples',d.creative.samples);set('creative-websites',d.creative.websiteSamples);set('creative-proposals',d.creative.proposals);set('gov-success',(d.runs.successRate||0)+'%');set('gov-failed',d.runs.failed);set('gov-errors',d.errors.count);renderRuns(d.runs.rows);renderApprovals(d.approvals.rows);renderTasks(d.tasks.rows);renderErrors(d.errors.rows);renderRunTable(d.runs.rows);renderOpp(await api('/api/opportunities?limit=20'))}catch(err){set('agent-status','Dashboard error');document.getElementById('agent-status').className='badge danger';const m=document.getElementById('message');if(m)m.textContent='Dashboard refresh failed: '+err.message}}
async function createTask(){const name=document.getElementById('name').value.trim(),goal=document.getElementById('goal').value.trim(),location=document.getElementById('location').value.trim(),max=document.getElementById('maxResults').value,cron=document.getElementById('schedule').value,tz=document.getElementById('timezone').value.trim()||undefined;if(!name||!goal){document.getElementById('message').textContent='Enter a name and objective first.';return}let finalGoal=goal;if(location)finalGoal+='\\n\\nTarget Location: '+location;if(max)finalGoal+='\\nMaximum Results: '+max;document.getElementById('message').textContent='Creating and starting objective…';try{const d=await api('/api/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,goal:finalGoal,cronExpression:cron||undefined,timezone:tz,metadata:{targetLocation:location,maximumResults:Number(max||10),taskType:'business_objective'}})});await api('/api/tasks/'+d.id+'/run',{method:'POST'});document.getElementById('message').textContent='Objective created and started.';setTimeout(loadDashboard,700)}catch(err){document.getElementById('message').textContent='Error: '+err.message}}
async function runTask(id){try{await api('/api/tasks/'+encodeURIComponent(id)+'/run',{method:'POST'});setTimeout(loadDashboard,400)}catch(err){alert(err.message)}}
async function decideApproval(id,decision){try{await api('/api/approvals/'+encodeURIComponent(id),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({decision})});setTimeout(loadDashboard,300)}catch(err){alert(err.message)}}
loadDashboard();setInterval(loadDashboard,30000);
</script></body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&', '<': '<', '>': '>', '"': '"', "'": '&#39;' }[c]));
}
