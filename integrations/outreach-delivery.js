// integrations/outreach-delivery.js
// Phase 6 — Human-approved outreach delivery.
// Approves/denies READY_FOR_APPROVAL drafts; sends ONLY after matching approval.
// Never invents recipients. Never auto-sends. No fake success without real delivery.

import { config } from '../config/index.js';
import {
  outreachMessages,
  outreachApprovals,
  outreachAttempts,
  prospects,
  assertCanMarkContacted,
} from '../database/index.js';
import { computeOutreachContentHash } from './outreach-prep.js';

const OUTREACH_STATUS_TRANSITIONS = {
  DRAFT: new Set(['DRAFT', 'READY_FOR_APPROVAL']),
  READY_FOR_APPROVAL: new Set(['READY_FOR_APPROVAL', 'APPROVED', 'REJECTED']),
  APPROVED: new Set(['APPROVED', 'SENDING', 'SENT', 'FAILED', 'REJECTED']),
  REJECTED: new Set(['REJECTED']),
  SENDING: new Set(['SENDING', 'SENT', 'FAILED']),
  SENT: new Set(['SENT']),
  FAILED: new Set(['FAILED', 'APPROVED']),
};

export function assertOutreachStatusTransition(from, to) {
  if (from === to) return;
  const allowed = OUTREACH_STATUS_TRANSITIONS[from];
  if (!allowed || !allowed.has(to)) {
    throw new Error(`Invalid outreach status transition: ${from} → ${to}`);
  }
}

function recomputeHash(message) {
  return computeOutreachContentHash({
    recipient: message.recipient,
    channel: message.channel,
    subject: message.subject,
    body: message.body,
    proposalId: message.proposal_id,
  });
}

export function approveOutreachMessage(messageId, { decidedBy = 'dashboard' } = {}) {
  const message = outreachMessages.get(messageId);
  if (!message) throw new Error(`Outreach message not found: ${messageId}`);
  if (message.status !== 'READY_FOR_APPROVAL' && message.status !== 'APPROVED') {
    throw new Error(`Outreach message cannot be approved from status ${message.status}`);
  }
  const contentHash = recomputeHash(message);
  if (contentHash !== message.content_hash) {
    throw new Error('Outreach content hash mismatch; regenerate draft before approval');
  }
  assertOutreachStatusTransition(message.status, 'APPROVED');
  const approval = outreachApprovals.create({
    outreachMessageId: message.id,
    decision: 'approve',
    contentHash,
    decidedAt: new Date().toISOString(),
    decidedBy,
  });
  const updated = outreachMessages.updateStatus(message.id, 'APPROVED');
  return { message: updated, approval };
}

export function denyOutreachMessage(messageId, { decidedBy = 'dashboard' } = {}) {
  const message = outreachMessages.get(messageId);
  if (!message) throw new Error(`Outreach message not found: ${messageId}`);
  if (!['READY_FOR_APPROVAL', 'APPROVED'].includes(message.status)) {
    throw new Error(`Outreach message cannot be denied from status ${message.status}`);
  }
  const contentHash = recomputeHash(message);
  assertOutreachStatusTransition(message.status, 'REJECTED');
  const approval = outreachApprovals.create({
    outreachMessageId: message.id,
    decision: 'deny',
    contentHash,
    decidedAt: new Date().toISOString(),
    decidedBy,
  });
  const updated = outreachMessages.updateStatus(message.id, 'REJECTED');
  return { message: updated, approval };
}

function latestApproval(messageId) {
  return outreachApprovals.listForMessage(messageId, { limit: 5 })[0] || null;
}

async function createTransport() {
  if (!config.notifications?.smtp?.host) return null;
  const nodemailer = (await import('nodemailer')).default;
  return nodemailer.createTransport({
    host: config.notifications.smtp.host,
    port: config.notifications.smtp.port,
    secure: config.notifications.smtp.secure,
    auth: config.notifications.smtp.user
      ? { user: config.notifications.smtp.user, pass: config.notifications.smtp.pass }
      : undefined,
  });
}

/**
 * Send an APPROVED outreach message.
 * @param {string} messageId
 * @param {{ idempotencyKey: string, decidedBy?: string, transport?: object }} opts
 *        transport: inject for tests only. Never treat stub success as production delivery
 *        unless the caller intentionally supplies a real transport.
 */
export async function sendApprovedOutreach(messageId, {
  idempotencyKey,
  decidedBy = 'dashboard',
  transport = undefined,
} = {}) {
  if (!idempotencyKey || String(idempotencyKey).trim() === '') {
    throw new Error('idempotencyKey is required for outreach send');
  }

  const existingAttempt = outreachAttempts.getByIdempotencyKey(idempotencyKey);
  if (existingAttempt) {
    const msg = outreachMessages.get(existingAttempt.outreach_message_id);
    return {
      replay: true,
      attempt: existingAttempt,
      message: msg,
      sent: existingAttempt.status === 'SUCCESS',
      externalSideEffect: existingAttempt.status === 'SUCCESS',
    };
  }

  const message = outreachMessages.get(messageId);
  if (!message) throw new Error(`Outreach message not found: ${messageId}`);
  if (message.status !== 'APPROVED') {
    throw new Error(`Outreach send requires status APPROVED (got ${message.status})`);
  }

  const contentHash = recomputeHash(message);
  if (contentHash !== message.content_hash) {
    throw new Error('Outreach content hash mismatch; re-approve after content change');
  }

  const approval = latestApproval(message.id);
  if (!approval || approval.decision !== 'approve') {
    throw new Error('Outreach send requires a recorded approve decision');
  }
  if (approval.content_hash !== contentHash) {
    throw new Error('Approval content_hash does not match current message; re-approve');
  }

  assertOutreachStatusTransition(message.status, 'SENDING');
  outreachMessages.updateStatus(message.id, 'SENDING');

  const startedAt = new Date().toISOString();
  let attempt = outreachAttempts.create({
    outreachMessageId: message.id,
    idempotencyKey,
    status: 'PENDING',
    startedAt,
  });

  const mailer = transport === undefined ? await createTransport() : transport;
  if (!mailer) {
    const finishedAt = new Date().toISOString();
    attempt = outreachAttempts.update(attempt.id, {
      status: 'FAILED',
      finishedAt,
      errorMessage: 'SMTP not configured (set SMTP_HOST and related env vars)',
    });
    assertOutreachStatusTransition('SENDING', 'FAILED');
    const failed = outreachMessages.updateStatus(message.id, 'FAILED');
    return {
      replay: false,
      attempt,
      message: failed,
      sent: false,
      externalSideEffect: false,
      error: attempt.error_message,
    };
  }

  try {
    const from =
      config.notifications.email.from ||
      config.notifications.smtp.user ||
      (transport ? 'phase6-test@localhost' : null);
    if (!from) {
      throw new Error('NOTIFY_EMAIL_FROM or SMTP_USER required as From address');
    }

    const info = await mailer.sendMail({
      from,
      to: message.recipient,
      subject: message.subject,
      text: message.body,
    });

    const finishedAt = new Date().toISOString();
    const providerMessageId = info?.messageId || null;
    attempt = outreachAttempts.update(attempt.id, {
      status: 'SUCCESS',
      providerMessageId,
      finishedAt,
      errorMessage: null,
    });

    assertOutreachStatusTransition('SENDING', 'SENT');
    const sentMessage = outreachMessages.updateStatus(message.id, 'SENT');

    // CONTACTED only after confirmed successful adapter response.
    assertCanMarkContacted({ hasConfirmedSend: true });
    try {
      const prospect = prospects.get(message.prospect_id);
      if (prospect && !['CONTACTED', 'WON', 'LOST', 'REPLIED', 'FOLLOW_UP'].includes(prospect.status)) {
        prospects.updateStatus(message.prospect_id, 'CONTACTED');
      }
    } catch (crmErr) {
      return {
        replay: false,
        attempt,
        message: sentMessage,
        sent: true,
        externalSideEffect: true,
        providerMessageId,
        crmWarning: crmErr.message,
        decidedBy,
      };
    }

    return {
      replay: false,
      attempt,
      message: sentMessage,
      sent: true,
      externalSideEffect: true,
      providerMessageId,
      decidedBy,
    };
  } catch (err) {
    const finishedAt = new Date().toISOString();
    attempt = outreachAttempts.update(attempt.id, {
      status: 'FAILED',
      finishedAt,
      errorMessage: err.message || String(err),
    });
    assertOutreachStatusTransition('SENDING', 'FAILED');
    const failed = outreachMessages.updateStatus(message.id, 'FAILED');
    return {
      replay: false,
      attempt,
      message: failed,
      sent: false,
      externalSideEffect: false,
      error: attempt.error_message,
    };
  }
}

export function listPendingOutreachApprovals({ limit = 50 } = {}) {
  return outreachMessages.list({ status: 'READY_FOR_APPROVAL', limit });
}
