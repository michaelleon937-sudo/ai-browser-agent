// control/idempotency.js
// Mutating Control actions require an idempotency key.

import crypto from 'node:crypto';
import { controlIdempotency } from '../database/index.js';

export function hashRequest(toolName, body) {
  return crypto.createHash('sha256').update(`${toolName}:${JSON.stringify(body || {})}`).digest('hex');
}

export function parseStoredResult(row) {
  if (!row) return null;
  if (!row.result) return { replayed: true, status: row.status, result: null };
  try {
    return { replayed: true, status: row.status, result: JSON.parse(row.result) };
  } catch {
    return { replayed: true, status: row.status, result: row.result };
  }
}

export function lookupIdempotency(key) {
  if (!key) return null;
  return controlIdempotency.getByKey(key);
}

export function beginIdempotency({ idempotencyKey, operatorId, toolName, requestHash }) {
  return controlIdempotency.create({
    idempotencyKey,
    operatorId,
    toolName,
    requestHash,
    status: 'started',
    result: null,
  });
}

export function completeIdempotency(key, { status, result }) {
  return controlIdempotency.update(key, { status, result });
}
