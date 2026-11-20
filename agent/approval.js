// agent/approval.js
// Human-in-the-loop approval flow. Each approval is bound to one run, tool and
// canonical action-payload hash, and expires after the configured timeout.
// The hash is a consistency check, not a signed token or tenant authorization.
import { getDb } from '../database/index.js';
import { nanoid } from 'nanoid';
import { notify } from '../notifications/index.js';
import { config, redact } from '../config/index.js';
import { isApprovalNotificationEnabled } from './approval-notifications.js';
import { buildApprovalMetadata, validateApprovalRecord } from './approval-payload.js';

const DEFAULT_APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;
function approvalTimeoutMs() {
  const configured = Number(config.agent?.approvalTimeoutMs);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_APPROVAL_TIMEOUT_MS;
}

function ensureApprovalsTable() {
  getDb().prepare(`
    CREATE TABLE IF NOT EXISTS pending_approvals (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      tool TEXT NOT NULL,
      args_json TEXT,
      reasoning TEXT,
      goal TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      decision TEXT,
      decided_by TEXT,
      decided_at TEXT,
      requested_at TEXT NOT NULL
    );
  `).run();
}

export async function enqueueApproval({ runId, tool, args, reasoning, goal }) {
  ensureApprovalsTable();
  const id = nanoid(16);
  const requestedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + approvalTimeoutMs()).toISOString();
  const normalizedRunId = runId || null;
  const metadata = buildApprovalMetadata({ runId: normalizedRunId, tool, args: args || {}, requestedAt, expiresAt });
  const storedArgs = { ...redact(args || {}), __approval: metadata };
  getDb().prepare(`
    INSERT INTO pending_approvals (id, run_id, tool, args_json, reasoning, goal, requested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, normalizedRunId, tool, JSON.stringify(storedArgs), reasoning || null, goal || null, requestedAt);

  // Approval rows remain visible in the dashboard; outbound notifications are opt-in only.
  if (isApprovalNotificationEnabled()) {
    notify({
      level: 'warn',
      subject: `Approval required: ${tool}`,
      body: `Run ${runId || '(ad-hoc)'}: ${reasoning || tool}\nArgs: ${JSON.stringify(redact(args || {}))}\nExpires: ${expiresAt}`,
    });
  }
  return { id, requestedAt, expiresAt, payloadHash: metadata.payloadHash };
}

export async function awaitApproval(id, { tool, args, runId, timeoutMs = approvalTimeoutMs(), pollMs = 2_000 } = {}) {
  if (!id || !tool) return 'deny';
  const normalizedRunId = runId || null;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const row = getDb().prepare('SELECT status, tool, run_id, args_json FROM pending_approvals WHERE id = ?').get(id);
    if (!row) return 'deny';
    const validation = validateApprovalRecord({ row, runId: normalizedRunId, tool, args: args || {} });
    if (!validation.valid) {
      if (row.status === 'pending') recordDecision(id, 'deny', `system:${validation.reason}`);
      return 'deny';
    }
    if (row.status === 'approved') return 'approve';
    if (row.status === 'denied') return 'deny';
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  recordDecision(id, 'deny', 'system:timeout-default');
  return 'deny';
}

export function recordDecision(id, decision, decidedBy = 'user') {
  if (!['approve', 'deny'].includes(decision)) throw new Error('decision must be approve|deny');
  ensureApprovalsTable();
  const status = decision === 'approve' ? 'approved' : 'denied';
  getDb().prepare(`
    UPDATE pending_approvals
    SET status = ?, decision = ?, decided_by = ?, decided_at = ?
    WHERE id = ? AND status = 'pending'
  `).run(status, decision, decidedBy, new Date().toISOString(), id);
  return { id, status };
}

export function listPending() {
  ensureApprovalsTable();
  return getDb().prepare("SELECT * FROM pending_approvals WHERE status = 'pending' ORDER BY requested_at ASC").all();
}

export function listAll({ limit = 50 } = {}) {
  ensureApprovalsTable();
  return getDb().prepare('SELECT * FROM pending_approvals ORDER BY requested_at DESC LIMIT ?').all(limit);
}

export { config };
