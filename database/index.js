// database/index.js
// Data access layer on top of better-sqlite3. Single file DB (config.database.path),
// WAL mode for concurrent dashboard reads while the agent writes.
// Exposes small, purpose-built repositories rather than a generic ORM so the
// rest of the codebase stays easy to audit.


import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';
import { config } from '../config/index.js';


let db = null;


export function getDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(config.database.path), { recursive: true });
  db = new Database(config.database.path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}


export function closeDb() {
  if (db) { db.close(); db = null; }
}


export function migrate() {
  const schemaPath = fileURLToPath(new URL('./schema.sql', import.meta.url));
  const sql = fs.readFileSync(schemaPath, 'utf8');
  getDb().exec(sql);

  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT OR IGNORE INTO tasks (id, name, goal, status, created_at, updated_at)
    VALUES ('ad-hoc', 'Ad-hoc run', '(ad-hoc — goal supplied at run time)', 'idle', ?, ?)
  `).run(now, now);
}


// ── tasks ──────────────────────────────────────────────────────────
export const tasks = {
  create({ name, goal, cronExpression, timezone, metadata }) {
    const id = nanoid(12);
    const now = new Date().toISOString();
    getDb().prepare(`
      INSERT INTO tasks (id, name, goal, cron_expression, timezone, status, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'idle', ?, ?, ?)
    `).run(id, name, goal, cronExpression || null, timezone || null, JSON.stringify(metadata || {}), now, now);
    return tasks.get(id);
  },
  get(id) {
    return getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  },
  list({ limit = 100 } = {}) {
    return getDb().prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?').all(limit);
  },
  update(id, { name, goal, cronExpression, timezone, nextRunAt, metadata } = {}) {
    const current = tasks.get(id);
    if (!current) return null;
    getDb().prepare(`
      UPDATE tasks SET
        name = ?, goal = ?, cron_expression = ?, timezone = ?, next_run_at = ?,
        metadata_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      name ?? current.name,
      goal ?? current.goal,
      cronExpression !== undefined ? cronExpression : current.cron_expression,
      timezone !== undefined ? timezone : current.timezone,
      nextRunAt !== undefined ? nextRunAt : current.next_run_at,
      metadata ? JSON.stringify(metadata) : current.metadata_json,
      new Date().toISOString(),
      id,
    );
    return tasks.get(id);
  },
  setStatus(id, status, extra = {}) {
    const current = tasks.get(id);
    if (!current) return null;
    getDb().prepare(`
      UPDATE tasks SET status = ?, last_run_at = ?, last_status = ?, error_message = ?, updated_at = ?
      WHERE id = ?
    `).run(
      status,
      extra.lastRunAt ?? current.last_run_at,
      extra.lastStatus ?? current.last_status,
      extra.errorMessage ?? null,
      new Date().toISOString(),
      id,
    );
  },
  setNextRun(id, nextRunAt) {
    getDb().prepare('UPDATE tasks SET next_run_at = ?, updated_at = ? WHERE id = ?')
      .run(nextRunAt, new Date().toISOString(), id);
  },
  dueForRun(nowIso) {
    return getDb().prepare(`
      SELECT * FROM tasks
      WHERE cron_expression IS NOT NULL
        AND next_run_at IS NOT NULL
        AND next_run_at <= ?
      ORDER BY next_run_at ASC
    `).all(nowIso);
  },
  remove(id) {
    getDb().prepare('DELETE FROM tasks WHERE id = ?').run(id);
  },
};


// ── runs ───────────────────────────────────────────────────────────
export const runs = {
  start({ taskId }) {
    const id = nanoid(14);
    const now = new Date().toISOString();
    getDb().prepare(`
      INSERT INTO runs (id, task_id, status, started_at, steps_total, steps_done, retries)
      VALUES (?, ?, 'running', ?, 0, 0, 0)
    `).run(id, taskId, now);
    return runs.get(id);
  },
  get(id) {
    return getDb().prepare('SELECT * FROM runs WHERE id = ?').get(id);
  },
  listForTask(taskId, { limit = 20 } = {}) {
    return getDb().prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC LIMIT ?').all(taskId, limit);
  },
  listRecent({ limit = 50 } = {}) {
    return getDb().prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?').all(limit);
  },
  finish(id, { status, result, errorMessage }) {
    getDb().prepare(`
      UPDATE runs SET status = ?, finished_at = ?, result_json = ?, error_message = ?
      WHERE id = ?
    `).run(status, new Date().toISOString(), result ? JSON.stringify(result) : null, errorMessage || null, id);
  },
  bumpSteps(id, { total, done, retries }) {
    getDb().prepare('UPDATE runs SET steps_total = ?, steps_done = ?, retries = ? WHERE id = ?')
      .run(total, done, retries, id);
  },
};


// ── steps ──────────────────────────────────────────────────────────
export const steps = {
  create({ runId, seq, action, reasoning }) {
    const id = nanoid(14);
    getDb().prepare(`
      INSERT INTO steps (id, run_id, seq, tool, args_json, reasoning, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')
    `).run(id, runId, seq, action.tool, JSON.stringify(action.args || {}), reasoning || null);
    return { id };
  },
  start(id) {
    getDb().prepare("UPDATE steps SET status = 'running', started_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  },
  finish(id, { status, observation, errorMessage }) {
    getDb().prepare(`
      UPDATE steps SET status = ?, finished_at = ?, observation_json = ?, error_message = ?
      WHERE id = ?
    `).run(status, new Date().toISOString(), observation ? JSON.stringify(observation) : null, errorMessage || null, id);
  },
  listForRun(runId) {
    return getDb().prepare('SELECT * FROM steps WHERE run_id = ? ORDER BY seq ASC').all(runId);
  },
};


// ── errors ─────────────────────────────────────────────────────────
export const errors = {
  record({ runId, stepId, level = 'error', message, stack, context }) {
    const id = nanoid(14);
    getDb().prepare(`
      INSERT INTO errors (id, run_id, step_id, level, message, stack, context_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, runId || null, stepId || null, level, message, stack || null, context ? JSON.stringify(context) : null, new Date().toISOString());
    return { id };
  },
  listRecent({ limit = 50 } = {}) {
    return getDb().prepare('SELECT * FROM errors ORDER BY created_at DESC LIMIT ?').all(limit);
  },
};


// ── key/value store (small config / cursor bookkeeping) ─────────────
export const kv = {
  get(key) {
    const row = getDb().prepare('SELECT value FROM kv_store WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : undefined;
  },
  set(key, value) {
    getDb().prepare(`
      INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), new Date().toISOString());
  },
  delete(key) {
    getDb().prepare('DELETE FROM kv_store WHERE key = ?').run(key);
  },
};


// ── sessions (browser cookies/storage snapshots for reuse, metadata only) ──
export const sessions = {
  upsert({ domain, label, metadata }) {
    const id = nanoid(10);
    getDb().prepare(`
      INSERT INTO sessions (id, domain, label, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(domain, label) DO UPDATE SET metadata_json = excluded.metadata_json, updated_at = excluded.updated_at
    `).run(id, domain, label || 'default', JSON.stringify(metadata || {}), new Date().toISOString(), new Date().toISOString());
  },
  get(domain, label = 'default') {
    return getDb().prepare('SELECT * FROM sessions WHERE domain = ? AND label = ?').get(domain, label);
  },
};


// ── website samples (generated by the Website Engine, Phase 1) ──────
export const websiteSamples = {
  create({ id, taskId, runId, prospectName, status, businessType, location, websiteGoal, style, files, previewPath }) {
    const now = new Date().toISOString();
    getDb().prepare(`
      INSERT INTO website_samples
        (id, task_id, run_id, prospect_name, status, business_type, location, website_goal, style, files_json, preview_path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      taskId || null,
      runId || null,
      prospectName || null,
      status || 'SPECULATIVE_SAMPLE',
      businessType || null,
      location || null,
      websiteGoal || null,
      style || null,
      JSON.stringify(files || []),
      previewPath || null,
      now,
    );
    return websiteSamples.get(id);
  },
  get(id) {
    return getDb().prepare('SELECT * FROM website_samples WHERE id = ?').get(id);
  },
  list({ limit = 50 } = {}) {
    return getDb().prepare('SELECT * FROM website_samples ORDER BY created_at DESC LIMIT ?').all(limit);
  },
};


// ── prospects (Phase 2 — Real Estate Prospecting) ────────────────────
export const prospects = {
  create({ id, taskId, runId, businessName, websiteUrl, location, contactEmail, contactPhone, socialProfiles, serviceGaps, sourceUrl, notes, status }) {
    const genId = id || nanoid(12);
    const now = new Date().toISOString();
    getDb().prepare(`
      INSERT INTO prospects
        (id, task_id, run_id, business_name, website_url, location, contact_email, contact_phone, social_profiles_json, service_gaps_json, source_url, notes, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      genId,
      taskId || null,
      runId || null,
      businessName || null,
      websiteUrl || null,
      location || null,
      contactEmail || null,
      contactPhone || null,
      JSON.stringify(socialProfiles || []),
      JSON.stringify(serviceGaps || []),
      sourceUrl || null,
      notes || null,
      status || 'NEW',
      now,
      now,
    );
    return prospects.get(genId);
  },
  get(id) {
    return getDb().prepare('SELECT * FROM prospects WHERE id = ?').get(id);
  },
  list({ limit = 50, status } = {}) {
    if (status) {
      return getDb().prepare('SELECT * FROM prospects WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit);
    }
    return getDb().prepare('SELECT * FROM prospects ORDER BY created_at DESC LIMIT ?').all(limit);
  },
  updateStatus(id, status) {
    const current = prospects.get(id);
    if (!current) throw new Error(`Prospect not found: ${id}`);
    assertProspectStatusTransition(current.status, status);
    getDb().prepare('UPDATE prospects SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), id);
    return prospects.get(id);
  },
};

// CRM status transitions for prospects (Phase 8 vocabulary reserved in schema).
// Phase 5A never sets CONTACTED — that requires a confirmed send (Phase 5D+).
const PROSPECT_STATUS_TRANSITIONS = {
  NEW: new Set(['NEW', 'ANALYZED', 'SAMPLE_CREATED', 'PROPOSAL_READY', 'AWAITING_APPROVAL']),
  ANALYZED: new Set(['ANALYZED', 'SAMPLE_CREATED', 'PROPOSAL_READY', 'AWAITING_APPROVAL']),
  SAMPLE_CREATED: new Set(['SAMPLE_CREATED', 'PROPOSAL_READY', 'AWAITING_APPROVAL']),
  PROPOSAL_READY: new Set(['PROPOSAL_READY', 'AWAITING_APPROVAL', 'CONTACTED']),
  AWAITING_APPROVAL: new Set(['AWAITING_APPROVAL', 'CONTACTED', 'LOST']),
  CONTACTED: new Set(['CONTACTED', 'REPLIED', 'FOLLOW_UP', 'QUALIFIED', 'WON', 'LOST']),
  REPLIED: new Set(['REPLIED', 'FOLLOW_UP', 'QUALIFIED', 'WON', 'LOST']),
  FOLLOW_UP: new Set(['FOLLOW_UP', 'REPLIED', 'QUALIFIED', 'WON', 'LOST']),
  QUALIFIED: new Set(['QUALIFIED', 'CONTACTED', 'FOLLOW_UP', 'WON', 'CUSTOMER', 'LOST']),
  WON: new Set(['WON', 'CUSTOMER', 'ACTIVE_CLIENT']),
  CUSTOMER: new Set(['CUSTOMER', 'ACTIVE_CLIENT', 'COMPLETED', 'ARCHIVED']),
  ACTIVE_CLIENT: new Set(['ACTIVE_CLIENT', 'COMPLETED', 'ARCHIVED']),
  COMPLETED: new Set(['COMPLETED', 'ARCHIVED', 'ACTIVE_CLIENT']),
  ARCHIVED: new Set(['ARCHIVED']),
  LOST: new Set(['LOST', 'ARCHIVED']),
};

export function assertProspectStatusTransition(from, to) {
  if (from === to) return;
  const allowed = PROSPECT_STATUS_TRANSITIONS[from];
  if (!allowed || !allowed.has(to)) {
    throw new Error(`Invalid prospect status transition: ${from} → ${to}`);
  }
}

/** CONTACTED requires a confirmed external send — never a draft alone. */
export function assertCanMarkCustomer({ explicitAction } = {}) {
  if (!explicitAction) {
    throw new Error('CUSTOMER/WON requires an explicit business action; positive message alone is not sufficient');
  }
}

export function assertCanMarkContacted({ hasConfirmedSend } = {}) {
  if (!hasConfirmedSend) {
    throw new Error('CONTACTED requires a confirmed successful external send; outreach draft alone is not sufficient');
  }
}


// ── opportunities (Phase 3 — Real Estate Opportunity Intelligence) ───
export const opportunities = {
  createOpportunity({ id, prospectId, taskId, runId, score, priority, opportunityType, summary, identifiedProblems, recommendedServices, recommendedActions, recommendedSampleType, recommendedSampleReason, estimatedValue, confidence, status }) {
    const genId = id || nanoid(12);
    const now = new Date().toISOString();
    getDb().prepare(`
      INSERT INTO opportunities
        (id, prospect_id, task_id, run_id, score, priority, opportunity_type, summary, identified_problems_json, recommended_services_json, recommended_actions_json, recommended_sample_type, recommended_sample_reason, estimated_value, confidence, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      genId,
      prospectId,
      taskId || null,
      runId || null,
      score,
      priority,
      opportunityType || null,
      summary || null,
      JSON.stringify(identifiedProblems || []),
      JSON.stringify(recommendedServices || []),
      JSON.stringify(recommendedActions || []),
      recommendedSampleType || null,
      recommendedSampleReason || null,
      estimatedValue || null,
      confidence || null,
      status || 'NEW',
      now,
      now,
    );
    return opportunities.getOpportunity(genId);
  },
  getOpportunity(id) {
    return getDb().prepare('SELECT * FROM opportunities WHERE id = ?').get(id);
  },
  listOpportunities({ limit = 50, status, priority, minScore } = {}) {
    const clauses = [];
    const params = [];
    if (status) { clauses.push('status = ?'); params.push(status); }
    if (priority) { clauses.push('priority = ?'); params.push(priority); }
    if (typeof minScore === 'number') { clauses.push('score >= ?'); params.push(minScore); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(limit);
    return getDb().prepare(`SELECT * FROM opportunities ${where} ORDER BY score DESC, created_at DESC LIMIT ?`).all(...params);
  },
  updateOpportunity(id, fields = {}) {
    const current = opportunities.getOpportunity(id);
    if (!current) return null;
    const status = fields.status ?? current.status;
    getDb().prepare('UPDATE opportunities SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), id);
    return opportunities.getOpportunity(id);
  },
  getOpportunitiesForProspect(prospectId, { limit = 20 } = {}) {
    return getDb().prepare('SELECT * FROM opportunities WHERE prospect_id = ? ORDER BY created_at DESC LIMIT ?').all(prospectId, limit);
  },
};


// ── samples (Phase 4 — Sample & Proposal Generation) ─────────────────
export const samples = {
  create({ id, prospectId, opportunityId, taskId, runId, sampleType, contentKind, websiteSampleId, content, previewPath }) {
    if (websiteSampleId) {
      const websiteSample = getDb().prepare('SELECT * FROM website_samples WHERE id = ?').get(websiteSampleId);
      if (!websiteSample) {
        throw new Error(`Website sample not found: ${websiteSampleId}`);
      }
      if ((websiteSample.task_id || null) !== (taskId || null) || (websiteSample.run_id || null) !== (runId || null)) {
        throw new Error(`Website sample ${websiteSampleId} does not belong to the current task/run context`);
      }
      const existingLink = getDb().prepare('SELECT * FROM samples WHERE website_sample_id = ?').get(websiteSampleId);
      if (existingLink && existingLink.opportunity_id !== opportunityId) {
        throw new Error(`Website sample ${websiteSampleId} is already linked to a different opportunity`);
      }
    }

    const genId = id || nanoid(12);
    const now = new Date().toISOString();
    getDb().prepare(`
      INSERT INTO samples
        (id, prospect_id, opportunity_id, task_id, run_id, sample_type, status, content_kind, website_sample_id, concept_content_json, preview_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      genId,
      prospectId,
      opportunityId,
      taskId || null,
      runId || null,
      sampleType,
      'DRAFT',
      contentKind,
      websiteSampleId || null,
      content ? JSON.stringify(content) : null,
      previewPath || null,
      now,
      now,
    );
    return samples.get(genId);
  },
  get(id) {
    return getDb().prepare('SELECT * FROM samples WHERE id = ?').get(id);
  },
  list({ limit = 50, status, contentKind, sampleType, opportunityId } = {}) {
    const clauses = [];
    const params = [];
    if (status) { clauses.push('status = ?'); params.push(status); }
    if (contentKind) { clauses.push('content_kind = ?'); params.push(contentKind); }
    if (sampleType) { clauses.push('sample_type = ?'); params.push(sampleType); }
    if (opportunityId) { clauses.push('opportunity_id = ?'); params.push(opportunityId); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(limit);
    return getDb().prepare(`SELECT * FROM samples ${where} ORDER BY created_at DESC LIMIT ?`).all(...params);
  },
  getForOpportunity(opportunityId, { limit = 20 } = {}) {
    return getDb().prepare('SELECT * FROM samples WHERE opportunity_id = ? ORDER BY created_at DESC LIMIT ?').all(opportunityId, limit);
  },
  markSaved(id) {
    getDb().prepare("UPDATE samples SET status = 'SAVED', updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
    return samples.get(id);
  },
};


// ── proposals (Phase 4 — Sample & Proposal Generation) ───────────────
export const proposals = {
  create({ id, prospectId, opportunityId, sampleId, taskId, runId, pitch, serviceRecommendation, valueProposition, suggestedPackage, callToAction, assumptions }) {
    const genId = id || nanoid(12);
    const now = new Date().toISOString();
    getDb().prepare(`
      INSERT INTO proposals
        (id, prospect_id, opportunity_id, sample_id, task_id, run_id, status, pitch, service_recommendation, value_proposition, suggested_package, call_to_action, assumptions_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      genId,
      prospectId,
      opportunityId,
      sampleId || null,
      taskId || null,
      runId || null,
      'DRAFT',
      pitch || null,
      serviceRecommendation || null,
      valueProposition || null,
      suggestedPackage || null,
      callToAction || null,
      JSON.stringify(assumptions || []),
      now,
      now,
    );
    return proposals.get(genId);
  },
  get(id) {
    return getDb().prepare('SELECT * FROM proposals WHERE id = ?').get(id);
  },
  list({ limit = 50, status, opportunityId } = {}) {
    const clauses = [];
    const params = [];
    if (status) { clauses.push('status = ?'); params.push(status); }
    if (opportunityId) { clauses.push('opportunity_id = ?'); params.push(opportunityId); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(limit);
    return getDb().prepare(`SELECT * FROM proposals ${where} ORDER BY created_at DESC LIMIT ?`).all(...params);
  },
  getForOpportunity(opportunityId, { limit = 20 } = {}) {
    return getDb().prepare('SELECT * FROM proposals WHERE opportunity_id = ? ORDER BY created_at DESC LIMIT ?').all(opportunityId, limit);
  },
  markReady(id) {
    getDb().prepare("UPDATE proposals SET status = 'READY', updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
    return proposals.get(id);
  },
};


// ── Phase 5A outreach (preparation only — no send) ───────────────────
export function assertOutreachOwnership({ prospect, opportunity, proposal, sample, taskId, runId } = {}) {
  if (!prospect) throw new Error('Outreach ownership: prospect is required');
  if (!opportunity) throw new Error('Outreach ownership: opportunity is required');
  if (!proposal) throw new Error('Outreach ownership: proposal is required');

  if (opportunity.prospect_id !== prospect.id) {
    throw new Error('Outreach ownership: opportunity does not belong to prospect');
  }
  if (proposal.opportunity_id !== opportunity.id) {
    throw new Error('Outreach ownership: proposal does not belong to opportunity');
  }
  if (proposal.prospect_id !== prospect.id) {
    throw new Error('Outreach ownership: proposal prospect_id mismatch');
  }
  if (sample) {
    if (sample.opportunity_id !== opportunity.id) {
      throw new Error('Outreach ownership: sample does not belong to opportunity');
    }
    if (sample.prospect_id !== prospect.id) {
      throw new Error('Outreach ownership: sample prospect_id mismatch');
    }
  }

  if (taskId != null || runId != null) {
    const check = (row, label) => {
      if (!row) return;
      if (row.task_id != null && taskId != null && row.task_id !== taskId) {
        throw new Error(`Outreach ownership: ${label} task_id mismatch`);
      }
      if (row.run_id != null && runId != null && row.run_id !== runId) {
        throw new Error(`Outreach ownership: ${label} run_id mismatch`);
      }
    };
    check(prospect, 'prospect');
    check(opportunity, 'opportunity');
    check(proposal, 'proposal');
    check(sample, 'sample');
  }
}

export const outreachMessages = {
  create({
    id, prospectId, opportunityId, proposalId, sampleId, taskId, runId,
    channel, recipient, subject, body, contentHash, status,
  }) {
    const genId = id || nanoid(12);
    const now = new Date().toISOString();
    getDb().prepare(`
      INSERT INTO outreach_messages
        (id, prospect_id, opportunity_id, proposal_id, sample_id, task_id, run_id,
         channel, recipient, subject, body, content_hash, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      genId,
      prospectId,
      opportunityId,
      proposalId,
      sampleId || null,
      taskId || null,
      runId || null,
      channel,
      recipient,
      subject,
      body,
      contentHash,
      status || 'DRAFT',
      now,
      now,
    );
    return outreachMessages.get(genId);
  },
  get(id) {
    return getDb().prepare('SELECT * FROM outreach_messages WHERE id = ?').get(id);
  },
  list({ limit = 50, status, opportunityId, prospectId } = {}) {
    const clauses = [];
    const params = [];
    if (status) { clauses.push('status = ?'); params.push(status); }
    if (opportunityId) { clauses.push('opportunity_id = ?'); params.push(opportunityId); }
    if (prospectId) { clauses.push('prospect_id = ?'); params.push(prospectId); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(limit);
    return getDb().prepare(`SELECT * FROM outreach_messages ${where} ORDER BY created_at DESC LIMIT ?`).all(...params);
  },
};

export const outreachApprovals = {
  create({ id, outreachMessageId, decision, contentHash, decidedAt, decidedBy }) {
    const genId = id || nanoid(12);
    const now = new Date().toISOString();
    getDb().prepare(`
      INSERT INTO outreach_approvals
        (id, outreach_message_id, decision, content_hash, decided_at, decided_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      genId,
      outreachMessageId,
      decision || null,
      contentHash,
      decidedAt || null,
      decidedBy || null,
      now,
    );
    return outreachApprovals.get(genId);
  },
  get(id) {
    return getDb().prepare('SELECT * FROM outreach_approvals WHERE id = ?').get(id);
  },
  listForMessage(outreachMessageId, { limit = 20 } = {}) {
    return getDb().prepare(
      'SELECT * FROM outreach_approvals WHERE outreach_message_id = ? ORDER BY created_at DESC LIMIT ?',
    ).all(outreachMessageId, limit);
  },
};

export const outreachAttempts = {
  create({ id, outreachMessageId, idempotencyKey, status, providerMessageId, startedAt, finishedAt, errorMessage }) {
    const genId = id || nanoid(12);
    const now = new Date().toISOString();
    getDb().prepare(`
      INSERT INTO outreach_attempts
        (id, outreach_message_id, idempotency_key, status, provider_message_id, started_at, finished_at, error_message, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      genId,
      outreachMessageId,
      idempotencyKey,
      status || 'PENDING',
      providerMessageId || null,
      startedAt || null,
      finishedAt || null,
      errorMessage || null,
      now,
    );
    return outreachAttempts.get(genId);
  },
  get(id) {
    return getDb().prepare('SELECT * FROM outreach_attempts WHERE id = ?').get(id);
  },
  getByIdempotencyKey(key) {
    return getDb().prepare('SELECT * FROM outreach_attempts WHERE idempotency_key = ?').get(key);
  },
  listForMessage(outreachMessageId, { limit = 20 } = {}) {
    return getDb().prepare(
      'SELECT * FROM outreach_attempts WHERE outreach_message_id = ? ORDER BY created_at DESC LIMIT ?',
    ).all(outreachMessageId, limit);
  },
};


// ── notifications log (sent notifications, for audit / dashboard) ───
export const notifications = {
  record({ level, subject, body, channel, ok, errorMessage }) {
    const id = nanoid(12);
    getDb().prepare(`
      INSERT INTO notifications_log (id, level, subject, body, channel, ok, error_message, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, level, subject, body?.slice(0, 4000) || '', channel, ok ? 1 : 0, errorMessage || null, new Date().toISOString());
  },
  listRecent({ limit = 50 } = {}) {
    return getDb().prepare('SELECT * FROM notifications_log ORDER BY created_at DESC LIMIT ?').all(limit);
  },
  listForRun({ runId, limit = 50 } = {}) {
    if (!runId) return [];
    const like = `%${runId}%`;
    return getDb().prepare(
      'SELECT * FROM notifications_log WHERE body LIKE ? OR subject LIKE ? ORDER BY created_at DESC LIMIT ?',
    ).all(like, like, limit);
  },
};

export const operatorAuditLog = {
  append({ operatorId, action, toolName, requestId, idempotencyKey, target, status, details }) {
    const id = nanoid(14);
    const now = new Date().toISOString();
    getDb().prepare(`
      INSERT INTO operator_audit_log
        (id, operator_id, action, tool_name, request_id, idempotency_key, target, status, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      operatorId || 'unknown',
      action,
      toolName || null,
      requestId || null,
      idempotencyKey || null,
      target || null,
      status,
      details != null ? JSON.stringify(details) : null,
      now,
    );
    return operatorAuditLog.get(id);
  },
  get(id) {
    return getDb().prepare('SELECT * FROM operator_audit_log WHERE id = ?').get(id);
  },
  listRecent({ limit = 50, toolName } = {}) {
    if (toolName) {
      return getDb().prepare(
        'SELECT * FROM operator_audit_log WHERE tool_name = ? ORDER BY created_at DESC LIMIT ?',
      ).all(toolName, limit);
    }
    return getDb().prepare('SELECT * FROM operator_audit_log ORDER BY created_at DESC LIMIT ?').all(limit);
  },
};

export const controlIdempotency = {
  create({ idempotencyKey, operatorId, toolName, requestHash, status, result }) {
    const id = nanoid(14);
    const now = new Date().toISOString();
    getDb().prepare(`
      INSERT INTO control_idempotency
        (id, idempotency_key, operator_id, tool_name, request_hash, status, result, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      idempotencyKey,
      operatorId,
      toolName,
      requestHash,
      status,
      result != null ? JSON.stringify(result) : null,
      now,
      now,
    );
    return controlIdempotency.getByKey(idempotencyKey);
  },
  getByKey(key) {
    return getDb().prepare('SELECT * FROM control_idempotency WHERE idempotency_key = ?').get(key);
  },
  update(key, { status, result }) {
    const current = controlIdempotency.getByKey(key);
    if (!current) return null;
    getDb().prepare(`
      UPDATE control_idempotency SET status = ?, result = ?, updated_at = ? WHERE idempotency_key = ?
    `).run(
      status !== undefined ? status : current.status,
      result !== undefined ? JSON.stringify(result) : current.result,
      new Date().toISOString(),
      key,
    );
    return controlIdempotency.getByKey(key);
  },
};

export const repairSessions = {
  create({ taskId, initialRunId, currentRunId, maxAttempts, state, failureReason, diagnosis, branchName }) {
    const id = nanoid(14);
    const now = new Date().toISOString();
    getDb().prepare(`
      INSERT INTO repair_sessions
        (id, task_id, initial_run_id, current_run_id, attempt_count, max_attempts, state, failure_reason, diagnosis, branch_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      taskId || null,
      initialRunId || null,
      currentRunId || null,
      maxAttempts || 3,
      state || 'STARTED',
      failureReason || null,
      diagnosis || null,
      branchName || null,
      now,
      now,
    );
    return repairSessions.get(id);
  },
  get(id) {
    return getDb().prepare('SELECT * FROM repair_sessions WHERE id = ?').get(id);
  },
  getActiveForTask(taskId) {
    return getDb().prepare(
      `SELECT * FROM repair_sessions WHERE task_id = ? AND state NOT IN ('VERIFIED','STOPPED') ORDER BY created_at DESC LIMIT 1`,
    ).get(taskId) || null;
  },
  update(id, fields = {}) {
    const current = repairSessions.get(id);
    if (!current) return null;
    const map = {
      state: 'state',
      attemptCount: 'attempt_count',
      attempt_count: 'attempt_count',
      currentRunId: 'current_run_id',
      current_run_id: 'current_run_id',
      failureReason: 'failure_reason',
      failure_reason: 'failure_reason',
      diagnosis: 'diagnosis',
      branchName: 'branch_name',
      branch_name: 'branch_name',
    };
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(fields)) {
      const col = map[k];
      if (!col) continue;
      sets.push(`${col} = ?`);
      vals.push(v);
    }
    if (!sets.length) return current;
    sets.push('updated_at = ?');
    vals.push(new Date().toISOString());
    vals.push(id);
    getDb().prepare(`UPDATE repair_sessions SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return repairSessions.get(id);
  },
};


// ── Phase 6 outreach write methods (attached after repository objects) ──
outreachMessages.updateStatus = function updateStatus(id, status) {
  const current = outreachMessages.get(id);
  if (!current) throw new Error(`Outreach message not found: ${id}`);
  getDb().prepare(
    'UPDATE outreach_messages SET status = ?, updated_at = ? WHERE id = ?',
  ).run(status, new Date().toISOString(), id);
  return outreachMessages.get(id);
};

outreachAttempts.update = function update(id, { status, providerMessageId, startedAt, finishedAt, errorMessage } = {}) {
  const current = outreachAttempts.get(id);
  if (!current) throw new Error(`Outreach attempt not found: ${id}`);
  getDb().prepare(`
    UPDATE outreach_attempts
    SET status = ?, provider_message_id = ?, started_at = ?, finished_at = ?, error_message = ?
    WHERE id = ?
  `).run(
    status !== undefined ? status : current.status,
    providerMessageId !== undefined ? providerMessageId : current.provider_message_id,
    startedAt !== undefined ? startedAt : current.started_at,
    finishedAt !== undefined ? finishedAt : current.finished_at,
    errorMessage !== undefined ? errorMessage : current.error_message,
    id,
  );
  return outreachAttempts.get(id);
};


// ── Phase 6 CRM — companies, contacts, conversations, inbound messages ──

export const companies = {
  create({ id, name, website, domain, industry, location, notes, metadata } = {}) {
    if (!name) throw new Error('company name is required');
    const genId = id || nanoid(12);
    const now = new Date().toISOString();
    const resolvedDomain = domain || (website ? extractDomain(website) : null);
    getDb().prepare(`
      INSERT INTO companies
        (id, name, website, domain, industry, location, notes, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(genId, name, website || null, resolvedDomain, industry || null, location || null, notes || null, metadata ? JSON.stringify(metadata) : null, now, now);
    return companies.get(genId);
  },
  get(id) { return getDb().prepare('SELECT * FROM companies WHERE id = ?').get(id); },
  findByDomain(domain) {
    if (!domain) return null;
    return getDb().prepare('SELECT * FROM companies WHERE lower(domain) = lower(?) LIMIT 1').get(domain);
  },
  findByName(name) {
    if (!name) return null;
    return getDb().prepare('SELECT * FROM companies WHERE lower(name) = lower(?) LIMIT 1').get(name);
  },
  list({ limit = 50 } = {}) { return getDb().prepare('SELECT * FROM companies ORDER BY created_at DESC LIMIT ?').all(limit); },
  update(id, fields = {}) {
    const current = companies.get(id);
    if (!current) return null;
    const now = new Date().toISOString();
    getDb().prepare(`UPDATE companies SET name = ?, website = ?, domain = ?, industry = ?, location = ?, notes = ?, metadata_json = ?, updated_at = ? WHERE id = ?`).run(fields.name ?? current.name, fields.website !== undefined ? fields.website : current.website, fields.domain !== undefined ? fields.domain : current.domain, fields.industry !== undefined ? fields.industry : current.industry, fields.location !== undefined ? fields.location : current.location, fields.notes !== undefined ? fields.notes : current.notes, fields.metadata !== undefined ? JSON.stringify(fields.metadata) : current.metadata_json, now, id);
    return companies.get(id);
  },
};

export const contacts = {
  create({ id, companyId, prospectId, name, email, phone, role, externalId, metadata } = {}) {
    const genId = id || nanoid(12);
    const now = new Date().toISOString();
    getDb().prepare(`INSERT INTO contacts (id, company_id, prospect_id, name, email, phone, role, external_id, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(genId, companyId || null, prospectId || null, name || null, email ? String(email).toLowerCase().trim() : null, phone || null, role || null, externalId || null, metadata ? JSON.stringify(metadata) : null, now, now);
    return contacts.get(genId);
  },
  get(id) { return getDb().prepare('SELECT * FROM contacts WHERE id = ?').get(id); },
  findByEmail(email) {
    if (!email) return null;
    return getDb().prepare('SELECT * FROM contacts WHERE lower(email) = lower(?) LIMIT 1').get(String(email).trim());
  },
  findByExternalId(externalId) {
    if (!externalId) return null;
    return getDb().prepare('SELECT * FROM contacts WHERE external_id = ? LIMIT 1').get(externalId);
  },
  list({ limit = 50, companyId, prospectId } = {}) {
    const clauses = []; const params = [];
    if (companyId) { clauses.push('company_id = ?'); params.push(companyId); }
    if (prospectId) { clauses.push('prospect_id = ?'); params.push(prospectId); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(limit);
    return getDb().prepare(`SELECT * FROM contacts ${where} ORDER BY created_at DESC LIMIT ?`).all(...params);
  },
  update(id, fields = {}) {
    const current = contacts.get(id);
    if (!current) return null;
    const now = new Date().toISOString();
    getDb().prepare(`UPDATE contacts SET company_id = ?, prospect_id = ?, name = ?, email = ?, phone = ?, role = ?, external_id = ?, metadata_json = ?, updated_at = ? WHERE id = ?`).run(fields.companyId !== undefined ? fields.companyId : current.company_id, fields.prospectId !== undefined ? fields.prospectId : current.prospect_id, fields.name !== undefined ? fields.name : current.name, fields.email !== undefined ? (fields.email ? String(fields.email).toLowerCase().trim() : null) : current.email, fields.phone !== undefined ? fields.phone : current.phone, fields.role !== undefined ? fields.role : current.role, fields.externalId !== undefined ? fields.externalId : current.external_id, fields.metadata !== undefined ? JSON.stringify(fields.metadata) : current.metadata_json, now, id);
    return contacts.get(id);
  },
};

export const conversations = {
  create({ id, companyId, contactId, prospectId, channel, externalThreadId, status, subject, summary } = {}) {
    if (!channel) throw new Error('conversation channel is required');
    const genId = id || nanoid(12);
    const now = new Date().toISOString();
    getDb().prepare(`INSERT INTO conversations (id, company_id, contact_id, prospect_id, channel, external_thread_id, status, subject, summary, last_message_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(genId, companyId || null, contactId || null, prospectId || null, channel, externalThreadId || null, status || 'OPEN', subject || null, summary || null, null, now, now);
    return conversations.get(genId);
  },
  get(id) { return getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(id); },
  findByExternalThread(channel, externalThreadId) {
    if (!channel || !externalThreadId) return null;
    return getDb().prepare('SELECT * FROM conversations WHERE channel = ? AND external_thread_id = ? LIMIT 1').get(channel, externalThreadId);
  },
  list({ limit = 50, status, contactId, companyId, prospectId } = {}) {
    const clauses = []; const params = [];
    if (status) { clauses.push('status = ?'); params.push(status); }
    if (contactId) { clauses.push('contact_id = ?'); params.push(contactId); }
    if (companyId) { clauses.push('company_id = ?'); params.push(companyId); }
    if (prospectId) { clauses.push('prospect_id = ?'); params.push(prospectId); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(limit);
    return getDb().prepare(`SELECT * FROM conversations ${where} ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT ?`).all(...params);
  },
  update(id, fields = {}) {
    const current = conversations.get(id);
    if (!current) return null;
    const now = new Date().toISOString();
    getDb().prepare(`UPDATE conversations SET company_id = ?, contact_id = ?, prospect_id = ?, status = ?, subject = ?, summary = ?, last_message_at = ?, updated_at = ? WHERE id = ?`).run(fields.companyId !== undefined ? fields.companyId : current.company_id, fields.contactId !== undefined ? fields.contactId : current.contact_id, fields.prospectId !== undefined ? fields.prospectId : current.prospect_id, fields.status !== undefined ? fields.status : current.status, fields.subject !== undefined ? fields.subject : current.subject, fields.summary !== undefined ? fields.summary : current.summary, fields.lastMessageAt !== undefined ? fields.lastMessageAt : current.last_message_at, now, id);
    return conversations.get(id);
  },
};

export const inboundMessages = {
  create({ id, conversationId, companyId, contactId, prospectId, provider, externalMessageId, direction, sender, recipient, subject, body, receivedAt, intent, classification, extractedData, rawMetadata } = {}) {
    if (!conversationId) throw new Error('conversationId is required');
    if (!provider) throw new Error('provider is required');
    const genId = id || nanoid(14);
    const now = new Date().toISOString();
    getDb().prepare(`INSERT INTO inbound_messages (id, conversation_id, company_id, contact_id, prospect_id, provider, external_message_id, direction, sender, recipient, subject, body, received_at, intent, classification, extracted_data_json, raw_metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(genId, conversationId, companyId || null, contactId || null, prospectId || null, provider, externalMessageId || null, direction || 'inbound', sender || null, recipient || null, subject || null, body || null, receivedAt || now, intent || null, classification || null, extractedData ? JSON.stringify(extractedData) : null, rawMetadata ? JSON.stringify(rawMetadata) : null, now);
    return inboundMessages.get(genId);
  },
  get(id) { return getDb().prepare('SELECT * FROM inbound_messages WHERE id = ?').get(id); },
  findByProviderExternalId(provider, externalMessageId) {
    if (!provider || !externalMessageId) return null;
    return getDb().prepare('SELECT * FROM inbound_messages WHERE provider = ? AND external_message_id = ? LIMIT 1').get(provider, externalMessageId);
  },
  list({ limit = 50, conversationId, contactId, prospectId, classification } = {}) {
    const clauses = []; const params = [];
    if (conversationId) { clauses.push('conversation_id = ?'); params.push(conversationId); }
    if (contactId) { clauses.push('contact_id = ?'); params.push(contactId); }
    if (prospectId) { clauses.push('prospect_id = ?'); params.push(prospectId); }
    if (classification) { clauses.push('classification = ?'); params.push(classification); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(limit);
    return getDb().prepare(`SELECT * FROM inbound_messages ${where} ORDER BY received_at DESC LIMIT ?`).all(...params);
  },
};

function extractDomain(urlOrHost) {
  if (!urlOrHost) return null;
  try {
    const withProto = String(urlOrHost).includes('://') ? urlOrHost : `https://${urlOrHost}`;
    return new URL(withProto).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return String(urlOrHost).replace(/^www\./, '').toLowerCase() || null;
  }
}


export const MEMORY_CONFIDENCE = Object.freeze({ CONFIRMED_BY_CLIENT: 'CONFIRMED_BY_CLIENT', CONFIRMED_BY_SYSTEM: 'CONFIRMED_BY_SYSTEM', INFERRED: 'INFERRED', UNKNOWN: 'UNKNOWN' });
export const clientMemory = {
  create({ id, companyId, contactId, prospectId, key, value, confidence, source, sourceMessageId, notes, expiresAt } = {}) {
    if (!key) throw new Error('memory key is required');
    if (value === undefined || value === null) throw new Error('memory value is required');
    const genId = id || nanoid(12); const now = new Date().toISOString();
    const conf = confidence && MEMORY_CONFIDENCE[confidence] ? confidence : 'INFERRED';
    getDb().prepare(`INSERT INTO client_memory (id, company_id, contact_id, prospect_id, key, value, confidence, source, source_message_id, notes, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(genId, companyId||null, contactId||null, prospectId||null, key, String(value), conf, source||'system', sourceMessageId||null, notes||null, now, now, expiresAt||null);
    return clientMemory.get(genId);
  },
  get(id) { return getDb().prepare('SELECT * FROM client_memory WHERE id = ?').get(id); },
  list({ companyId, contactId, prospectId, key, limit = 100 } = {}) {
    const clauses = []; const params = [];
    if (companyId) { clauses.push('company_id = ?'); params.push(companyId); }
    if (contactId) { clauses.push('contact_id = ?'); params.push(contactId); }
    if (prospectId) { clauses.push('prospect_id = ?'); params.push(prospectId); }
    if (key) { clauses.push('key = ?'); params.push(key); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''; params.push(limit);
    return getDb().prepare(`SELECT * FROM client_memory ${where} ORDER BY updated_at DESC LIMIT ?`).all(...params);
  },
  findCurrent(scope, key) {
    const rows = clientMemory.list({ ...scope, key, limit: 20 });
    const rank = { CONFIRMED_BY_CLIENT: 3, CONFIRMED_BY_SYSTEM: 2, INFERRED: 1, UNKNOWN: 0 };
    rows.sort((a, b) => (rank[b.confidence]||0) - (rank[a.confidence]||0));
    return rows[0] || null;
  },
  upsertFact({ companyId, contactId, prospectId, key, value, confidence, source, sourceMessageId, notes } = {}) {
    const current = clientMemory.findCurrent({ companyId, contactId, prospectId }, key);
    const conf = confidence && MEMORY_CONFIDENCE[confidence] ? confidence : 'INFERRED';
    if (current && current.value === String(value) && current.confidence === conf) return { entry: current, changed: false };
    if (current && current.confidence === 'CONFIRMED_BY_CLIENT' && conf === 'INFERRED') return { entry: current, changed: false, blocked: true };
    const entry = clientMemory.create({ companyId: companyId || current?.company_id, contactId: contactId || current?.contact_id, prospectId: prospectId || current?.prospect_id, key, value, confidence: conf, source, sourceMessageId, notes: notes || (current ? `supersedes ${current.id}` : null) });
    return { entry, changed: true, previous: current || null };
  },
};
export const conversationInsights = {
  get(conversationId) { return getDb().prepare('SELECT * FROM conversation_insights WHERE conversation_id = ?').get(conversationId); },
  upsert(conversationId, fields = {}) {
    const current = conversationInsights.get(conversationId); const now = new Date().toISOString();
    if (!current) {
      getDb().prepare(`INSERT INTO conversation_insights (conversation_id, message_count, latest_message_id, current_intent, current_classification, summary, facts_json, requested_service, requested_deliverables, deadline, budget, unresolved_questions_json, next_action, next_action_reason, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(conversationId, fields.messageCount??0, fields.latestMessageId||null, fields.currentIntent||null, fields.currentClassification||null, fields.summary||null, fields.facts?JSON.stringify(fields.facts):null, fields.requestedService||null, fields.requestedDeliverables||null, fields.deadline||null, fields.budget||null, fields.unresolvedQuestions?JSON.stringify(fields.unresolvedQuestions):null, fields.nextAction||null, fields.nextActionReason||null, now);
    } else {
      getDb().prepare(`UPDATE conversation_insights SET message_count=?, latest_message_id=?, current_intent=?, current_classification=?, summary=?, facts_json=?, requested_service=?, requested_deliverables=?, deadline=?, budget=?, unresolved_questions_json=?, next_action=?, next_action_reason=?, updated_at=? WHERE conversation_id=?`).run(fields.messageCount??current.message_count, fields.latestMessageId!==undefined?fields.latestMessageId:current.latest_message_id, fields.currentIntent!==undefined?fields.currentIntent:current.current_intent, fields.currentClassification!==undefined?fields.currentClassification:current.current_classification, fields.summary!==undefined?fields.summary:current.summary, fields.facts!==undefined?JSON.stringify(fields.facts):current.facts_json, fields.requestedService!==undefined?fields.requestedService:current.requested_service, fields.requestedDeliverables!==undefined?fields.requestedDeliverables:current.requested_deliverables, fields.deadline!==undefined?fields.deadline:current.deadline, fields.budget!==undefined?fields.budget:current.budget, fields.unresolvedQuestions!==undefined?JSON.stringify(fields.unresolvedQuestions):current.unresolved_questions_json, fields.nextAction!==undefined?fields.nextAction:current.next_action, fields.nextActionReason!==undefined?fields.nextActionReason:current.next_action_reason, now, conversationId);
    }
    return conversationInsights.get(conversationId);
  },
};
