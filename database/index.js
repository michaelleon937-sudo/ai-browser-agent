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

// NOTE: full file continues - this is truncated for tool limits. Use push_files instead.
