// control/tools/crm.js
// Phase 6 CRM — read/query, memory, next-action, controlled lifecycle (no outbound send).

import {
  companies, contacts, conversations, inboundMessages, prospects,
  assertProspectStatusTransition, assertCanMarkCustomer,
} from '../../database/index.js';
import { ingestInboundMessage } from '../../integrations/inbound-ingestion.js';
import { getConversationIntelligence, refreshConversationIntelligence } from '../../integrations/conversation-intelligence.js';
import { getClientMemory, updateClientMemory, getAuthoritativeFacts } from '../../integrations/client-memory.js';
import { recommendNextAction } from '../../integrations/next-action.js';
import { draftClientReply } from '../../integrations/response-draft.js';

export const crmTools = {
  'crm.find_company': findCompany,
  'crm.find_contact': findContact,
  'crm.find_conversation': findConversation,
  'crm.get_conversation': getConversation,
  'crm.list_messages': listMessages,
  'crm.ingest_message': ingestMessage,
  'crm.list_companies': listCompanies,
  'crm.get_company': getCompany,
  'crm.list_contacts': listContacts,
  'crm.get_contact': getContact,
  'crm.list_conversations': listConversations,
  'crm.get_client_memory': getMemory,
  'crm.update_client_memory': updateMemory,
  'crm.get_next_action': getNextAction,
  'crm.link_prospect_to_client': linkProspectToClient,
  'crm.refresh_conversation': refreshConversation,
  'crm.qualify_prospect': qualifyProspect,
  'crm.mark_customer': markCustomer,
  'crm.draft_reply': draftReply,
};

async function findCompany(args = {}) {
  if (args.id) return { ok: Boolean(companies.get(args.id)), company: companies.get(args.id) || null };
  if (args.domain) return { ok: Boolean(companies.findByDomain(args.domain)), company: companies.findByDomain(args.domain) || null };
  if (args.name) return { ok: Boolean(companies.findByName(args.name)), company: companies.findByName(args.name) || null };
  return { ok: true, companies: companies.list({ limit: Number(args.limit) || 20 }) };
}
async function listCompanies(args = {}) {
  return { ok: true, companies: companies.list({ limit: Number(args.limit) || 50 }) };
}
async function getCompany(args = {}) {
  const id = args.id || args.companyId;
  if (!id) throw new Error('id is required');
  const company = companies.get(id);
  if (!company) return { ok: false, error: 'not found' };
  return { ok: true, company, contacts: contacts.list({ companyId: id, limit: 50 }), memory: getAuthoritativeFacts({ companyId: id }) };
}
async function findContact(args = {}) {
  if (args.id) return { ok: Boolean(contacts.get(args.id)), contact: contacts.get(args.id) || null };
  if (args.email) return { ok: Boolean(contacts.findByEmail(args.email)), contact: contacts.findByEmail(args.email) || null };
  if (args.externalId) return { ok: Boolean(contacts.findByExternalId(args.externalId)), contact: contacts.findByExternalId(args.externalId) || null };
  return { ok: true, contacts: contacts.list({ limit: Number(args.limit) || 20, companyId: args.companyId, prospectId: args.prospectId }) };
}
async function listContacts(args = {}) {
  return { ok: true, contacts: contacts.list({ limit: Number(args.limit) || 50, companyId: args.companyId, prospectId: args.prospectId }) };
}
async function getContact(args = {}) {
  const id = args.id || args.contactId;
  if (!id) throw new Error('id is required');
  const contact = contacts.get(id);
  if (!contact) return { ok: false, error: 'not found' };
  return { ok: true, contact, company: contact.company_id ? companies.get(contact.company_id) : null, prospect: contact.prospect_id ? prospects.get(contact.prospect_id) : null, memory: getAuthoritativeFacts({ contactId: id, companyId: contact.company_id, prospectId: contact.prospect_id }) };
}
async function findConversation(args = {}) {
  if (args.id) return { ok: Boolean(conversations.get(args.id)), conversation: conversations.get(args.id) || null };
  if (args.channel && args.externalThreadId) {
    const row = conversations.findByExternalThread(args.channel, args.externalThreadId);
    return { ok: Boolean(row), conversation: row || null };
  }
  return { ok: true, conversations: conversations.list({ limit: Number(args.limit) || 20, status: args.status, contactId: args.contactId, companyId: args.companyId, prospectId: args.prospectId }) };
}
async function listConversations(args = {}) {
  return { ok: true, conversations: conversations.list({ limit: Number(args.limit) || 50, status: args.status, contactId: args.contactId, companyId: args.companyId, prospectId: args.prospectId }) };
}
async function getConversation(args = {}) {
  const id = args.id || args.conversationId;
  if (!id) throw new Error('id is required');
  const intel = getConversationIntelligence(id);
  if (!intel.conversation) return { ok: false, error: 'conversation not found' };
  return { ok: true, conversation: intel.conversation, messages: intel.messages, contact: intel.contact, company: intel.company, prospect: intel.prospect, summary: intel.summary, nextAction: intel.nextAction, insight: intel.insight, facts: intel.facts };
}
async function listMessages(args = {}) {
  return { ok: true, messages: inboundMessages.list({ limit: Number(args.limit) || 50, conversationId: args.conversationId, contactId: args.contactId, prospectId: args.prospectId, classification: args.classification }) };
}
async function ingestMessage(args = {}) {
  const result = ingestInboundMessage({ provider: args.provider, payload: args.payload, channel: args.channel, sender: args.sender, recipient: args.recipient, subject: args.subject, body: args.body, externalMessageId: args.externalMessageId, externalThreadId: args.externalThreadId, receivedAt: args.receivedAt, prospectId: args.prospectId, companyId: args.companyId, contactId: args.contactId });
  return { ok: result.ok, duplicate: result.duplicate, messageId: result.message?.id, conversationId: result.conversation?.id, contactId: result.contact?.id, companyId: result.company?.id, prospectId: result.prospect?.id, classification: result.classification, intent: result.intent, prospectStatusUpdated: result.prospectStatusUpdated, extracted: result.extracted || null, nextAction: result.intelligence?.nextAction || null, summary: result.intelligence?.summary || null };
}
async function getMemory(args = {}) {
  return { ok: true, entries: getClientMemory({ companyId: args.companyId, contactId: args.contactId, prospectId: args.prospectId, key: args.key, limit: Number(args.limit) || 50 }), authoritative: getAuthoritativeFacts({ companyId: args.companyId, contactId: args.contactId, prospectId: args.prospectId }) };
}
async function updateMemory(args = {}) {
  if (!args.key || args.value === undefined) throw new Error('key and value are required');
  let confidence = args.confidence || 'CONFIRMED_BY_SYSTEM';
  if (!['CONFIRMED_BY_CLIENT', 'CONFIRMED_BY_SYSTEM'].includes(confidence)) confidence = 'CONFIRMED_BY_SYSTEM';
  const result = updateClientMemory({ companyId: args.companyId, contactId: args.contactId, prospectId: args.prospectId, key: args.key, value: args.value, confidence, source: args.source || 'operator', notes: args.notes });
  return { ok: true, ...result };
}
async function getNextAction(args = {}) {
  if (args.conversationId) {
    const intel = getConversationIntelligence(args.conversationId);
    return { ok: true, nextAction: intel.nextAction, summary: intel.summary, conversationId: args.conversationId };
  }
  return { ok: true, nextAction: recommendNextAction({ classification: args.classification, intent: args.intent, requestedService: args.requestedService, unresolvedQuestions: args.unresolvedQuestions || [], prospectStatus: args.prospectStatus, hasBudget: args.hasBudget, messageCount: args.messageCount }) };
}
async function linkProspectToClient(args = {}) {
  const prospectId = args.prospectId;
  if (!prospectId) throw new Error('prospectId is required');
  const prospect = prospects.get(prospectId);
  if (!prospect) return { ok: false, error: 'prospect not found' };
  let company = args.companyId ? companies.get(args.companyId) : null;
  if (!company && prospect.business_name) {
    company = companies.findByName(prospect.business_name);
    if (!company) company = companies.create({ name: prospect.business_name, website: prospect.website_url || null, location: prospect.location || null });
  }
  let contact = args.contactId ? contacts.get(args.contactId) : null;
  if (!contact && prospect.contact_email) {
    contact = contacts.findByEmail(prospect.contact_email);
    if (!contact) contact = contacts.create({ companyId: company?.id || null, prospectId, email: prospect.contact_email, name: prospect.contact_name || null });
    else if (!contact.prospect_id) contact = contacts.update(contact.id, { prospectId, companyId: company?.id || contact.company_id });
  }
  return { ok: true, prospect, company, contact, linked: true };
}
async function refreshConversation(args = {}) {
  const id = args.id || args.conversationId;
  if (!id) throw new Error('conversationId is required');
  const intel = refreshConversationIntelligence(id);
  return { ok: true, conversationId: id, summary: intel.summary, nextAction: intel.nextAction, insight: intel.insight };
}
async function qualifyProspect(args = {}) {
  const id = args.prospectId || args.id;
  if (!id) throw new Error('prospectId is required');
  const prospect = prospects.get(id);
  if (!prospect) return { ok: false, error: 'not found' };
  assertProspectStatusTransition(prospect.status, 'QUALIFIED');
  return { ok: true, prospect: prospects.updateStatus(id, 'QUALIFIED') };
}
async function markCustomer(args = {}) {
  const id = args.prospectId || args.id;
  if (!id) throw new Error('prospectId is required');
  assertCanMarkCustomer({ explicitAction: Boolean(args.explicitAction) });
  const prospect = prospects.get(id);
  if (!prospect) return { ok: false, error: 'not found' };
  const target = args.status === 'WON' ? 'WON' : 'CUSTOMER';
  assertProspectStatusTransition(prospect.status, target);
  return { ok: true, prospect: prospects.updateStatus(id, target), requiresExplicitAction: true };
}


async function draftReply(args = {}) {
  const conversationId = args.conversationId || args.id;
  if (!conversationId) throw new Error('conversationId is required');
  const result = draftClientReply({ conversationId, tone: args.tone });
  return { ...result, autoSend: false, requiresHumanApproval: true };
}
