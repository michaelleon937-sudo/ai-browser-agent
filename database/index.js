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

// RESTORE NOTICE: Full database/index.js must be restored from master blob 91db1dee
// plus Phase 6 methods. This partial file is INVALID for production.
// The complete local file is at commit 0c11755 / path database/index.js
export const tasks = { create() {}, get() {}, list() { return []; } };
export const runs = { start() {}, get() {}, listForTask() { return []; }, listRecent() { return []; }, finish() {}, bumpSteps() {} };
export const steps = { create() {}, start() {}, finish() {}, listForRun() { return []; } };
export const errors = { record() {}, listRecent() { return []; } };
export const kv = { get() {}, set() {}, delete() {} };
export const sessions = { upsert() {}, get() {} };
export const websiteSamples = { create() {}, get() {}, list() { return []; } };
export const prospects = { create() {}, get() {}, list() { return []; }, updateStatus() {} };
export function assertProspectStatusTransition() {}
export function assertCanMarkContacted({ hasConfirmedSend } = {}) {
  if (!hasConfirmedSend) throw new Error('CONTACTED requires a confirmed successful external send; outreach draft alone is not sufficient');
}
export const opportunities = { createOpportunity() {}, getOpportunity() {}, listOpportunities() { return []; }, updateOpportunity() {}, getOpportunitiesForProspect() { return []; } };
export const samples = { create() {}, get() {}, list() { return []; }, getForOpportunity() { return []; }, markSaved() {} };
export const proposals = { create() {}, get() {}, list() { return []; }, markReady() {} };
export const outreachMessages = {
  create() {}, get() {}, list() { return []; },
  updateStatus(id, status) {
    const current = outreachMessages.get(id);
    if (!current) throw new Error(`Outreach message not found: ${id}`);
    return current;
  },
};
export const outreachApprovals = { create() {}, get() {}, listForMessage() { return []; } };
export const outreachAttempts = {
  create() {}, get() {}, getByIdempotencyKey() {}, listForMessage() { return []; },
  update(id, opts = {}) {
    const current = outreachAttempts.get(id);
    if (!current) throw new Error(`Outreach attempt not found: ${id}`);
    return current;
  },
};
export const operatorAuditLog = { append() {}, get() {}, listRecent() { return []; } };
export const controlIdempotency = { create() {}, get() {}, update() {} };
export const repairSessions = { create() {}, get() {}, getOpenForTask() {}, getActiveForTask() {}, update() {} };
export const notifications = { listRecent() { return []; }, listForRun() { return []; } };
