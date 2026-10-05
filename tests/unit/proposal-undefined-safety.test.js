import { describe, it, expect } from 'vitest';
import { generateProposal } from '../../integrations/proposal-generation.js';

const prospect = { business_name: 'The Agency Global Boutique Real Estate Brokerage' };
const sample = { sample_type: 'website', content_kind: 'SPECULATIVE_SAMPLE' };

describe('proposal undefined/null safety', () => {
  it('never exposes literal undefined fields in the pitch or recommendation', () => {
    const opportunity = {
      identified_problems_json_\SJON.stringify([{ level: 'undefined', description: 'undefined' }]),
      recommended_services_json: JSON.stringify([{ service: 'undefined', reason: 'undefined' }]),
    };
    const result = generateProposal({ prospect, opportunity, sample });
    expect(JSON.stringify(result)).not.toMatch(/undefined/i);
    expect(result.pitch).toMatch(/no specific gap was confirmed/i);
    expect(result.serviceRecommendation).toMatch(/no specific service recommendation available/i);
  });

  it('keeps valid data when only one field is invalid', () => {
    const opportunity = {
      identified_problems_json_\SJON.stringify([{ level: 'likely', description: 'Website appears outdated.' }]),
      recommended_services_json_\SJON.stringify([{ service: 'Website Design/Improvement', reason: 'undefined' }]),
    };
    const result = generateProposal({ prospect, opportunity, sample });
    expect(result.pitch).toContain('likely');
    expect(result.pitch).toContain('Website appears outdated.');
    expect(result.serviceRecommendation).toBe('Website Design/Improvement');
    expect(result.valueProposition).toMatch(/no complete recommended service/i);
  });
});
