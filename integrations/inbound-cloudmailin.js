// integrations/inbound-cloudmailin.js
// Phase A2 — CloudMailin JSON Normalized inbound provider adapter.
// Authentication is supplied by the HTTP Authorization header and never by payload data.

import crypto from 'node:crypto';

const MAX_ATTACHMENTS = 20;
const MAX_ATTACHMENT_METADATA = 2048;

function timingSafeEqualText(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function verifyCloudMailinAuthorization({ authorization, secret } = {}) {
  if (!secret) return { ok: false, reason: 'missing configured CloudMailin secret', status: 503 };
  const value = String(authorization || '').trim();
  const expected = `Bearer ${secret}`;
  if (!/^Bearer\s+\S+$/i.test(value)) {
    return { ok: false, reason: 'missing or malformed CloudMailin authorization', status: 401 };
  }
  return timingSafeEqualText(value, expected)
    ? { ok: true }
    : { ok: false, reason: 'invalid CloudMailin authorization', status: 401 };
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return null;
  const wanted = String(name).toLowerCase();
  const key = Object.keys(headers).find((candidate) => String(candidate).toLowerCase() === wanted);
  const value = key ? headers[key] : null;
  return Array.isArray(value) ? value[0] || null : value || null;
}

function firstRecipient(value) {
  if (Array.isArray(value)) return value[0] || null;
  return value || null;
}

function safeAttachmentMetadata(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments.slice(0, MAX_ATTACHMENTS).map((attachment) => {
    const metadata = {
      fileName: String(attachment?.file_name || '').slice(0, 255),
      contentType: String(attachment?.content_type || 'application/octet-stream').slice(0, 160),
      size: Number.isFinite(Number(attachment?.size)) ? Number(attachment.size) : null,
      disposition: attachment?.disposition ? String(attachment.disposition).slice(0, 80) : null,
      contentId: attachment?.content_id ? String(attachment.content_id).slice(0, 255) : null,
      hasInlineContent: typeof attachment?.content === 'string',
      hasUrl: typeof attachment?.url === 'string',
    };
    return JSON.parse(JSON.stringify(metadata).slice(0, MAX_ATTACHMENT_METADATA));
  });
}

export function normalizeCloudMailinInbound(payload = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw Object.assign(new Error('invalid CloudMailin JSON payload'), { status: 400 });
  }

  const envelope = payload.envelope && typeof payload.envelope === 'object' ? payload.envelope : {};
  const headers = payload.headers && typeof payload.headers === 'object' ? payload.headers : {};

  const externalMessageId = headerValue(headers, 'message_id');
  const sender = headerValue(headers, 'from') || envelope.from || null;
  const envelopeSender = envelope.from || null;
  const recipient = envelope.to || null;
  const recipients = Array.isArray(envelope.recipients)
    ? envelope.recipients.slice(0, 50).map((value) => String(value).slice(0, 320))
    : envelope.recipients ? [String(envelope.recipients).slice(0, 320)] : [];
  const headerRecipient = headerValue(headers, 'to');
  const subject = headerValue(headers, 'subject');
  const plain = typeof payload.plain === 'string' ? payload.plain : '';
  const html = typeof payload.html === 'string' ? payload.html : '';
  const replyPlain = typeof payload.reply_plain === 'string' ? payload.reply_plain : '';
  const receivedAt = headerValue(headers, 'date') || new Date().toISOString();

  if (!externalMessageId) throw Object.assign(new Error('message_id required'), { status: 400 });
  if (!sender) throw Object.assign(new Error('sender required'), { status: 400 });
  if (!recipient) throw Object.assign(new Error('recipient required'), { status: 400 });
  if (!plain && !html && !subject) throw Object.assign(new Error('message content required'), { status: 400 });

  return {
    provider: 'cloudmailin',
    channel: 'email',
    externalMessageId: String(externalMessageId),
    externalThreadId: headerValue(headers, 'in_reply_to') || null,
    sender: String(sender),
    recipient: String(recipient),
    subject: subject ? String(subject) : null,
    body: plain || html || null,
    receivedAt: String(receivedAt),
    rawMetadata: {
      verificationState: 'VERIFIED_CLOUDMAILIN_AUTH',
      envelopeSender: envelopeSender ? String(envelopeSender) : null,
      recipients,
      headerRecipient: headerRecipient ? String(headerRecipient) : null,
      headers,
      html: html || null,
      replyPlain: replyPlain || null,
      attachments: safeAttachmentMetadata(payload.attachments),
    },
  };
}

export { timingSafeEqualText };
