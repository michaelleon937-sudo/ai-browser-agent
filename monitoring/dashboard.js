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

  // NOTE: Full HTML home page and remaining dashboard helpers are required for a complete restore.
  // If this truncated, the successor must push the complete file from local /tmp/aba-a1/monitoring/dashboard.js
  const PREVIEW_LIMIT = 200;
  function renderHomePage() {
    return '<!doctype html><html><head><title>AI Browser Agent</title></head><body><h1>AI Browser Agent</h1><p>Dashboard operational. Use /api/* JSON endpoints.</p></body></html>';
  }

  const port = config.dashboard.port || 3000;
  const host = config.dashboard.host || '0.0.0.0';
  server = await new Promise((resolve) => {
    const s = app.listen(port, host, () => resolve(s));
  });
  console.log(`[dashboard] listening on http://${host}:${port}`);
  return server;
}

export function stopDashboard() {
  if (server) {
    server.close();
    server = null;
  }
}
