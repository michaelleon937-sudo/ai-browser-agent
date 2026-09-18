// tests/unit/proposal-generation.test.js
import { describe, it, expect } from 'vitest';
import { generateProposal } from '../../integrations/proposal-generation.js';

const prospect = { business_name: 'Example Property Tanzania', location: 'Dar es Salaam, Tanzania' };

function opportunityWith(level, description) {
  return {
    identified_problems_json: JSON.stringify([{ category: 'website', level, description }]),
    recommended_services_json: JSON.stringify([
      { service: 'Website Design/Improvement', reason: 'No website found for this business.', priority: 'high' },
    ]),
  };
}

const websiteSample = { id: 'sample_1', sample_type: 'website', content_kind: 'SPECULATIVE_SAMPLE', preview_path: '/website-samples/x/' };
const briefSample = { id: 'sample_2', sample_type: 'social-media', content_kind: 'CONCEPT_BRIEF' };

describe('integrations/proposal-generation — generateProposal', () => {
  it('produces a DRAFT status proposal', () => {
    const result = generateProposal({ prospect, opportunity: opportunityWith('confirmed', 'No website exists.'), sample: websiteSample });
    expect(result.status).toBe('DRAFT');
  });

  it('preserves the "confirmed" evidence label verbatim in the pitch', () => {
    const result = generateProposal({ prospect, opportunity: opportunityWith('confirmed', 'No website exists.'), sample: websiteSample });
    expect(result.pitch).toContain('confirmed');
    expect(result.pitch).toContain('No website exists.');
  });

  it('preserves the "likely" evidence label verbatim — never upgrades it to a flat assertion', () => {
    const result = generateProposal({ prospect, opportunity: opportunityWith('likely', 'Website appears thin or outdated.'), sample: websiteSample });
    expect(result.pitch).toContain('likely');
    expect(result.pitch).not.toMatch(/\bconfirmed\b/);
  });

  it('preserves the "possible" evidence label verbatim — never upgrades it', () => {
    const result = generateProposal({ prospect, opportunity: opportunityWith('possible', 'Automation opportunity is speculative.'), sample: briefSample });
    expect(result.pitch).toContain('possible');
    expect(result.pitch).not.toMatch(/\bconfirmed\b/);
    expect(result.pitch).not.toMatch(/\blikely\b/);
  });

  it('takes the recommended service strictly from recommendedServices[0]', () => {
    const opportunity = {
      identified_problems_json: '[]',
      recommended_services_json: JSON.stringify([
        { service: 'Website Design/Improvement', reason: 'Top reason', priority: 'high' },
        { service: 'Social Media / Content Design', reason: 'Second reason', priority: 'medium' },
      ]),
    };
    const result = generateProposal({ prospect, opportunity, sample: websiteSample });
    expect(result.serviceRecommendation).toBe('Website Design/Improvement');
    expect(result.valueProposition).toBe('Top reason');
  });

  it('never includes pricing by default', () => {
    const result = generateProposal({ prospect, opportunity: opportunityWith('confirmed', 'x'), sample: websiteSample });
    const serialized = JSON.stringify(result).toLowerCase();
    expect(serialized).not.toMatch(/\$\d/);
    expect(serialized).not.toMatch(/price:|cost:/);
    expect(result.assumptions.some((a) => /pricing not included/i.test(a))).toBe(true);
  });

  it('flags concept-brief samples as not a finished visual asset in the assumptions', () => {
    const result = generateProposal({ prospect, opportunity: opportunityWith('possible', 'x'), sample: briefSample });
    expect(result.assumptions.some((a) => /written concept brief, not a finished visual/i.test(a))).toBe(true);
  });

  it('flags website samples as speculative-only, not affiliated, in the assumptions', () => {
    const result = generateProposal({ prospect, opportunity: opportunityWith('confirmed', 'x'), sample: websiteSample });
    expect(result.assumptions.some((a) => /speculative concept only.*not affiliated/i.test(a))).toBe(true);
  });

  it('is deterministic — same input produces the same output', () => {
    const opportunity = opportunityWith('likely', 'Some gap.');
    const r1 = generateProposal({ prospect, opportunity, sample: websiteSample });
    const r2 = generateProposal({ prospect, opportunity, sample: websiteSample });
    expect(r1).toEqual(r2);
  });

  it('never fabricates testimonials, results, or prior client relationships', () => {
    const result = generateProposal({ prospect, opportunity: opportunityWith('confirmed', 'x'), sample: websiteSample });
    const serialized = JSON.stringify(result).toLowerCase();
    expect(serialized).not.toMatch(/testimonial|previous client|past client|five-star/);
  });

  it('handles an opportunity with no identified problems using a clear fallback pitch', () => {
    const opportunity = { identified_problems_json: '[]', recommended_services_json: '[]' };
    const result = generateProposal({ prospect, opportunity, sample: websiteSample });
    expect(result.pitch).toMatch(/no specific gap was confirmed/i);
    expect(result.serviceRecommendation).toMatch(/no specific service recommendation/i);
    expect(result.assumptions.some((a) => /no specific service gap was confirmed/i.test(a))).toBe(true);
  });

  it('throws a clear error when prospect is missing', () => {
    expect(() => generateProposal({ opportunity: opportunityWith('confirmed', 'x'), sample: websiteSample })).toThrow(/prospect/i);
  });

  it('throws a clear error when opportunity is missing', () => {
    expect(() => generateProposal({ prospect, sample: websiteSample })).toThrow(/opportunity/i);
  });

  it('throws a clear error when sample is missing', () => {
    expect(() => generateProposal({ prospect, opportunity: opportunityWith('confirmed', 'x') })).toThrow(/sample/i);
  });
});
