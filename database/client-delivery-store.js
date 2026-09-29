// database/client-delivery-store.js
// Phase A1 — client deliveries (approval-gated outbound email)
import { nanoid } from 'nanoid';
import { getDb } from './index.js';

export const clientDeliveries = {
  create({
    id, messageType, channel, status, recipient, subject, bodyText, bodyHtml, contentHash,
    companyId, contactId, conversationId, prospectId, opportunityId, proposalId,
    quoteId, invoiceId, paymentId, projectId, paymentUrl, artifactUrl, artifactKind,
    correlationId, metadata,
  } = {}) {
    if (!recipient) throw new Error('recipient is required');
    if (!subject && subject !== '') throw new Error('subject is required');
    if (!bodyText && bodyText !== '') throw new Error('bodyText is required');
    if (!contentHash) throw new Error('contentHash is required');
    const genId = id || nanoid(12);
    const now = new Date().toISOString();
    getDb().prepare(`
      INSERT INTO client_deliveries (
        id, message_type, channel, status, recipient, subject, body_text, body_html, content_hash,
        company_id, contact_id, conversation_id, prospect_id, opportunity_id, proposal_id,
        quote_id, invoice_id, payment_id, project_id, payment_url, artifact_url, artifact_kind,
        correlation_id, metadata_json, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      genId,
      messageType || 'GENERIC',
      channel || 'email',
      status || 'DRAFT',
      recipient,
      subject || '',
      bodyText || '',
      bodyHtml || null,
      contentHash,
      companyId || null,
      contactId || null,
      conversationId || null,
      prospectId || null,
      opportunityId || null,
      proposalId || null,
      quoteId || null,
      invoiceId || null,
      paymentId || null,
      projectId || null,
      paymentUrl || null,
      artifactUrl || null,
      artifactKind || null,
      correlationId || null,
      metadata != null ? (typeof metadata === 'string' ? metadata : JSON.stringify(metadata)) : null,
      now,
      now,
    );
    return clientDeliveries.get(genId);
  },
  get(id) {
    return getDb().prepare('SELECT * FROM client_deliveries WHERE id = ?').get(id);
  },
  list({ limit = 50, status, conversationId, invoiceId, companyId, contactId } = {}) {
    const c = [];
    const p = [];
    if (status) { c.push('status = ?'); p.push(status); }
    if (conversationId) { c.push('conversation_id = ?'); p.push(conversationId); }
    if (invoiceId) { c.push('invoice_id = ?'); p.push(invoiceId); }
    if (companyId) { c.push('company_id = ?'); p.push(companyId); }
    if (contactId) { c.push('contact_id = ?'); p.push(contactId); }
    const w = c.length ? `WHERE ${c.join(' AND ')}` : '';
    p.push(limit);
    return getDb().prepare(`SELECT * FROM client_deliveries ${w} ORDER BY created_at DESC LIMIT ?`).all(...p);
  },
  updateStatus(id, status, {
    decidedBy, approvedAt, sentAt, providerMessageId, errorMessage,
  } = {}) {
    const cur = clientDeliveries.get(id);
    if (!cur) throw new Error(`client delivery not found: ${id}`);
    const now = new Date().toISOString();
    getDb().prepare(`
      UPDATE client_deliveries SET
        status = ?,
        decided_by = COALESCE(?, decided_by),
        approved_at = COALESCE(?, approved_at),
        sent_at = COALESCE(?, sent_at),
        provider_message_id = COALESCE(?, provider_message_id),
        error_message = COALESCE(?, error_message),
        updated_at = ?
      WHERE id = ?
    `).run(
      status,
      decidedBy ?? null,
      approvedAt ?? null,
      sentAt ?? null,
      providerMessageId ?? null,
      errorMessage !== undefined ? errorMessage : null,
      now,
      id,
    );
    return clientDeliveries.get(id);
  },
};

export const clientDeliveryAttempts = {
  create({ id, deliveryId, idempotencyKey, status, providerMessageId, startedAt, finishedAt, errorMessage } = {}) {
    if (!deliveryId) throw new Error('deliveryId is required');
    if (!idempotencyKey) throw new Error('idempotencyKey is required');
    const genId = id || nanoid(12);
    const now = new Date().toISOString();
    getDb().prepare(`
      INSERT INTO client_delivery_attempts
        (id, delivery_id, idempotency_key, status, provider_message_id, started_at, finished_at, error_message, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      genId,
      deliveryId,
      idempotencyKey,
      status || 'PENDING',
      providerMessageId || null,
      startedAt || null,
      finishedAt || null,
      errorMessage || null,
      now,
    );
    return clientDeliveryAttempts.get(genId);
  },
  get(id) {
    return getDb().prepare('SELECT * FROM client_delivery_attempts WHERE id = ?').get(id);
  },
  getByIdempotencyKey(key) {
    return getDb().prepare('SELECT * FROM client_delivery_attempts WHERE idempotency_key = ?').get(key);
  },
  listForDelivery(deliveryId, { limit = 20 } = {}) {
    return getDb().prepare(
      'SELECT * FROM client_delivery_attempts WHERE delivery_id = ? ORDER BY created_at DESC LIMIT ?',
    ).all(deliveryId, limit);
  },
  update(id, { status, providerMessageId, finishedAt, errorMessage } = {}) {
    const cur = clientDeliveryAttempts.get(id);
    if (!cur) throw new Error(`client delivery attempt not found: ${id}`);
    getDb().prepare(`
      UPDATE client_delivery_attempts SET
        status = COALESCE(?, status),
        provider_message_id = COALESCE(?, provider_message_id),
        finished_at = COALESCE(?, finished_at),
        error_message = COALESCE(?, error_message)
      WHERE id = ?
    `).run(
      status ?? null,
      providerMessageId ?? null,
      finishedAt ?? null,
      errorMessage !== undefined ? errorMessage : null,
      id,
    );
    return clientDeliveryAttempts.get(id);
  },
};
