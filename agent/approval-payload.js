// agent/approval-payload.js
// Consistency binding for one-action human approvals. This is a payload hash,
// not a signature or tenant authorization token; customer/financial actions remain blocked.
import { createHash } from 'node:crypto';

function canonicalize(value) {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const output = {};
  for (const key of Object.keys(value).sort()) output[key] = canonicalize(value[key]);
  return output;
}

export function createApprovalPayloadHash({ runId, tool, args } = {}) {
  const payload = canonicalize({ runId: runId || null, tool: String(tool || ''), args: args || {} });
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function buildApprovalMetadata({ runId, tool, args, requestedAt, expiresAt } = {}) {
  return {
    version: 1,
    runId: runId || null,
    tool: String(tool || ''),
    requestedAt,
    expiresAt,
    payloadHash: createApprovalPayloadHash({ runId, tool, args }),
  };
}

export function validateApprovalRecord({ row, runId, tool, args, now = Date.now() } = {}) {
  if (!row) return { valid: false, reason: 'missing_record' };
  if (row.tool !== tool || (row.run_id || null) !== (runId || null)) {
    return { valid: false, reason: 'approval_scope_mismatch' };
  }
  let storedArgs;
  try { storedArgs = JSON.parse(row.args_json || '{}'); } catch { return { valid: false, reason: 'invalid_approval_payload' }; }
  const metadata = storedArgs?.__approval;
  if (!metadata || metadata.version !== 1 || metadata.tool !== tool || (metadata.runId || null) !== (runId || null)) {
    return { valid: false, reason: 'missing_approval_binding' };
  }
  const expiresAt = Date.parse(metadata.expiresAt || '');
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return { valid: false, reason: 'approval_expired' };
  const expectedHash = createApprovalPayloadHash({ runId, tool, args });
  if (metadata.payloadHash !== expectedHash) return { valid: false, reason: 'approval_payload_changed' };
  return { valid: true, reason: 'approved_payload_matches' };
}
