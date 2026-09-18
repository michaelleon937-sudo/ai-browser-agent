// tests/unit/sample-generation.test.js
import { describe, it, expect, vi } from 'vitest';
import { createSample, CONCEPT_BRIEF_TYPES } from '../../integrations/sample-generation.js';

const prospect = {
  business_name: 'Example Property Tanzania',
  location: 'Dar es Salaam, Tanzania',
  service_gaps_json: JSON.stringify(['No public contact information found on the page (no email or phone detected).']),
};

const opportunity = {
  id: 'opp_1',
  opportunity_type: 'website',
  identified_problems_json: JSON.stringify([
    { category: 'website', level: 'confirmed', description: 'No website URL is on record for this prospect.' },
  ]),
  recommended_services_json: JSON.stringify([
    { service: 'Website Design/Improvement', reason: 'No website found.', priority: 'high' },
  ]),
};

describe('integrations/sample-generation — createSample', () => {
  it('delegates website sampleType to the injected generateWebsite function', () => {
    const fakeGenerateWebsite = vi.fn(() => ({ sampleId: 'website_fake123', previewPath: '/website-samples/website_fake123/' }));
    const result = createSample({ prospect, opportunity, sampleType: 'website' }, { generateWebsite: fakeGenerateWebsite });

    expect(fakeGenerateWebsite).toHaveBeenCalledOnce();
    expect(result.sampleType).toBe('website');
    expect(result.contentKind).toBe('SPECULATIVE_SAMPLE');
    expect(result.websiteSampleId).toBe('website_fake123');
    expect(result.previewPath).toBe('/website-samples/website_fake123/');
    expect(result.content).toBeNull();
  });

  it('passes prospect business name and location through to generateWebsite', () => {
    const fakeGenerateWebsite = vi.fn(() => ({ sampleId: 'x', previewPath: '/x/' }));
    createSample({ prospect, opportunity, sampleType: 'website' }, { generateWebsite: fakeGenerateWebsite });
    const callArgs = fakeGenerateWebsite.mock.calls[0][0];
    expect(callArgs.prospectName).toBe('Example Property Tanzania');
    expect(callArgs.location).toBe('Dar es Salaam, Tanzania');
  });

  for (const sampleType of CONCEPT_BRIEF_TYPES) {
    it(`produces a CONCEPT_BRIEF (never a rendered asset) for sampleType "${sampleType}"`, () => {
      const result = createSample({ prospect, opportunity, sampleType });
      expect(result.contentKind).toBe('CONCEPT_BRIEF');
      expect(result.websiteSampleId).toBeNull();
      expect(result.previewPath).toBeNull();
      expect(result.content).toBeTruthy();
      expect(result.content.disclaimer).toMatch(/speculative concept brief/i);
      expect(result.content.disclaimer).toMatch(/not a rendered image, video, or 3D asset/i);
    });

    it(`"${sampleType}" concept brief preserves the evidence level from the opportunity`, () => {
      const result = createSample({ prospect, opportunity, sampleType });
      expect(result.content.evidenceLevel).toBe('confirmed');
      expect(result.content.basedOnEvidence).toMatch(/No website URL/);
    });
  }

  it('uses a clear placeholder when the prospect has no business name', () => {
    const noNameProspect = { location: 'Somewhere' };
    const result = createSample({ prospect: noNameProspect, opportunity, sampleType: 'social-media' });
    expect(result.content.businessName).toMatch(/not available/i);
  });

  it('uses a clear placeholder for evidence when the opportunity has no identified problems', () => {
    const noProblemsOpportunity = { id: 'opp_2', identified_problems_json: '[]', recommended_services_json: '[]' };
    const result = createSample({ prospect, opportunity: noProblemsOpportunity, sampleType: 'brand-design' });
    expect(result.content.evidenceLevel).toBe('none');
    expect(result.content.basedOnEvidence).toBeNull();
  });

  it('is deterministic — same input produces the same output', () => {
    const r1 = createSample({ prospect, opportunity, sampleType: 'property-ad' });
    const r2 = createSample({ prospect, opportunity, sampleType: 'property-ad' });
    expect(r1.content).toEqual(r2.content);
  });

  it('never fabricates testimonials, results, or client relationships', () => {
    for (const sampleType of CONCEPT_BRIEF_TYPES) {
      const result = createSample({ prospect, opportunity, sampleType });
      const serialized = JSON.stringify(result.content).toLowerCase();
      expect(serialized).not.toMatch(/testimonial|client said|five-star|five star|review from|our client/);
    }
  });

  it('throws a clear error when prospect is missing', () => {
    expect(() => createSample({ opportunity, sampleType: 'website' })).toThrow(/prospect/i);
  });

  it('throws a clear error when opportunity is missing', () => {
    expect(() => createSample({ prospect, sampleType: 'website' })).toThrow(/opportunity/i);
  });

  it('throws a clear error when sampleType is "none"', () => {
    expect(() => createSample({ prospect, opportunity, sampleType: 'none' })).toThrow(/sampleType/i);
  });

  it('throws a clear error for an unknown sampleType', () => {
    expect(() => createSample({ prospect, opportunity, sampleType: 'not-a-real-type' })).toThrow(/Unknown sampleType/);
  });

  it('accepts a camelCase prospect/opportunity shape as well as snake_case DB rows', () => {
    const camelProspect = { businessName: 'Camel Co', location: 'Arusha' };
    const camelOpportunity = { id: 'opp_3', identifiedProblems: [], recommendedServices: [] };
    const result = createSample({ prospect: camelProspect, opportunity: camelOpportunity, sampleType: 'automation-demo' });
    expect(result.content.businessName).toBe('Camel Co');
  });
});
