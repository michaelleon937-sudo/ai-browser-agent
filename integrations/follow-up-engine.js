// integrations/follow-up-engine.js
// Follow-up RECOMMENDATIONS only — never sends email/DM/WhatsApp.

import {
  followUpRecommendations,
  relationshipStates,
  conversations,
  inboundMessages,
  opportunities,
  invoices,
  projects,
  companies,
  contacts,
  prospects,
} from '../database/index.js';

export const FOLLOW_UP_TYPES = Object.freeze({
  FIRST_TOUCH: 'FIRST_TOUCH',
  REPLY_PENDING: 'REPLY_PENDING',
  QUALIFY: 'QUALIFY',
  SEND_PROPOSAL: 'SEND_PROPOSAL',
  PROPOSAL_FOLLOW: 'PROPOSAL_FOLLOW',
  PAYMENT_REMINDER: 'PAYMENT_REMINDER',
  PROJECT_CHECKIN: 'PROJECT_CHECKIN',
  RE_ENGAGE_DORMANT: 'RE_ENGAGE_DORMANT',
  REPEAT_BUSINESS: 'REPEAT_BUSINESS',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
});

const PRIORITY = Object.freeze({ HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW' });

export function generateFollowUps({ companyId, contactId, prospectId, persist = true } = {}) {
  if (!companyId && !contactId && !prospectId) {
    throw new Error('At least one of companyId, contactId, prospectId is required');
  }

  const recommendations = [];
  const now = Date.now();

  const rel = relationshipStates.getCurrent({ companyId, contactId, prospectId });
  const state = rel?.state || 'NEW';

  const convFilters = { limit: 50 };
  if (companyId) convFilters.companyId = companyId;
  if (contactId) convFilters.contactId = contactId;
  if (prospectId) convFilters.prospectId = prospectId;
  const convs = conversations.list(convFilters);

  let lastInbound = null;
  let lastOutbound = null;
  let messageCount = 0;
  for (const c of convs) {
    const msgs = inboundMessages.list({ conversationId: c.id, limit: 100 });
    messageCount += msgs.length;
    for (const m of msgs) {
      const t = m.received_at || m.created_at;
      if (m.direction === 'outbound') {
        if (!lastOutbound || String(t) > String(lastOutbound)) lastOutbound = t;
      } else {
        if (!lastInbound || String(t) > String(lastInbound)) lastInbound = t;
      }
    }
  }

  const daysSince = (iso) => (iso ? Math.floor((now - new Date(iso).getTime()) / 86400000) : null);
  const daysSinceInbound = daysSince(lastInbound);
  const daysSinceOutbound = daysSince(lastOutbound);

  if (messageCount === 0 && (state === 'NEW' || state === 'CONTACTED')) {
    recommendations.push({
      recommendationType: FOLLOW_UP_TYPES.FIRST_TOUCH,
      priority: PRIORITY.MEDIUM,
      reason: 'No messages yet; first human outreach may be appropriate.',
      suggestedAction: 'Prepare personalized introduction (manual send).',
      dueAt: new Date(now + 2 * 86400000).toISOString(),
    });
  }

  if (lastInbound && (!lastOutbound || String(lastInbound) > String(lastOutbound))) {
    const age = daysSinceInbound ?? 0;
    recommendations.push({
      recommendationType: FOLLOW_UP_TYPES.REPLY_PENDING,
      priority: age >= 3 ? PRIORITY.HIGH : PRIORITY.MEDIUM,
      reason: `Inbound message waiting ${age} day(s) without outbound reply.`,
      suggestedAction: 'Draft and manually send a reply.',
      dueAt: new Date(now + 1 * 86400000).toISOString(),
    });
  }

  if (state === 'ENGAGED' || state === 'CONTACTED') {
    recommendations.push({
      recommendationType: FOLLOW_UP_TYPES.QUALIFY,
      priority: PRIORITY.MEDIUM,
      reason: `Relationship is ${state}; qualification recommended before opportunity.`,
      suggestedAction: 'Review conversation and mark qualified if appropriate.',
      dueAt: new Date(now + 3 * 86400000).toISOString(),
    });
  }

  if (state === 'PROPOSAL' || state === 'NEGOTIATION') {
    recommendations.push({
      recommendationType: FOLLOW_UP_TYPES.PROPOSAL_FOLLOW,
      priority: PRIORITY.HIGH,
      reason: `Client in ${state}; proposal/invoice follow-up recommended.`,
      suggestedAction: 'Review proposal status and plan human follow-up.',
      dueAt: new Date(now + 2 * 86400000).toISOString(),
    });
  }

  const invList = invoices.list({ companyId, limit: 50 }).filter((i) => ['SENT', 'OVERDUE', 'PARTIALLY_PAID'].includes(i.status));
  if (invList.length > 0) {
    recommendations.push({
      recommendationType: FOLLOW_UP_TYPES.PAYMENT_REMINDER,
      priority: PRIORITY.HIGH,
      reason: `${invList.length} open invoice(s) awaiting payment.`,
      suggestedAction: 'Review payment status; any client contact must be human-approved.',
      dueAt: new Date(now + 1 * 86400000).toISOString(),
      metadata: { invoiceIds: invList.map((i) => i.id) },
    });
  }

  const activeProjects = projects.list({ companyId, limit: 50 }).filter((p) =>
    ['IN_PROGRESS', 'IN_REVIEW', 'REVISION_REQUESTED'].includes(p.status));
  if (activeProjects.length > 0) {
    recommendations.push({
      recommendationType: FOLLOW_UP_TYPES.PROJECT_CHECKIN,
      priority: PRIORITY.MEDIUM,
      reason: `${activeProjects.length} active project(s).`,
      suggestedAction: 'Internal project status review; client update requires approval.',
      dueAt: new Date(now + 5 * 86400000).toISOString(),
      metadata: { projectIds: activeProjects.map((p) => p.id) },
    });
  }

  if (state === 'DORMANT' || (daysSinceInbound != null && daysSinceInbound > 45) || (daysSinceOutbound != null && daysSinceOutbound > 45 && !lastInbound)) {
    recommendations.push({
      recommendationType: FOLLOW_UP_TYPES.RE_ENGAGE_DORMANT,
      priority: PRIORITY.LOW,
      reason: 'Client appears dormant; re-engagement is optional and human-gated.',
      suggestedAction: 'Consider a low-pressure check-in (manual).',
      dueAt: new Date(now + 7 * 86400000).toISOString(),
    });
  }

  if (state === 'PAID' || state === 'CUSTOMER') {
    const completed = projects.list({ companyId, limit: 50 }).filter((p) =>
      ['COMPLETED', 'DELIVERED'].includes(p.status));
    if (completed.length > 0) {
      recommendations.push({
        recommendationType: FOLLOW_UP_TYPES.REPEAT_BUSINESS,
        priority: PRIORITY.MEDIUM,
        reason: 'Completed work exists; repeat-business opportunity may apply.',
        suggestedAction: 'Review for upsell/adjacent services (recommendation only).',
        dueAt: new Date(now + 14 * 86400000).toISOString(),
        metadata: { completedProjectCount: completed.length },
      });
    }
  }

  if (recommendations.length === 0) {
    recommendations.push({
      recommendationType: FOLLOW_UP_TYPES.MANUAL_REVIEW,
      priority: PRIORITY.LOW,
      reason: 'No specific follow-up rule matched.',
      suggestedAction: 'Manual review of client timeline.',
      dueAt: null,
    });
  }

  const results = [];
  for (const rec of recommendations) {
    if (persist) {
      const row = followUpRecommendations.create({
        companyId,
        contactId,
        prospectId,
        recommendationType: rec.recommendationType,
        priority: rec.priority,
        reason: rec.reason,
        suggestedAction: rec.suggestedAction,
        dueAt: rec.dueAt,
        metadata: rec.metadata || null,
        externalSideEffect: false,
        source: 'follow_up_engine',
        confidence: 'INFERRED',
      });
      results.push(row);
    } else {
      results.push({ ...rec, externalSideEffect: false, status: 'OPEN' });
    }
  }

  return { ok: true, recommendations: results, externalSideEffect: false };
}

export function listFollowUps(filters = {}) {
  return { ok: true, recommendations: followUpRecommendations.list(filters) };
}

export function resolveFollowUp(id, { resolvedBy = 'operator', status = 'RESOLVED' } = {}) {
  if (!id) throw new Error('id is required');
  const row = followUpRecommendations.resolve(id, { resolvedBy, status });
  if (!row) return { ok: false, error: 'not found' };
  return { ok: true, recommendation: row };
}
