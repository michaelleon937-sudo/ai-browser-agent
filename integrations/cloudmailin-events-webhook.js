// integrations/cloudmailin-events-webhook.js
// Phase A2.1 — authenticated, idempotent CloudMailin outbound delivery events.

import { clientDeliveries } from '../database/client-delivery-store.js';
import { clientDeliveryEvents } from '../database/client-delivery-event-store.js';
import { verifyCloudMailinEventsAuthorization, hashEventPayload } from './cloudmailin-outbound.js';

const ROUTE = '/api/outbound/email/cloudmailin/events';
const MAX_BODY_BYTES = 512 * 1024;

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function safeString(v, max = 500) {
  return v == null ? null : String(v).slice(0, max);
}

function statusForEvent(kind) {
  if (kind === 'delivery') return 'DELIVERED';
  if (['bounce', 'retries_exhausted', 'suppressed', 'error'].includes(kind)) return 'FAILED';
  if (['soft_bounce', 'dispatch_soft_bounce', 'rate_limit'].includes(kind)) return 'RETRYING';
  return null;
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw Object.assign(new Error('request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function findDelivery(event) {
  const providerMessageId = safeString(event?.message_id, 200);
  const originalMessageId = safeString(event?.original_message_id, 320);
  const rows = clientDeliveries.list({ limit: 200 });
  if (providerMessageId) {
    const byProvider = rows.find((d) => d.provider_message_id === providerMessageId);
    if (byProvider) return byProvider;
  }
  if (originalMessageId) {
    for (const row of rows) {
      if (!row.metadata_json) continue;
      try {
        const meta = JSON.parse(row.metadata_json);
        if (meta.cloudmailinClientMessageId === originalMessageId) return row;
      } catch {}
    }
  }
  return null;
}

export function installCloudMailinOutboundEventsWebhook(server, { route = ROUTE } = {}) {
  if (!server || typeof server.listeners !== 'function') throw new Error('HTTP server is required');
  if (server.__cloudMailinEventsInstalled) return server;
  const listeners = server.listeners('request');
  const original = listeners[0];
  if (typeof original !== 'function') throw new Error('HTTP server request listener not found');
  server.__cloudMailinEventsInstalled = true;
  server.removeAllListeners('request');
  server.on('request', async (req, res) => {
    const pathname = String(req.url || '').split('?')[0];
    if (req.method !== 'POST' || pathname !== route) return original(req, res);
    try {
      const verification = verifyCloudMailinEventsAuthorization(req.headers.authorization);
      if (!verification.ok) return json(res, verification.status, { ok: false, error: verification.reason });
      const raw = await readBody(req);
      let payload;
      try { payload = JSON.parse(raw); } catch { return json(res, 400, { ok: false, error: 'invalid JSON payload' }); }
      const events = Array.isArray(payload?.events) ? payload.events.slice(0, 100) : [];
      if (!events.length) return json(res, 400, { ok: false, error: 'events array required' });

      const results = [];
      for (const event of events) {
        const eventKey = hashEventPayload(event);
        const providerMessageId = safeString(event?.message_id, 200);
        const originalMessageId = safeString(event?.original_message_id, 320);
        const delivery = findDelivery(event);
        const stored = clientDeliveryEvents.create({
          deliveryId: delivery?.id,
          eventKey,
          eventKind: safeString(event?.kind, 80) || 'unknown',
          providerMessageId,
          originalMessageId,
          recipient: safeString(event?.recipient, 320),
          occurredAt: safeString(event?.timestamp, 80) || new Date().toISOString(),
          details: event?.details || null,
        });
        if (!stored.duplicate && delivery) {
          const status = statusForEvent(event?.kind);
          if (status) {
            const failure = ['bounce', 'retries_exhausted', 'suppressed', 'error'].includes(event?.kind);
            clientDeliveries.updateStatus(delivery.id, status, {
              providerMessageId,
              errorMessage: failure ? JSON.stringify(event?.details || { kind: event?.kind }) : null,
            });
          }
        }
        results.push({ eventKey, duplicate: stored.duplicate, deliveryId: delivery?.id || null });
      }
      return json(res, 200, { ok: true, processed: results.length, results });
    } catch (err) {
      return json(res, Number(err?.status) || 500, { ok: false, error: err.message || 'event processing failed' });
    }
  });
  return server;
}

export { ROUTE as CLOUDMAILIN_OUTBOUND_EVENTS_ROUTE };
