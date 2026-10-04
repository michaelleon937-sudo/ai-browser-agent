// Website Engine — persisted lead capture adapter.
// Converts public website enquiries into the existing CRM inbound-message pipeline.
import crypto from 'node:crypto';
import { ingestInboundMessage } from './inbound-ingestion.js';

const clean = (v, max = 4000) => String(v ?? '').trim().slice(0, max);
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ingestWebsiteLead(input = {}) {
  const name = clean(input.name, 160);
  const email = clean(input.email, 320).toLowerCase();
  const phone = clean(input.phone, 80);
  const message = clean(input.message, 4000);
  const consent = input.consent === true || input.consent === 'true' || input.consent === 'on';
  if (!name) throw Object.assign(new Error('name is required'), { status: 400 });
  if (!email || !emailRe.test(email)) throw Object.assign(new Error('valid email is required'), { status: 400 });
  if (!message) throw Object.assign(new Error('message is required'), { status: 400 });
  if (!consent) throw Object.assign(new Error('consent is required'), { status: 400 });
  const externalMessageId = clean(input.externalMessageId, 180) || 'website-' + crypto.createHash('sha256').update([email, message, input.page || ''].join('|')).digest('hex').slice(0, 32);
  const body = [`Name: ${name}`, `Email: ${email}`, phone ? `Phone: ${phone}` : '', `Message: ${message}`].filter(Boolean).join('\\n');
  const result = ingestInboundMessage({
    provider: 'website-engine', channel: 'website', sender: email, recipient: clean(input.recipient, 320),
    subject: clean(input.subject || 'Website enquiry', 200), body, externalMessageId,
    externalThreadId: clean(input.externalThreadId, 180) || 'website:' + email,
    receivedAt: input.receivedAt, rawMetadata: { page: clean(input.page, 500), userAgent: clean(input.userAgent, 500), consent: true }
  });
  return { ok: true, duplicate: Boolean(result.duplicate), leadId: result.message?.id || null, conversationId: result.conversation?.id || null, contactId: result.contact?.id || null, companyId: result.company?.id || null, classification: result.classification || null, nextAction: result.intelligence?.nextAction || null };
}
