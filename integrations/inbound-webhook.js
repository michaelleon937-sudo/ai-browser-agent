// integrations/inbound-webhook.js
// Phase A2 — authenticated Mailgun inbound-email webhook.
import crypto from 'node:crypto';
import { ingestA2InboundMessage } from './a2-safe-ingestion.js';

const ROUTE = '/api/inbound/email/mailgun.json';
const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_MAX_AGE_SECONDS = 300;
const installedServers = new WeakSet();

export function verifyMailgunSignature({ signingKey, timestamp, signature, rawBody, nowSeconds = Math.floor(Date.now() / 1000), maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS } = {}) {
  if (!signingKey || !timestamp || !signature) return { ok: false, reason: 'missing webhook authentication' };
  const ts = Number(timestamp);
  if (!Number.isInteger(ts)) return { ok: false, reason: 'invalid webhook timestamp' };
  if (Math.abs(nowSeconds - ts) > maxAgeSeconds) return { ok: false, reason: 'stale webhook' };
  const expected = crypto.createHmac('sha256', signingKey).update(`${timestamp}${rawBody}`, 'utf8').digest('hex');
  const a = Buffer.from(String(signature), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'invalid webhook signature' };
  return { ok: true };
}

export function normalizeMailgunInbound(payload = {}) {
  const headers = Array.isArray(payload['message-headers']) ? payload['message-headers'] : [];
  const headerValue = (name) => {
    const row = headers.find((h) => Array.isArray(h) && String(h[0]).toLowerCase() === name.toLowerCase());
    return row ? String(row[1] || '') : '';
  };
  const externalMessageId = payload['Message-Id'] || payload['message-id'] || headerValue('Message-Id') || null;
  const externalThreadId = payload['In-Reply-To'] || payload['in-reply-to'] || headerValue('In-Reply-To') || null;
  const references = payload['References'] || payload.references || headerValue('References') || null;
  const attachments = Array.isArray(payload.attachments)
    ? payload.attachments.slice(0, 20).map((a) => ({ filename: String(a?.filename || '').slice(0, 255), contentType: String(a?.['content-type'] || a?.contentType || 'application/octet-stream').slice(0, 160), sizeBytes: typeof a?.content === 'string' ? Math.floor(Buffer.byteLength(a.content, 'base64') * 0.75) : null }))
    : [];
  return {
    provider: 'mailgun', channel: 'email', externalMessageId, externalThreadId,
    sender: payload.sender || payload.from || null, recipient: payload.recipient || null,
    subject: payload.subject || null, body: payload['body-plain'] || payload['stripped-text'] || '',
    receivedAt: payload.timestamp ? new Date(Number(payload.timestamp) * 1000).toISOString() : new Date().toISOString(),
    rawMetadata: { verificationState: 'VERIFIED_WEBHOOK', domain: payload.domain?.name || payload.domain || null, authenticationResults: payload['authentication-results'] || payload.authentication || null, spam: { flag: payload['X-Mailgun-Sflag'] || null, score: payload['X-Mailgun-Sscore'] || null }, references, headers: headers.slice(0, 100), attachments },
  };
}

async function readBody(req, maxBytes) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > maxBytes) throw Object.assign(new Error('request body too large'), { status: 413 });
  const chunks = []; let total = 0;
  for await (const chunk of req) { total += chunk.length; if (total > maxBytes) throw Object.assign(new Error('request body too large'), { status: 413 }); chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}

function json(res, status, body) { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body)); }

export function installInboundEmailWebhook(server, { route = ROUTE } = {}) {
  if (!server || typeof server.listeners !== 'function') throw new Error('HTTP server is required');
  if (installedServers.has(server)) return server;
  const listeners = server.listeners('request');
  const original = listeners[0];
  if (typeof original !== 'function') throw new Error('Express request listener not found');
  server.removeAllListeners('request');
  server.on('request', async (req, res) => {
    const pathname = String(req.url || '').split('?')[0];
    if (req.method !== 'POST' || pathname !== route) return original(req, res);
    const signingKey = process.env.MAILGUN_WEBHOOK_SIGNING_KEY || '';
    if (!signingKey) return json(res, 503, { ok: false, error: 'inbound email provider is not configured' });
    try {
      const rawBody = await readBody(req, MAX_BODY_BYTES);
      const verification = verifyMailgunSignature({ signingKey, timestamp: req.headers['x-mailgun-timestamp'], signature: req.headers['x-mailgun-signature'], rawBody, maxAgeSeconds: Number(process.env.MAILGUN_WEBHOOK_MAX_AGE_SECONDS) || DEFAULT_MAX_AGE_SECONDS });
      if (!verification.ok) return json(res, 401, { ok: false, error: 'unauthorized webhook' });
      let payload; try { payload = JSON.parse(rawBody); } catch { return json(res, 400, { ok: false, error: 'invalid JSON payload' }); }
      const normalized = normalizeMailgunInbound(payload);
      if (!normalized.externalMessageId) return json(res, 400, { ok: false, error: 'message identifier required' });
      if (!normalized.sender || (!normalized.body && !normalized.subject)) return json(res, 400, { ok: false, error: 'sender and message content required' });
      const result = ingestA2InboundMessage({ normalized });
      return json(res, 200, { ok: true, duplicate: Boolean(result.duplicate), messageId: result.message?.id || null, conversationId: result.conversation?.id || null, classification: result.classification || null, intent: result.intent || null, unresolved: !result.contact && !result.company && !result.prospect, draftAvailable: Boolean(result.conversation?.id), externalSideEffect: false });
    } catch (err) {
      const status = Number(err?.status) || 500;
      return json(res, status, { ok: false, error: status >= 500 ? 'inbound processing failed' : err.message });
    }
  });
  installedServers.add(server);
  return server;
}

export { ROUTE as INBOUND_EMAIL_ROUTE, MAX_BODY_BYTES as INBOUND_EMAIL_MAX_BODY_BYTES };
