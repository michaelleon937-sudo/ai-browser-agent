// database/bi-store.js
// Phase 7 BI data access — relationship, timeline, follow-ups, revenue.
import { nanoid } from 'nanoid';
import { getDb } from './index.js';

const BI_SCHEMA_SQL = "-- Phase 7 BI — Business Relationship & Intelligence Engine\n\nCREATE TABLE IF NOT EXISTS relationship_states (\n  id                TEXT PRIMARY KEY,\n  company_id        TEXT,\n  contact_id        TEXT,\n  prospect_id       TEXT,\n  state             TEXT NOT NULL DEFAULT 'NEW',\n  previous_state    TEXT,\n  reason            TEXT,\n  source            TEXT NOT NULL DEFAULT 'system',\n  confidence        TEXT NOT NULL DEFAULT 'CONFIRMED_BY_SYSTEM',\n  metadata_json     TEXT,\n  computed_at       TEXT NOT NULL,\n  created_at        TEXT NOT NULL,\n  updated_at        TEXT NOT NULL,\n  FOREIGN KEY (company_id) REFERENCES companies(id),\n  FOREIGN KEY (contact_id) REFERENCES contacts(id),\n  FOREIGN KEY (prospect_id) REFERENCES prospects(id)\n);\n\nCREATE INDEX IF NOT EXISTS idx_relationship_states_company ON relationship_states (company_id);\nCREATE INDEX IF NOT EXISTS idx_relationship_states_contact ON relationship_states (contact_id);\nCREATE INDEX IF NOT EXISTS idx_relationship_states_prospect ON relationship_states (prospect_id);\nCREATE INDEX IF NOT EXISTS idx_relationship_states_state ON relationship_states (state);\nCREATE INDEX IF NOT EXISTS idx_relationship_states_updated ON relationship_states (updated_at);\n\nCREATE TABLE IF NOT EXISTS client_timeline_events (\n  id                TEXT PRIMARY KEY,\n  company_id        TEXT,\n  contact_id        TEXT,\n  prospect_id       TEXT,\n  opportunity_id    TEXT,\n  project_id        TEXT,\n  invoice_id        TEXT,\n  payment_id        TEXT,\n  conversation_id   TEXT,\n  event_type        TEXT NOT NULL,\n  title             TEXT NOT NULL,\n  summary           TEXT,\n  actor             TEXT,\n  source            TEXT NOT NULL DEFAULT 'system',\n  confidence        TEXT NOT NULL DEFAULT 'CONFIRMED_BY_SYSTEM',\n  amount            REAL,\n  currency          TEXT,\n  metadata_json     TEXT,\n  occurred_at       TEXT NOT NULL,\n  created_at        TEXT NOT NULL,\n  FOREIGN KEY (company_id) REFERENCES companies(id),\n  FOREIGN KEY (contact_id) REFERENCES contacts(id),\n  FOREIGN KEY (prospect_id) REFERENCES prospects(id)\n);\n\nCREATE INDEX IF NOT EXISTS idx_timeline_company ON client_timeline_events (company_id);\nCREATE INDEX IF NOT EXISTS idx_timeline_contact ON client_timeline_events (contact_id);\nCREATE INDEX IF NOT EXISTS idx_timeline_prospect ON client_timeline_events (prospect_id);\nCREATE INDEX IF NOT EXISTS idx_timeline_type ON client_timeline_events (event_type);\nCREATE INDEX IF NOT EXISTS idx_timeline_occurred ON client_timeline_events (occurred_at);\n\nCREATE TABLE IF NOT EXISTS follow_up_recommendations (\n  id                TEXT PRIMARY KEY,\n  company_id        TEXT,\n  contact_id        TEXT,\n  prospect_id       TEXT,\n  conversation_id   TEXT,\n  opportunity_id    TEXT,\n  recommendation_type TEXT NOT NULL,\n  priority          TEXT NOT NULL DEFAULT 'MEDIUM',\n  reason            TEXT NOT NULL,\n  suggested_action  TEXT NOT NULL,\n  due_at            TEXT,\n  status            TEXT NOT NULL DEFAULT 'OPEN',\n  external_side_effect INTEGER NOT NULL DEFAULT 0,\n  source            TEXT NOT NULL DEFAULT 'system',\n  confidence        TEXT NOT NULL DEFAULT 'INFERRED',\n  metadata_json     TEXT,\n  created_at        TEXT NOT NULL,\n  updated_at        TEXT NOT NULL,\n  resolved_at       TEXT,\n  resolved_by       TEXT,\n  FOREIGN KEY (company_id) REFERENCES companies(id),\n  FOREIGN KEY (contact_id) REFERENCES contacts(id),\n  FOREIGN KEY (prospect_id) REFERENCES prospects(id)\n);\n\nCREATE INDEX IF NOT EXISTS idx_followups_status ON follow_up_recommendations (status);\nCREATE INDEX IF NOT EXISTS idx_followups_company ON follow_up_recommendations (company_id);\nCREATE INDEX IF NOT EXISTS idx_followups_due ON follow_up_recommendations (due_at);\nCREATE INDEX IF NOT EXISTS idx_followups_priority ON follow_up_recommendations (priority);\n\nCREATE TABLE IF NOT EXISTS client_revenue_snapshots (\n  id                TEXT PRIMARY KEY,\n  company_id        TEXT,\n  contact_id        TEXT,\n  prospect_id       TEXT,\n  total_invoiced    REAL NOT NULL DEFAULT 0,\n  total_paid        REAL NOT NULL DEFAULT 0,\n  total_outstanding REAL NOT NULL DEFAULT 0,\n  invoice_count     INTEGER NOT NULL DEFAULT 0,\n  payment_count     INTEGER NOT NULL DEFAULT 0,\n  project_count     INTEGER NOT NULL DEFAULT 0,\n  currency          TEXT NOT NULL DEFAULT 'USD',\n  first_revenue_at  TEXT,\n  last_revenue_at   TEXT,\n  computed_at       TEXT NOT NULL,\n  metadata_json     TEXT,\n  FOREIGN KEY (company_id) REFERENCES companies(id),\n  FOREIGN KEY (contact_id) REFERENCES contacts(id),\n  FOREIGN KEY (prospect_id) REFERENCES prospects(id)\n);\n\nCREATE INDEX IF NOT EXISTS idx_revenue_company ON client_revenue_snapshots (company_id);\nCREATE INDEX IF NOT EXISTS idx_revenue_computed ON client_revenue_snapshots (computed_at);\n";
let _biSchemaReady = false;
function ensureBiSchema() {
  if (_biSchemaReady) return;
  getDb().exec(BI_SCHEMA_SQL);
  _biSchemaReady = true;
}
function db() {
  ensureBiSchema();
  return getDb();
}



// ── Phase 7 BI — Relationship, Timeline, Follow-ups, Revenue ──

export const RELATIONSHIP_STATE_VALUES = Object.freeze([
  'NEW', 'CONTACTED', 'ENGAGED', 'QUALIFIED', 'OPPORTUNITY', 'PROPOSAL',
  'NEGOTIATION', 'CUSTOMER', 'ACTIVE_PROJECT', 'PAID', 'DORMANT', 'CHURN_RISK', 'LOST',
]);

export const relationshipStates = {
  get(id) {
    return db().prepare('SELECT * FROM relationship_states WHERE id = ?').get(id);
  },
  getCurrent({ companyId, contactId, prospectId } = {}) {
    const clauses = [];
    const params = [];
    if (companyId) { clauses.push('company_id = ?'); params.push(companyId); }
    if (contactId) { clauses.push('contact_id = ?'); params.push(contactId); }
    if (prospectId) { clauses.push('prospect_id = ?'); params.push(prospectId); }
    if (!clauses.length) return null;
    const where = clauses.join(' AND ');
    return db().prepare(
      `SELECT * FROM relationship_states WHERE ${where} ORDER BY updated_at DESC LIMIT 1`
    ).get(...params);
  },
  listHistory({ companyId, contactId, prospectId, limit = 50 } = {}) {
    const clauses = [];
    const params = [];
    if (companyId) { clauses.push('company_id = ?'); params.push(companyId); }
    if (contactId) { clauses.push('contact_id = ?'); params.push(contactId); }
    if (prospectId) { clauses.push('prospect_id = ?'); params.push(prospectId); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(limit);
    return db().prepare(
      `SELECT * FROM relationship_states ${where} ORDER BY updated_at DESC LIMIT ?`
    ).all(...params);
  },
  transition({ companyId, contactId, prospectId, state, reason, source, confidence, metadata } = {}) {
    if (!state) throw new Error('state is required');
    if (!RELATIONSHIP_STATE_VALUES.includes(state)) throw new Error(`Invalid relationship state: ${state}`);
    const current = relationshipStates.getCurrent({ companyId, contactId, prospectId });
    const id = nanoid(12);
    const now = new Date().toISOString();
    db().prepare(
      `INSERT INTO relationship_states
        (id, company_id, contact_id, prospect_id, state, previous_state, reason, source, confidence, metadata_json, computed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      companyId || null,
      contactId || null,
      prospectId || null,
      state,
      current?.state || null,
      reason || null,
      source || 'system',
      confidence || 'CONFIRMED_BY_SYSTEM',
      metadata ? JSON.stringify(metadata) : null,
      now,
      now,
      now,
    );
    return relationshipStates.get(id);
  },
};

export const clientTimelineEvents = {
  get(id) {
    return db().prepare('SELECT * FROM client_timeline_events WHERE id = ?').get(id);
  },
  list({ companyId, contactId, prospectId, eventType, limit = 100 } = {}) {
    const clauses = [];
    const params = [];
    if (companyId) { clauses.push('company_id = ?'); params.push(companyId); }
    if (contactId) { clauses.push('contact_id = ?'); params.push(contactId); }
    if (prospectId) { clauses.push('prospect_id = ?'); params.push(prospectId); }
    if (eventType) { clauses.push('event_type = ?'); params.push(eventType); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(limit);
    return db().prepare(
      `SELECT * FROM client_timeline_events ${where} ORDER BY occurred_at DESC LIMIT ?`
    ).all(...params);
  },
  record({
    id, companyId, contactId, prospectId, opportunityId, projectId, invoiceId, paymentId,
    conversationId, eventType, title, summary, actor, source, confidence, amount, currency,
    metadata, occurredAt,
  } = {}) {
    if (!eventType) throw new Error('eventType is required');
    if (!title) throw new Error('title is required');
    const genId = id || nanoid(12);
    const now = new Date().toISOString();
    db().prepare(
      `INSERT INTO client_timeline_events
        (id, company_id, contact_id, prospect_id, opportunity_id, project_id, invoice_id, payment_id,
         conversation_id, event_type, title, summary, actor, source, confidence, amount, currency,
         metadata_json, occurred_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      genId,
      companyId || null,
      contactId || null,
      prospectId || null,
      opportunityId || null,
      projectId || null,
      invoiceId || null,
      paymentId || null,
      conversationId || null,
      eventType,
      title,
      summary || null,
      actor || null,
      source || 'system',
      confidence || 'CONFIRMED_BY_SYSTEM',
      amount != null ? Number(amount) : null,
      currency || null,
      metadata ? JSON.stringify(metadata) : null,
      occurredAt || now,
      now,
    );
    return clientTimelineEvents.get(genId);
  },
};

export const followUpRecommendations = {
  get(id) {
    return db().prepare('SELECT * FROM follow_up_recommendations WHERE id = ?').get(id);
  },
  list({ companyId, contactId, prospectId, status, limit = 50 } = {}) {
    const clauses = [];
    const params = [];
    if (companyId) { clauses.push('company_id = ?'); params.push(companyId); }
    if (contactId) { clauses.push('contact_id = ?'); params.push(contactId); }
    if (prospectId) { clauses.push('prospect_id = ?'); params.push(prospectId); }
    if (status) { clauses.push('status = ?'); params.push(status); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(limit);
    return db().prepare(
      `SELECT * FROM follow_up_recommendations ${where} ORDER BY
        CASE priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END,
        CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at ASC,
        created_at DESC
       LIMIT ?`
    ).all(...params);
  },
  create({
    companyId, contactId, prospectId, conversationId, opportunityId,
    recommendationType, priority, reason, suggestedAction, dueAt,
    externalSideEffect, source, confidence, metadata,
  } = {}) {
    if (!recommendationType) throw new Error('recommendationType is required');
    if (!reason) throw new Error('reason is required');
    if (!suggestedAction) throw new Error('suggestedAction is required');
    const id = nanoid(12);
    const now = new Date().toISOString();
    db().prepare(
      `INSERT INTO follow_up_recommendations
        (id, company_id, contact_id, prospect_id, conversation_id, opportunity_id,
         recommendation_type, priority, reason, suggested_action, due_at, status,
         external_side_effect, source, confidence, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      companyId || null,
      contactId || null,
      prospectId || null,
      conversationId || null,
      opportunityId || null,
      recommendationType,
      priority || 'MEDIUM',
      reason,
      suggestedAction,
      dueAt || null,
      externalSideEffect ? 1 : 0,
      source || 'system',
      confidence || 'INFERRED',
      metadata ? JSON.stringify(metadata) : null,
      now,
      now,
    );
    return followUpRecommendations.get(id);
  },
  resolve(id, { resolvedBy, status = 'RESOLVED' } = {}) {
    const current = followUpRecommendations.get(id);
    if (!current) return null;
    const now = new Date().toISOString();
    db().prepare(
      `UPDATE follow_up_recommendations SET status = ?, resolved_at = ?, resolved_by = ?, updated_at = ? WHERE id = ?`
    ).run(status, now, resolvedBy || 'operator', now, id);
    return followUpRecommendations.get(id);
  },
};

export const clientRevenueSnapshots = {
  get(id) {
    return db().prepare('SELECT * FROM client_revenue_snapshots WHERE id = ?').get(id);
  },
  getLatest({ companyId, contactId, prospectId } = {}) {
    const clauses = [];
    const params = [];
    if (companyId) { clauses.push('company_id = ?'); params.push(companyId); }
    if (contactId) { clauses.push('contact_id = ?'); params.push(contactId); }
    if (prospectId) { clauses.push('prospect_id = ?'); params.push(prospectId); }
    if (!clauses.length) return null;
    return db().prepare(
      `SELECT * FROM client_revenue_snapshots WHERE ${clauses.join(' AND ')} ORDER BY computed_at DESC LIMIT 1`
    ).get(...params);
  },
  upsert({
    companyId, contactId, prospectId, totalInvoiced, totalPaid, totalOutstanding,
    invoiceCount, paymentCount, projectCount, currency, firstRevenueAt, lastRevenueAt, metadata,
  } = {}) {
    const id = nanoid(12);
    const now = new Date().toISOString();
    db().prepare(
      `INSERT INTO client_revenue_snapshots
        (id, company_id, contact_id, prospect_id, total_invoiced, total_paid, total_outstanding,
         invoice_count, payment_count, project_count, currency, first_revenue_at, last_revenue_at,
         computed_at, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      companyId || null,
      contactId || null,
      prospectId || null,
      Number(totalInvoiced) || 0,
      Number(totalPaid) || 0,
      Number(totalOutstanding) || 0,
      Number(invoiceCount) || 0,
      Number(paymentCount) || 0,
      Number(projectCount) || 0,
      currency || 'USD',
      firstRevenueAt || null,
      lastRevenueAt || null,
      now,
      metadata ? JSON.stringify(metadata) : null,
    );
    return clientRevenueSnapshots.get(id);
  },
  list({ limit = 50 } = {}) {
    return db().prepare(
      `SELECT * FROM client_revenue_snapshots ORDER BY computed_at DESC LIMIT ?`
    ).all(limit);
  },
};
