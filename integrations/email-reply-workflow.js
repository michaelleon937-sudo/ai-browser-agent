// integrations/email-reply-workflow.js
// Production email conversation loop:
// inbound message -> AI draft -> human approval -> CloudMailin send -> delivery webhook.
//
// The inbound message is always treated as untrusted data. No draft is auto-sent.
// The generic approval API remains the human gate; approved email sends are processed
// by a small durable poller so the dashboard authentication model is preserved.

import crypto from 'node:crypto';
import { clientDeliveries, clientDeliveryAttempts } from '../database/index.js';
import { enqueueApproval, listAll as listApprovals } from '../agent/approval.js';
import { generateA2ReplyDraft } from './a2-reply-draft.js';
import { sendCloudMailinMessage } from './cloudmailin-outbound.js';

const APPROVAL_TOOL = 'email_reply_send';
const REPLY_STATUS = {
  DRAFT: 'READY_FOR_APPROVAL',
  APPROVED: 'APPROVED',
  SENDING: 'SENDING',
  SENT: 'SENT',
  FAILED: 'FAILED',
  REJECTED: 'REJECTED',
};

function contentHash({ recipient, subject, bodyText }) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ recipient, subject, bodyText }))
    .digest('hex');
}

function metadataFor(row) {
  if (!row?.metadata_json) return {};
  try { return JSON.parse(row.metadata_json) || {}; } catch { return {}; }
}

function findDraftForMessage(messageId) {
  return clientDeliveries.list({ limit: 100 }).find((row) => {
    const meta = metadataFor(row);
    return meta.sourceInboundMessageId === messageId && row.message_type === 'EMAIL_REPLY';
  }) || null;
}

function findApprovalForDelivery(deliveryId) {
  return listApprovals().find((row) => {
    if (row.tool !== APPROVAL_TOOL) return false;
    try {
      const args = JSON.parse(row.args_json || '{}');
      return args.deliveryId === deliveryId;
    } catch {
      return false;
    }
  }) || null;
}

export async function queueEmailReplyDraft(result) {
  const message = result?.message;
  const conversation = result?.conversation;
  if (!message?.id || !conversation?.id || !message.sender) return { ok: false, skipped: true, reason: 'missing message/conversation/recipient' };

  // Never generate customer-facing drafts for explicit rejection/unsubscribe mail.
  if (result.classification === 'REJECTION') {
    return { ok: true, skipped: true, reason: 'rejection message' };
  }

  const existing = findDraftForMessage(message.id);
  if (existing) return { ok: true, replay: true, delivery: existing, approval: findApprovalForDelivery(existing.id) };

  const draft = await generateA2ReplyDraft({
    conversationId: conversation.id,
    messageText: message.body || '',
    context: {
      classification: result.classification || null,
      nextAction: result.intelligence?.nextAction || null,
      knownFacts: result.extracted || {},
    },
  });

  if (!draft?.ok || !draft.draft?.trim()) {
    throw new Error('AI reply draft generation returned no draft');
  }

  const subject = /^re:\s/i.test(String(message.subject || ''))
    ? String(message.subject)
    : `Re: ${String(message.subject || 'Your message')}`;
  const bodyText = draft.draft.trim();
  const hash = contentHash({ recipient: message.sender, subject, bodyText });
  const metadata = {
    source: 'cloudmailin-inbound',
    sourceInboundMessageId: message.id,
    externalInboundMessageId: message.external_message_id || null,
    classification: result.classification || null,
    intent: result.intent || null,
    nextAction: draft.recommendedNextAction || result.intelligence?.nextAction || null,
    warnings: draft.warnings || [],
    draftSource: draft.source || null,
  };

  const delivery = clientDeliveries.create({
    messageType: 'EMAIL_REPLY',
    channel: 'email',
    status: REPLY_STATUS.DRAFT,
    recipient: message.sender,
    subject,
    bodyText,
    bodyHtml: null,
    contentHash: hash,
    companyId: message.company_id || null,
    contactId: message.contact_id || null,
    conversationId: conversation.id,
    prospectId: message.prospect_id || null,
    correlationId: message.id,
    metadata,
  });

  const existingApproval = findApprovalForDelivery(delivery.id);
  const approval = existingApproval || await enqueueApproval({
    runId: `email:${message.id}`,
    tool: APPROVAL_TOOL,
    args: { deliveryId: delivery.id, contentHash: hash },
    reasoning: `Approve customer email reply for ${message.sender}. Classification: ${result.classification || 'UNKNOWN'}.`,
    goal: 'Send the approved AI-drafted email reply through CloudMailin.',
  });

  return { ok: true, delivery, approval, autoSend: false, requiresHumanApproval: true };
}

async function sendApprovedDelivery(delivery, approval) {
  if (!delivery || delivery.message_type !== 'EMAIL_REPLY') return { ok: false, skipped: true };
  if (delivery.status === REPLY_STATUS.SENT) return { ok: true, replay: true, delivery };

  const meta = metadataFor(delivery);
  const expectedHash = contentHash({
    recipient: delivery.recipient,
    subject: delivery.subject,
    bodyText: delivery.body_text,
  });
  if (expectedHash !== delivery.content_hash) {
    clientDeliveries.updateStatus(delivery.id, REPLY_STATUS.FAILED, {
      errorMessage: 'content hash mismatch; re-approval required',
    });
    return { ok: false, delivery, error: 'content hash mismatch' };
  }

  const approvalArgs = JSON.parse(approval.args_json || '{}');
  if (approvalArgs.contentHash !== delivery.content_hash) {
    clientDeliveries.updateStatus(delivery.id, REPLY_STATUS.FAILED, {
      errorMessage: 'approval content hash mismatch; re-approval required',
    });
    return { ok: false, delivery, error: 'approval content hash mismatch' };
  }

  const idempotencyKey = `email-reply:${delivery.id}:${delivery.content_hash}`;
  const priorAttempt = clientDeliveryAttempts.getByIdempotencyKey(idempotencyKey);
  if (priorAttempt) {
    return { ok: true, replay: true, delivery, attempt: priorAttempt };
  }

  clientDeliveries.updateStatus(delivery.id, REPLY_STATUS.SENDING, {
    decidedBy: approval.decided_by || 'dashboard',
    approvedAt: approval.decided_at || new Date().toISOString(),
  });

  const attempt = clientDeliveryAttempts.create({
    deliveryId: delivery.id,
    idempotencyKey,
    status: 'PENDING',
    startedAt: new Date().toISOString(),
  });

  try {
    const sent = await sendCloudMailinMessage({
      deliveryId: delivery.id,
      to: delivery.recipient,
      subject: delivery.subject,
      plain: delivery.body_text,
      html: delivery.body_html || undefined,
      conversationId: delivery.conversation_id,
      tags: ['ai-browser-agent', 'customer-reply'],
    });

    clientDeliveryAttempts.update(attempt.id, {
      status: 'SUCCESS',
      providerMessageId: sent.providerMessageId || null,
      finishedAt: new Date().toISOString(),
      errorMessage: null,
    });
    const updated = clientDeliveries.updateStatus(delivery.id, REPLY_STATUS.SENT, {
      sentAt: new Date().toISOString(),
      providerMessageId: sent.providerMessageId || null,
      errorMessage: null,
    });
    return { ok: true, sent: true, delivery: updated, providerMessageId: sent.providerMessageId || null, externalSideEffect: true };
  } catch (err) {
    clientDeliveryAttempts.update(attempt.id, {
      status: 'FAILED',
      finishedAt: new Date().toISOString(),
      errorMessage: err?.message || String(err),
    });
    const failed = clientDeliveries.updateStatus(delivery.id, REPLY_STATUS.FAILED, {
      errorMessage: err?.message || String(err),
    });
    return { ok: false, delivery: failed, error: err?.message || String(err), externalSideEffect: false };
  }
}

export async function processApprovedEmailReplies() {
  const approvals = listApprovals();
  const processed = [];
  for (const approval of approvals) {
    if (approval.tool !== APPROVAL_TOOL) continue;
    let args;
    try { args = JSON.parse(approval.args_json || '{}'); } catch { continue; }
    if (!args.deliveryId) continue;

    const delivery = clientDeliveries.get(args.deliveryId);
    if (!delivery) continue;

    if (approval.status === 'denied' && delivery.status !== REPLY_STATUS.REJECTED) {
      const updated = clientDeliveries.updateStatus(delivery.id, REPLY_STATUS.REJECTED, {
        decidedBy: approval.decided_by || 'dashboard',
        approvedAt: approval.decided_at || new Date().toISOString(),
      });
      processed.push({ deliveryId: delivery.id, status: 'REJECTED' });
      continue;
    }

    if (approval.status !== 'approved') continue;
    if (delivery.status === REPLY_STATUS.SENT || delivery.status === REPLY_STATUS.REJECTED) continue;

    processed.push(await sendApprovedDelivery(delivery, approval));
  }
  return processed;
}

export { APPROVAL_TOOL, REPLY_STATUS, contentHash };
