// database/index.js
// Data access layer on top of better-sqlite3. Single file DB (config.database.path),
// WAL mode for concurrent dashboard reads while the agent writes.
// Exposes small, purpose-built repositories rather than a generic ORM so the
// rest of the codebase stays easy to audit.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let db = null;

export function getDb() {
  if (!db) {
    const dbPath = config.database.path;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

export function migrate() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  getDb().exec(schema);
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export const tasks = {
  create({ name, description = null, schedule = null, config: taskConfig = {}, enabled = 1 } = {}) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `INSERT INTO tasks (id, name, description, schedule, config, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, name, description, schedule, JSON.stringify(taskConfig || {}), enabled ? 1 : 0, now, now);
    return tasks.get(id);
  },

  get(id) {
    const row = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    return row ? hydrateTask(row) : null;
  },

  list({ enabled = null, limit = 100, offset = 0 } = {}) {
    let sql = 'SELECT * FROM tasks';
    const params = [];
    if (enabled !== null && enabled !== undefined) {
      sql += ' WHERE enabled = ?';
      params.push(enabled ? 1 : 0);
    }
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    return getDb()
      .prepare(sql)
      .all(...params)
      .map(hydrateTask);
  },

  update(id, fields = {}) {
    const allowed = ['name', 'description', 'schedule', 'config', 'enabled'];
    const sets = [];
    const params = [];
    for (const key of allowed) {
      if (key in fields) {
        sets.push(`${key} = ?`);
        params.push(key === 'config' ? JSON.stringify(fields[key] || {}) : fields[key]);
      }
    }
    if (!sets.length) return tasks.get(id);
    sets.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(id);
    getDb()
      .prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params);
    return tasks.get(id);
  },

  remove(id) {
    getDb().prepare('DELETE FROM tasks WHERE id = ?').run(id);
  },
};

function hydrateTask(row) {
  if (!row) return null;
  return {
    ...row,
    config: typeof row.config === 'string' ? JSON.parse(row.config || '{}') : row.config,
    enabled: !!row.enabled,
  };
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export const runs = {
  create({ taskId, status = 'pending', trigger = 'manual' } = {}) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `INSERT INTO runs (id, task_id, status, trigger, started_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, taskId, status, trigger, now, now);
    return runs.get(id);
  },

  get(id) {
    const row = getDb().prepare('SELECT * FROM runs WHERE id = ?').get(id);
    return row ? hydrateRun(row) : null;
  },

  list({ taskId = null, status = null, limit = 50, offset = 0 } = {}) {
    let sql = 'SELECT * FROM runs WHERE 1=1';
    const params = [];
    if (taskId) {
      sql += ' AND task_id = ?';
      params.push(taskId);
    }
    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    return getDb()
      .prepare(sql)
      .all(...params)
      .map(hydrateRun);
  },

  update(id, fields = {}) {
    const allowed = ['status', 'finished_at', 'error_message', 'summary'];
    const sets = [];
    const params = [];
    for (const key of allowed) {
      if (key in fields) {
        sets.push(`${key} = ?`);
        params.push(fields[key]);
      }
    }
    if (!sets.length) return runs.get(id);
    params.push(id);
    getDb()
      .prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params);
    return runs.get(id);
  },

  listForTask(taskId, { limit = 20 } = {}) {
    return runs.list({ taskId, limit });
  },
};

function hydrateRun(row) {
  if (!row) return null;
  return { ...row };
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export const steps = {
  create({ runId, stepIndex, action, input = null, output = null, status = 'pending', error = null } = {}) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `INSERT INTO steps (id, run_id, step_index, action, input, output, status, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        runId,
        stepIndex,
        action,
        input != null ? JSON.stringify(input) : null,
        output != null ? JSON.stringify(output) : null,
        status,
        error,
        now,
      );
    return steps.get(id);
  },

  get(id) {
    const row = getDb().prepare('SELECT * FROM steps WHERE id = ?').get(id);
    return row ? hydrateStep(row) : null;
  },

  listForRun(runId) {
    return getDb()
      .prepare('SELECT * FROM steps WHERE run_id = ? ORDER BY step_index ASC')
      .all(runId)
      .map(hydrateStep);
  },

  update(id, fields = {}) {
    const allowed = ['status', 'output', 'error', 'finished_at'];
    const sets = [];
    const params = [];
    for (const key of allowed) {
      if (key in fields) {
        sets.push(`${key} = ?`);
        const val = key === 'output' && fields[key] != null ? JSON.stringify(fields[key]) : fields[key];
        params.push(val);
      }
    }
    if (!sets.length) return steps.get(id);
    params.push(id);
    getDb()
      .prepare(`UPDATE steps SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params);
    return steps.get(id);
  },
};

function hydrateStep(row) {
  if (!row) return null;
  return {
    ...row,
    input: row.input ? JSON.parse(row.input) : null,
    output: row.output ? JSON.parse(row.output) : null,
  };
}

// ---------------------------------------------------------------------------
// Errors / events (lightweight)
// ---------------------------------------------------------------------------

export const errors = {
  create({ runId = null, taskId = null, message, context = null } = {}) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `INSERT INTO errors (id, run_id, task_id, message, context, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, runId, taskId, message, context != null ? JSON.stringify(context) : null, now);
    return errors.get(id);
  },

  get(id) {
    const row = getDb().prepare('SELECT * FROM errors WHERE id = ?').get(id);
    if (!row) return null;
    return {
      ...row,
      context: row.context ? JSON.parse(row.context) : null,
    };
  },

  list({ runId = null, limit = 50 } = {}) {
    let sql = 'SELECT * FROM errors WHERE 1=1';
    const params = [];
    if (runId) {
      sql += ' AND run_id = ?';
      params.push(runId);
    }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);
    return getDb()
      .prepare(sql)
      .all(...params)
      .map((row) => ({
        ...row,
        context: row.context ? JSON.parse(row.context) : null,
      }));
  },
};

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export const notifications = {
  create({ runId = null, taskId = null, channel, recipient, subject = null, body = null, status = 'pending' } = {}) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `INSERT INTO notifications (id, run_id, task_id, channel, recipient, subject, body, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, runId, taskId, channel, recipient, subject, body, status, now);
    return notifications.get(id);
  },

  get(id) {
    return getDb().prepare('SELECT * FROM notifications WHERE id = ?').get(id) || null;
  },

  list({ limit = 50 } = {}) {
    return getDb()
      .prepare('SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?')
      .all(limit);
  },

  listForRun(runId) {
    return getDb()
      .prepare('SELECT * FROM notifications WHERE run_id = ? ORDER BY created_at DESC')
      .all(runId);
  },

  update(id, fields = {}) {
    const allowed = ['status', 'sent_at', 'error'];
    const sets = [];
    const params = [];
    for (const key of allowed) {
      if (key in fields) {
        sets.push(`${key} = ?`);
        params.push(fields[key]);
      }
    }
    if (!sets.length) return notifications.get(id);
    params.push(id);
    getDb()
      .prepare(`UPDATE notifications SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params);
    return notifications.get(id);
  },
};

// ---------------------------------------------------------------------------
// Operator audit log (Control Layer)
// ---------------------------------------------------------------------------

export const operatorAuditLog = {
  append({
    toolName,
    actor = 'operator',
    requestId = null,
    idempotencyKey = null,
    input = null,
    output = null,
    status = 'ok',
    error = null,
    durationMs = null,
  } = {}) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `INSERT INTO operator_audit_log
         (id, tool_name, actor, request_id, idempotency_key, input, output, status, error, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        toolName,
        actor,
        requestId,
        idempotencyKey,
        input != null ? JSON.stringify(input) : null,
        output != null ? JSON.stringify(output) : null,
        status,
        error,
        durationMs,
        now,
      );
    return operatorAuditLog.get(id);
  },

  get(id) {
    const row = getDb().prepare('SELECT * FROM operator_audit_log WHERE id = ?').get(id);
    if (!row) return null;
    return {
      ...row,
      input: row.input ? JSON.parse(row.input) : null,
      output: row.output ? JSON.parse(row.output) : null,
    };
  },

  list({ toolName = null, limit = 100 } = {}) {
    let sql = 'SELECT * FROM operator_audit_log WHERE 1=1';
    const params = [];
    if (toolName) {
      sql += ' AND tool_name = ?';
      params.push(toolName);
    }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);
    return getDb()
      .prepare(sql)
      .all(...params)
      .map((row) => ({
        ...row,
        input: row.input ? JSON.parse(row.input) : null,
        output: row.output ? JSON.parse(row.output) : null,
      }));
  },
};

// ---------------------------------------------------------------------------
// Control idempotency
// ---------------------------------------------------------------------------

export const controlIdempotency = {
  begin({ idempotencyKey, toolName, requestHash }) {
    const now = new Date().toISOString();
    try {
      getDb()
        .prepare(
          `INSERT INTO control_idempotency
           (idempotency_key, tool_name, request_hash, status, created_at)
           VALUES (?, ?, ?, 'in_progress', ?)`,
        )
        .run(idempotencyKey, toolName, requestHash, now);
      return { status: 'new' };
    } catch (err) {
      if (String(err.message || err).includes('UNIQUE')) {
        const existing = controlIdempotency.getByKey(idempotencyKey);
        return { status: 'exists', record: existing };
      }
      throw err;
    }
  },

  getByKey(key) {
    const row = getDb().prepare('SELECT * FROM control_idempotency WHERE idempotency_key = ?').get(key);
    if (!row) return null;
    return {
      ...row,
      response: row.response ? JSON.parse(row.response) : null,
    };
  },

  complete(key, { status = 'completed', response = null, error = null } = {}) {
    const current = controlIdempotency.getByKey(key);
    if (!current) return null;
    getDb()
      .prepare(
        `UPDATE control_idempotency
         SET status = ?, response = ?, error = ?, completed_at = ?
         WHERE idempotency_key = ?`,
      )
      .run(
        status,
        response != null ? JSON.stringify(response) : null,
        error,
        new Date().toISOString(),
        key,
      );
    return controlIdempotency.getByKey(key);
  },
};

// ---------------------------------------------------------------------------
// Repair sessions
// ---------------------------------------------------------------------------

export const repairSessions = {
  create({ taskId, runId = null, reason = null, maxAttempts = 3 } = {}) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `INSERT INTO repair_sessions
         (id, task_id, run_id, state, attempt, max_attempts, reason, created_at, updated_at)
         VALUES (?, ?, ?, 'open', 0, ?, ?, ?, ?)`,
      )
      .run(id, taskId, runId, maxAttempts, reason, now, now);
    return repairSessions.get(id);
  },

  get(id) {
    return getDb().prepare('SELECT * FROM repair_sessions WHERE id = ?').get(id) || null;
  },

  getOpenForTask(taskId) {
    return getDb()
      .prepare(
        `SELECT * FROM repair_sessions
         WHERE task_id = ? AND state IN ('open', 'in_progress', 'retrying')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(taskId) || null;
  },

  update(id, fields = {}) {
    const allowed = ['state', 'attempt', 'run_id', 'reason', 'last_error', 'result'];
    const sets = [];
    const params = [];
    for (const key of allowed) {
      if (key in fields) {
        sets.push(`${key} = ?`);
        params.push(key === 'result' && fields[key] != null ? JSON.stringify(fields[key]) : fields[key]);
      }
    }
    if (!sets.length) return repairSessions.get(id);
    sets.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(id);
    getDb()
      .prepare(`UPDATE repair_sessions SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params);
    return repairSessions.get(id);
  },
};
