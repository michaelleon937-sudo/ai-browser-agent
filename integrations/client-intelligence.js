// integrations/client-intelligence.js
// Aggregates timeline, relationship, memory, revenue, readiness signals.
// Read-mostly; write paths are explicit and audited.

import {
  companies,
  contacts,
  prospects,
  opportunities,
  invoices,
  payments,
  projects,
  clientMemory,
  clientTimelineEvents,
  relationshipStates,
  clientRevenueSnapshots,
  conversations,
  inboundMessages,
  MEMORY_CONFIDENCE,
} from '../database/index.js';
import { getAuthoritativeFacts } from './client-memory.js';
import { evaluateRelationship, getRelationship, gatherEvidence } from './relationship-engine.js';
import { generateFollowUps } from './follow-up-engine.js';

const DORMANT_DAYS = 60;

export function buildClientTimeline({ companyId, contactId, prospectId, limit = 100 } = {}) {
  if (!companyId && !contactId && !prospectId) {
    throw new Error('At least one of companyId, contactId, prospectId is required');
  }
  const events = clientTimelineEvents.list({ companyId, contactId, prospectId, limit });
  const supplemented = [...events];
  if (events.length < 5) {
    const convFilters = { limit: 20 };
    if (companyId) convFilters.companyId = companyId;
    if (contactId) convFilters.contactId = contactId;
    if (prospectId) convFilters.prospectId = prospectId;
    for (const c of conversations.list(convFilters)) {
      for (const m of inboundMessages.list({ conversationId: c.id, limit: 20 })) {
        supplemented.push({
          id: `msg_${m.id}`,
          event_type: m.direction === 'outbound' ? 'OUTBOUND_MESSAGE' : 'INBOUND_MESSAGE',
          title: m.subject || (m.direction === 'outbound' ? 'Outbound message' : 'Inbound message'),
          summary: (m.body || '').slice(0, 200),
          occurred_at: m.received_at || m.created_at,
          source: 'derived',
          confidence: 'CONFIRMED_BY_SYSTEM',
          company_id: companyId || m.company_id,
          contact_id: contactId || m.contact_id,
          prospect_id: prospectId || m.prospect_id,
        });
      }
    }
    for (const inv of invoices.list({ companyId, limit: 20 })) {
      supplemented.push({
        id: `inv_${inv.id}`,
        event_type: 'INVOICE',
        title: `Invoice ${inv.invoice_number || inv.id} (${inv.status})`,
        summary: inv.description || null,
        amount: inv.total,
        currency: inv.currency,
        occurred_at: inv.updated_at || inv.created_at,
        source: 'derived',
        confidence: 'CONFIRMED_BY_SYSTEM',
        invoice_id: inv.id,
        company_id: inv.company_id,
      });
    }
    for (const p of projects.list({ companyId, limit: 20 })) {
      supplemented.push({
        id: `proj_${p.id}`,
        event_type: 'PROJECT',
        title: `Project ${p.id} (${p.status})`,
        summary: p.scope || p.project_type || null,
        occurred_at: p.updated_at || p.created_at,
        source: 'derived',
        confidence: 'CONFIRMED_BY_SYSTEM',
        project_id: p.id,
        company_id: p.company_id,
      });
    }
  }
  supplemented.sort((a, b) => String(b.occurred_at || '').localeCompare(String(a.occurred_at || '')));
  return { ok: true, events: supplemented.slice(0, limit) };
}

export function computeRevenueHistory({ companyId, contactId, prospectId, persist = true } = {}) {
  if (!companyId && !contactId && !prospectId) {
    throw new Error('At least one of companyId, contactId, prospectId is required');
  }
  const invList = invoices.list({ companyId, limit: 200 });
  const payList = payments.list({ limit: 200 }).filter((p) => {
    if (companyId && p.company_id === companyId) return true;
    if (contactId && p.client_id === contactId) return true;
    return false;
  });
  const projList = projects.list({ companyId, limit: 200 });
  let totalInvoiced = 0;
  let totalPaid = 0;
  let currency = 'USD';
  let firstRevenueAt = null;
  let lastRevenueAt = null;
  for (const inv of invList) {
    totalInvoiced += Number(inv.total) || 0;
    if (inv.currency) currency = inv.currency;
    const t = inv.created_at;
    if (!firstRevenueAt || String(t) < String(firstRevenueAt)) firstRevenueAt = t;
    if (!lastRevenueAt || String(t) > String(lastRevenueAt)) lastRevenueAt = t;
  }
  for (const p of payList) {
    if (p.status === 'SUCCEEDED') {
      totalPaid += Number(p.amount) || 0;
      if (p.currency) currency = p.currency;
      const t = p.verified_at || p.updated_at || p.created_at;
      if (!firstRevenueAt || String(t) < String(firstRevenueAt)) firstRevenueAt = t;
      if (!lastRevenueAt || String(t) > String(lastRevenueAt)) lastRevenueAt = t;
    }
  }
  const snapshot = {
    companyId, contactId, prospectId,
    totalInvoiced, totalPaid,
    totalOutstanding: Math.max(0, totalInvoiced - totalPaid),
    invoiceCount: invList.length,
    paymentCount: payList.filter((p) => p.status === 'SUCCEEDED').length,
    projectCount: projList.length,
    currency, firstRevenueAt, lastRevenueAt,
  };
  if (persist) {
    const row = clientRevenueSnapshots.upsert(snapshot);
    return { ok: true, snapshot: row };
  }
  return { ok: true, snapshot };
}

export function detectDormantClients({ limit = 50, dormantDays = DORMANT_DAYS } = {}) {
  const companyList = companies.list({ limit: 200 });
  const dormant = [];
  for (const company of companyList) {
    const evidence = gatherEvidence({ companyId: company.id });
    const days = evidence.daysSinceLastActivity;
    const rel = relationshipStates.getCurrent({ companyId: company.id });
    if (days != null && days >= dormantDays) {
      dormant.push({
        companyId: company.id,
        companyName: company.name,
        daysSinceLastActivity: days,
        relationshipState: rel?.state || null,
        lastActivity: evidence.lastActivity,
      });
    }
  }
  dormant.sort((a, b) => (b.daysSinceLastActivity || 0) - (a.daysSinceLastActivity || 0));
  return { ok: true, dormant: dormant.slice(0, limit), dormantDays };
}

export function detectRepeatBusiness({ limit = 50 } = {}) {
  const companyList = companies.list({ limit: 200 });
  const opportunitiesOut = [];
  for (const company of companyList) {
    const evidence = gatherEvidence({ companyId: company.id });
    const revenue = computeRevenueHistory({ companyId: company.id, persist: false }).snapshot;
    const hasCompleted = evidence.hasCompletedProject || evidence.hasPaidInvoice;
    const hasOpenWork = evidence.hasActiveProject || evidence.hasOpportunity || evidence.hasInvoice;
    if (hasCompleted && !hasOpenWork && (revenue.totalPaid > 0 || revenue.projectCount > 0)) {
      opportunitiesOut.push({
        companyId: company.id,
        companyName: company.name,
        totalPaid: revenue.totalPaid,
        projectCount: revenue.projectCount,
        lastRevenueAt: revenue.lastRevenueAt,
        reason: 'Prior paid/completed work with no open opportunity or project',
        suggestedAction: 'Review for repeat-business outreach (human-gated)',
      });
    }
  }
  opportunitiesOut.sort((a, b) => (b.totalPaid || 0) - (a.totalPaid || 0));
  return { ok: true, opportunities: opportunitiesOut.slice(0, limit) };
}

export function linkOpportunityToClient({ opportunityId, companyId, contactId, prospectId } = {}) {
  if (!opportunityId) throw new Error('opportunityId is required');
  const opp = opportunities.get?.(opportunityId) || opportunities.getOpportunity?.(opportunityId);
  if (!opp) return { ok: false, error: 'opportunity not found' };
  let company = companyId ? companies.get(companyId) : null;
  let contact = contactId ? contacts.get(contactId) : null;
  let prospect = prospectId ? prospects.get(prospectId) : (opp.prospect_id ? prospects.get(opp.prospect_id) : null);
  if (!company && prospect?.business_name) {
    company = companies.findByName(prospect.business_name);
    if (!company) {
      company = companies.create({
        name: prospect.business_name,
        website: prospect.website_url || null,
        location: prospect.location || null,
      });
    }
  }
  clientTimelineEvents.record({
    companyId: company?.id || companyId,
    contactId: contact?.id || contactId,
    prospectId: prospect?.id || prospectId || opp.prospect_id,
    opportunityId,
    eventType: 'OPPORTUNITY_LINKED',
    title: 'Opportunity linked to client',
    summary: `Opportunity ${opportunityId} linked`,
    source: 'operator',
    confidence: 'CONFIRMED_BY_SYSTEM',
    metadata: { opportunityId, companyId: company?.id, contactId: contact?.id },
  });
  return { ok: true, opportunity: opp, company, contact, prospect, linked: true };
}

export function assessProjectReadiness({ companyId, contactId, prospectId, invoiceId, paymentId } = {}) {
  const inv = invoiceId ? invoices.get(invoiceId) : null;
  const pay = paymentId ? payments.get(paymentId) : null;
  const facts = getAuthoritativeFacts({ companyId, contactId, prospectId });
  const evidence = gatherEvidence({ companyId, contactId, prospectId });
  const checks = {
    hasClientIdentity: Boolean(companyId || contactId || prospectId),
    hasConfirmedService: Boolean(facts.requested_service && ['CONFIRMED_BY_CLIENT', 'CONFIRMED_BY_SYSTEM'].includes(facts.requested_service.confidence)),
    hasPaidInvoice: Boolean(pay?.status === 'SUCCEEDED' || evidence.hasPaidInvoice),
    invoicePaid: Boolean(inv?.status === 'PAID'),
    noBlockingUnknowns: true,
  };
  const ready = checks.hasClientIdentity && (checks.hasPaidInvoice || checks.invoicePaid);
  return {
    ok: true,
    projectReady: ready,
    paymentReady: checks.hasClientIdentity && Boolean(inv && ['APPROVED', 'SENT'].includes(inv.status)),
    checks,
    facts,
    note: 'Readiness is advisory; project.start remains approval-gated.',
  };
}

export function getClientIntelligence({ companyId, contactId, prospectId, refreshRelationship = false } = {}) {
  if (!companyId && !contactId && !prospectId) {
    throw new Error('At least one of companyId, contactId, prospectId is required');
  }
  const company = companyId ? companies.get(companyId) : null;
  const contact = contactId ? contacts.get(contactId) : null;
  const prospect = prospectId ? prospects.get(prospectId) : null;
  let relationship;
  if (refreshRelationship) {
    relationship = evaluateRelationship({ companyId, contactId, prospectId, persist: true });
  } else {
    relationship = getRelationship({ companyId, contactId, prospectId });
  }
  const timeline = buildClientTimeline({ companyId, contactId, prospectId, limit: 50 });
  const revenue = computeRevenueHistory({ companyId, contactId, prospectId, persist: true });
  const facts = getAuthoritativeFacts({ companyId, contactId, prospectId });
  const memoryHistory = clientMemory.list({ companyId, contactId, prospectId, limit: 100 });
  const readiness = assessProjectReadiness({ companyId, contactId, prospectId });
  const evidence = gatherEvidence({ companyId, contactId, prospectId });
  return {
    ok: true,
    company, contact, prospect,
    relationship: relationship.current || relationship,
    relationshipHistory: relationship.history || [],
    timeline: timeline.events,
    revenue: revenue.snapshot,
    authoritativeFacts: facts,
    memoryHistory,
    readiness,
    evidence,
    generatedAt: new Date().toISOString(),
  };
}

export function businessIntelligenceQuery({ query, limit = 50 } = {}) {
  const q = String(query || '').toLowerCase().trim();
  if (q === 'dormant' || q === 'dormant_clients') return detectDormantClients({ limit });
  if (q === 'repeat' || q === 'repeat_business') return detectRepeatBusiness({ limit });
  if (q === 'revenue_summary' || q === 'revenue') {
    const companyList = companies.list({ limit: 200 });
    let totalInvoiced = 0, totalPaid = 0, clientsWithRevenue = 0;
    for (const c of companyList) {
      const snap = computeRevenueHistory({ companyId: c.id, persist: false }).snapshot;
      totalInvoiced += snap.totalInvoiced;
      totalPaid += snap.totalPaid;
      if (snap.totalPaid > 0 || snap.totalInvoiced > 0) clientsWithRevenue += 1;
    }
    return { ok: true, summary: { totalInvoiced, totalPaid, totalOutstanding: Math.max(0, totalInvoiced - totalPaid), clientsWithRevenue, companyCount: companyList.length } };
  }
  if (q === 'relationship_distribution' || q === 'states') {
    const dist = {};
    for (const c of companies.list({ limit: 200 })) {
      const rel = relationshipStates.getCurrent({ companyId: c.id });
      const s = rel?.state || 'UNKNOWN';
      dist[s] = (dist[s] || 0) + 1;
    }
    return { ok: true, distribution: dist };
  }
  if (q === 'pipeline') {
    let opps = [];
    try {
      if (typeof opportunities.listOpportunities === 'function') opps = opportunities.listOpportunities({ limit });
      else if (typeof opportunities.list === 'function') opps = opportunities.list({ limit });
    } catch { opps = []; }
    return { ok: true, opportunities: opps };
  }
  return {
    ok: true,
    availableQueries: ['dormant', 'repeat_business', 'revenue_summary', 'relationship_distribution', 'pipeline'],
    note: 'Pass query= one of the availableQueries values.',
  };
}

export function generateBusinessAnalystBrief({ companyId, contactId, prospectId } = {}) {
  const intel = getClientIntelligence({ companyId, contactId, prospectId, refreshRelationship: true });
  const followUps = generateFollowUps({ companyId, contactId, prospectId, persist: false });
  const brief = {
    client: {
      company: intel.company?.name || null,
      contact: intel.contact?.name || intel.contact?.email || null,
      prospect: intel.prospect?.business_name || null,
    },
    relationshipState: intel.relationship?.state || intel.relationship?.current?.state || null,
    revenue: {
      totalPaid: intel.revenue?.total_paid ?? intel.revenue?.totalPaid ?? 0,
      totalInvoiced: intel.revenue?.total_invoiced ?? intel.revenue?.totalInvoiced ?? 0,
      outstanding: intel.revenue?.total_outstanding ?? intel.revenue?.totalOutstanding ?? 0,
    },
    readiness: intel.readiness,
    topFacts: intel.authoritativeFacts,
    recommendedFollowUps: (followUps.recommendations || []).slice(0, 5).map((r) => ({
      type: r.recommendation_type || r.recommendationType,
      priority: r.priority,
      reason: r.reason,
      suggestedAction: r.suggested_action || r.suggestedAction,
      externalSideEffect: false,
    })),
    timelineHighlights: (intel.timeline || []).slice(0, 10).map((e) => ({
      type: e.event_type,
      title: e.title,
      at: e.occurred_at,
    })),
    constraints: {
      noAutomaticCommunication: true,
      noAutomaticPayment: true,
      noAutomaticWon: true,
      recommendationsOnly: true,
    },
    generatedAt: new Date().toISOString(),
  };
  return { ok: true, brief };
}
