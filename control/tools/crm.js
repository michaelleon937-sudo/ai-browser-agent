// control/tools/crm.js
// Phase 6 CRM — read/query tools + controlled inbound ingestion.
// No outbound messaging tools.

import {
  companies,
  contacts,
  conversations,
  inboundMessages,
  prospects,
} from '../../database/index.js';
import { ingestInboundMessage } from '../../integrations/inbound-ingestion.js';

export const crmTools = {
  'crm.find_company': findCompany,
  'crm.find_contact': findContact,
  'crm.find_conversation': findConversation,
  'crm.get_conversation': getConversation,
  'crm.list_messages': listMessages,
  'crm.ingest_message': ingestMessage,
};

async function findCompany(args = {}) {
  if (args.id) {
    const row = companies.get(args.id);
    return { ok: Boolean(row), company: row || null };
  }
  if (args.domain) {
    const row = companies.findByDomain(args.domain);
    return { ok: Boolean(row), company: row || null };
  }
  if (args.name) {
    const row = companies.findByName(args.name);
    return { ok: Boolean(row), company: row || null };
  }
  const list = companies.list({ limit: Number(args.limit) || 20 });
  return { ok: true, companies: list };
}

async function findContact(args = {}) {
  if (args.id) {
    const row = contacts.get(args.id);
    return { ok: Boolean(row), contact: row || null };
  }
  if (args.email) {
    const row = contacts.findByEmail(args.email);
    return { ok: Boolean(row), contact: row || null };
  }
  if (args.externalId) {
    const row = contacts.findByExternalId(args.externalId);
    return { ok: Boolean(row), contact: row || null };
  }
  const list = contacts.list({
    limit: Number(args.limit) || 20,
    companyId: args.companyId,
    prospectId: args.prospectId,
  });
  return { ok: true, contacts: list };
}

async function findConversation(args = {}) {
  if (args.id) {
    const row = conversations.get(args.id);
    return { ok: Boolean(row), conversation: row || null };
  }
  if (args.channel && args.externalThreadId) {
    const row = conversations.findByExternalThread(args.channel, args.externalThreadId);
    return { ok: Boolean(row), conversation: row || null };
  }
  const list = conversations.list({
    limit: Number(args.limit) || 20,
    status: args.status,
    contactId: args.contactId,
    companyId: args.companyId,
    prospectId: args.prospectId,
  });
  return { ok: true, conversations: list };
}

async function getConversation(args = {}) {
  const id = args.id || args.conversationId;
  if (!id) throw new Error('id is required');
  const conversation = conversations.get(id);
  if (!conversation) return { ok: false, error: 'conversation not found' };
  const messages = inboundMessages.list({ conversationId: id, limit: Number(args.limit) || 50 });
  return {
    ok: true,
    conversation,
    messages,
    contact: conversation.contact_id ? contacts.get(conversation.contact_id) : null,
    company: conversation.company_id ? companies.get(conversation.company_id) : null,
    prospect: conversation.prospect_id ? prospects.get(conversation.prospect_id) : null,
  };
}

async function listMessages(args = {}) {
  const list = inboundMessages.list({
    limit: Number(args.limit) || 50,
    conversationId: args.conversationId,
    contactId: args.contactId,
    prospectId: args.prospectId,
    classification: args.classification,
  });
  return { ok: true, messages: list };
}

async function ingestMessage(args = {}) {
  const result = ingestInboundMessage({
    provider: args.provider,
    payload: args.payload,
    channel: args.channel,
    sender: args.sender,
    recipient: args.recipient,
    subject: args.subject,
    body: args.body,
    externalMessageId: args.externalMessageId,
    externalThreadId: args.externalThreadId,
    receivedAt: args.receivedAt,
    prospectId: args.prospectId,
    companyId: args.companyId,
    contactId: args.contactId,
  });
  return {
    ok: result.ok,
    duplicate: result.duplicate,
    messageId: result.message?.id,
    conversationId: result.conversation?.id,
    contactId: result.contact?.id,
    companyId: result.company?.id,
    prospectId: result.prospect?.id,
    classification: result.classification,
    intent: result.intent,
    prospectStatusUpdated: result.prospectStatusUpdated,
    extracted: result.extracted || null,
  };
}
