// agent/approval.js
// Human-in-the-loop approval flow. When the agent wants to perform a sensitive
// action, it pauses and surfaces the request via:
//   - a `pending_approvals` row in the database (visible to the dashboard)
//   - a notification (webhook/email) to the user
// The dashboard exposes POST /approvals/:id {decision: 'approve'|'deny'}.
// `awaitApproval` polls the DB and resolves when a decision is recorded, or
// after the configured timeout (default policy: deny on timeout).


import { getDb } from '../database/index.js';
import { nanoid } from 'nanoid';
import { notify } from '../notifications/index.js';
import { config, redact } from '../config/index.js';


export async function enqueueApproval({ runId, tool, args, reasoning, goal }) {
  const id = nanoid(16);
  const requestedAt = new Date().toISOString();
  getDb().prepare(`
    CREATE TABLE IF NOT EXISTS pending_approvals (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      tool TEXT NOT NULL,
      args_json TEXT,
      reasoning TEXT,
      goal TEXT,
      status TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | denied
      decision TEXT,                           -- approve | deny
      decided_by TEXT,
      decided_at TEXT,
      requested_at TEXT NOT NULL
    );
  `).run();
  getDb().prepare(`
    INSERT INTO pending_approvals (id, run_id, tool, args_json, reasoning, goal, requested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, runId || null, tool, JSON.stringify(redact(args || {})), reasoning || null, goal || null, requestedAt);


  notify({
    level: 'warn',
    subject: `Approval required: ${tool}`,
    body: `Run ${runId || '(ad-hoc)'}: ${reasoning || tool}\nArgs: ${JSON.stringify(redact(args || {}))}`,
  });


  return { id, requestedAt };
}


export async function awaitApproval(id, { timeoutMs = 24 * 60 * 60 * 1000, pollMs = 2_000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = getDb().prepare('SELECT status FROM pending_approvals WHERE id = ?').get(id);
    if (!row) return 'deny'; // disappeared — treat as denied
    if (row.status === 'approved') return 'approve';
    if (row.status === 'denied') return 'deny';
    await new Promise((r) => setTimeout(r, pollMs));
  }
  // Default policy on timeout: deny (safer).
  recordDecision(id, 'deny', 'timeout-default');
  return 'deny';
}


export function recordDecision(id, decision, decidedBy = 'user') {
  if (!['approve', 'deny'].includes(decision)) throw new Error('decision must be approve|deny');
  const status = decision === 'approve' ? 'approved' : 'denied';
  getDb().prepare(`
    UPDATE pending_approvals
    SET status = ?, decision = ?, decided_by = ?, decided_at = ?
    WHERE id = ? AND status = 'pending'
  `).run(status, decision, decidedBy, new Date().toISOString(), id);
  return { id, status };
}


export function listPending() {
  return getDb().prepare("SELECT * FROM pending_approvals WHERE status = 'pending' ORDER BY requested_at ASC").all();
}


export function listAll({ limit = 50 } = {}) {
  return getDb().prepare("SELECT * FROM pending_approvals ORDER BY requested_at DESC LIMIT ?").all(limit);
}


export { config };
