// integrations/opportunity-intelligence.js
// Phase 3 — Real Estate Opportunity Intelligence.
//
// Purely deterministic and side-effect-free: no AI call, no network, no DB
// access. Takes a prospect record (as stored by Phase 2's `prospects`
// repository, or the equivalent camelCase shape) plus optional additional
// signals, and returns a structured, explainable opportunity assessment.
// Every claim is labeled with its evidence level (confirmed/likely/possible)
// and traceable to a specific input field — nothing is invented. Where
// there is genuinely no evidence for a category, it is marked 'possible'
// with minimal weight or 'none', never asserted as fact.

const SERVICE_CATEGORIES = ['website', 'social', 'visual', 'video', '3d', 'leadgen', 'automation'];

const SERVICE_LABELS = {
  website: 'Website Design/Improvement',
  social: 'Social Media / Content Design',
  visual: 'Property Promotional Graphics',
  video: 'Property Promotional Video/Reels/TikTok',
  '3d': '3D Visualization',
  leadgen: 'Lead Generation / Marketing',
  automation: 'AI Automation',
};

const SAMPLE_TYPE_BY_CATEGORY = {
  website: 'website',
  visual: 'property-ad',
  social: 'social-media',
  video: 'promotional-video',
  '3d': '3d-visualization',
  leadgen: 'brand-design',
  automation: 'automation-demo',
};

const LEVEL_TO_PRIORITY = { confirmed: 'high', likely: 'medium', possible: 'low', none: 'low' };

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

// Accepts either a raw DB row (snake_case, JSON-string columns) or an
// already-normalized camelCase object (e.g. tool call args) and returns a
// single normalized shape.
function normalizeProspect(prospect) {
  if (!prospect || typeof prospect !== 'object') return null;
  return {
    businessName: prospect.businessName ?? prospect.business_name ?? null,
    websiteUrl: prospect.websiteUrl ?? prospect.website_url ?? null,
    location: prospect.location ?? null,
    contactEmail: prospect.contactEmail ?? prospect.contact_email ?? null,
    contactPhone: prospect.contactPhone ?? prospect.contact_phone ?? null,
    socialProfiles: parseJsonArray(prospect.socialProfiles ?? prospect.social_profiles_json),
    serviceGaps: parseJsonArray(prospect.serviceGaps ?? prospect.service_gaps_json),
  };
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/**
 * Analyze a prospect + its known analysis for genuine service opportunities.
 *
 * @param {object} prospect - prospect record (DB row or camelCase shape)
 * @param {object} [analysis] - optional additional known signals:
 *   propertyListingsCount?: number|null
 *   hasPromoVideo?: boolean|null
 *   has3DVisualization?: boolean|null
 *   mobileFriendly?: boolean|null
 * @returns {object} structured opportunity assessment
 */
export function analyzeOpportunity(prospect, analysis = {}) {
  const p = normalizeProspect(prospect);
  if (!p) {
    throw new Error('analyzeOpportunity requires a prospect object');
  }
  const a = analysis && typeof analysis === 'object' ? analysis : {};

  const gaps = p.serviceGaps;
  const hasWebsite = Boolean(p.websiteUrl);
  const hasContactInfo = Boolean(p.contactEmail || p.contactPhone);
  const hasSocial = p.socialProfiles.length > 0;
  const gapText = gaps.join(' ');

  const isThinOrOutdated = /thin, outdated|very short/i.test(gapText);
  const isNoHttps = /plain HTTP \(no HTTPS\)/i.test(gapText);
  const isNoPropertyContent = /No property\/listing content/i.test(gapText);
  const isNoSocialGap = /No linked social media profiles/i.test(gapText);
  const isNoContactGap = /No public contact information/i.test(gapText);

  const categories = {};

  // ── Website (max 28 points) ──────────────────────────────────────
  if (!hasWebsite) {
    categories.website = { level: 'confirmed', points: 28, reason: 'No website URL is on record for this prospect.' };
  } else if (isThinOrOutdated && isNoHttps) {
    categories.website = { level: 'likely', points: 22, reason: 'Website exists but the page content was found to be very short and the site is served over plain HTTP without HTTPS.' };
  } else if (isThinOrOutdated || isNoHttps) {
    const reason = isThinOrOutdated
      ? 'the page content was found to be very short, suggesting a thin or outdated site'
      : 'the site is served over plain HTTP without HTTPS';
    categories.website = { level: 'likely', points: 14, reason: `Website exists but ${reason}.` };
  } else if (!hasContactInfo) {
    categories.website = { level: 'likely', points: 8, reason: 'Website exists but no clear contact path (email/phone) was found on the analyzed page.' };
  } else {
    categories.website = { level: 'none', points: 0, reason: 'Website exists with contact information; no confirmed website gap.' };
  }

  // ── Social (max 22 points) ────────────────────────────────────────
  if (isNoSocialGap || (!hasSocial && hasWebsite)) {
    categories.social = { level: 'confirmed', points: 22, reason: 'No linked social media profiles were found on the analyzed page.' };
  } else if (!hasSocial) {
    categories.social = { level: 'possible', points: 8, reason: 'No social profiles on record, though no page was confirmed to lack them.' };
  } else {
    categories.social = { level: 'none', points: 0, reason: 'Social media profiles were found for this prospect.' };
  }

  // ── Visual marketing / property presentation (max 18 points) ─────
  if (isNoPropertyContent) {
    categories.visual = { level: 'likely', points: 18, reason: 'No property/listing content was detected on the analyzed page, suggesting weak property presentation.' };
  } else {
    categories.visual = { level: 'possible', points: 4, reason: 'No confirmed gap in property presentation, but visual marketing quality was not directly assessed.' };
  }

  // ── Video (max 8 points — rarely confirmable from public info alone) ─
  if (a.hasPromoVideo === false) {
    categories.video = { level: 'likely', points: 8, reason: 'No promotional video content was confirmed present for this business.' };
  } else if (a.hasPromoVideo === true) {
    categories.video = { level: 'none', points: 0, reason: 'Promotional video content was confirmed already present.' };
  } else if (typeof a.propertyListingsCount === 'number' && a.propertyListingsCount > 0) {
    categories.video = { level: 'likely', points: 7, reason: `${a.propertyListingsCount} property listing(s) on record could reasonably benefit from promotional video/Reels content.` };
  } else {
    categories.video = { level: 'possible', points: 4, reason: 'Property promotional video is a generally applicable opportunity for real-estate businesses, though not directly confirmed here.' };
  }

  // ── 3D visualization (max 6 points) ───────────────────────────────
  if (a.has3DVisualization === false) {
    categories['3d'] = { level: 'likely', points: 6, reason: 'No 3D visualization content was confirmed present for this business.' };
  } else if (a.has3DVisualization === true) {
    categories['3d'] = { level: 'none', points: 0, reason: '3D visualization content was confirmed already present.' };
  } else if (typeof a.propertyListingsCount === 'number' && a.propertyListingsCount > 0) {
    categories['3d'] = { level: 'likely', points: 5, reason: `${a.propertyListingsCount} property listing(s) on record could reasonably benefit from 3D visualization.` };
  } else {
    categories['3d'] = { level: 'possible', points: 3, reason: '3D visualization is a plausible opportunity for a real-estate business, though not directly confirmed here.' };
  }

  // ── Lead generation / marketing (max 14 points) ───────────────────
  const leadGenSignals = [!hasContactInfo || isNoContactGap, !hasSocial || isNoSocialGap, categories.website.level !== 'none'].filter(Boolean).length;
  if (leadGenSignals >= 2) {
    categories.leadgen = { level: 'confirmed', points: 14, reason: 'Multiple confirmed gaps (contact path, social presence, and/or website) point to a genuine lead-generation opportunity.' };
  } else if (leadGenSignals === 1) {
    categories.leadgen = { level: 'likely', points: 7, reason: 'At least one confirmed gap suggests a lead-generation opportunity.' };
  } else {
    categories.leadgen = { level: 'possible', points: 2, reason: 'No confirmed lead-generation gap; general marketing support may still be of interest.' };
  }

  // ── Automation (max 6 points) ─────────────────────────────────────
  if (!hasContactInfo && hasWebsite) {
    categories.automation = { level: 'likely', points: 6, reason: 'Website exists without a clear contact/lead-capture path — a lead-routing or automation gap is plausible.' };
  } else {
    categories.automation = { level: 'possible', points: 2, reason: 'No direct evidence of operational/lead-management processes; automation opportunity is speculative.' };
  }

  // ── Score & priority ─────────────────────────────────────────────
  const score = clamp(SERVICE_CATEGORIES.reduce((sum, key) => sum + categories[key].points, 0), 0, 100);
  const priority = score >= 80 ? 'HIGH' : score >= 60 ? 'MEDIUM' : 'LOW';

  // ── Confidence: how much evidence did we actually have? ──────────
  const evidenceSignals = [gaps.length > 0, hasWebsite, hasSocial || isNoSocialGap, hasContactInfo || isNoContactGap].filter(Boolean).length;
  const confidence = evidenceSignals >= 3 ? 'high' : evidenceSignals >= 1 ? 'medium' : 'low';

  // ── Recommended services (only categories with any points) ───────
  const recommendedServices = SERVICE_CATEGORIES
    .filter((key) => categories[key].points > 0)
    .sort((a, b) => categories[b].points - categories[a].points)
    .map((key) => ({
      service: SERVICE_LABELS[key],
      reason: categories[key].reason,
      priority: LEVEL_TO_PRIORITY[categories[key].level],
    }));

  // ── Identified problems (level != none) ───────────────────────────
  const identifiedProblems = SERVICE_CATEGORIES
    .filter((key) => categories[key].level !== 'none')
    .map((key) => ({ category: key, level: categories[key].level, description: categories[key].reason }));

  // ── Recommended sample type: top-scoring category, or 'none' ─────
  const topCategory = SERVICE_CATEGORIES
    .filter((key) => categories[key].points > 0)
    .sort((a, b) => categories[b].points - categories[a].points)[0];
  const recommendedSampleType = topCategory ? SAMPLE_TYPE_BY_CATEGORY[topCategory] : 'none';
  const recommendedSampleReason = topCategory
    ? `Highest-scoring opportunity is ${SERVICE_LABELS[topCategory]} (${categories[topCategory].level}), so a ${recommendedSampleType} sample would best demonstrate value.`
    : 'No significant opportunity was identified; no sample is recommended at this time.';

  // ── Estimated value: qualitative only — no fabricated figures ────
  const estimatedValue = score >= 80 ? 'high' : score >= 60 ? 'medium' : 'low';

  // ── Deterministic summary ─────────────────────────────────────────
  const topProblem = identifiedProblems[0];
  const summary = topProblem
    ? `${p.businessName || 'This prospect'} shows a ${priority}-priority opportunity (score ${score}/100), primarily due to a ${topProblem.level} gap: ${topProblem.description}`
    : `${p.businessName || 'This prospect'} shows a ${priority}-priority opportunity (score ${score}/100); no significant service gaps were identified from available evidence.`;

  return {
    score,
    priority,
    opportunityType: topCategory || 'none',
    summary,
    identifiedProblems,
    recommendedServices,
    recommendedSampleType,
    recommendedSampleReason,
    estimatedValue,
    confidence,
    categories, // full breakdown, for transparency/explainability
  };
}
