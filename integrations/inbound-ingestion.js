// integrations/inbound-ingestion.js
// Phase 6 CRM — safe inbound message ingestion with idempotency and CRM linking.

import {
  companies, contacts, conversations, inboundMessages, prospects,
  assertProspectStatusTransition,
} from '../database/index.js';
import { normalizeInboundPayload, validateNormalizedInbound } from './inbound-adapters.js';
import { classifyInboundMessage } from './message-classification.js';
import { refreshConversationIntelligence } from './conversation-intelligence.js';

export function ingestInboundMessage(input = {}) {
  const normalized = input.payload
    ? normalizeInboundPayload(input.provider || input.payload.provider, input.payload)
    : normalizeInboundPayload(input.provider || 'generic', input);

  const validation = validateNormalizedInbound(normalized);
  if (!validation.ok) throw new Error(validation.error);

  if (normalized.externalMessageId) {
    const existing = inboundMessages.findByProviderExternalId(normalized.provider, normalized.externalMessageId);
    if (existing) {
      return {
        ok: true, duplicate: true, message: existing,
        conversation: conversations.get(existing.conversation_id),
        contact: existing.contact_id ? contacts.get(existing.contact_id) : null,
        company: existing.company_id ? companies.get(existing.company_id) : null,
        prospect: existing.prospect_id ? prospects.get(existing.prospect_id) : null,
        classification: existing.classification, prospectStatusUpdated: false,
      };
    }
  }

  const resolution = resolveEntities({
    sender: normalized.sender,
    explicitContactId: input.contactId,
    explicitCompanyId: input.companyId,
    explicitProspectId: input.prospectId,
  });

  let conversation = null;
  if (normalized.externalThreadId) {
    conversation = conversations.findByExternalThread(normalized.channel, normalized.externalThreadId);
  }
  if (!conversation && resolution.contact) {
    const open = conversations.list({ contactId: resolution.contact.id, status: 'OPEN', limit: 1 });
    if (open.length) conversation = open[0];
  }
  if (!conversation) {
    conversation = conversations.create({
      companyId: resolution.company?.id || null,
      contactId: resolution.contact?.id || null,
      prospectId: resolution.prospect?.id || null,
      channel: normalized.channel,
      externalThreadId: normalized.externalThreadId || null,
      status: 'OPEN',
      subject: normalized.subject || null,
    });
  } else {
    const patch = {};
    if (!conversation.contact_id && resolution.contact) patch.contactId = resolution.contact.id;
    if (!conversation.company_id && resolution.company) patch.companyId = resolution.company.id;
    if (!conversation.prospect_id && resolution.prospect) patch.prospectId = resolution.prospect.id;
    if (Object.keys(patch).length) conversation = conversations.update(conversation.id, patch);
  }

  const classified = classifyInboundMessage({ subject: normalized.subject, body: normalized.body });

  let message;
  try {
    message = inboundMessages.create({
      conversationId: conversation.id,
      companyId: resolution.company?.id || conversation.company_id || null,
      contactId: resolution.contact?.id || conversation.contact_id || null,
      prospectId: resolution.prospect?.id || conversation.prospect_id || null,
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
    if (String(err.message || err).includes('UNIQUE') && normalized.externalMessageId) {
      const existing = inboundMessages.findByProviderExternalId(normalized.provider, normalized.externalMessageId);
      if (existing) {
        return {
          ok: true, duplicate: true, message: existing,
          conversation: conversations.get(existing.conversation_id),
          contact: existing.contact_id ? contacts.get(existing.contact_id) : null,
          company: existing.company_id ? companies.get(existing.company_id) : null,
          prospect: existing.prospect_id ? prospects.get(existing.prospect_id) : null,
          classification: existing.classification, prospectStatusUpdated: false,
        };
      }
    }
    throw err;
  }

  conversations.update(conversation.id, {
    lastMessageAt: message.received_at,
    subject: conversation.subject || message.subject || null,
  });
  let intelligence = null;
  try {
    intelligence = refreshConversationIntelligence(conversation.id);
  } catch {
    intelligence = null;
  }


  let prospectStatusUpdated = false;
  if (message.prospect_id) {
    const prospect = prospects.get(message.prospect_id);
    if (prospect && prospect.status === 'CONTACTED') {
      try {
        assertProspectStatusTransition(prospect.status, 'REPLIED');
        prospects.updateStatus(message.prospect_id, 'REPLIED');
        prospectStatusUpdated = true;
      } catch { /* leave unchanged */ }
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

function resolveEntities({ sender, explicitContactId, explicitCompanyId, explicitProspectId }) {
  let contact = explicitContactId ? contacts.get(explicitContactId) : null;
  let company = explicitCompanyId ? companies.get(explicitCompanyId) : null;
  let prospect = explicitProspectId ? prospects.get(explicitProspectId) : null;
  const email = extractEmail(sender);

  if (!contact && email) contact = contacts.findByEmail(email);
  if (!prospect && email) {
    const list = prospects.list({ limit: 200 });
    prospect = list.find((p) => p.contact_email && String(p.contact_email).toLowerCase() === email) || null;
  }
  if (!prospect && email) {
    const domain = email.split('@')[1];
    if (domain) {
      const list = prospects.list({ limit: 200 });
      prospect = list.find((p) => {
        if (!p.website_url) return false;
        try {
          const host = new URL(p.website_url.includes('://') ? p.website_url : `https://${p.website_url}`)
            .hostname.replace(/^www\./, '').toLowerCase();
          return host === domain || host.endsWith(`.${domain}`);
        } catch { return false; }
      }) || null;
    }
  }
  if (!company && contact?.company_id) company = companies.get(contact.company_id);
  if (!company && email) {
    const domain = email.split('@')[1];
    if (domain && !isPublicEmailDomain(domain)) {
      company = companies.findByDomain(domain);
      if (!company) company = companies.create({ name: domain, domain, website: `https://${domain}` });
    }
  }
  if (!contact && (email || sender)) {
    contact = contacts.create({
      companyId: company?.id || null,
      prospectId: prospect?.id || null,
      email: email || null,
    });
  } else if (contact) {
    const patch = {};
    if (!contact.company_id && company) patch.companyId = company.id;
    if (!contact.prospect_id && prospect) patch.prospectId = prospect.id;
    if (Object.keys(patch).length) contact = contacts.update(contact.id, patch);
  }
  if (!company && prospect?.business_name) {
    company = companies.findByName(prospect.business_name);
    if (!company) {
      let domain = null;
      if (prospect.website_url) {
        try {
          domain = new URL(prospect.website_url.includes('://') ? prospect.website_url : `https://${prospect.website_url}`)
            .hostname.replace(/^www\./, '').toLowerCase();
        } catch { /* ignore */ }
      }
      company = companies.create({
        name: prospect.business_name,
        website: prospect.website_url || null,
        domain,
        location: prospect.location || null,
      });
    }
    if (contact && !contact.company_id) contact = contacts.update(contact.id, { companyId: company.id });
  }
  return { contact, company, prospect };
}

function extractEmail(sender) {
  if (!sender) return null;
  const s = String(sender).trim();
  const angle = s.match(/<([^>]+@[^>]+)>/);
  if (angle) return angle[1].toLowerCase().trim();
  if (s.includes('@')) return s.toLowerCase().trim();
  return null;
}

function isPublicEmailDomain(domain) {
  return new Set([
    'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk',
    'hotmail.com', 'outlook.com', 'live.com', 'msn.com',
    'icloud.com', 'me.com', 'aol.com', 'protonmail.com', 'proton.me',
  ]).has(String(domain).toLowerCase());
}
