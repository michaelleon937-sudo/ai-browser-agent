// integrations/sample-generation.js
// Phase 4 — Sample Generation.
//
// Local-only operation; may create local website artifact files (via
// delegation to the existing generate_website tool), but performs no
// external communication whatsoever — no browser, no network, no
// messaging, no publishing. For the six non-website sample types this
// module is purely computational (no filesystem writes at all).
//
// content_kind (stored separately from any lifecycle status — see
// database/schema.sql) is fixed per type: 'website' always produces
// SPECULATIVE_SAMPLE (a real generated artifact); every other type always
// produces CONCEPT_BRIEF (a structured text description, never a rendered
// image/video/3D asset, since no such generator exists in this codebase).
//
// Nothing here fabricates testimonials, results, client relationships, or
// business facts — every field either comes from the prospect/opportunity
// records passed in, or is an explicit placeholder.

import { generateWebsite as defaultGenerateWebsite } from './website-gen.js';

const CONCEPT_BRIEF_TYPES = new Set([
  'property-ad', 'social-media', 'promotional-video', '3d-visualization', 'brand-design', 'automation-demo',
]);

function placeholder(label) {
  return `[${label} not available — add before using this sample]`;
}

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
    websiteUrl: prospect?.websiteUrl ?? prospect?.website_url ?? null,
    location: prospect?.location ?? null,
    serviceGaps: parseJsonMaybe(prospect?.serviceGaps ?? prospect?.service_gaps_json, []),
  };
}

function normalizeOpportunity(opportunity) {
  return {
    id: opportunity?.id ?? null,
    opportunityType: opportunity?.opportunityType ?? opportunity?.opportunity_type ?? null,
    identifiedProblems: parseJsonMaybe(opportunity?.identifiedProblems ?? opportunity?.identified_problems_json, []),
    recommendedServices: parseJsonMaybe(opportunity?.recommendedServices ?? opportunity?.recommended_services_json, []),
  };
}

function buildConceptBrief(sampleType, prospect, opportunity, notes) {
  const p = normalizeProspect(prospect);
  const o = normalizeOpportunity(opportunity);
  const businessName = p.businessName || placeholder('Business name');
  const topProblem = o.identifiedProblems[0] || null;

  const TEMPLATES = {
    'property-ad': {
      headline: `Property advertisement concept for ${businessName}`,
      layout: 'Single-property ad layout: hero image area, key details (price/location/beds/baths), contact strip.',
      keyMessage: topProblem ? `Address the ${topProblem.level} gap: ${topProblem.description}` : placeholder('Key message'),
      visualStyle: 'Clean, high-contrast, property-photo-led — style to match brand once real photos are available.',
    },
    'social-media': {
      headline: `Social media content concept for ${businessName}`,
      layout: 'Square/vertical post series: 1 branded intro post + 2–3 property/listing highlight posts.',
      keyMessage: topProblem ? `Address the ${topProblem.level} gap: ${topProblem.description}` : placeholder('Key message'),
      visualStyle: 'Consistent brand colors/typography across posts; captions left as placeholders pending real copy.',
    },
    'promotional-video': {
      headline: `Promotional video concept for ${businessName}`,
      layout: 'Short-form (15–30s) walkthrough-style cut: opening hook, 3–4 property/feature shots, closing CTA card.',
      keyMessage: topProblem ? `Address the ${topProblem.level} gap: ${topProblem.description}` : placeholder('Key message'),
      visualStyle: 'Vertical (Reels/TikTok) format, captions on-screen, no music/voiceover specified yet.',
    },
    '3d-visualization': {
      headline: `3D visualization concept for ${businessName}`,
      layout: 'Exterior render + one interior render, standard daytime lighting.',
      keyMessage: topProblem ? `Address the ${topProblem.level} gap: ${topProblem.description}` : placeholder('Key message'),
      visualStyle: 'Photorealistic, neutral staging — requires real floor plan/reference photos to proceed.',
    },
    'brand-design': {
      headline: `Brand design concept for ${businessName}`,
      layout: 'Core identity elements: logo direction, primary/secondary colors, one letterhead/signage mockup.',
      keyMessage: topProblem ? `Address the ${topProblem.level} gap: ${topProblem.description}` : placeholder('Key message'),
      visualStyle: placeholder('Preferred visual style (not yet specified by the business)'),
    },
    'automation-demo': {
      headline: `Automation demo concept for ${businessName}`,
      layout: 'Simple flow diagram: lead comes in → auto-acknowledgement → routed to agent.',
      keyMessage: topProblem ? `Address the ${topProblem.level} gap: ${topProblem.description}` : placeholder('Key message'),
      visualStyle: 'Diagram/flowchart format, not a working system — illustrative only.',
    },
  };

  const template = TEMPLATES[sampleType];
  return {
    ...template,
    businessName,
    evidenceLevel: topProblem?.level || 'none',
    basedOnEvidence: topProblem?.description || null,
    notes: notes || null,
    disclaimer: 'This is a speculative concept brief only — a written description, not a rendered image, video, or 3D asset. Not published, not sent to anyone, not affiliated with this business unless they choose to engage.',
  };
}

/**
 * Local-only operation; may create local website artifact files (via
 * generate_website), but performs no external communication.
 */
export function createSample({ prospect, opportunity, sampleType, notes } = {}, deps = {}) {
  if (!prospect) throw new Error('createSample requires a prospect');
  if (!opportunity) throw new Error('createSample requires an opportunity');
  if (sampleType === 'none' || !sampleType) {
    throw new Error('createSample requires a specific sampleType (not "none")');
  }

  if (sampleType === 'website') {
    const generateWebsiteFn = deps.generateWebsite || defaultGenerateWebsite;
    const p = normalizeProspect(prospect);
    const result = generateWebsiteFn({
      prospectName: p.businessName,
      businessType: 'Real Estate',
      location: p.location,
      websiteGoal: 'Showcase properties and generate inquiries',
      services: [],
    });
    return {
      sampleType,
      contentKind: 'SPECULATIVE_SAMPLE',
      content: null,
      websiteSampleId: result.sampleId,
      previewPath: result.previewPath,
    };
  }

  if (!CONCEPT_BRIEF_TYPES.has(sampleType)) {
    throw new Error(`Unknown sampleType: ${sampleType}`);
  }

  const content = buildConceptBrief(sampleType, prospect, opportunity, notes);
  return {
    sampleType,
    contentKind: 'CONCEPT_BRIEF',
    content,
    websiteSampleId: null,
    previewPath: null,
  };
}

export { CONCEPT_BRIEF_TYPES };
