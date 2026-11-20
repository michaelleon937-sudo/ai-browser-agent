import { describe, expect, it } from 'vitest';
import { buildApprovalMetadata, createApprovalPayloadHash, validateApprovalRecord } from '../../agent/approval-payload.js';

const runId = 'run-123';
const tool = 'browser_click';
const args = { target: 'e7', approvalContext: { pageUrl: 'https://example.com/about', target: { label: 'About us' } } };
const requestedAt = '2026-11-20T10:00:00.000Z';
const expiresAt = '2026-11-20T10:30:00.000Z';
const now = Date.parse('2026-11-20T10:10:00.000Z');

function rowFor(actionArgs = args, options = {}) {
  const metadata = buildApprovalMetadata({ runId, tool, args: actionArgs, requestedAt, expiresAt: options.expiresAt || expiresAt });
  return { tool, run_id: runId, args_json: JSON.stringify({ ...actionArgs, __approval: metadata }) };
}

describe('payload-bound approval records', () => {
  it('canonicalizes object key order and binds run, tool and exact args', () => {
    expect(createApprovalPayloadHash({ runId, tool, args: { a: 1, b: 2 } })).toBe(createApprovalPayloadHash({ runId, tool, args: { b: 2, a: 1 } }));
    expect(createApprovalPayloadHash({ runId, tool, args })).not.toBe(createApprovalPayloadHash({ runId: 'other-run', tool, args }));
  });
  it('accepts the unchanged action within its expiry window', () => {
    expect(validateApprovalRecord({ row: rowFor(), runId, tool, args, now })).toEqual({ valid: true, reason: 'approved_payload_matches' });
  });
  it('rejects changed action payloads and mismatched run/tool scope', () => {
    expect(validateApprovalRecord({ row: rowFor(), runId, tool, args: { ...args, target: 'e8' }, now }).reason).toBe('approval_payload_changed');
    expect(validateApprovalRecord({ row: rowFor(), runId: 'other-run', tool, args, now }).reason).toBe('approval_scope_mismatch');
    expect(validateApprovalRecord({ row: rowFor(), runId, tool: 'browser_type', args, now }).reason).toBe('approval_scope_mismatch');
  });
  it('rejects expired, missing and malformed approval metadata', () => {
    expect(validateApprovalRecord({ row: rowFor(args, { expiresAt: '2026-11-20T10:05:00.000Z' }), runId, tool, args, now }).reason).toBe('approval_expired');
    expect(validateApprovalRecord({ row: { tool, run_id: runId, args_json: '{}' }, runId, tool, args, now }).reason).toBe('missing_approval_binding');
    expect(validateApprovalRecord({ row: { tool, run_id: runId, args_json: '{bad json' }, runId, tool, args, now }).reason).toBe('invalid_approval_payload');
  });
});
