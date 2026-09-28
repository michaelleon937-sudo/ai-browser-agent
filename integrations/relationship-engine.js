// integrations/relationship-engine.js
// Deterministic, auditable relationship state machine.
// Never auto-sends, never auto-charges, never auto-WON.

import {
  relationshipStates,
  clientTimelineEvents,
  companies,
  contacts,
  prospects,
  conversations,
  inboundMessages,
  opportunities,
  invoices,
  payments,
  projects,
  clientMemory,
} from '../database/index.js';

/** Canonical relationship states — ordered by lifecycle maturity. */
export const RELATIONSHIP_STATES = Object.freeze({
  NEW: 'NEW',
  CONTACTED: 'CONTACTED',
  ENGAGED: 'ENGAGED',
  QUALIFIED: 'QUALIFIED',
  OPPORTUNITY: 'OPPORTUNITY',
  PROPOSAL: 'PROPOSAL',
  NEGOTIATION: 'NEGOTIATION',
  CUSTOMER: 'CUSTOMER',
  ACTIVE_PROJECT: 'ACTIVE_PROJECT',
  PAID: 'PAID',
  DORMANT: 'DORMANT',
  CHURN_RISK: 'CHURN_RISK',
  LOST: 'LOST',
});

const ALLOWED = {
  NEW: new Set(['CONTACTED', 'ENGAGED', 'QUALIFIED', 'OPPORTUNITY', 'LOST']),
  CONTACTED: new Set(['ENGAGED', 'QUALIFIED', 'OPPORTUNITY', 'DORMANT', 'LOST']),
  ENGAGED: new Set(['QUALIFIED', 'OPPORTUNITY', 'PROPOSAL', 'DORMANT', 'LOST']),
  QUALIFIED: new Set(['OPPORTUNITY', 'PROPOSAL', 'CUSTOMER', 'DORMANT', 'LOST']),
  OPPORTUNITY: new Set(['PROPOSAL', 'NEGOTIATION', 'CUSTOMER', 'DORMANT', 'LOST']),
  PROPOSAL: new Set(['NEGOTIATION', 'CUSTOMER', 'DORMANT', 'LOST']),
  NEGOTIATION: new Set(['CUSTOMER', 'PROPOSAL', 'LOST', 'DORMANT']),
  CUSTOMER: new Set(['ACTIVE_PROJECT', 'PAID', 'DORMANT', 'CHURN_RISK']),
  ACTIVE_PROJECT: new Set(['PAID', 'CUSTOMER', 'CHURN_RISK']),
  PAID: new Set(['ACTIVE_PROJECT', 'CUSTOMER', 'DORMANT', 'CHURN_RISK']),
  DORMANT: new Set(['ENGAGED', 'QUALIFIED', 'OPPORTUNITY', 'CUSTOMER', 'CONTACTED']),
  CHURN_RISK: new Set(['ENGAGED', 'CUSTOMER', 'ACTIVE_PROJECT', 'PAID', 'DORMANT', 'LOST']),
  LOST: new Set(['CONTACTED', 'ENGAGED', 'NEW']),
};

export function assertRelationshipTransition(from, to) {
  if (from === to) return;
  const allowed = ALLOWED[from];
  if (!allowed || !allowed.has(to)) {
    throw new Error(`Invalid relationship state transition: ${from} → ${to}`);
  }
}

export function computeRelationshipState(evidence = {}) {
  const {
    prospectStatus,
    messageCount = 0,
    hasOpportunity = false,
    hasProposal = false,
    hasInvoice = false,
    hasPaidInvoice = false,
    hasActiveProject = false,
    hasCompletedProject = false,
    daysSinceLastActivity = null,
    explicitLost = false,
  } = evidence;

  if (explicitLost || prospectStatus === 'LOST' || prospectStatus === 'REJECTED') {
    return { state: RELATIONSHIP_STATES.LOST, reason: 'Prospect marked lost/rejected', confidence: 'CONFIRMED_BY_SYSTEM' };
  }
  if (hasActiveProject) {
    return { state: RELATIONSHIP_STATES.ACTIVE_PROJECT, reason: 'Active project in progress', confidence: 'CONFIRMED_BY_SYSTEM' };
  }
  if (hasPaidInvoice || hasCompletedProject) {
    return { state: RELATIONSHIP_STATES.PAID, reason: 'Paid invoice or completed project', confidence: 'CONFIRMED_BY_SYSTEM' };
  }
  if (prospectStatus === 'CUSTOMER' || prospectStatus === 'WON') {
    return { state: RELATIONSHIP_STATES.CUSTOMER, reason: 'Prospect marked customer/won', confidence: 'CONFIRMED_BY_SYSTEM' };
  }
  if (hasInvoice) {
    return { state: RELATIONSHIP_STATES.NEGOTIATION, reason: 'Invoice exists (pending payment)', confidence: 'CONFIRMED_BY_SYSTEM' };
  }
  if (hasProposal) {
    return { state: RELATIONSHIP_STATES.PROPOSAL, reason: 'Proposal present', confidence: 'CONFIRMED_BY_SYSTEM' };
  }
  if (hasOpportunity) {
    return { state: RELATIONSHIP_STATES.OPPORTUNITY, reason: 'Open opportunity', confidence: 'CONFIRMED_BY_SYSTEM' };
  }
  if (prospectStatus === 'QUALIFIED') {
    return { state: RELATIONSHIP_STATES.QUALIFIED, reason: 'Prospect qualified', confidence: 'CONFIRMED_BY_SYSTEM' };
  }
  if (messageCount >= 2 || prospectStatus === 'REPLIED') {
    return { state: RELATIONSHIP_STATES.ENGAGED, reason: 'Multiple messages or reply', confidence: 'CONFIRMED_BY_SYSTEM' };
  }
  if (messageCount >= 1 || prospectStatus === 'CONTACTED') {
    return { state: RELATIONSHIP_STATES.CONTACTED, reason: 'Contact initiated', confidence: 'CONFIRMED_BY_SYSTEM' };
  }
  if (daysSinceLastActivity != null && daysSinceLastActivity > 60) {
    return { state: RELATIONSHIP_STATES.DORMANT, reason: `No activity for ${daysSinceLastActivity} days`, confidence: 'INFERRED' };
  }
  return { state: RELATIONSHIP_STATES.NEW, reason: 'No relationship signals yet', confidence: 'CONFIRMED_BY_SYSTEM' };
}

export function gatherEvidence({ companyId, contactId, prospectId } = {}) {
  let prospect = null;
  if (prospectId) prospect = prospects.get(prospectId);
  if (!prospect && companyId) {
    const list = prospects.list?.({ limit: 50 }) || [];
    const company = companies.get(companyId);
    if (company) {
      prospect = list.find((p) => p.business_name && company.name && p.business_name.toLowerCase() === company.name.toLowerCase()) || null;
    }
  }

  const convFilters = { limit: 100 };
  if (companyId) convFilters.companyId = companyId;
  if (contactId) convFilters.contactId = contactId;
  if (prospectId) convFilters.prospectId = prospectId;
  const convs = conversations.list(convFilters);
  let messageCount = 0;
  let lastActivity = null;
  for (const c of convs) {
    const msgs = inboundMessages.list({ conversationId: c.id, limit: 200 });
    messageCount += msgs.length;
    for (const m of msgs) {
      if (!lastActivity || String(m.received_at) > String(lastActivity)) lastActivity = m.received_at;
    }
  }

  let oppList = [];
  try {
    if (typeof opportunities.listOpportunities === 'function') {
      oppList = opportunities.listOpportunities({ limit: 100 });
      const pid = prospectId || prospect?.id;
      if (pid) oppList = oppList.filter((o) => o.prospect_id === pid);
    } else if (typeof opportunities.list === 'function') {
      oppList = opportunities.list({ prospectId: prospectId || prospect?.id, limit: 50 });
    }
  } catch { oppList = []; }
  const hasOpportunity = oppList.length > 0;

  const invFilters = { limit: 100 };
  if (companyId) invFilters.companyId = companyId;
  const invList = invoices.list(invFilters);
  const hasInvoice = invList.length > 0;
  const hasPaidInvoice = invList.some((i) => i.status === 'PAID');

  const payList = payments.list({ limit: 100 }).filter((p) => {
    if (companyId && p.company_id === companyId) return true;
    if (prospectId && p.client_id === prospectId) return true;
    return !companyId && !prospectId;
  });

  const projFilters = { limit: 100 };
  if (companyId) projFilters.companyId = companyId;
  const projList = projects.list(projFilters);
  const hasActiveProject = projList.some((p) => ['READY_TO_START', 'IN_PROGRESS', 'IN_REVIEW', 'REVISION_REQUESTED'].includes(p.status));
  const hasCompletedProject = projList.some((p) => ['COMPLETED', 'DELIVERED', 'APPROVED'].includes(p.status));

  let hasProposal = false;
  try {
    for (const o of oppList) {
      if (o.status && /PROPOSAL|SENT|ACCEPTED/i.test(o.status)) { hasProposal = true; break; }
    }
  } catch { /* ignore */ }

  let daysSinceLastActivity = null;
  if (lastActivity) {
    daysSinceLastActivity = Math.floor((Date.now() - new Date(lastActivity).getTime()) / 86400000);
  }

  return {
    prospectStatus: prospect?.status || null,
    messageCount,
    hasOpportunity,
    hasProposal,
    hasInvoice,
    hasPaidInvoice: hasPaidInvoice || payList.some((p) => p.status === 'SUCCEEDED'),
    hasActiveProject,
    hasCompletedProject,
    daysSinceLastActivity,
    explicitLost: false,
    lastActivity,
    evidenceMeta: {
      conversationCount: convs.length,
      opportunityCount: oppList.length,
      invoiceCount: invList.length,
      projectCount: projList.length,
    },
  };
}

export function evaluateRelationship({ companyId, contactId, prospectId, persist = true, source = 'system' } = {}) {
  if (!companyId && !contactId && !prospectId) {
    throw new Error('At least one of companyId, contactId, prospectId is required');
  }
  const evidence = gatherEvidence({ companyId, contactId, prospectId });
  const computed = computeRelationshipState(evidence);
  const current = relationshipStates.getCurrent({ companyId, contactId, prospectId });

  if (!persist) {
    return { ok: true, state: computed.state, reason: computed.reason, confidence: computed.confidence, current, evidence, changed: !current || current.state !== computed.state };
  }

  if (current && current.state === computed.state) {
    return { ok: true, state: current.state, reason: current.reason, confidence: current.confidence, current, evidence, changed: false };
  }

  if (current) {
    try {
      assertRelationshipTransition(current.state, computed.state);
    } catch (err) {
      if (computed.state !== RELATIONSHIP_STATES.DORMANT && computed.state !== RELATIONSHIP_STATES.CHURN_RISK) {
        return { ok: false, error: err.message, current, computed };
      }
    }
  }

  const row = relationshipStates.transition({
    companyId,
    contactId,
    prospectId,
    state: computed.state,
    reason: computed.reason,
    source,
    confidence: computed.confidence,
    metadata: evidence.evidenceMeta,
  });

  clientTimelineEvents.record({
    companyId,
    contactId,
    prospectId,
    eventType: 'RELATIONSHIP_STATE_CHANGE',
    title: `Relationship → ${computed.state}`,
    summary: computed.reason,
    source,
    confidence: computed.confidence,
    metadata: { previous: current?.state || null, next: computed.state },
    occurredAt: row.updated_at,
  });

  return { ok: true, state: row.state, reason: row.reason, confidence: row.confidence, current: row, previous: current, evidence, changed: true };
}

export function getRelationship({ companyId, contactId, prospectId } = {}) {
  const current = relationshipStates.getCurrent({ companyId, contactId, prospectId });
  const history = relationshipStates.listHistory({ companyId, contactId, prospectId, limit: 50 });
  return { ok: true, current, history };
}
