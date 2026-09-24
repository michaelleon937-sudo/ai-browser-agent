// control/tools/outreach.js
// Phase 6 — operator-facing outreach tools (approve / deny / send approved).

import {
  outreachMessages,
  outreachApprovals,
  outreachAttempts,
} from '../../database/index.js';
import {
  approveOutreachMessage,
  denyOutreachMessage,
  sendApprovedOutreach,
  listPendingOutreachApprovals,
} from '../../integrations/outreach-delivery.js';

export async function list(args = {}) {
  return {
    ok: true,
    items: outreachMessages.list({
      limit: Number(args.limit) || 50,
      status: args.status || undefined,
      opportunityId: args.opportunityId,
      prospectId: args.prospectId,
    }),
  };
}

export async function get(args = {}) {
  const id = args.messageId || args.id;
  if (!id) {
    const err = new Error('messageId is required');
    err.status = 400;
    throw err;
  }
  const message = outreachMessages.get(id);
  if (!message) {
    const err = new Error('not found');
    err.status = 404;
    throw err;
  }
  return {
    ok: true,
    message,
    approvals: outreachApprovals.listForMessage(id, { limit: 10 }),
    attempts: outreachAttempts.listForMessage(id, { limit: 10 }),
  };
}

export async function listPending(args = {}) {
  return {
    ok: true,
    items: listPendingOutreachApprovals({ limit: Number(args.limit) || 50 }),
  };
}

export async function approve(args = {}) {
  const id = args.messageId || args.id;
  if (!id) {
    const err = new Error('messageId is required');
    err.status = 400;
    throw err;
  }
  if (!args.approved) {
    const err = new Error('outreach.approve requires approved=true (explicit operator confirmation)');
    err.status = 403;
    throw err;
  }
  const result = approveOutreachMessage(id, { decidedBy: args.decidedBy || 'control' });
  return {
    ok: true,
    status: result.message.status,
    messageId: result.message.id,
    approvalId: result.approval.id,
    sent: false,
  };
}

export async function deny(args = {}) {
  const id = args.messageId || args.id;
  if (!id) {
    const err = new Error('messageId is required');
    err.status = 400;
    throw err;
  }
  const result = denyOutreachMessage(id, { decidedBy: args.decidedBy || 'control' });
  return {
    ok: true,
    status: result.message.status,
    messageId: result.message.id,
    approvalId: result.approval.id,
    sent: false,
  };
}

export async function sendApproved(args = {}) {
  const id = args.messageId || args.id;
  if (!id) {
    const err = new Error('messageId is required');
    err.status = 400;
    throw err;
  }
  if (!args.approved) {
    const err = new Error('outreach.send_approved requires approved=true');
    err.status = 403;
    throw err;
  }
  const idempotencyKey = args.idempotencyKey;
  if (!idempotencyKey) {
    const err = new Error('idempotencyKey is required');
    err.status = 400;
    throw err;
  }
  const result = await sendApprovedOutreach(id, {
    idempotencyKey,
    decidedBy: args.decidedBy || 'control',
  });
  return {
    ok: result.sent,
    replay: Boolean(result.replay),
    status: result.message?.status,
    messageId: result.message?.id,
    attemptId: result.attempt?.id,
    sent: result.sent,
    externalSideEffect: result.externalSideEffect,
    error: result.error || null,
    crmWarning: result.crmWarning || null,
  };
}

export const outreachTools = {
  'outreach.list': list,
  'outreach.get': get,
  'outreach.list_pending': listPending,
  'outreach.approve': approve,
  'outreach.deny': deny,
  'outreach.send_approved': sendApproved,
};
