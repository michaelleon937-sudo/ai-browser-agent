// integrations/client-revenue-intelligence.js
// Client Intelligence + Presentation Intelligence + Revenue Intelligence.
// Deterministic, explainable, approval-safe. No outbound side effects.

import {
  prospects, opportunities, samples, proposals, conversations,
  clientMemory, conversationInsights, invoices, payments, outreachMessages,
} from '../database/index.js';
import { relationshipStates, followUpRecommendations, clientRevenueSnapshots } from '../database/bi-store.js';
import { analyzeOpportunity } from './opportunity-intelligence.js';
import { recommendNextAction } from './next-action.js';

const clamp = (n, min, max) => Math.max(min, Math.min(max, Number(n) || 0));
const parse = (v, fallback = {}) => {
  if (v == null) return fallback;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return fallback; }
};
const clean = (v, fallback = '') => String(v ?? '').trim() || fallback;

function resolveProspect({ prospectId, businessName } = {}) {
  if (prospectId) return prospects.get(prospectId);
  if (businessName) return prospects.list({ limit: 200 }).find(
    p => String(p.business_name || '').toLowerCase() === String(businessName).toLowerCase()
  ) || null;
  return null;
}

function memoryFor(p) {
  if (!p) return { facts: {}, count: 0 };
  const rows = clientMemory.list({ companyId: p.company_id, contactId: p.contact_id, prospectId: p.id, limit: 200 });
  const rank = { CONFIRMED_BY_CLIENT: 3, CONFIRMED_BY_SYSTEM: 2, INFERRED: 1, UNKNOWN: 0 };
  const best = {};
  for (const row of rows) {
    const old = best[row.key];
    if (!old || (rank[row.confidence] || 0) > (rank[old.confidence] || 0)) best[row.key] = row;
  }
  return {
    facts: Object.fromEntries(Object.entries(best).map(([k, v]) => [
      k, { value: v.value, confidence: v.confidence, source: v.source, updatedAt: v.updated_at }
    ])),
    count: rows.length,
  };
}

function relationshipFor(p) {
  if (!p) return null;
  return relationshipStates.getCurrent({ companyId: p.company_id, contactId: p.contact_id, prospectId: p.id });
}

function latestRevenueFor(p) {
  if (!p) return null;
  return clientRevenueSnapshots.getLatest({ companyId: p.company_id, contactId: p.contact_id, prospectId: p.id });
}

export function qualifyClient({ prospectId, businessName, requestedService, budget, urgency } = {}) {
  const p = resolveProspect({ prospectId, businessName });
  if (!p) throw new Error('prospectId or known businessName is required');

  const opportunity = opportunities.getOpportunitiesForProspect(p.id, { limit: 1 })[0] || null;
  const analysis = opportunity ? {
    score: Number(opportunity.score) || 0,
    priority: opportunity.priority,
    recommendedServices: parse(opportunity.recommended_services_json, []),
    confidence: opportunity.confidence || 'low',
  } : analyzeOpportunity(p);

  const memory = memoryFor(p);
  const relationship = relationshipFor(p);
  const revenue = latestRevenueFor(p);
  const conversation = conversations.list({ limit: 200 }).find(
    c => c.prospect_id === p.id || c.company_id === p.company_id || c.contact_id === p.contact_id
  ) || null;
  const insight = conversation ? conversationInsights.get(conversation.id) : null;

  let score = clamp(analysis.score, 0, 100);
  const positive = new Set(['ENGAGED', 'QUALIFIED', 'OPPORTUNITY', 'PROPOSAL', 'NEGOTIATION', 'CUSTOMER', 'ACTIVE_PROJECT', 'PAID']);
  const negative = new Set(['DORMANT', 'CHURN_RISK', 'LOST']);
  if (positive.has(relationship?.state)) score += 10;
  if (negative.has(relationship?.state)) score -= 20;
  if (memory.count >= 3) score += 5;
  if (conversation?.message_count > 1) score += 5;
  if (revenue?.total_paid > 0) score += 10;
  if (budget || insight?.budget) score += 5;
  if (urgency || insight?.deadline) score += 3;
  score = clamp(score, 0, 100);

  const missing = [];
  if (!requestedService && !insight?.requested_service) missing.push('requested_service');
  if (!budget && !insight?.budget) missing.push('budget');
  if (!urgency && !insight?.deadline) missing.push('deadline');
  if (!p.contact_email && !p.contact_phone) missing.push('contact_channel');

  const tier = score >= 80 ? 'A' : score >= 60 ? 'B' : score >= 40 ? 'C' : 'D';
  const action = recommendNextAction({
    classification: insight?.current_classification,
    intent: insight?.current_intent,
    requestedService: requestedService || insight?.requested_service,
    unresolvedQuestions: parse(insight?.unresolved_questions_json, []),
    prospectStatus: p.status,
    hasBudget: Boolean(budget || insight?.budget),
    messageCount: Number(conversation?.message_count || 0),
  });

  return {
    ok: true, feature: 'CLIENT_INTELLIGENCE',
    qualification: {
      score, tier, priority: score >= 80 ? 'HIGH' : score >= 60 ? 'MEDIUM' : 'LOW',
      confidence: analysis.confidence || 'low',
      relationshipState: relationship?.state || p.status || 'NEW',
      missingInformation: missing, nextAction: action,
    },
    client: {
      id: p.id, businessName: p.business_name, location: p.location, websiteUrl: p.website_url,
      serviceGaps: parse(p.service_gaps_json, []), memory: memory.facts,
      conversation: insight ? {
        intent: insight.current_intent, classification: insight.current_classification,
        requestedService: insight.requested_service, deliverables: insight.requested_deliverables,
        deadline: insight.deadline, budget: insight.budget,
        unresolvedQuestions: parse(insight.unresolved_questions_json, []),
      } : null,
      revenueSnapshot: revenue,
    },
    opportunity: opportunity || analysis, externalSideEffect: false,
  };
}

function modeLabel(mode) {
  const modes = {
    luxury: ['Premium Creative Direction', 'I selected a few directions that best match the premium positioning we discussed.'],
    startup: ['Growth-Focused Creative Direction', 'I selected practical directions focused on clarity, conversion and growth.'],
    corporate: ['Professional Brand Direction', 'I selected directions aligned with a polished, professional customer experience.'],
    hospitality: ['Hospitality Experience Direction', 'I selected visual directions designed to strengthen the guest experience and brand perception.'],
    real_estate: ['Property Marketing Direction', 'I selected directions focused on presenting the property clearly and professionally.'],
    church: ['Community Brand Direction', 'I selected clean, respectful directions aligned with the organisation and its audience.'],
    fitness: ['Fitness Brand Direction', 'I selected energetic directions designed to communicate the transformation and offer clearly.'],
  };
  return modes[String(mode || 'luxury').toLowerCase()] || modes.luxury;
}

export function buildWhatsAppPresentation({
  prospectId, opportunityId, proposalId, mode = 'luxury', maxSamples = 4,
  clientName, service, packageName, price, deadline, callToAction,
} = {}) {
  const p = prospectId ? prospects.get(prospectId) : null;
  if (!p) throw new Error('prospectId is required');

  const opportunity = opportunityId
    ? opportunities.getOpportunity(opportunityId)
    : opportunities.getOpportunitiesForProspect(p.id, { limit: 1 })[0] || null;
  const proposal = proposalId
    ? proposals.get(proposalId)
    : opportunity ? proposals.getForOpportunity(opportunity.id, { limit: 1 })[0] || null : null;

  const desiredType = opportunity?.recommended_sample_type || null;
  let selected = opportunity ? samples.getForOpportunity(opportunity.id, { limit: 100 }) : [];
  if (!selected.length && desiredType) selected = samples.list({ limit: 100, sampleType: desiredType });
  if (!selected.length) selected = samples.list({ limit: 100 });
  selected = selected.filter(s => s.status !== 'ARCHIVED').slice(0, clamp(maxSamples, 1, 6));

  const [title, opener] = modeLabel(mode);
  const name = clean(clientName || p.business_name, 'there');
  const serviceName = clean(service || proposal?.service_recommendation || opportunity?.opportunity_type, 'the project');
  const packageText = clean(packageName || proposal?.suggested_package, '');
  const valueText = clean(proposal?.value_proposition, opportunity?.summary || '');
  const cta = clean(callToAction || proposal?.call_to_action, 'If you like this direction, I can prepare the first concept specifically for your brand.');

  const lines = [
    `*✨ ${title}*`, '', `Hi ${name} 👋`, '', opener, '',
    '*🎯 Recommended direction*', `• Service: ${serviceName}`,
    packageText ? `• Package: ${packageText}` : '',
    deadline ? `• Target timeline: ${deadline}` : '',
    price != null ? `• Investment: ${price}` : '',
    valueText ? `• Why: ${valueText}` : '', '',
    selected.length ? '*📸 Selected work*' : '',
    ...selected.map((s, i) => {
      const content = parse(s.concept_content_json, {});
      const label = clean(content.title || content.name || s.sample_type, `Sample ${i + 1}`);
      const reason = clean(content.reason || content.description, '');
      return `${i + 1}️⃣ *${label}*${reason ? ` — ${reason}` : ''}${s.preview_path ? `\\n${s.preview_path}` : ''}`;
    }),
    '', '*💡 My recommendation*',
    valueText || 'Start with the direction that most closely matches the business goal, then expand the system after the first concept is approved.',
    '', `*Next step:* ${cta}`,
  ].filter(Boolean);

  return {
    ok: true, feature: 'PRESENTATION_INTELLIGENCE', channel: 'whatsapp',
    client: { prospectId: p.id, businessName: p.business_name },
    selectedSamples: selected.map(s => ({
      id: s.id, sampleType: s.sample_type, status: s.status,
      previewPath: s.preview_path, content: parse(s.concept_content_json, {}),
    })),
    proposal: proposal || null, formattedMessage: lines.join('\n'),
    formatting: { shortSections: true, visualHierarchy: true, numberedSamples: selected.length, personalized: true, approvalRequiredForSend: true },
    externalSideEffect: false,
  };
}

export function revenueIntelligence({ days = 30 } = {}) {
  const windowDays = clamp(days, 1, 365);
  const since = Date.now() - windowDays * 86400000;
  const recent = row => {
    const t = Date.parse(row?.created_at || row?.updated_at || row?.received_at || '');
    return !Number.isFinite(t) || t >= since;
  };

  const ps = prospects.list({ limit: 500 }).filter(recent);
  const ops = opportunities.listOpportunities({ limit: 500 }).filter(recent);
  const msgs = outreachMessages.list({ limit: 500 }).filter(recent);
  const inv = invoices.list({ limit: 500 }).filter(recent);
  const pay = payments.list({ limit: 500 }).filter(recent);
  const countStatus = (rows, field, value) => rows.filter(r => String(r[field] || '').toUpperCase() === value).length;

  const leads = ps.length;
  const contacted = countStatus(ps, 'status', 'CONTACTED');
  const replied = countStatus(ps, 'status', 'REPLIED');
  const qualified = countStatus(ps, 'status', 'QUALIFIED');
  const won = ps.filter(r => ['WON', 'CUSTOMER', 'ACTIVE_CLIENT'].includes(String(r.status || '').toUpperCase())).length;
  const proposalReady = countStatus(ps, 'status', 'PROPOSAL_READY');
  const openFollowups = followUpRecommendations.list({ status: 'OPEN', limit: 500 }).length;
  const paid = pay.filter(p => String(p.status || '').toUpperCase() === 'SUCCEEDED');
  const revenue = paid.reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const sent = msgs.filter(m => String(m.status || '').toUpperCase() === 'SENT').length;
  const rate = (n, d) => d ? Number((n / d * 100).toFixed(1)) : 0;

  const funnel = {
    leads, opportunities: ops.length, proposalReady, contacted, replied, qualified, won,
    outboundDrafts: msgs.length, outboundConfirmed: sent, invoices: inv.length,
    successfulPayments: paid.length, revenue, openFollowUps: openFollowups,
    leadToReplyPct: rate(replied, leads), replyToQualifiedPct: rate(qualified, replied),
    qualifiedToWonPct: rate(won, qualified), leadToWonPct: rate(won, leads),
  };

  const insights = [];
  if (leads && funnel.leadToReplyPct < 20) insights.push({ priority: 'HIGH', area: 'presentation', insight: 'Reply rate is low; test stronger personalization and fewer, better-matched samples.' });
  if (replied && funnel.replyToQualifiedPct < 40) insights.push({ priority: 'HIGH', area: 'qualification', insight: 'Replies are not converting to qualified opportunities; capture budget, timeline and service need more clearly.' });
  if (qualified && funnel.qualifiedToWonPct < 25) insights.push({ priority: 'MEDIUM', area: 'proposal', insight: 'Qualified leads are not closing strongly; improve value framing, proof and next-step clarity.' });
  if (openFollowups > Math.max(5, leads * 0.25)) insights.push({ priority: 'HIGH', area: 'follow_up', insight: 'Follow-up queue is building; prioritize high-intent conversations before new outreach.' });
  if (ops.length && proposalReady < ops.length) insights.push({ priority: 'MEDIUM', area: 'presentation', insight: 'Some opportunities lack proposal-ready material; generate matched sample/proposal material before outreach.' });
  if (!insights.length) insights.push({ priority: 'LOW', area: 'optimization', insight: 'No major funnel bottleneck detected in the selected window.' });

  return {
    ok: true, feature: 'REVENUE_INTELLIGENCE', windowDays, funnel, insights,
    experiments: [
      'A/B test personalized 3-sample WhatsApp presentations against generic portfolio messages.',
      'Prioritize leads with confirmed service need + budget + deadline.',
      'Track proposal-to-win conversion by service and presentation mode.',
      'Resolve high-priority follow-ups before starting new outbound campaigns.',
    ],
    optimizationLoop: {
      measure: ['reply_rate', 'qualification_rate', 'proposal_rate', 'close_rate', 'revenue'],
      compare: ['industry', 'service', 'presentation_mode', 'sample_count', 'message_variant'],
      improve: ['sample_selection', 'message_hierarchy', 'CTA', 'follow_up_timing', 'offer_positioning'],
    },
    externalSideEffect: false,
  };
}

export const clientRevenueIntelligenceTools = {
  'client.intelligence': qualifyClient,
  'client.qualify': qualifyClient,
  'client.whatsapp_presentation': buildWhatsAppPresentation,
  'revenue.intelligence': revenueIntelligence,
};
