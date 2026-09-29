// Phase A1 — approval-gated client delivery over email (SMTP).
import { createHash } from 'node:crypto';
import { config } from '../../config/index.js';
import {
  getDb, conversations, inboundMessages,
  invoices, payments, projects,
} from '../../database/index.js';
import { clientDeliveries, clientDeliveryAttempts } from '../../database/client-delivery-store.js';
import { renderTemplate, assertSafeClientContent, TEMPLATE_TYPES } from './templates.js';

const INTERNAL_PATH_RE = /(\/mnt\/|\/home\/workdir\/|\/var\/data\/|file:\/\/)/i;

export function computeDeliveryContentHash(o) {
  return createHash('sha256').update([
    o.recipient || '', o.channel || 'email', o.subject || '', o.bodyText || '',
    o.messageType || '', o.paymentUrl || '', o.artifactUrl || '',
  ].join('\n')).digest('hex');
}

function validateRecipient(r) {
  r = String(r || '').trim();
  if (!r || !r.includes('@') || r.length < 5) throw new Error('valid recipient email is required');
  return r;
}
function assertNoInternalPath(url) {
  if (url && INTERNAL_PATH_RE.test(String(url))) {
    throw new Error('artifact/payment URL must not be an internal filesystem path');
  }
}

export function resolvePaymentUrlFromPayment(paymentRow) {
  if (!paymentRow) return null;
  let meta = paymentRow.metadata || {};
  if (typeof paymentRow.metadata_json === 'string') {
    try { meta = JSON.parse(paymentRow.metadata_json) || {}; } catch { meta = {}; }
  }
  const candidates = [
    paymentRow.checkout_url, paymentRow.checkoutUrl, paymentRow.payment_url, paymentRow.paymentUrl,
    meta.checkoutUrl, meta.checkout_url, meta.paymentUrl, meta.payment_url,
  ].filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u));
  return candidates[0] || null;
}

export function assertFinalDeliveryAllowed({ projectId, invoiceId, paymentId } = {}) {
  if (!projectId && !invoiceId && !paymentId) {
    throw new Error('FINAL_DELIVERY requires projectId, invoiceId, or paymentId');
  }
  if (paymentId) {
    const p = payments.get(paymentId);
    if (!p) throw new Error('payment not found for final delivery');
    if (!['SUCCEEDED', 'COMPLETED', 'PAID'].includes(String(p.status || '').toUpperCase())) {
      throw new Error('FINAL_DELIVERY requires verified payment (status not succeeded)');
    }
    return { payment: p };
  }
  if (invoiceId) {
    const inv = invoices.get(invoiceId);
    if (!inv) throw new Error('invoice not found for final delivery');
    if (!['PAID', 'PARTIALLY_PAID'].includes(String(inv.status || '').toUpperCase())) {
      throw new Error('FINAL_DELIVERY requires paid invoice');
    }
    return { invoice: inv };
  }
  const proj = projects.get(projectId);
  if (!proj) throw new Error('project not found for final delivery');
  if (proj.payment_id) return assertFinalDeliveryAllowed({ paymentId: proj.payment_id });
  if (proj.invoice_id) return assertFinalDeliveryAllowed({ invoiceId: proj.invoice_id });
  throw new Error('FINAL_DELIVERY project lacks verified payment/invoice linkage');
}

export function prepareClientDelivery(input = {}) {
  const messageType = String(input.messageType || input.type || 'GENERIC').toUpperCase();
  if (!Object.values(TEMPLATE_TYPES).includes(messageType)) {
    throw new Error(`unsupported messageType: ${messageType}`);
  }
  const recipient = validateRecipient(input.recipient || input.to);
  const channel = String(input.channel || 'email').toLowerCase();
  if (channel !== 'email') throw new Error('A1 supports channel=email only (WhatsApp deferred)');

  let paymentUrl = input.paymentUrl || input.payment_url || null;
  if (paymentUrl) {
    assertNoInternalPath(paymentUrl);
    if (!/^https?:\/\//i.test(paymentUrl)) {
      throw new Error('paymentUrl must be an absolute http(s) URL from the payment provider');
    }
  }
  if (!paymentUrl && input.paymentId) {
    paymentUrl = resolvePaymentUrlFromPayment(payments.get(input.paymentId));
  }

  let artifactUrl = input.artifactUrl || input.artifact_url || null;
  if (artifactUrl) {
    assertNoInternalPath(artifactUrl);
    if (!/^https?:\/\//i.test(artifactUrl)) {
      throw new Error('artifactUrl must be an absolute http(s) URL (SECURE_ARTIFACT_STORAGE_REQUIRED for private files)');
    }
  }

  if (messageType === 'FINAL_DELIVERY') {
    assertFinalDeliveryAllowed({
      projectId: input.projectId, invoiceId: input.invoiceId, paymentId: input.paymentId,
    });
    if (!artifactUrl && !input.allowWithoutArtifactUrl) {
      throw new Error('FINAL_DELIVERY requires artifactUrl (public https) or allowWithoutArtifactUrl');
    }
  }
  if (messageType === 'PAYMENT_CONFIRMATION') {
    assertFinalDeliveryAllowed({ invoiceId: input.invoiceId, paymentId: input.paymentId });
  }

  const vars = {
    ...input.vars,
    clientName: input.clientName || input.contactName,
    companyName: input.companyName,
    service: input.service,
    subject: input.subject,
    quoteId: input.quoteId,
    quoteNumber: input.quoteNumber,
    invoiceId: input.invoiceId,
    invoiceNumber: input.invoiceNumber,
    amount: input.amount,
    currency: input.currency,
    dueDate: input.dueDate,
    validUntil: input.validUntil,
    paymentUrl,
    artifactUrl,
    proposalUrl: artifactUrl,
    sampleUrl: artifactUrl,
    deliveryUrl: artifactUrl,
    scopeNote: input.scopeNote,
    body: input.body,
    intro: input.intro,
    callToAction: input.callToAction,
    sampleNote: input.sampleNote,
    proposalSummary: input.proposalSummary,
    serviceDescription: input.serviceDescription,
    nextStep: input.nextStep,
    deliveryNote: input.deliveryNote,
    handoffNote: input.handoffNote,
    senderName: input.senderName,
  };

  const rendered = renderTemplate(messageType, vars);
  if (input.subject) rendered.subject = String(input.subject);
  if (input.bodyText) rendered.bodyText = String(input.bodyText);
  assertSafeClientContent(rendered.subject);
  assertSafeClientContent(rendered.bodyText);

  const contentHash = computeDeliveryContentHash({
    recipient, channel, subject: rendered.subject, bodyText: rendered.bodyText,
    messageType: rendered.messageType, paymentUrl, artifactUrl,
  });
  const status = input.submitForApproval === false ? 'DRAFT' : 'READY_FOR_APPROVAL';
  const row = clientDeliveries.create({
    messageType: rendered.messageType, channel, status, recipient,
    subject: rendered.subject, bodyText: rendered.bodyText, bodyHtml: rendered.bodyHtml, contentHash,
    companyId: input.companyId, contactId: input.contactId, conversationId: input.conversationId,
    prospectId: input.prospectId, opportunityId: input.opportunityId, proposalId: input.proposalId,
    quoteId: input.quoteId, invoiceId: input.invoiceId, paymentId: input.paymentId, projectId: input.projectId,
    paymentUrl, artifactUrl,
    artifactKind: input.artifactKind
      || (messageType === 'SAMPLE' ? 'SAMPLE' : messageType === 'FINAL_DELIVERY' ? 'FINAL' : null),
    correlationId: input.correlationId || null, metadata: input.metadata || null,
  });
  return { ok: true, delivery: row, externalSend: false };
}

export function approveClientDelivery(deliveryId, { decidedBy = 'control' } = {}) {
  const d = clientDeliveries.get(deliveryId);
  if (!d) throw new Error(`delivery not found: ${deliveryId}`);
  if (d.status !== 'READY_FOR_APPROVAL' && d.status !== 'APPROVED') {
    throw new Error(`cannot approve from status ${d.status}`);
  }
  const hash = computeDeliveryContentHash({
    recipient: d.recipient, channel: d.channel, subject: d.subject, bodyText: d.body_text,
    messageType: d.message_type, paymentUrl: d.payment_url, artifactUrl: d.artifact_url,
  });
  if (hash !== d.content_hash) throw new Error('content hash mismatch; regenerate delivery before approval');
  return {
    ok: true,
    delivery: clientDeliveries.updateStatus(deliveryId, 'APPROVED', {
      decidedBy, approvedAt: new Date().toISOString(),
    }),
    externalSend: false,
  };
}

export function denyClientDelivery(deliveryId, { decidedBy = 'control' } = {}) {
  const d = clientDeliveries.get(deliveryId);
  if (!d) throw new Error(`delivery not found: ${deliveryId}`);
  if (!['DRAFT', 'READY_FOR_APPROVAL', 'APPROVED'].includes(d.status)) {
    throw new Error(`cannot deny from status ${d.status}`);
  }
  return {
    ok: true,
    delivery: clientDeliveries.updateStatus(deliveryId, 'REJECTED', { decidedBy }),
    externalSend: false,
  };
}

async function createTransport(injected) {
  if (injected !== undefined) return injected;
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

function ensureConversationForDelivery(d) {
  if (d.conversation_id) return d.conversation_id;
  try {
    const existing = conversations.list({
      companyId: d.company_id || undefined, contactId: d.contact_id || undefined, limit: 5,
    });
    if (existing?.length) return existing[0].id;
  } catch { /* */ }
  try {
    const created = conversations.create({
      companyId: d.company_id, contactId: d.contact_id, prospectId: d.prospect_id,
      channel: d.channel || 'email', status: 'OPEN',
    });
    return created?.id || null;
  } catch { return null; }
}

function recordOutbound(d, { providerMessageId } = {}) {
  let conversationId = d.conversation_id || ensureConversationForDelivery(d);
  if (conversationId && !d.conversation_id) {
    try {
      getDb().prepare('UPDATE client_deliveries SET conversation_id = ?, updated_at = ? WHERE id = ?')
        .run(conversationId, new Date().toISOString(), d.id);
    } catch { /* */ }
    d = { ...d, conversation_id: conversationId };
  }
  if (!conversationId) return null;
  const externalId = providerMessageId || `outbound:${d.id}`;
  const prior = inboundMessages.findByProviderExternalId?.('smtp', externalId);
  if (prior) return prior;
  return inboundMessages.create({
    conversationId, companyId: d.company_id, contactId: d.contact_id, prospectId: d.prospect_id,
    provider: 'smtp', externalMessageId: externalId, direction: 'outbound',
    sender: config.notifications?.email?.from || config.notifications?.smtp?.user || null,
    recipient: d.recipient, subject: d.subject, body: d.body_text, receivedAt: new Date().toISOString(),
    classification: d.message_type,
    rawMetadata: {
      deliveryId: d.id, messageType: d.message_type,
      paymentUrlPresent: Boolean(d.payment_url), artifactUrlPresent: Boolean(d.artifact_url),
      correlationId: d.correlation_id,
    },
  });
}

export async function sendApprovedClientDelivery(deliveryId, {
  idempotencyKey, decidedBy = 'control', transport,
} = {}) {
  if (!idempotencyKey || String(idempotencyKey).trim() === '') {
    throw new Error('idempotencyKey is required');
  }
  const existingAttempt = clientDeliveryAttempts.getByIdempotencyKey(idempotencyKey);
  if (existingAttempt) {
    const delivery = clientDeliveries.get(existingAttempt.delivery_id);
    return {
      ok: existingAttempt.status === 'SUCCESS', replay: true, attempt: existingAttempt, delivery,
      sent: existingAttempt.status === 'SUCCESS', externalSideEffect: existingAttempt.status === 'SUCCESS',
    };
  }
  const d = clientDeliveries.get(deliveryId);
  if (!d) throw new Error(`delivery not found: ${deliveryId}`);
  if (d.status !== 'APPROVED') throw new Error(`send requires APPROVED status (got ${d.status})`);
  const hash = computeDeliveryContentHash({
    recipient: d.recipient, channel: d.channel, subject: d.subject, bodyText: d.body_text,
    messageType: d.message_type, paymentUrl: d.payment_url, artifactUrl: d.artifact_url,
  });
  if (hash !== d.content_hash) throw new Error('content hash mismatch; re-approve after changes');
  assertSafeClientContent(d.subject);
  assertSafeClientContent(d.body_text);
  clientDeliveries.updateStatus(deliveryId, 'SENDING');
  let attempt = clientDeliveryAttempts.create({
    deliveryId, idempotencyKey, status: 'PENDING', startedAt: new Date().toISOString(),
  });
  const mailer = await createTransport(transport);
  if (!mailer) {
    const finishedAt = new Date().toISOString();
    attempt = clientDeliveryAttempts.update(attempt.id, {
      status: 'FAILED', finishedAt,
      errorMessage: 'SMTP not configured (set SMTP_HOST and related env vars)',
    });
    const failed = clientDeliveries.updateStatus(deliveryId, 'FAILED', { errorMessage: attempt.error_message });
    return {
      ok: false, replay: false, attempt, delivery: failed,
      sent: false, externalSideEffect: false, error: attempt.error_message,
    };
  }
  try {
    const from = config.notifications.email?.from
      || config.notifications.smtp?.user
      || (transport ? 'phase-a1-test@localhost' : null);
    if (!from) throw new Error('NOTIFY_EMAIL_FROM or SMTP_USER required as From address');
    const info = await mailer.sendMail({
      from, to: d.recipient, subject: d.subject, text: d.body_text, html: d.body_html || undefined,
    });
    const finishedAt = new Date().toISOString();
    const providerMessageId = info?.messageId || null;
    attempt = clientDeliveryAttempts.update(attempt.id, {
      status: 'SUCCESS', providerMessageId, finishedAt, errorMessage: null,
    });
    const sent = clientDeliveries.updateStatus(deliveryId, 'SENT', {
      providerMessageId, sentAt: finishedAt, decidedBy, errorMessage: null,
    });
    let outboundMessageId = null;
    try {
      outboundMessageId = recordOutbound(sent, { providerMessageId })?.id || null;
    } catch (err) {
      return {
        ok: true, replay: false, attempt, delivery: sent,
        sent: true, externalSideEffect: true, providerMessageId, historyWarning: err.message,
      };
    }
    return {
      ok: true, replay: false, attempt, delivery: sent,
      sent: true, externalSideEffect: true, providerMessageId, outboundMessageId,
    };
  } catch (err) {
    const finishedAt = new Date().toISOString();
    attempt = clientDeliveryAttempts.update(attempt.id, {
      status: 'FAILED', finishedAt, errorMessage: err.message || String(err),
    });
    const failed = clientDeliveries.updateStatus(deliveryId, 'FAILED', { errorMessage: attempt.error_message });
    return {
      ok: false, replay: false, attempt, delivery: failed,
      sent: false, externalSideEffect: false, error: attempt.error_message,
    };
  }
}

export function getClientDelivery(id) {
  const delivery = clientDeliveries.get(id);
  if (!delivery) return null;
  return { delivery, attempts: clientDeliveryAttempts.listForDelivery(id, { limit: 20 }) };
}
export function listClientDeliveries(filters = {}) {
  return clientDeliveries.list(filters);
}
export const artifactDelivery = {
  isConfigured() { return false; },
  createSignedUrl() {
    return {
      ok: false, code: 'SECURE_ARTIFACT_STORAGE_REQUIRED',
      message: 'No secure public artifact storage configured. Pass an existing https artifactUrl only.',
    };
  },
};
