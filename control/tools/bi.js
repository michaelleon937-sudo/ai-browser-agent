// control/tools/bi.js
// Phase 7 BI — Business Relationship & Intelligence control tools.
// All tools are recommendation/read oriented; no automatic external side effects.

import {
  evaluateRelationship,
  getRelationship,
  RELATIONSHIP_STATES,
} from '../../integrations/relationship-engine.js';
import {
  generateFollowUps,
  listFollowUps,
  resolveFollowUp,
} from '../../integrations/follow-up-engine.js';
import {
  buildClientTimeline,
  computeRevenueHistory,
  detectDormantClients,
  detectRepeatBusiness,
  linkOpportunityToClient,
  assessProjectReadiness,
  getClientIntelligence,
  businessIntelligenceQuery,
  generateBusinessAnalystBrief,
} from '../../integrations/client-intelligence.js';
import { clientTimelineEvents } from '../../database/index.js';

export const biTools = {
  'bi.get_relationship': getRel,
  'bi.evaluate_relationship': evalRel,
  'bi.get_timeline': getTimeline,
  'bi.record_timeline_event': recordTimeline,
  'bi.generate_followups': genFollowups,
  'bi.list_followups': listFu,
  'bi.resolve_followup': resolveFu,
  'bi.get_revenue': getRevenue,
  'bi.detect_dormant': detectDormant,
  'bi.detect_repeat_business': detectRepeat,
  'bi.link_opportunity_client': linkOpp,
  'bi.assess_readiness': assessReady,
  'bi.get_client_intelligence': getIntel,
  'bi.query': biQuery,
  'bi.analyst_brief': analystBrief,
};

function requireScope(args) {
  if (!args.companyId && !args.contactId && !args.prospectId) {
    throw new Error('At least one of companyId, contactId, prospectId is required');
  }
}

async function getRel(args = {}) {
  requireScope(args);
  return getRelationship({
    companyId: args.companyId,
    contactId: args.contactId,
    prospectId: args.prospectId,
  });
}

async function evalRel(args = {}) {
  requireScope(args);
  return evaluateRelationship({
    companyId: args.companyId,
    contactId: args.contactId,
    prospectId: args.prospectId,
    persist: args.persist !== false,
    source: args.source || 'operator',
  });
}

async function getTimeline(args = {}) {
  requireScope(args);
  return buildClientTimeline({
    companyId: args.companyId,
    contactId: args.contactId,
    prospectId: args.prospectId,
    limit: Number(args.limit) || 100,
  });
}

async function recordTimeline(args = {}) {
  requireScope(args);
  if (!args.eventType) throw new Error('eventType is required');
  if (!args.title) throw new Error('title is required');
  const row = clientTimelineEvents.record({
    companyId: args.companyId,
    contactId: args.contactId,
    prospectId: args.prospectId,
    opportunityId: args.opportunityId,
    projectId: args.projectId,
    invoiceId: args.invoiceId,
    paymentId: args.paymentId,
    conversationId: args.conversationId,
    eventType: args.eventType,
    title: args.title,
    summary: args.summary,
    actor: args.actor || 'operator',
    source: args.source || 'operator',
    confidence: args.confidence || 'CONFIRMED_BY_SYSTEM',
    amount: args.amount,
    currency: args.currency,
    metadata: args.metadata,
    occurredAt: args.occurredAt,
  });
  return { ok: true, event: row };
}

async function genFollowups(args = {}) {
  requireScope(args);
  return generateFollowUps({
    companyId: args.companyId,
    contactId: args.contactId,
    prospectId: args.prospectId,
    persist: args.persist !== false,
  });
}

async function listFu(args = {}) {
  return listFollowUps({
    companyId: args.companyId,
    contactId: args.contactId,
    prospectId: args.prospectId,
    status: args.status,
    limit: Number(args.limit) || 50,
  });
}

async function resolveFu(args = {}) {
  const id = args.id || args.followUpId;
  if (!id) throw new Error('id is required');
  return resolveFollowUp(id, {
    resolvedBy: args.resolvedBy || 'operator',
    status: args.status || 'RESOLVED',
  });
}

async function getRevenue(args = {}) {
  requireScope(args);
  return computeRevenueHistory({
    companyId: args.companyId,
    contactId: args.contactId,
    prospectId: args.prospectId,
    persist: args.persist !== false,
  });
}

async function detectDormant(args = {}) {
  return detectDormantClients({
    limit: Number(args.limit) || 50,
    dormantDays: Number(args.dormantDays) || 60,
  });
}

async function detectRepeat(args = {}) {
  return detectRepeatBusiness({ limit: Number(args.limit) || 50 });
}

async function linkOpp(args = {}) {
  if (!args.opportunityId) throw new Error('opportunityId is required');
  return linkOpportunityToClient({
    opportunityId: args.opportunityId,
    companyId: args.companyId,
    contactId: args.contactId,
    prospectId: args.prospectId,
  });
}

async function assessReady(args = {}) {
  return assessProjectReadiness({
    companyId: args.companyId,
    contactId: args.contactId,
    prospectId: args.prospectId,
    invoiceId: args.invoiceId,
    paymentId: args.paymentId,
  });
}

async function getIntel(args = {}) {
  requireScope(args);
  return getClientIntelligence({
    companyId: args.companyId,
    contactId: args.contactId,
    prospectId: args.prospectId,
    refreshRelationship: Boolean(args.refreshRelationship),
  });
}

async function biQuery(args = {}) {
  return businessIntelligenceQuery({
    query: args.query || args.q,
    limit: Number(args.limit) || 50,
  });
}

async function analystBrief(args = {}) {
  requireScope(args);
  return generateBusinessAnalystBrief({
    companyId: args.companyId,
    contactId: args.contactId,
    prospectId: args.prospectId,
  });
}

export { RELATIONSHIP_STATES };
