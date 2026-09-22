// integrations/proposal-generation.js
// Phase 4 — Proposal Generation.
//
// Pure function. No AI call, no network, no browser. Builds a proposal
// draft strictly from data already present on the prospect/opportunity/
// sample records passed in — never invents facts, never fabricates
// testimonials/results/client relationships, never upgrades a 'possible'
// or 'likely' evidence label into a flat assertion. Pricing is never
// included unless a rate-card configuration is explicitly supplied (Phase 4
// does not build one, so pricing is always omitted here).

function parseJsonMaybe(value, fallback) {
  if (Array.isArray(value) || (value && typeof value === 'object')) return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return fallback;
}

function normalizeProspect(prospect) {
  return {
    businessName: prospect?.businessName ?? prospect?.business_name ?? null,
    location: prospect?.location ?? null,
  };
}

function normalizeOpportunity(opportunity) {
  return {
    identifiedProblems: parseJsonMaybe(opportunity?.identifiedProblems ?? opportunity?.identified_problems_json, []),
    // recommended_services_json[0] is the authoritative top recommendation, per spec §7
    recommendedServices: parseJsonMaybe(opportunity?.recommendedServices ?? opportunity?.recommended_services_json, []),
  };
}

function normalizeSample(sample) {
  return {
    id: sample?.id ?? null,
    sampleType: sample?.sampleType ?? sample?.sample_type ?? null,
    contentKind: sample?.contentKind ?? sample?.content_kind ?? null,
    previewPath: sample?.previewPath ?? sample?.preview_path ?? null,
  };
}

const PACKAGE_BY_TYPE = {
  website: 'Website design/redesign package',
  'property-ad': 'Property advertisement design package',
  'social-media': 'Social media content package',
  'promotional-video': 'Promotional video/Reels package',
  '3d-visualization': '3D visualization package',
  'brand-design': 'Brand design package',
  'automation-demo': 'Lead automation setup package',
};

/**
 * @param {object} input
 * @param {object} input.prospect
 * @param {object} input.opportunity
 * @param {object} input.sample
 * @returns {{status:'DRAFT', pitch, serviceRecommendation, valueProposition, suggestedPackage, callToAction, assumptions:string[]}}
 */
export function generateProposal({ prospect, opportunity, sample } = {}) {
  if (!prospect) throw new Error('generateProposal requires a prospect');
  if (!opportunity) throw new Error('generateProposal requires an opportunity');
  if (!sample) throw new Error('generateProposal requires a sample');

  const p = normalizeProspect(prospect);
  const o = normalizeOpportunity(opportunity);
  const s = normalizeSample(sample);

  const businessName = p.businessName || '[Business name not available]';
  const topProblem = o.identifiedProblems[0] || null;
  const topProblemDescription = typeof topProblem === 'string' ? topProblem : topProblem?.description;
  const topProblemLevel = typeof topProblem === 'string' ? null : topProblem?.level;
  // Per spec §7: recommended service MUST come from recommendedServices[0].
  const topService = o.recommendedServices[0] || null;

  // The evidence level (confirmed/likely/possible) is interpolated verbatim
  // wherever it appears — this is what prevents "possible" from silently
  // becoming a flat, assertive claim.
  const pitch = topProblemDescription
    ? topProblemLevel
      ? 'We noticed a ' + topProblemLevel + ' opportunity for ' + businessName + ': ' + topProblemDescription
      : 'We noticed an opportunity for ' + businessName + ': ' + topProblemDescription
    : `We'd like to share some ideas that could help ${businessName} — no specific gap was confirmed from available public information.`;

  const serviceRecommendation = topService ? topService.service : '[No specific service recommendation available]';
  const valueProposition = topService
    ? topService.reason
    : '[Value proposition not available — no recommended service on record]';

  const suggestedPackage = PACKAGE_BY_TYPE[s.sampleType] || '[Package not determined for this sample type]';

  const callToAction = 'Happy to share more detail if this would be useful — no obligation, and no action has been taken on your behalf.';

  const assumptions = [
    'Pricing not included — requires human input before this proposal can be sent.',
    'Contact details not verified beyond what was publicly found.',
  ];
  if (s.contentKind === 'CONCEPT_BRIEF') {
    assumptions.push('The referenced sample is a written concept brief, not a finished visual, video, or 3D asset.');
  } else if (s.contentKind === 'SPECULATIVE_SAMPLE') {
    assumptions.push('The referenced sample is a speculative concept only — not published, not affiliated with this business unless they choose to engage.');
  }
  if (!topProblem) {
    assumptions.push('No specific service gap was confirmed for this business from available public information.');
  }

  return {
    status: 'DRAFT',
    pitch,
    serviceRecommendation,
    valueProposition,
    suggestedPackage,
    callToAction,
    assumptions,
  };
}
