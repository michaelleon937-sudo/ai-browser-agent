// database/client-delivery-event-store.js
// Phase A2.1 — idempotent CloudMailin outbound event persistence.

import { nanoid } from 'nanoid';
import { getDb } from './index.js';

export const clientDeliveryEvents = {
  create({ id, deliveryId, eventKey, eventKind, providerMessageId, originalMessageId, recipient, occurredAt, details } = {}) {
    if (!eventKey) throw new Error('eventKey is required');
    const existing = this.getByEventKey(eventKey);
    if (existing) return { event: existing, duplicate: true };
    const genId = id || nanoid(12);
    const now = new Date().toISOString();
    getDb().prepare(`
      INSERT INTO client_delivery_events
        (id, delivery_id, provider, event_key, event_kind, provider_message_id, original_message_id, recipient, occurred_at, details_json, created_at)
      VALUES (?, ?, 'cloudmailin', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(genId, deliveryId || null, eventKey, eventKind || 'unknown',
      providerMessageId || null, originalMessageId || null, recipient || null,
      occurredAt || now, details ? JSON.stringify(details) : null, now);
    return { event: this.get(genId), duplicate: false };
  },
  get(id) { return getDb().prepare('SELECT * FROM client_delivery_events WHERE id = ?').get(id); },
  getByEventKey(key) { return getDb().prepare('SELECT * FROM client_delivery_events WHERE event_key = ?').get(key); },
  listForDelivery(deliveryId, { limit = 50 } = {}) {
    return getDb().prepare('SELECT * FROM client_delivery_events WHERE delivery_id = ? ORDER BY occurred_at DESC LIMIT ?').all(deliveryId, limit);
  },
};
