// integrations/inbound-webhook.js
// Phase A2 — provider-neutral authenticated inbound email webhook.
// Production provider: Resend. Mailgun is no longer a mandatory dependency.
import crypto from 'node:crypto';
import { ingestA2InboundMessage } from './a2-safe-ingestion.js';

const ROUTE = '/api/inbound/email/resend.json';
const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_MAX_AGE_SECONDS = 300;
const installedServers = new WeakSet();

function timingSafeEqualText(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function verifyResendSignature({
  signingSecret,
  webhookId,
  webhookTimestamp,
  webhookSignature,
  rawBody,
  nowSeconds = Math.floor(Date.now() / 1000),
  maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS,
} = {}) {
  if (!signingSecret || !webhookId || !webhookTimestamp || !webhookSignature) {
    return { ok: false, reason: 'missing webhook authentication' };
  }
  const ts = Number(webhookTimestamp);
  if (!Number.isInteger(ts)) return { ok: false, reason: 'invalid webhook timestamp' };
  if (Math.abs(nowSeconds - ts) > maxAgeSeconds) return { ok: false, reason: 'stale webhook' };

  const secret = String(signingSecret).replace(/^whsec_/, '');
  let key;
  try {
    key = Buffer.from(secret, 'base64');
  } catch {
    return { ok: false, reason: 'invalid webhook secret' };
  }
  if (!key.length) return { ok: false, reason: 'invalid webhook secret' };

  const signedContent = `${webhookId}.${webhookTimestamp}.${rawBody}`;
  const expected = crypto.createHmac('sha256', key).update(signedContent, 'utf8').digest('base64');
  const accepted = String(webhookSignature).split(' ').some((entry) => {
    const [version, signature] = entry.split(',', 2);
    return version === 'v1' && timingSafeEqualText(signature, expected);
  });
  return accepted ? { ok: true } : { ok: false, reason: 'invalid webhook signature' };
}

export function normalizeResendInbound(payload = {}) {
  const data = payload?.data || payload || {};
  const attachments = Array.isArray(data.attachments)
    ? data.attachments.slice(0, 20).map((a) => ({
        id: a?.id ? String(a.id).slice(0, 200) : null,
        filename: String(a?.filename || '').slice(0, 255),
        contentType: String(a?.content_type || a?.contentType || 'application/octet-stream').slice(0, 160),
        disposition: a?.content_disposition ? String(a.content_disposition).slice(0, 80) : null,
      }))
    : [];
  const externalMessageId = data.message_id || data.email_id || payload.id || null;
  const externalThreadId = data.in_reply_to || data.inReplyTo || null;
  return {
    provider: 'resend',
    channel: 'email',
    externalMessageId: externalMessageId ? String(externalMessageId) : null,
    externalThreadId: externalThreadId ? String(externalThreadId) : null,
    sender: data.from || null,
    recipient: Array.isArray(data.to) ? data.to[0] || null : data.to || null,
    subject: data.subject || null,
    body: data.text || data.html || null,
    receivedAt: data.created_at || payload.created_at || new Date().toISOString(),
    rawMetadata: {
      verificationState: 'VERIFIED_WEBHOOK',
      emailId: data.email_id || data.id || null,
      references: data.references || null,
      replyTo: data.reply_to || null,
      headers: Array.isArray(data.headers) ? data.headers.slice(0, 100) : null,
      attachments,
    },
  };
}

async function readBody(req, maxBytes) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > maxBytes) throw Object.assign(new Error('request body too large'), { status: 413 });
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw Object.assign(new Error('request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function retrieveResendEmail(emailId, apiKey) {
  if (!emailId || !apiKey) return null;
  const response = await fetch(`https://api.resend.com/emails/${encodeURIComponent(emailId)}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  });
  if (!response.ok) throw Object.assign(new Error('inbound email content retrieval failed'), { status: response.status >= 400 && response.status < 500 ? 502 : 503 });
  return response.json();
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

export function installInboundEmailWebhook(server, { route = ROUTE } = {}) {
  if (!server || typeof server.listeners !== 'function') throw new Error('HTTP server is required');
  if (installedServers.has(server)) return server;
  const listeners = server.listeners('request');
  const original = listeners[0];
  if (typeof original !== 'function') throw new Error('HTTP server request listener not found');
  server.removeAllListeners('request');
  server.on('request', async (req, res) => {
    const pathname = String(req.url || '').split('?')[0];
    if (req.method !== 'POST' || pathname !== route) return original(req, res);

    const provider = String(process.env.INBOUND_EMAIL_PROVIDER || 'resend').trim().toLowerCase();
    if (provider !== 'resend') return json(res, 503, { ok: false, error: 'unsupported inbound email provider' });

    const signingSecret = process.env.RESEND_WEBHOOK_SIGNING_SECRET || '';
    if (!signingSecret) return json(res, 503, { ok: false, error: 'inbound email provider is not configured' });

    try {
      const rawBody = await readBody(req, MAX_BODY_BYTES);
      const verification = verifyResendSignature({
        signingSecret,
        webhookId: req.headers['svix-id'],
        webhookTimestamp: req.headers['svix-timestamp'],
        webhookSignature: req.headers['svix-signature'],
        rawBody,
        maxAgeSeconds: Number(process.env.RESEND_WEBHOOK_MAX_AGE_SECONDS) || DEFAULT_MAX_AGE_SECONDS,
      });
      if (!verification.ok) return json(res, 401, { ok: false, error: 'unauthorized webhook' });

      let payload;
      try { payload = JSON.parse(rawBody); } catch { return json(res, 400, { ok: false, error: 'invalid JSON payload' }); }
      if (payload.type !== 'email.received') return json(res, 202, { ok: true, ignored: true });

      let normalized = normalizeResendInbound(payload);
      if (!normalized.body && normalized.rawMetadata.emailId) {
        const apiKey = process.env.RESEND_API_KEY || '';
        if (!apiKey) return json(res, 503, { ok: false, error: 'inbound email content provider is not configured' });
        const email = await retrieveResendEmail(normalized.rawMetadata.emailId, apiKey);
        normalized = normalizeResendInbound({ ...payload, data: { ...payload.data, ...email } });
      }

      if (!normalized.externalMessageId) return json(res, 400, { ok: false, error: 'message identifier required' });
      if (!normalized.sender || (!normalized.body && !normalized.subject)) {
        return json(res, 400, { ok: false, error: 'sender and message content required' });
      }

      const result = ingestA2InboundMessage({ normalized });
      return json(res, 200, {
        ok: true,
        duplicate: Boolean(result.duplicate),
        messageId: result.message?.id || null,
        conversationId: result.conversation?.id || null,
        classification: result.classification || null,
        intent: result.intent || null,
        unresolved: !result.contact && !result.company && !result.prospect,
        externalSideEffect: false,
      });
    } catch (err) {
      const status = Number(err?.status) || 500;
      return json(res, status, { ok: false, error: status >= 500 ? 'inbound processing failed' : err.message });
    }
  });
  installedServers.add(server);
  return server;
}

export { ROUTE as INBOUND_EMAIL_ROUTE, MAX_BODY_BYTES as INBOUND_EMAIL_MAX_BODY_BYTES };
