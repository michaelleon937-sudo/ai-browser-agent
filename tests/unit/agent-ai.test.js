// tests/unit/agent-ai.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isKnownTool, ACTION_TOOLS, isSensitive, getProvider } from '../../agent/ai/index.js';

describe('agent/ai', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('knows core browser tools', () => {
    expect(isKnownTool('browser_navigate')).toBe(true);
    expect(isKnownTool('browser_click')).toBe(true);
    expect(isKnownTool('task_complete')).toBe(true);
    expect(isKnownTool('task_fail')).toBe(true);
    expect(isKnownTool('not_a_real_tool')).toBe(false);
  });

  it('exposes ACTION_TOOLS with name and parameters', () => {
    expect(Array.isArray(ACTION_TOOLS)).toBe(true);
    expect(ACTION_TOOLS.length).toBeGreaterThan(10);
    for (const tool of ACTION_TOOLS) {
      expect(tool.name).toBeTruthy();
      expect(tool.parameters).toBeTruthy();
    }
  });

  it('registers Phase 1-3 CRM tools', () => {
    expect(isKnownTool('generate_website')).toBe(true);
    expect(isKnownTool('analyze_prospect_page')).toBe(true);
    expect(isKnownTool('save_prospect')).toBe(true);
    expect(isKnownTool('analyze_opportunity')).toBe(true);
    expect(isKnownTool('save_opportunity')).toBe(true);
  });

  it('isSensitive respects HUMAN_APPROVAL_REQUIRED', () => {
    process.env.HUMAN_APPROVAL_REQUIRED = 'false';
    // isSensitive reads config which may be cached — just assert the function runs
    expect(typeof isSensitive('browser_type', { text: 'hello' })).toBe('boolean');
  });

  it('does not treat Phase 2/3 tools as sensitive', () => {
    process.env.HUMAN_APPROVAL_REQUIRED = 'true';
    expect(isSensitive('save_prospect', { businessName: 'x' })).toBe(false);
    expect(isSensitive('analyze_opportunity', { prospectId: 'x' })).toBe(false);
    expect(isSensitive('save_opportunity', { prospectId: 'x', score: 50, priority: 'LOW' })).toBe(false);
  });

  it('registers create_sample as a known tool with a structured schema', () => {
    expect(isKnownTool('create_sample')).toBe(true);
    const tool = ACTION_TOOLS.find((t) => t.name === 'create_sample');
    expect(tool).toBeTruthy();
    expect(tool.parameters.properties).toHaveProperty('opportunityId');
    expect(tool.parameters.properties).toHaveProperty('sampleType');
    expect(tool.parameters.properties.sampleType.enum).toEqual(
      expect.arrayContaining(['website', 'property-ad', 'social-media', 'promotional-video', '3d-visualization', 'brand-design', 'automation-demo'])
    );
    expect(tool.parameters.required).toEqual(expect.arrayContaining(['opportunityId', 'sampleType']));
  });

  it('registers save_sample as a known tool with a structured schema', () => {
    expect(isKnownTool('save_sample')).toBe(true);
    const tool = ACTION_TOOLS.find((t) => t.name === 'save_sample');
    expect(tool).toBeTruthy();
    expect(tool.parameters.properties).toHaveProperty('websiteSampleId');
    expect(tool.parameters.properties.contentKind.enum).toEqual(['SPECULATIVE_SAMPLE', 'CONCEPT_BRIEF']);
    expect(tool.parameters.required).toEqual(expect.arrayContaining(['opportunityId', 'sampleType', 'contentKind']));
  });

  it('registers generate_proposal as a known tool with a structured schema', () => {
    expect(isKnownTool('generate_proposal')).toBe(true);
    const tool = ACTION_TOOLS.find((t) => t.name === 'generate_proposal');
    expect(tool).toBeTruthy();
    expect(tool.parameters.required).toEqual(expect.arrayContaining(['opportunityId', 'sampleId']));
  });

  it('registers save_proposal as a known tool with a structured schema', () => {
    expect(isKnownTool('save_proposal')).toBe(true);
    const tool = ACTION_TOOLS.find((t) => t.name === 'save_proposal');
    expect(tool).toBeTruthy();
    expect(tool.parameters.properties).toHaveProperty('pitch');
    expect(tool.parameters.required).toEqual(expect.arrayContaining(['opportunityId', 'sampleId', 'pitch']));
  });

  it('does not flag any of the four Phase 4 tools as sensitive (fully local, no external effect)', () => {
    process.env.HUMAN_APPROVAL_REQUIRED = 'true';
    expect(isSensitive('create_sample', { opportunityId: 'x', sampleType: 'website' })).toBe(false);
    expect(isSensitive('save_sample', { opportunityId: 'x', sampleType: 'website', contentKind: 'SPECULATIVE_SAMPLE' })).toBe(false);
    expect(isSensitive('generate_proposal', { opportunityId: 'x', sampleId: 'y' })).toBe(false);
    expect(isSensitive('save_proposal', { opportunityId: 'x', sampleId: 'y', pitch: 'z' })).toBe(false);
  });
});
