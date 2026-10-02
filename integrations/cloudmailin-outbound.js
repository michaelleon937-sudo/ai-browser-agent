// integrations/cloudmailin-outbound.js
// Phase A2.1 — CloudMailin transactional outbound email.

import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { inboundMessages } from '../database/index.js';

const MAX_REFERENCES = 20;

export function cloudMailinConfigured() {
  const cfg = config.cloudmailin?.outbound;
  return Boolean(cfg?.accountId && cfg?.apiToken && cfg?.from);
}

function normalizeMessageId(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  return s.startsWith('<') && s.endsWith('>') ? s : `<${s}>`;
}

function senderDomain(from) {
  const match = String(from || '').match(/@([^>\s]+)>?\s*$/);
  return (match?.[1] || 'agent.local').replace(/[^a-z0-9.-]/gi, '').toLowerCase() || 'agent.local';
}

function latestInboundForConversation(conversationId) {
  if (!conversationId) return null;
  const rows = inboundMessages.list({ conversationId, limit: 50 }) || [];
  return rows.find((row) => row.direction !== 'outbound' && row.external_message_id);
}

export function buildReplyHeaders({ conversationId, deliveryId } = {}) {
  const latest = latestInboundForConversation(conversationId);
  const previous = normalizeMessageId(latest?.external_message_id);
  const metadata = latest?.raw_metadata_json ? (() => {
    try { return JSON.parse(latest.raw_metadata_json) || {}; } catch { return {}; }
  })() : {};
  const refs = [];
  const priorReferences = metadata?.references;
  if (Array.isArray(priorReferences)) refs.push(...priorReferences);
  else if (typeof priorReferences === 'string') refs.push(...priorReferences.split(/\s+/));
  if (previous) refs.push(previous);
  const uniqueRefs = [...new Set(refs.map(normalizeMessageId).filter(Boolean))].slice(-MAX_REFERENCES);
  const messageId = `<${deliveryId}@${senderDomain(config.cloudmailin.outbound.from)}>`;
  const headers = { 'Message-ID': messageId };
  if (previous) headers['In-Reply-To'] = previous;
  if (uniqueRefs.length) headers.References = uniqueRefs.join(' ');
  return { headers, messageId, inReplyTo: previous, references: uniqueRefs };
}

export async function sendCloudMailinMessage({
  deliveryId, to, subject, plain, html, conversationId, tags = [], fetchImpl = fetch,
} = {}) {
  const cfg = config.cloudmailin.outbound;
  if (!cloudMailinConfigured()) {
    throw new Error('CloudMailin outbound is not configured (account ID, API token, and From are required)');
  }
  const reply = buildReplyHeaders({ conversationId, deliveryId });
  const endpoint = `${String(cfg.apiBaseUrl).replace(/\/$/, '')}/${encodeURIComponent(cfg.accountId)}/messages`;
  const payload = {
    from: cfg.from,
    to: [to],
    test_mode: Boolean(cfg.testMode),
    subject,
    plain,
    html: html || undefined,
    headers: reply.headers,
    tags: ['ai-browser-agent', 'customer-reply', ...tags].slice(0, 20),
  };
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.apiToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) {
    const detail = data?.error || data?.message || text.slice(0, 500);
    const err = new Error(`CloudMailin outbound rejected request (HTTP ${response.status})${detail ? `: ${detail}` : ''}`);
    err.status = response.status;
    throw err;
  }
  const providerMessageId = data?.id || data?.message_id || response.headers.get('x-message-id') || null;
  return {
    provider: 'cloudmailin',
    providerMessageId: providerMessageId ? String(providerMessageId) : null,
    clientMessageId: reply.messageId,
    inReplyTo: reply.inReplyTo,
    references: reply.references,
    accepted: true,
    response: data,
  };
}

export function hashEventPayload(event) {
  return crypto.createHash('sha256').update(JSON.stringify(event || {})).digest('hex');
}

export function verifyCloudMailinEventsAuthorization(authorization) {
  const secret = config.cloudmailin?.outbound?.eventsAuthSecret || '';
  if (!secret) return { ok: false, status: 503, reason: 'CloudMailin outbound events secret is not configured' };
  const value = String(authorization || '').trim();
  const expected = `Bearer ${secret}`;
  const left = Buffer.from(value, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  const ok = left.length === right.length && crypto.timingSafeEqual(left, right);
  return ok ? { ok: true } : { ok: false, status: 401, reason: 'invalid CloudMailin events authorization' };
}
