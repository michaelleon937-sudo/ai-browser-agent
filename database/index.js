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
