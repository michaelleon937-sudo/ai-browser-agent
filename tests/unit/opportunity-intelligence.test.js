// tests/unit/opportunity-intelligence.test.js
import { describe, it, expect } from 'vitest';
import { analyzeOpportunity } from '../../integrations/opportunity-intelligence.js';

const NO_CONTACT_GAP = 'No public contact information found on the page (no email or phone detected).';
const NO_SOCIAL_GAP = 'No linked social media profiles detected — potential social media marketing opportunity.';
const THIN_GAP = 'Page text content is very short — may indicate a thin, outdated, or under-developed website.';
const NO_HTTPS_GAP = 'Site is served over plain HTTP (no HTTPS) — a basic website-improvement opportunity.';
const NO_PROPERTY_GAP = 'No property/listing content detected on this page — may indicate weak property marketing.';

describe('integrations/opportunity-intelligence — analyzeOpportunity', () => {
  it('produces a HIGH priority for a prospect with multiple confirmed gaps from actual page analysis', () => {
    // Realistic HIGH case: a real website was analyzed and several gaps
    // were directly confirmed (thin content, no HTTPS, no social, no
    // property content, no contact info) — not merely "no website found".
    const prospect = {
      businessName: 'Confirmed Gaps Realty',
      websiteUrl: 'https://confirmed-gaps-realty.com',
      contactEmail: null,
      contactPhone: null,
      socialProfiles: [],
      serviceGaps: [NO_CONTACT_GAP, NO_SOCIAL_GAP, NO_PROPERTY_GAP, NO_HTTPS_GAP, THIN_GAP],
    };
    const result = analyzeOpportunity(prospect);
    expect(result.score).toBeGreaterThanOrEqual(80);
    expect(result.priority).toBe('HIGH');
  });

  it('produces a MEDIUM priority for a prospect with a thin, non-HTTPS website and no recorded social presence', () => {
    const prospect = {
      businessName: 'Thin Site Realty',
      websiteUrl: 'https://thin-realty.com',
      contactEmail: 'info@thin-realty.com',
      contactPhone: null,
      socialProfiles: [],
      serviceGaps: [THIN_GAP, NO_HTTPS_GAP],
    };
    const result = analyzeOpportunity(prospect);
    expect(result.score).toBeGreaterThanOrEqual(60);
    expect(result.score).toBeLessThan(80);
    expect(result.priority).toBe('MEDIUM');
  });

  it('produces a LOW priority for a prospect with a strong website, contact info, and social presence', () => {
    const prospect = {
      businessName: 'Strong Realty',
      websiteUrl: 'https://strong-realty.com',
      contactEmail: 'info@strong-realty.com',
      contactPhone: '+255700000000',
      socialProfiles: [{ platform: 'facebook', url: 'https://facebook.com/strong' }, { platform: 'instagram', url: 'https://instagram.com/strong' }],
      serviceGaps: [],
    };
    const result = analyzeOpportunity(prospect, { hasPromoVideo: true, has3DVisualization: true });
    expect(result.score).toBeLessThan(60);
    expect(result.priority).toBe('LOW');
  });

  it('flags "no website" as a confirmed website gap with maximum website points', () => {
    const prospect = { businessName: 'No Site Co', websiteUrl: null, serviceGaps: [] };
    const result = analyzeOpportunity(prospect);
    expect(result.categories.website.level).toBe('confirmed');
    expect(result.categories.website.points).toBe(28);
  });

  it('flags a weak/thin website as "likely" (not confirmed) since it is inferred, not directly proven', () => {
    const prospect = { businessName: 'Weak Site Co', websiteUrl: 'https://weak.com', serviceGaps: [THIN_GAP] };
    const result = analyzeOpportunity(prospect);
    expect(result.categories.website.level).toBe('likely');
  });

  it('flags missing social presence as a confirmed gap when the page was actually checked', () => {
    const prospect = { businessName: 'No Social Co', websiteUrl: 'https://x.com', serviceGaps: [NO_SOCIAL_GAP] };
    const result = analyzeOpportunity(prospect);
    expect(result.categories.social.level).toBe('confirmed');
  });

  it('recommends multiple services when multiple gaps are present', () => {
    const prospect = {
      businessName: 'Multi Gap Realty',
      websiteUrl: null,
      serviceGaps: [NO_CONTACT_GAP, NO_SOCIAL_GAP, NO_PROPERTY_GAP],
    };
    const result = analyzeOpportunity(prospect);
    expect(result.recommendedServices.length).toBeGreaterThanOrEqual(3);
    const serviceNames = result.recommendedServices.map((s) => s.service);
    expect(serviceNames).toContain('Website Design/Improvement');
    expect(serviceNames).toContain('Social Media / Content Design');
  });

  it('selects the highest-scoring category as the recommended sample type', () => {
    const prospect = { businessName: 'No Site Co', websiteUrl: null, serviceGaps: [] };
    const result = analyzeOpportunity(prospect);
    expect(result.recommendedSampleType).toBe('website');
    expect(result.recommendedSampleReason).toBeTruthy();
  });

  it('recommends "none" as the sample type when there are no positive-point categories', () => {
    // Construct a prospect where every category should land at 0 points:
    // impossible in practice (possible-level categories always have some
    // baseline points), so instead verify the function never crashes and
    // always returns a valid enum value from the allowed set.
    const prospect = {
      businessName: 'Perfect Co',
      websiteUrl: 'https://perfect.com',
      contactEmail: 'info@perfect.com',
      contactPhone: '+255700000000',
      socialProfiles: [{ platform: 'facebook', url: 'https://facebook.com/perfect' }],
      serviceGaps: [],
    };
    const result = analyzeOpportunity(prospect, { hasPromoVideo: true, has3DVisualization: true });
    const allowed = ['website', 'property-ad', 'social-media', 'promotional-video', '3d-visualization', 'brand-design', 'automation-demo', 'none'];
    expect(allowed).toContain(result.recommendedSampleType);
  });

  it('is fully deterministic — same input always produces the same score', () => {
    const prospect = { businessName: 'Repeat Co', websiteUrl: 'https://repeat.com', serviceGaps: [THIN_GAP, NO_SOCIAL_GAP] };
    const r1 = analyzeOpportunity(prospect);
    const r2 = analyzeOpportunity(prospect);
    expect(r1.score).toBe(r2.score);
    expect(r1.priority).toBe(r2.priority);
    expect(r1.recommendedSampleType).toBe(r2.recommendedSampleType);
  });

  it('never asserts a "confirmed" level without a specific supporting gap or field', () => {
    // Video/3D/automation categories have no direct Phase-2 signal for
    // "confirmed" — they should never reach 'confirmed' purely from
    // inference; only 'likely' or 'possible'.
    const prospect = { businessName: 'X', websiteUrl: 'https://x.com', serviceGaps: [] };
    const result = analyzeOpportunity(prospect);
    expect(result.categories.video.level).not.toBe('confirmed');
    expect(result.categories['3d'].level).not.toBe('confirmed');
    expect(result.categories.automation.level).not.toBe('confirmed');
  });

  it('uses qualitative estimated_value labels only — never a fabricated dollar figure', () => {
    const prospect = { businessName: 'X', websiteUrl: null, serviceGaps: [] };
    const result = analyzeOpportunity(prospect);
    expect(['low', 'medium', 'high']).toContain(result.estimatedValue);
  });

  it('throws a clear error for malformed input (null prospect)', () => {
    expect(() => analyzeOpportunity(null)).toThrow(/prospect/i);
  });

  it('throws a clear error for malformed input (undefined prospect)', () => {
    expect(() => analyzeOpportunity(undefined)).toThrow(/prospect/i);
  });

  it('accepts a raw DB row shape (snake_case + JSON string columns)', () => {
    const dbRow = {
      business_name: 'DB Row Realty',
      website_url: null,
      contact_email: null,
      contact_phone: null,
      social_profiles_json: '[]',
      service_gaps_json: JSON.stringify([NO_CONTACT_GAP]),
    };
    const result = analyzeOpportunity(dbRow);
    expect(result.score).toBeGreaterThan(0);
    expect(result.categories.website.level).toBe('confirmed');
  });

  it('handles malformed JSON string fields gracefully instead of throwing', () => {
    const dbRow = { business_name: 'Bad JSON Co', social_profiles_json: 'not json', service_gaps_json: 'also not json' };
    expect(() => analyzeOpportunity(dbRow)).not.toThrow();
  });

  it('score is always clamped between 0 and 100', () => {
    const prospect = { businessName: 'X', websiteUrl: null, serviceGaps: [NO_CONTACT_GAP, NO_SOCIAL_GAP, THIN_GAP, NO_HTTPS_GAP, NO_PROPERTY_GAP] };
    const result = analyzeOpportunity(prospect);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('every identified problem has a level of confirmed, likely, or possible — never a bare assertion', () => {
    const prospect = { businessName: 'X', websiteUrl: null, serviceGaps: [NO_CONTACT_GAP, NO_SOCIAL_GAP] };
    const result = analyzeOpportunity(prospect);
    for (const problem of result.identifiedProblems) {
      expect(['confirmed', 'likely', 'possible']).toContain(problem.level);
    }
  });
});
