// integrations/a2-safe-ingestion.js
// Phase A2 — deterministic identity resolution: exact contact/prospect matches only.
// Unknown senders remain unresolved; no company/contact is guessed or created.
import { companies, contacts, conversations, inboundMessages, prospects, assertProspectStatusTransition } from '../database/index.js';
import { classifyInboundMessage } from './message-classification.js';
import { refreshConversationIntelligence } from './conversation-intelligence.js';

export function ingestA2InboundMessage({ normalized } = {}) {
  if (!normalized || typeof normalized !== 'object') throw new Error('normalized message required');
  if (!normalized.provider || !normalized.externalMessageId || !normalized.sender) throw new Error('provider, externalMessageId, and sender are required');

  const existing = inboundMessages.findByProviderExternalId(normalized.provider, normalized.externalMessageId);
  if (existing) {
    return {
      ok: true, duplicate: true, message: existing,
      conversation: conversations.get(existing.conversation_id),
      contact: existing.contact_id ? contacts.get(existing.contact_id) : null,
      company: existing.company_id ? companies.get(existing.company_id) : null,
      prospect: existing.prospect_id ? prospects.get(existing.prospect_id) : null,
      classification: existing.classification,
      intent: existing.intent,
    };
  }

  const email = extractEmail(normalized.sender);
  const contact = email ? contacts.findByEmail(email) : null;
  const prospect = email ? findProspectByExactEmail(email) : null;
  const company = contact?.company_id ? companies.get(contact.company_id) : null;

  let conversation = normalized.externalThreadId
    ? conversations.findByExternalThread(normalized.channel || 'email', normalized.externalThreadId)
    : null;
  if (!conversation && contact) {
    const open = conversations.list({ contactId: contact.id, status: 'OPEN', limit: 1 });
    conversation = open[0] || null;
  }
  if (!conversation) {
    conversation = conversations.create({
      companyId: company?.id || null,
      contactId: contact?.id || null,
      prospectId: prospect?.id || null,
      channel: normalized.channel || 'email',
      externalThreadId: normalized.externalThreadId || null,
      status: 'OPEN',
      subject: normalized.subject || null,
    });
  }

  const classified = classifyInboundMessage({ subject: normalized.subject, body: normalized.body });
  let message;
  try {
    message = inboundMessages.create({
      conversationId: conversation.id,
      companyId: company?.id || conversation.company_id || null,
      contactId: contact?.id || conversation.contact_id || null,
      prospectId: prospect?.id || conversation.prospect_id || null,
      provider: normalized.provider,
      externalMessageId: normalized.externalMessageId,
      direction: 'inbound',
      sender: normalized.sender,
      recipient: normalized.recipient,
      subject: normalized.subject,
      body: normalized.body,
      receivedAt: normalized.receivedAt,
      intent: classified.intent,
      classification: classified.classification,
      extractedData: classified.extracted,
      rawMetadata: normalized.rawMetadata,
    });
  } catch (err) {
    if (String(err.message || err).includes('UNIQUE')) {
      const duplicate = inboundMessages.findByProviderExternalId(normalized.provider, normalized.externalMessageId);
      if (duplicate) return { ok: true, duplicate: true, message: duplicate, conversation: conversations.get(duplicate.conversation_id), contact: duplicate.contact_id ? contacts.get(duplicate.contact_id) : null, company: duplicate.company_id ? companies.get(duplicate.company_id) : null, prospect: duplicate.prospect_id ? prospects.get(duplicate.prospect_id) : null, classification: duplicate.classification, intent: duplicate.intent };
    }
    throw err;
  }

  conversations.update(conversation.id, { lastMessageAt: message.received_at, subject: conversation.subject || message.subject || null });
  let intelligence = null;
  try { intelligence = refreshConversationIntelligence(conversation.id); } catch { intelligence = null; }

  let prospectStatusUpdated = false;
  if (message.prospect_id) {
    const p = prospects.get(message.prospect_id);
    if (p?.status === 'CONTACTED') {
      try { assertProspectStatusTransition(p.status, 'REPLIED'); prospects.updateStatus(p.id, 'REPLIED'); prospectStatusUpdated = true; } catch { /* safe no-op */ }
    }
  }

  return {
    ok: true, duplicate: false, message,
    conversation: conversations.get(conversation.id),
    contact: message.contact_id ? contacts.get(message.contact_id) : null,
    company: message.company_id ? companies.get(message.company_id) : null,
    prospect: message.prospect_id ? prospects.get(message.prospect_id) : null,
    classification: classified.classification,
    intent: classified.intent,
    extracted: classified.extracted,
    prospectStatusUpdated,
    intelligence: intelligence ? { summary: intelligence.summary, nextAction: intelligence.nextAction, classification: intelligence.insight?.current_classification } : null,
  };
}

function findProspectByExactEmail(email) {
  return prospects.list({ limit: 200 }).find((p) => p.contact_email && String(p.contact_email).trim().toLowerCase() === email) || null;
}

function extractEmail(sender) {
  const s = String(sender || '').trim();
  const angle = s.match(/<([^>]+@[^>]+)>/);
  const raw = angle ? angle[1] : s.includes('@') ? s : '';
  return raw ? raw.toLowerCase().trim() : null;
}

export { extractEmail };
