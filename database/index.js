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
  CONTACTED: new Set(['CONTACTED', 'REPLIED', 'FOLLOW_UP', 'WON', 'LOST']),
  REPLIED: new Set(['REPLIED', 'FOLLOW_UP', 'WON', 'LOST']),
  FOLLOW_UP: new Set(['FOLLOW_UP', 'REPLIED', 'WON', 'LOST']),
  WON: new Set(['WON']),
  LOST: new Set(['LOST']),
};

export function assertProspectStatusTransition(from, to) {
  if (from === to) return;
  const allowed = PROSPECT_STATUS_TRANSITIONS[from];
  if (!allowed || !allowed.has(to)) {
    throw new Error(`Invalid prospect status transition: ${from} → ${to}`);
  }
}

/** CONTACTED requires a confirmed external send — never a draft alone. */
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
};
