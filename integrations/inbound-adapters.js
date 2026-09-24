// integrations/inbound-adapters.js
// Provider-neutral inbound message adapters.

export function normalizeInboundPayload(provider, payload = {}) {
  const p = String(provider || payload.provider || 'unknown').toLowerCase();
  if (p === 'mock' || p === 'test') return normalizeMock(payload);
  return normalizeGeneric({ ...payload, provider: p === 'generic' || p === 'webhook' ? (payload.provider || p) : p });
}

function normalizeMock(payload) {
  return {
    provider: 'mock',
    externalMessageId: payload.externalMessageId || payload.id || null,
    externalThreadId: payload.externalThreadId || payload.threadId || null,
    channel: payload.channel || 'email',
    sender: payload.sender || payload.from || null,
    recipient: payload.recipient || payload.to || null,
    subject: payload.subject || null,
    body: payload.body || payload.text || null,
    receivedAt: payload.receivedAt || payload.timestamp || new Date().toISOString(),
    rawMetadata: payload.metadata || payload.raw || null,
  };
}

function normalizeGeneric(payload) {
  return {
    provider: String(payload.provider || 'generic').toLowerCase(),
    externalMessageId: payload.externalMessageId || payload.messageId || payload.id || null,
    externalThreadId: payload.externalThreadId || payload.threadId || null,
    channel: payload.channel || 'email',
    sender: payload.sender || payload.from || null,
    recipient: payload.recipient || payload.to || null,
    subject: payload.subject || null,
    body: payload.body || payload.text || payload.html || null,
    receivedAt: payload.receivedAt || payload.timestamp || new Date().toISOString(),
    rawMetadata: payload.metadata || payload.raw || null,
  };
}

export function validateNormalizedInbound(msg) {
  if (!msg || typeof msg !== 'object') return { ok: false, error: 'payload must be an object' };
  if (!msg.provider) return { ok: false, error: 'provider is required' };
  if (!msg.channel) return { ok: false, error: 'channel is required' };
  if (!msg.sender && !msg.body && !msg.subject) {
    return { ok: false, error: 'at least one of sender, subject, or body is required' };
  }
  return { ok: true };
}
