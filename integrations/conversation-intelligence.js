// integrations/conversation-intelligence.js
// Phase 6 CRM Prompt 2 — conversation summary, facts, next-action (deterministic rules).
// Distinguishes FACT vs INFERENCE vs UNKNOWN. Never invents client requirements.

import {
  companies, contacts, conversations, inboundMessages, prospects,
  conversationInsights,
} from '../database/index.js';
import { classifyInboundMessage } from './message-classification.js';
import { recommendNextAction } from './next-action.js';
import { extractAndStoreMemory } from './client-memory.js';

export function refreshConversationIntelligence(conversationId) {
  const conversation = conversations.get(conversationId);
  if (!conversation) throw new Error(`conversation not found: ${conversationId}`);

  const messages = inboundMessages.list({ conversationId, limit: 100 });
  const chrono = [...messages].reverse();
  const latest = messages[0] || null;

  const contact = conversation.contact_id ? contacts.get(conversation.contact_id) : null;
  const company = conversation.company_id ? companies.get(conversation.company_id) : null;
  const prospect = conversation.prospect_id ? prospects.get(conversation.prospect_id) : null;

  const facts = { FACT: {}, INFERENCE: {}, UNKNOWN: {} };
  let requestedService = null;
  let requestedDeliverables = null;
  let deadline = null;
  let budget = null;
  const unresolvedQuestions = [];
  let currentClassification = latest?.classification || null;
  let currentIntent = latest?.intent || null;

  for (const msg of chrono) {
    let extracted = {};
    try {
      extracted = msg.extracted_data_json ? JSON.parse(msg.extracted_data_json) : {};
    } catch { extracted = {}; }
    if (!Object.keys(extracted).length && (msg.body || msg.subject)) {
      extracted = classifyInboundMessage({ subject: msg.subject, body: msg.body }).extracted;
    }
    if (extracted.requestedService) {
      requestedService = extracted.requestedService;
      facts.FACT.requestedService = { value: extracted.requestedService, source: msg.id };
    }
    if (extracted.requestedDeliverables) {
      requestedDeliverables = Array.isArray(extracted.requestedDeliverables)
        ? extracted.requestedDeliverables.join(', ')
        : String(extracted.requestedDeliverables);
      facts.FACT.requestedDeliverables = { value: requestedDeliverables, source: msg.id };
    }
    if (extracted.deadline) {
      deadline = extracted.deadline;
      facts.FACT.deadline = { value: deadline, source: msg.id };
    }
    if (extracted.budget) {
      budget = extracted.budget;
      facts.FACT.budget = { value: budget, source: msg.id };
    }
    if (extracted.brandOrBusinessName) {
      facts.FACT.brandName = { value: extracted.brandOrBusinessName, source: msg.id };
    }
    if (Array.isArray(extracted.explicitQuestions)) {
      for (const q of extracted.explicitQuestions) {
        if (q && !unresolvedQuestions.includes(q)) unresolvedQuestions.push(q);
      }
    }
    if (msg.classification) currentClassification = msg.classification;
    if (msg.intent) currentIntent = msg.intent;
  }

  if (company?.name && !facts.FACT.companyName) {
    facts.FACT.companyName = { value: company.name, source: 'company_record' };
  }
  if (contact?.email && !facts.FACT.contactEmail) {
    facts.FACT.contactEmail = { value: contact.email, source: 'contact_record' };
  }
  if (!requestedService) facts.UNKNOWN.requestedService = true;
  if (!budget) facts.UNKNOWN.budget = true;

  const summary = buildCompactSummary({
    contact, company, prospect, requestedService, requestedDeliverables,
    deadline, budget, unresolvedQuestions, currentClassification, currentIntent,
    messageCount: messages.length, latest,
  });

  const next = recommendNextAction({
    classification: currentClassification,
    intent: currentIntent,
    requestedService,
    unresolvedQuestions,
    prospectStatus: prospect?.status,
    hasBudget: Boolean(budget),
    messageCount: messages.length,
  });

  extractAndStoreMemory({
    companyId: company?.id,
    contactId: contact?.id,
    prospectId: prospect?.id,
    extracted: {
      requestedService,
      requestedDeliverables,
      deadline,
      budget,
      brandOrBusinessName: facts.FACT.brandName?.value,
    },
    sourceMessageId: latest?.id,
  });

  const insight = conversationInsights.upsert(conversationId, {
    messageCount: messages.length,
    latestMessageId: latest?.id || null,
    currentIntent,
    currentClassification,
    summary,
    facts,
    requestedService,
    requestedDeliverables,
    deadline,
    budget,
    unresolvedQuestions,
    nextAction: next.action,
    nextActionReason: next.reason,
  });

  return {
    conversation,
    insight,
    contact,
    company,
    prospect,
    messages,
    summary,
    nextAction: next,
    facts,
  };
}

function buildCompactSummary({
  contact, company, prospect, requestedService, requestedDeliverables,
  deadline, budget, unresolvedQuestions, currentClassification, currentIntent,
  messageCount, latest,
}) {
  const who = contact?.name || contact?.email || latest?.sender || 'Unknown contact';
  const biz = company?.name || prospect?.business_name || 'Unknown business';
  const service = requestedService || 'UNKNOWN';
  const deliverables = requestedDeliverables || 'UNKNOWN';
  const missing = [];
  if (!requestedService) missing.push('service');
  if (!budget) missing.push('budget');
  if (!deadline) missing.push('deadline');
  const lines = [
    `Client: ${who}`,
    `Business: ${biz}`,
    `Service interest: ${service}`,
    `Deliverables: ${deliverables}`,
    `Messages: ${messageCount}`,
    `Latest intent: ${currentIntent || currentClassification || 'UNKNOWN'}`,
    `Missing: ${missing.length ? missing.join(', ') : 'none identified'}`,
    `Open questions: ${unresolvedQuestions.length ? unresolvedQuestions.slice(0, 3).join(' | ') : 'none'}`,
  ];
  return lines.join('\n');
}

export function getConversationIntelligence(conversationId) {
  const existing = conversationInsights.get(conversationId);
  if (!existing) return refreshConversationIntelligence(conversationId);
  const conversation = conversations.get(conversationId);
  return {
    conversation,
    insight: existing,
    contact: conversation?.contact_id ? contacts.get(conversation.contact_id) : null,
    company: conversation?.company_id ? companies.get(conversation.company_id) : null,
    prospect: conversation?.prospect_id ? prospects.get(conversation.prospect_id) : null,
    messages: inboundMessages.list({ conversationId, limit: 50 }),
    summary: existing.summary,
    nextAction: { action: existing.next_action, reason: existing.next_action_reason },
    facts: safeParse(existing.facts_json),
  };
}

function safeParse(s) {
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
}
