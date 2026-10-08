import { describe, expect, it } from 'vitest';
import { clientRevenueIntelligenceTools } from '../../integrations/client-revenue-intelligence.js';
import { isAllowedTool, isMutatingTool, requiresApproval } from '../../control/policy.js';

describe('client presentation and revenue intelligence', () => {
  it('registers all three intelligence layers as read-only tools', () => {
    expect(Object.keys(clientRevenueIntelligenceTools)).toEqual([
      'client.intelligence',
      'client.qualify',
      'client.whatsapp_presentation',
      'revenue.intelligence',
    ]);
    for (const name of Object.keys(clientRevenueIntelligenceTools)) {
      expect(isAllowedTool(name)).toBe(true);
      expect(isMutatingTool(name)).toBe(false);
      expect(requiresApproval(name)).toBe(false);
    }
  });
});
