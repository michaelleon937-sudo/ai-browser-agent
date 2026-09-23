// control/audit.js
// Append-only operator audit. Never persist secrets.

import { operatorAuditLog } from '../database/index.js';
import { redact } from '../config/index.js';

const SECRET_PATTERN = /token|key|password|pass|secret|authorization|cookie|bearer/i;

export function sanitizeForAudit(value) {
  if (value == null) return value;
  if (typeof value === 'string') {
    if (SECRET_PATTERN.test(value) && value.length > 8) return '[REDACTED]';
    return value;
  }
  if (typeof value !== 'object') return value;
  return redact(value);
}

export function recordAudit({
  operatorId,
  action,
  toolName,
  requestId,
  idempotencyKey,
  target,
  status,
  details,
}) {
  return operatorAuditLog.append({
    operatorId,
    action,
    toolName,
    requestId,
    idempotencyKey,
    target: target ? String(target).slice(0, 500) : null,
    status,
    details: sanitizeForAudit(details || {}),
  });
}

export function listAudit(opts) {
  return operatorAuditLog.listRecent(opts);
}
