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
import { tasks, runs, steps, errors as dbErrors, notifications, websiteSamples, prospects, opportunities, samples, proposals, outreachMessages, outreachApprovals, outreachAttempts, companies, contacts, conversations, inboundMessages, clientMemory, conversationInsights, invoices, payments, projects, relationshipStates, clientTimelineEvents, followUpRecommendations, clientRevenueSnapshots, clientDeliveries, getDb, operatorAuditLog } from '../database/index.js';
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

  app.get('/api/dashboard/summary', (req, res) => {
    const db = getDb();
    const rows=tasks.list({limit:200}); const rs=runs.listRecent({limit:100}); const aps=listPending(); const es=dbErrors.listRecent({limit:100});
    const ps=prospects.list({limit:200}); const os=opportunities.listOpportunities({limit:200}); const pr=proposals.list({limit:200}); const om=outreachMessages.list({limit:200});
    const cs=companies.list({limit:200}); const ct=contacts.list({limit:200}); const cv=conversations.list({limit:200}); const inv=invoices.list({limit:200}); const pay=payments.list({limit:200}); const proj=projects.list({limit:200});
    const q=quotes.list({limit:200}); const rec=receipts.list({limit:200}); const rem=paymentReminders.list({limit:200}); const ref=refundRecords.list({limit:200}); const del=clientDeliveries.list({limit:200}); const sm=samples.list({limit:200}); const ws=websiteSamples.list({limit:200});
    const norm=v=>String(v||'').toUpperCase(); const count=(a,p)=>a.filter(p).length; const good=r=>['SUCCESS','SUCCEEDED','COMPLETED','DONE','PASS'].includes(norm(r.status)); const bad=r=>['FAILED','ERROR','FAIL','CANCELLED','TIMEOUT'].includes(norm(r.status));
    const settled=p=>['PAID','SUCCEEDED','SUCCESS','COMPLETED','SETTLED'].includes(norm(p.status)); const amount=x=>{const n=Number(x?.amount??x?.total??x?.value??0);return Number.isFinite(n)?n:0}; const ok=count(rs,good);
    const pausedTasks=rows.filter(t=>['PAUSED','SUSPENDED'].includes(norm(t.status)));
    const auditRows=operatorAuditLog.listRecent({limit:100});
    const policyRows=auditRows.filter(a=>['DENIED','BLOCKED','POLICY_BLOCK','FORBIDDEN'].includes(norm(a.status))||/policy|forbidden|deny/i.test(String(a.action||'')));
    const lowConfidence=os.filter(o=>{const n=Number(o.confidence);return Number.isFinite(n)?n<0.6:/^(LOW|VERY_LOW)$/i.test(String(o.confidence||''));});
    const idemRows=db.prepare('SELECT * FROM control_idempotency ORDER BY created_at DESC LIMIT 100').all();
    const idemReplays=idemRows.filter(r=>/replay/i.test(String(r.status||''))||(()=>{try{return JSON.parse(r.result||'{}')?.replayed===true}catch{return false}})()).length;
    const finished=rs.filter(r=>r.started_at&&r.finished_at); const durations=finished.map(r=>new Date(r.finished_at)-new Date(r.started_at)).filter(n=>Number.isFinite(n)&&n>=0);
    const recentSteps=rs.slice(0,20).flatMap(r=>steps.listForRun(r.id).map(st=>({...st,run_id:r.id}))).slice(-30).reverse();
    res.json({
      generatedAt:new Date().toISOString(), agent:{status:'online',uptimeSeconds:process.uptime(),pausedTasks:pausedTasks.length},
      control:{approvals:{pending:aps.length,rows:aps.slice(0,12)},failedRuns:count(rs,bad),pausedTasks:{count:pausedTasks.length,rows:pausedTasks.slice(0,12)},policyBlocks:{count:policyRows.length,rows:policyRows.slice(0,12)},lowConfidence:{count:lowConfidence.length,rows:lowConfidence.slice(0,12)},interventionCount:aps.length+count(rs,bad)+pausedTasks.length+policyRows.length+lowConfidence.length},
      business:{objectives:{total:rows.length,active:count(rows,t=>!['DISABLED','PAUSED','COMPLETED'].includes(norm(t.status)))},prospects:ps.length,pipeline:{opportunities:os.length,highPriority:count(os,o=>['HIGH','URGENT','CRITICAL'].includes(norm(o.priority))),proposals:pr.length,outreachDrafts:om.length,outreachReady:count(om,m=>['READY_FOR_APPROVAL','APPROVED'].includes(norm(m.status)))},clients:{companies:cs.length,contacts:ct.length,conversations:cv.length},revenue:{invoices:inv.length,payments:pay.length,settledPayments:count(pay,settled),recordedRevenue:pay.filter(settled).reduce((sum,p)=>sum+amount(p),0),quotes:q.length,receipts:rec.length,reminders:rem.length,refunds:ref.length},communications:{conversations:cv.length,outreachDrafts:om.length,outreachReady:count(om,m=>['READY_FOR_APPROVAL','APPROVED'].includes(norm(m.status)))},projects:{projects:proj.length,deliveries:del.length}},
      observability:{runs:{total:rs.length,active:count(rs,r=>['RUNNING','IN_PROGRESS','STARTED'].includes(norm(r.status))),successful:ok,failed:count(rs,bad),successRate:rs.length?Math.round(ok/rs.length*100):0,rows:rs.slice(0,20)},toolExecution:{count:recentSteps.length,rows:recentSteps},audit:{count:auditRows.length,rows:auditRows.slice(0,30)},idempotency:{records:idemRows.length,replays:idemReplays,completed:count(idemRows,r=>['COMPLETED','SUCCESS','SUCCEEDED'].includes(norm(r.status))),inFlight:count(idemRows,r=>['STARTED','PENDING','IN_PROGRESS'].includes(norm(r.status)))},errors:{count:es.length,rows:es.slice(0,20)},performance:{sampleSize:durations.length,avgRunDurationMs:durations.length?Math.round(durations.reduce((a,b)=>a+b,0)/durations.length):0,avgRunDurationSeconds:durations.length?Math.round(durations.reduce((a,b)=>a+b,0)/durations.length/100)/10:0},history:{runs:rs.slice(0,20),audit:auditRows.slice(0,20)}},
      tasks:{total:rows.length,active:count(rows,t=>!['DISABLED','PAUSED','COMPLETED'].includes(norm(t.status))),scheduled:count(rows,t=>Boolean(t.cron_expression)),rows:rows.slice(0,12)},runs:{total:rs.length,active:count(rs,r=>['RUNNING','IN_PROGRESS','STARTED'].includes(norm(r.status))),successful:ok,failed:count(rs,bad),successRate:rs.length?Math.round(ok/rs.length*100):0,rows:rs.slice(0,12)},approvals:{pending:aps.length,rows:aps.slice(0,12)},errors:{count:es.length,rows:es.slice(0,12)},pipeline:{prospects:ps.length,opportunities:os.length,highPriority:count(os,o=>['HIGH','URGENT','CRITICAL'].includes(norm(o.priority))),proposals:pr.length,outreachDrafts:om.length,outreachReady:count(om,m=>['READY_FOR_APPROVAL','APPROVED'].includes(norm(m.status)))},clients:{companies:cs.length,contacts:ct.length,conversations:cv.length},commercial:{invoices:inv.length,payments:pay.length,settledPayments:count(pay,settled),recordedRevenue:pay.filter(settled).reduce((sum,p)=>sum+amount(p),0),quotes:q.length,receipts:rec.length,reminders:rem.length,refunds:ref.length,projects:proj.length,deliveries:del.length},creative:{samples:sm.length,websiteSamples:ws.length,proposals:pr.length}
    });
  });


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
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#070707">
<title>AI Business OS — Command Center</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@600;700&family=Manrope:wght@500;600;700&display=swap" rel="stylesheet">
<style>

:root{
  --bg:#070707;--surface:#121212;--surface2:#1A1A1A;--line:#2A2A22;
  --text:#F5F5F0;--muted:#8C8C86;--primary:#D4FF2A;--ice:#1E2410;
  --success:#D4FF2A;--successbg:#1E2410;--warning:#F5C542;--warningbg:#2A2410;
  --danger:#FF6B5E;--dangerbg:#2A1114;--shadow:none;
  --lime:#D4FF2A;--lime-border:#55661A;--lime-chip:#1E2410;--secondary:#B0B0A8;
}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--text);font-family:Manrope,ui-sans-serif,system-ui,sans-serif;font-weight:500;-webkit-font-smoothing:antialiased}
button,input,textarea,select{font:inherit}button{cursor:pointer}a{color:inherit;text-decoration:none}
:focus-visible{outline:2px solid #D4FF2A;outline-offset:3px}
.app{min-height:100vh;background:var(--bg)}
.sidebar{position:fixed;inset:0 auto 0 0;width:220px;background:#0C0C0C;border-right:1px solid var(--line);padding:22px 14px;display:flex;flex-direction:column;z-index:20}
.brand{display:flex;align-items:center;gap:11px;padding:4px 10px 22px}
.brand-mark{width:36px;height:36px;border-radius:10px;background:#D4FF2A;display:grid;place-items:center;color:#070707;font-family:Sora,system-ui,sans-serif;font-weight:700;font-size:14px}
.brand-name{font-family:Sora,system-ui,sans-serif;font-weight:700;font-size:15px;letter-spacing:-.3px;color:var(--text)}
.brand-name span{color:#D4FF2A}
.brand-sub{font-size:11px;color:var(--muted);margin-top:2px;letter-spacing:1px;text-transform:uppercase;font-weight:700}
.nav{display:grid;gap:4px}
.nav a{display:flex;align-items:center;gap:10px;padding:11px 14px;border-radius:12px;color:var(--muted);font-size:13px;font-weight:600}
.nav a:hover{background:#1A1A1A;color:var(--text)}
.nav a.active{background:#1E2410;color:#D4FF2A;border:1px solid #55661A}
.nav-icon{width:20px;text-align:center}
.sidebar-foot{margin-top:auto;border-top:1px solid var(--line);padding:14px 8px 0;color:var(--muted);font-size:11px}
.main{margin-left:220px;width:calc(100% - 220px);background:var(--bg)}
.topbar{height:64px;position:sticky;top:0;z-index:15;background:rgba(7,7,7,.92);backdrop-filter:blur(12px);border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;padding:0 28px}
.topbar-left{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.eyebrow{font-size:12px;color:var(--muted);font-weight:600}
.eyebrow .sep{color:#D4FF2A;margin:0 4px}
.live{display:inline-flex;align-items:center;gap:7px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#D4FF2A;background:#1A1A1A;border:1px solid var(--line);border-radius:999px;padding:6px 12px}
.dot{width:7px;height:7px;border-radius:50%;background:#D4FF2A;flex-shrink:0;box-shadow:0 0 0 0 rgba(212,255,42,.4);animation:pulse 1.8s ease-out infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(212,255,42,.45)}70%{box-shadow:0 0 0 8px transparent}100%{box-shadow:0 0 0 0 transparent}}
.top-actions{display:flex;gap:8px;align-items:center;flex-shrink:0}
.icon-btn,.btn{border:1px solid var(--line);background:#121212;color:#F5F5F0;border-radius:14px;padding:10px 14px;font-weight:700;font-size:12px;min-height:40px;display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap}
.icon-btn:hover,.btn:hover{border-color:#55661A;color:#D4FF2A}
.icon-btn:active,.btn:active{transform:scale(.97)}
.btn.primary{background:#D4FF2A;color:#070707;border-color:#D4FF2A;font-family:Sora,system-ui,sans-serif}
.btn.primary:hover{filter:brightness(1.05);color:#070707}
.btn.danger{background:transparent;color:#FF6B5E;border-color:#5A2A26}
.content{max-width:1100px;margin:0 auto;padding:28px 28px 100px;display:flex;flex-direction:column;gap:18px}
.hero{background:transparent;border:none;padding:0;box-shadow:none;display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:16px}
.hero h1{font-family:Sora,system-ui,sans-serif;font-weight:700;font-size:40px;line-height:1.05;letter-spacing:-1.5px;margin:0 0 10px;color:var(--text)}
.hero h1 .accent{color:#D4FF2A}
.hero p{color:var(--muted);font-size:14px;max-width:420px;line-height:1.55;margin:0}
.title-bar{width:32px;height:3px;background:#D4FF2A;border-radius:2px;margin-bottom:12px}
.hero-card{background:#D4FF2A;color:#070707;border-radius:22px;padding:22px 20px;display:flex;align-items:flex-end;justify-content:space-between;gap:12px;width:100%}
.hero-card .hl{font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;opacity:.7}
.hero-card .hv{font-family:Sora,system-ui,sans-serif;font-weight:700;font-size:56px;line-height:.9;letter-spacing:-2px;margin-top:6px}
.hero-card .hd{font-size:12px;font-weight:600;max-width:120px;text-align:right;opacity:.75;line-height:1.4}
.attention{background:#121212;border:1px solid var(--line);border-radius:22px;padding:18px}
.attention-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:12px;flex-wrap:wrap}
.attention-head h2,.section-title{font-family:Sora,system-ui,sans-serif;font-weight:700;font-size:17px;letter-spacing:-.3px;margin:0;color:var(--text)}
.attention-head p{margin:4px 0 0;font-size:13px;color:var(--muted)}
.agent-chip,#agent-status.badge.success{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#D4FF2A;background:#1E2410;border:1px solid #55661A;border-radius:999px;padding:5px 10px}
.attention-grid{display:grid;gap:8px}
.attention-item{display:flex;align-items:center;justify-content:space-between;background:#1A1A1A;border-radius:14px;padding:14px 16px;min-height:56px;gap:12px}
.attention-item strong,.attention-item .num{font-family:Sora,system-ui,sans-serif;font-weight:700;font-size:28px;letter-spacing:-1px;color:#D4FF2A}
.attention-item span{font-size:13px;color:var(--secondary);font-weight:600}
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.stat,.panel,.mini{background:#121212;border:1px solid var(--line);border-radius:22px;padding:16px}
.stat-label,.panel-sub,.section-note,.mini-label{font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:var(--muted)}
.stat-value,.mini-value{font-family:Sora,system-ui,sans-serif;font-weight:700;font-size:32px;letter-spacing:-1.5px;line-height:1.1;margin-top:4px;color:var(--text)}
.stat-meta{font-size:12px;color:var(--muted);font-weight:600;margin-top:2px}
.section{margin:0}
.section-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:12px;gap:12px;flex-wrap:wrap}
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.grid-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
.panel{padding:18px}
.panel h3,.panel-title{font-family:Sora,system-ui,sans-serif;font-weight:700;font-size:15px;margin:0 0 4px;color:var(--text)}
.list{display:flex;flex-direction:column;gap:8px;margin-top:10px}
.list-item{display:flex;align-items:center;justify-content:space-between;gap:12px;background:#1A1A1A;border-radius:14px;padding:12px 14px}
.list-main{flex:1;min-width:0}
.list-title{font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.list-meta{font-size:12px;color:var(--muted);margin-top:2px}
.list-actions{display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap}
.empty{color:var(--muted);font-size:13px;padding:16px 0;text-align:center}
.badge{display:inline-flex;align-items:center;font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;border-radius:999px;padding:4px 10px;border:1px solid var(--line);color:var(--secondary)}
.badge.success{color:#D4FF2A;border-color:#55661A;background:#1E2410}
.badge.danger{color:#FF6B5E;border-color:#5A2A26}
.badge.warning{color:#F5C542;border-color:#5A4A10;background:#2A2410}
.kpi-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:10px;margin-top:10px}
.mini{padding:12px}
.mini-value{font-size:22px}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:10px}
.field{display:flex;flex-direction:column;gap:6px}
.field.full{grid-column:1/-1}
.field label{font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:var(--muted)}
.field input,.field textarea,.field select{background:#1A1A1A;border:1px solid var(--line);border-radius:12px;color:var(--text);padding:11px 14px;outline:none}
.field input:focus,.field textarea:focus,.field select:focus{border-color:#55661A}
.notice{margin-top:12px;font-size:13px;color:var(--secondary);min-height:20px}
table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}
th{text-align:left;font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:var(--muted);padding:8px 10px;border-bottom:1px solid var(--line)}
td{padding:10px;border-bottom:1px solid var(--line);color:var(--secondary)}
tr:hover td{background:#1A1A1A;color:var(--text)}
.mobile-nav{display:none;position:fixed;left:50%;transform:translateX(-50%);bottom:14px;width:calc(100% - 28px);max-width:400px;height:60px;background:#161616;border:1px solid var(--line);border-radius:999px;align-items:center;justify-content:space-around;z-index:100;padding:0 6px}
.mobile-nav a{display:flex;flex-direction:column;align-items:center;gap:2px;font-size:10px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--muted);padding:8px 12px;border-radius:999px}
.mobile-nav a.active{background:#D4FF2A;color:#070707}
@media(max-width:900px){
  .sidebar{display:none}.main{margin-left:0;width:100%}
  .stats,.grid-2,.grid-3{grid-template-columns:1fr 1fr}
  .content{padding:20px 16px 100px}.mobile-nav{display:flex}
  .hero h1{font-size:32px}.hero-card .hv{font-size:44px}
  .topbar{padding:0 14px}
}
@media(max-width:560px){
  .stats,.grid-2,.grid-3,.form-grid{grid-template-columns:1fr}
  .top-actions .icon-btn{padding:10px 12px;font-size:11px}
}
@media(prefers-reduced-motion:reduce){.dot{animation:none}}

.os-levels{display:flex;flex-direction:column;gap:16px;margin-bottom:18px}.level{border:1px solid var(--border);border-radius:18px;padding:18px;background:var(--panel);box-shadow:0 8px 28px rgba(30,60,100,.06)}.level-control{border-color:#e7bd62}.level-business{border-color:#9cc7ef}.level-observability{border-color:#b8c9dc}.level-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:14px}.level-kicker{font-size:11px;font-weight:800;letter-spacing:.14em;color:var(--muted)}.level h2{margin:4px 0;font-size:20px}.level-head p{margin:0;color:var(--muted);font-size:13px}.level-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}.business-grid{grid-template-columns:repeat(7,minmax(0,1fr))}.control-card,.business-card,.obs-card{padding:14px;border:1px solid var(--border);border-radius:13px;background:var(--surface)}.control-card strong,.business-card strong,.obs-card strong{display:block;font-size:22px;line-height:1.15}.control-card span,.business-card span,.obs-card span{display:block;margin-top:5px;color:var(--muted);font-size:12px}.control-detail-grid,.obs-detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}.alert-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)}.alert-row:last-child{border-bottom:0}.alert-row .label{font-weight:700}.alert-row .meta{font-size:12px;color:var(--muted)}.mini-table{width:100%;border-collapse:collapse}.mini-table th,.mini-table td{text-align:left;padding:8px;border-bottom:1px solid var(--border);font-size:12px}.mini-table th{color:var(--muted);font-weight:700}@media(max-width:1000px){.level-grid,.business-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.control-detail-grid,.obs-detail-grid{grid-template-columns:1fr}}@media(max-width:600px){.level-grid,.business-grid{grid-template-columns:1fr 1fr}.level{padding:14px}.level-head{display:block}.level-head>.badge{display:inline-flex;margin-top:8px}}</style></head>
<body>
<div class="app">
<aside class="sidebar"><div class="brand"><div class="brand-mark">AI</div><div><div class="brand-name">AI Business <span>OS</span></div><div class="brand-sub">Command Center</div></div></div>
<nav class="nav">
<a class="active" href="#overview"><span class="nav-icon">⌂</span>Command Center</a><a href="#objectives"><span class="nav-icon">◎</span>Objectives & Work</a><a href="#clients"><span class="nav-icon">♙</span>Clients & Pipeline</a><a href="#revenue"><span class="nav-icon">◈</span>Revenue & Commercial</a><a href="#communications"><span class="nav-icon">◌</span>Communications</a><a href="#creative"><span class="nav-icon">✦</span>Creative & Websites</a><a href="#operations"><span class="nav-icon">↻</span>Automations</a><a href="#governance"><span class="nav-icon">◇</span>Governance</a>
</nav><div class="sidebar-foot">Production control surface<br>Policy • Approval • Audit • Idempotency</div></aside>
<main class="main">
<header class="topbar"><div class="topbar-left"><span class="eyebrow">Production / AI Business Operating System</span><span class="live"><span class="dot"></span>Live</span></div><div class="top-actions"><button class="icon-btn" id="themeBtn" title="Toggle theme">☾</button><button class="icon-btn" onclick="loadDashboard()" aria-label="Refresh dashboard">↻ Refresh</button></div></header>
<div class="content">
<section id="overview" class="hero"><div><h1>Command Center</h1><p>Supervise objectives, business outcomes, approvals and autonomous work from one place.</p></div><button class="btn primary" onclick="document.getElementById('create-task').scrollIntoView({behavior:'smooth'})">＋ New Objective</button></section>
<section class="os-levels">
<section class="level level-control"><div class="level-head"><div><span class="level-kicker">LEVEL 1</span><h2>CONTROL</h2><p>Needs Attention — intervene before consequential work continues.</p></div><span id="control-total" class="badge warning">0</span></div><div class="level-grid control-grid">
<div class="control-card"><strong id="ctl-approvals">0</strong><span>Approvals</span></div><div class="control-card"><strong id="ctl-failed">0</strong><span>Failed runs</span></div><div class="control-card"><strong id="ctl-paused">0</strong><span>Agent paused</span></div><div class="control-card"><strong id="ctl-policy">0</strong><span>Policy blocks</span></div><div class="control-card"><strong id="ctl-confidence">0</strong><span>Low-confidence decisions</span></div></div><div class="control-detail-grid"><div class="panel"><h3>Approval Center</h3><div class="panel-sub">Human decisions required before consequential actions.</div><div id="control-approvals"></div></div><div class="panel"><h3>Control alerts</h3><div class="panel-sub">Paused work, policy blocks and low-confidence decisions.</div><div id="control-alerts"></div></div></div></section>
<section class="level level-business"><div class="level-head"><div><span class="level-kicker">LEVEL 2</span><h2>BUSINESS</h2><p>What is happening — outcomes, customers and commercial activity.</p></div></div><div class="level-grid business-grid">
<div class="business-card"><strong id="biz-objectives">0</strong><span>Objectives</span></div><div class="business-card"><strong id="biz-prospects">0</strong><span>Prospects</span></div><div class="business-card"><strong id="biz-pipeline">0</strong><span>Pipeline</span></div><div class="business-card"><strong id="biz-clients">0</strong><span>Clients</span></div><div class="business-card"><strong id="biz-revenue">0</strong><span>Revenue</span></div><div class="business-card"><strong id="biz-comms">0</strong><span>Communications</span></div><div class="business-card"><strong id="biz-projects">0</strong><span>Projects</span></div></div></section>
<section class="level level-observability"><div class="level-head"><div><span class="level-kicker">LEVEL 3</span><h2>OBSERVABILITY</h2><p>Why/how it happened — execution evidence, reliability and history.</p></div></div><div class="level-grid business-grid">
<div class="obs-card"><strong id="obs-runs">0</strong><span>Runs</span></div><div class="obs-card"><strong id="obs-tools">0</strong><span>Tool execution</span></div><div class="obs-card"><strong id="obs-audit">0</strong><span>Audit trail</span></div><div class="obs-card"><strong id="obs-idem">0</strong><span>Idempotency</span></div><div class="obs-card"><strong id="obs-errors">0</strong><span>Errors</span></div><div class="obs-card"><strong id="obs-performance">0s</strong><span>Performance</span></div><div class="obs-card"><strong id="obs-history">0</strong><span>History</span></div></div><div class="obs-detail-grid"><div class="panel"><h3>Tool Execution</h3><div class="panel-sub">Recent steps, status and timing.</div><div id="tool-execution"></div></div><div class="panel"><h3>Audit & Idempotency</h3><div class="panel-sub">Traceable operator actions and replay protection.</div><div id="audit-idempotency"></div></div></div></section></section><section class="attention"><div class="attention-head"><div><h2>What needs your attention?</h2><p>Intervention first, reporting second.</p></div><span id="agent-status" class="badge success">Agent online</span></div><div class="attention-grid"><div class="attention-item"><strong id="attention-approvals">0</strong><span>Approvals waiting</span></div><div class="attention-item"><strong id="attention-failures">0</strong><span>Recent failed runs</span></div><div class="attention-item"><strong id="attention-errors">0</strong><span>Recent errors</span></div></div></section>
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
(function(){const t=localStorage.getItem('ai-business-os-theme');if(t)document.documentElement.dataset.theme='dark';const b=document.getElementById('themeBtn');if(b){b.addEventListener('click',function(){const n=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=n;localStorage.setItem('ai-business-os-theme',n);this.textContent=n==='dark'?'☀':'☾'});if(t==='dark')b.textContent='☀'}})();
const esc=v=>String(v??'—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const cls=v=>{const s=String(v||'').toUpperCase();if(['SUCCESS','SUCCEEDED','COMPLETED','DONE','PASS','APPROVED','PAID','SETTLED'].includes(s))return'success';if(['FAILED','ERROR','FAIL','CANCELLED','TIMEOUT','DENIED','REJECTED'].includes(s))return'danger';if(['RUNNING','IN_PROGRESS','STARTED','PENDING','READY_FOR_APPROVAL'].includes(s))return'warning';return''};const money=v=>{const n=Number(v||0);return Number.isFinite(n)?new Intl.NumberFormat(undefined,{maximumFractionDigits:2}).format(n):'0'};const set=(id,v)=>{const e=document.getElementById(id);if(e)e.textContent=v};const api=async(p,o)=>{const r=await fetch(p,o),d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||('HTTP '+r.status));return d};
function renderRuns(rs){const e=document.getElementById('runs-list');if(!rs?.length){e.innerHTML='<div class="empty">No recent runs.</div>';return}e.innerHTML=rs.slice(0,8).map(r=>'<div class="list-item"><div class="list-main"><div class="list-title">'+esc(r.task_id||r.id)+'</div><div class="list-meta">'+esc(r.started_at||r.created_at||'')+'</div></div><span class="badge '+cls(r.status)+'">'+esc(r.status)+'</span></div>').join('')}
function renderApprovals(rs){const e=document.getElementById('approval-list');if(!rs?.length){e.innerHTML='<div class="empty">No approvals waiting. You are clear.</div>';return}e.innerHTML=rs.slice(0,8).map(a=>'<div class="list-item"><div class="list-main"><div class="list-title">'+esc(a.tool||'Controlled action')+'</div><div class="list-meta">'+esc(a.goal||a.requested_at||'Decision required')+'</div></div><div class="list-actions"><button class="btn primary" onclick="decideApproval(\\''+esc(a.id)+'\\',\\'approve\\')">Approve</button><button class="btn danger" onclick="decideApproval(\\''+esc(a.id)+'\\',\\'deny\\')">Deny</button></div></div>').join('')}
function renderOpp(rs){const e=document.getElementById('opportunity-table');if(!rs?.length){e.innerHTML='<div class="empty">No opportunities yet.</div>';return}e.innerHTML='<div class="table-wrap"><table class="table"><thead><tr><th>Prospect</th><th>Score</th><th>Priority</th><th>Type</th><th>Confidence</th><th>Status</th></tr></thead><tbody>'+rs.slice(0,12).map(o=>'<tr><td><strong>'+esc(o.business_name||o.prospect_id)+'</strong></td><td>'+esc(o.score)+'</td><td><span class="badge '+(String(o.priority).toUpperCase()==='HIGH'?'warning':'')+'">'+esc(o.priority)+'</span></td><td>'+esc(o.opportunity_type)+'</td><td>'+esc(o.confidence)+'</td><td><span class="badge '+cls(o.status)+'">'+esc(o.status)+'</span></td></tr>').join('')+'</tbody></table></div>'}
function renderTasks(rs){const e=document.getElementById('task-table');if(!rs?.length){e.innerHTML='<div class="empty">No tasks yet. Create the first objective.</div>';return}e.innerHTML='<div class="table-wrap"><table class="table"><thead><tr><th>Task</th><th>Status</th><th>Schedule</th><th>Last run</th><th>Action</th></tr></thead><tbody>'+rs.slice(0,12).map(t=>'<tr><td><strong>'+esc(t.name)+'</strong><div class="list-meta">'+esc(t.goal)+'</div></td><td><span class="badge '+cls(t.status)+'">'+esc(t.status)+'</span></td><td>'+esc(t.cron_expression||'Run once')+'</td><td>'+esc(t.last_run_at)+'</td><td><button class="btn" onclick="runTask(\\''+esc(t.id)+'\\')">Run</button></td></tr>').join('')+'</tbody></table></div>'}
function renderErrors(rs){const e=document.getElementById('error-table');if(!rs?.length){e.innerHTML='<div class="empty">No recent errors recorded.</div>';return}e.innerHTML='<div class="table-wrap"><table class="table"><thead><tr><th>Time</th><th>Error</th><th>Context</th></tr></thead><tbody>'+rs.slice(0,12).map(x=>'<tr><td>'+esc(x.created_at||x.timestamp)+'</td><td><span class="badge danger">'+esc(x.error_code||x.code||'ERROR')+'</span><div style="margin-top:5px">'+esc(x.message||x.error)+'</div></td><td>'+esc(x.tool||x.task_id||'—')+'</td></tr>').join('')+'</tbody></table></div>'}
function renderRunTable(rs){const e=document.getElementById('run-table');if(!rs?.length){e.innerHTML='<div class="empty">No execution history.</div>';return}e.innerHTML='<div class="table-wrap"><table class="table"><thead><tr><th>Run</th><th>Task</th><th>Status</th><th>Started</th><th>Finished</th></tr></thead><tbody>'+rs.slice(0,20).map(r=>'<tr><td><code>'+esc(r.id)+'</code></td><td>'+esc(r.task_id)+'</td><td><span class="badge '+cls(r.status)+'">'+esc(r.status)+'</span></td><td>'+esc(r.started_at||r.created_at)+'</td><td>'+esc(r.finished_at||r.completed_at)+'</td></tr>').join('')+'</tbody></table></div>'}
function renderThreeLevels(d){
  const ctl=d.control||{},biz=d.business||{},obs=d.observability||{};
  set('control-total',ctl.interventionCount||0);set('ctl-approvals',ctl.approvals?.pending||0);set('ctl-failed',ctl.failedRuns||0);set('ctl-paused',ctl.pausedTasks?.count||0);set('ctl-policy',ctl.policyBlocks?.count||0);set('ctl-confidence',ctl.lowConfidence?.count||0);
  set('biz-objectives',biz.objectives?.total||0);set('biz-prospects',biz.prospects||0);set('biz-pipeline',biz.pipeline?.opportunities||0);set('biz-clients',biz.clients?.companies||0);set('biz-revenue',money(biz.revenue?.recordedRevenue||0));set('biz-comms',biz.communications?.conversations||0);set('biz-projects',biz.projects?.projects||0);
  set('obs-runs',obs.runs?.total||0);set('obs-tools',obs.toolExecution?.count||0);set('obs-audit',obs.audit?.count||0);set('obs-idem',obs.idempotency?.records||0);set('obs-errors',obs.errors?.count||0);set('obs-performance',(obs.performance?.avgRunDurationSeconds||0)+'s');set('obs-history',obs.history?.runs?.length||0);
  const a=document.getElementById('control-approvals');if(a){const rs=ctl.approvals?.rows||[];a.innerHTML=rs.length?rs.slice(0,8).map(x=>'<div class="alert-row"><div><div class="label">'+esc(x.tool||'Controlled action')+'</div><div class="meta">'+esc(x.reasoning||x.goal||x.requested_at||'Decision required')+'</div></div><div class="list-actions"><button class="btn primary" onclick="decideApproval(\\''+esc(x.id)+'\\',\\'approve\\')">Approve</button><button class="btn danger" onclick="decideApproval(\\''+esc(x.id)+'\\',\\'deny\\')">Deny</button></div></div>').join(''):'<div class="empty">No approvals waiting.</div>'}
  const al=document.getElementById('control-alerts');if(al){const items=[...(ctl.pausedTasks?.rows||[]).map(x=>({label:'Agent paused',meta:x.name||x.id,status:'PAUSED'})),...(ctl.policyBlocks?.rows||[]).map(x=>({label:'Policy block',meta:x.tool_name||x.action||x.target,status:x.status})),...(ctl.lowConfidence?.rows||[]).map(x=>({label:'Low confidence',meta:x.business_name||x.summary||x.id,status:String(x.confidence??'LOW')}))];al.innerHTML=items.slice(0,10).map(x=>'<div class="alert-row"><div><div class="label">'+esc(x.label)+'</div><div class="meta">'+esc(x.meta)+'</div></div><span class="badge warning">'+esc(x.status)+'</span></div>').join('')||'<div class="empty">No control alerts.</div>'}
  const te=document.getElementById('tool-execution');if(te){const rs=obs.toolExecution?.rows||[];te.innerHTML=rs.length?'<div class="table-wrap"><table class="mini-table"><thead><tr><th>Tool</th><th>Status</th><th>Run</th><th>Duration</th></tr></thead><tbody>'+rs.slice(0,10).map(x=>{const dur=x.started_at&&x.finished_at?Math.max(0,new Date(x.finished_at)-new Date(x.started_at)):0;return'<tr><td>'+esc(x.tool)+'</td><td><span class="badge '+cls(x.status)+'">'+esc(x.status)+'</span></td><td>'+esc(x.run_id)+'</td><td>'+esc(dur?Math.round(dur/10)/100+'s':'—')+'</td></tr>'}).join('')+'</tbody></table></div>':'<div class="empty">No tool execution history yet.</div>'}
  const ai=document.getElementById('audit-idempotency');if(ai){const idem=obs.idempotency||{};ai.innerHTML='<div class="kpi-row"><div class="mini"><strong>'+esc(idem.records||0)+'</strong><span>Records</span></div><div class="mini"><strong>'+esc(idem.replays||0)+'</strong><span>Replays</span></div><div class="mini"><strong>'+esc(idem.completed||0)+'</strong><span>Completed</span></div></div><div style="margin-top:12px"><div class="panel-sub">Latest audit actions</div>'+((obs.audit?.rows||[]).slice(0,6).map(x=>'<div class="alert-row"><div><div class="label">'+esc(x.action||x.tool_name||'Action')+'</div><div class="meta">'+esc(x.tool_name||x.target||'')+' · '+esc(x.created_at||'')+'</div></div><span class="badge '+cls(x.status)+'">'+esc(x.status)+'</span></div>').join('')||'<div class="empty">No audit records yet.</div>')+'</div>'}
}
async function loadDashboard(){try{const d=await api('/api/dashboard/summary');set('attention-approvals',d.approvals.pending);set('attention-failures',d.runs.failed);set('attention-errors',d.errors.count);set('stat-revenue',money(d.commercial.recordedRevenue));set('stat-opps',d.pipeline.opportunities);set('stat-success',(d.runs.successRate||0)+'%');set('stat-approvals',d.approvals.pending);set('clients-prospects',d.pipeline.prospects);set('clients-companies',d.clients.companies);set('clients-contacts',d.clients.contacts);set('clients-high',d.pipeline.highPriority);set('rev-invoices',d.commercial.invoices);set('rev-payments',d.commercial.payments);set('rev-settled',d.commercial.settledPayments);set('rev-quotes',d.commercial.quotes);set('rev-receipts',d.commercial.receipts);set('rev-projects',d.commercial.projects);set('rev-reminders',d.commercial.reminders);set('rev-refunds',d.commercial.refunds);set('rev-deliveries',d.commercial.deliveries);set('comm-conversations',d.clients.conversations);set('comm-drafts',d.pipeline.outreachDrafts);set('comm-ready',d.pipeline.outreachReady);set('creative-samples',d.creative.samples);set('creative-websites',d.creative.websiteSamples);set('creative-proposals',d.creative.proposals);set('gov-success',(d.runs.successRate||0)+'%');set('gov-failed',d.runs.failed);set('gov-errors',d.errors.count);renderThreeLevels(d);renderRuns(d.runs.rows);renderApprovals(d.approvals.rows);renderTasks(d.tasks.rows);renderErrors(d.errors.rows);renderRunTable(d.runs.rows);renderOpp(await api('/api/opportunities?limit=20'))}catch(err){set('agent-status','Dashboard error');document.getElementById('agent-status').className='badge danger';const m=document.getElementById('message');if(m)m.textContent='Dashboard refresh failed: '+err.message}}
async function createTask(){const name=document.getElementById('name').value.trim(),goal=document.getElementById('goal').value.trim(),location=document.getElementById('location').value.trim(),max=document.getElementById('maxResults').value,cron=document.getElementById('schedule').value,tz=document.getElementById('timezone').value.trim()||undefined;if(!name||!goal){document.getElementById('message').textContent='Enter a name and objective first.';return}let finalGoal=goal;if(location)finalGoal+='\\n\\nTarget Location: '+location;if(max)finalGoal+='\\nMaximum Results: '+max;document.getElementById('message').textContent='Creating and starting objective…';try{const d=await api('/api/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,goal:finalGoal,cronExpression:cron||undefined,timezone:tz,metadata:{targetLocation:location,maximumResults:Number(max||10),taskType:'business_objective'}})});await api('/api/tasks/'+d.id+'/run',{method:'POST'});document.getElementById('message').textContent='Objective created and started.';setTimeout(loadDashboard,700)}catch(err){document.getElementById('message').textContent='Error: '+err.message}}
async function runTask(id){try{await api('/api/tasks/'+encodeURIComponent(id)+'/run',{method:'POST'});setTimeout(loadDashboard,400)}catch(err){alert(err.message)}}
async function decideApproval(id,decision){try{await api('/api/approvals/'+encodeURIComponent(id),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({decision})});setTimeout(loadDashboard,300)}catch(err){alert(err.message)}}
loadDashboard();setInterval(loadDashboard,30000);
</script></body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&', '<': '<', '>': '>', '"': '"', "'": '&#39;' }[c]));
}
