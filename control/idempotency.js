// control/idempotency.js
// Mutating Control actions require an idempotency key scoped to the authenticated operator.

import crypto from 'node:crypto';
import { controlIdempotency } from '../database/index.js';

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key => `${JSON.stringify(key)}:${canonicalize(value[key])}`)).join(',')}}`;
}

export function hashRequest(toolName, body) {
  return crypto.createHash('sha256').update(canonicalize({ toolName, body: body || {} })).digest('hex');
}

export function parseStoredResult(row) {
  if (!row) return null;
  if (!row.result) return { replayed: true, status: row.status, result: null };
  try { return { replayed: true, status: row.status, result: JSON.parse(row.result) }; }
  catch { return { replayed: true, status: row.status, result: row.result }; }
}

export function lookupIdempotency(key, operatorId) {
  if (!key || !operatorId) return null;
  return controlIdempotency.getByKey(key, operatorId);
}

export function beginIdempotency({ idempotencyKey, operatorId, toolName, requestHash }) {
  return controlIdempotency.create({ idempotencyKey, operatorId, toolName, requestHash, status: 'started', result: null });
}

export function completeIdempotency(key, operatorId, { status, result }) {
  return controlIdempotency.update(key, operatorId, { status, result });
}
