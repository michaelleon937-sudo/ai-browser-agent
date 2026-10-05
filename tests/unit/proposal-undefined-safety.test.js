import { describe, it, expect } from 'vitest';
import { generateProposal } from '../../integrations/proposal-generation.js';

const prospect = { business_name: 'The Agency Global Boutique Real Estate Brokerage' };
const sample = { sample_type: 'website', content_kind: 'SPECULATIVE_SAMPLE' };
const missingSentinel = ['un', 'defined'].join('');

describe('proposal missing-data safety', () => {
  it('never exposes an invalid sentinel in customer-facing proposal fields', () => {
    const opportunity = {
      identified_problems_json: JSON.stringify([{ level: missingSentinel, description: missingSentinel }]),
      recommended_services_json: JSON.stringify([{ service: missingSentinel, reason: missingSentinel }]),
    };
    const result = generateProposal({ prospect, opportunity, sample });
    expect(JSON.stringify(result)).not.toContain(missingSentinel);
    expect(result.pitch).toMatch(/no specific gap was confirmed/i);
    expect(result.serviceRecommendation).toMatch(/no specific service recommendation available/i);
  });

  it('keeps valid data when one upstream field is invalid', () => {
    const opportunity = {
      identified_problems_json: JSON.stringify([{ level: 'likely', description: 'Website appears outdated.' }]),
      recommended_services_json: JSON.stringify([{ service: 'Website Design/Improvement', reason: missingSentinel }]),
    };
    const result = generateProposal({ prospect, opportunity, sample });
    expect(result.pitch).toContain('likely');
    expect(result.pitch).toContain('Website appears outdated.');
    expect(result.serviceRecommendation).toBe('Website Design/Improvement');
    expect(result.valueProposition).toMatch(/no complete recommended service/i);
  });
});
