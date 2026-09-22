// tests/unit/phase4-control-flow.test.js
// Hardening: Phase 3 goals may complete after save_opportunity;
// Phase 4 goals (sample + proposal) must NOT task_complete immediately after save_opportunity.

import { describe, it, expect } from 'vitest';
import {
  goalRequiresProspectAndOpportunity,
  goalRequiresPhase4SampleAndProposal,
  applyPhase3ControlFlow,
} from '../../agent/index.js';

const PHASE3_GOAL =
  'Find a prospect. Analyze and save the prospect. Analyze and save the opportunity.';

const PHASE4_GOAL =
  'Find a prospect, save prospect, analyze opportunity, save opportunity, create sample, save sample, generate proposal, save proposal, await approval.';

describe('goalRequiresPhase4SampleAndProposal', () => {
  it('is true when goal mentions sample and proposal', () => {
    expect(goalRequiresPhase4SampleAndProposal(PHASE4_GOAL)).toBe(true);
  });

  it('is false for prospect+opportunity only goals', () => {
    expect(goalRequiresPhase4SampleAndProposal(PHASE3_GOAL)).toBe(false);
    expect(goalRequiresPhase4SampleAndProposal('Save a prospect and opportunity')).toBe(false);
  });
});

describe('Phase 3 vs Phase 4 completion boundary', () => {
  const historyThroughSaveOpportunity = [
    { tool: 'save_prospect', status: 'success', observation: { prospectId: 'p1' } },
    {
      tool: 'analyze_opportunity',
      status: 'success',
      observation: { prospectId: 'p1', score: 60, priority: 'MEDIUM' },
    },
    {
      tool: 'save_opportunity',
      status: 'success',
      observation: { success: true, opportunityId: 'o1' },
    },
  ];

  it('Phase 3 goal: after save_opportunity, forces task_complete', () => {
    expect(goalRequiresProspectAndOpportunity(PHASE3_GOAL)).toBe(true);
    const next = {
      action: { tool: 'browser_navigate', args: { url: 'https://example.com' } },
      done: false,
    };
    const out = applyPhase3ControlFlow(PHASE3_GOAL, historyThroughSaveOpportunity, next);
    expect(out).not.toBeNull();
    expect(out.action.tool).toBe('task_complete');
    expect(out.done).toBe(true);
  });

  it('Phase 4 goal: after save_opportunity, does NOT force task_complete', () => {
    expect(goalRequiresProspectAndOpportunity(PHASE4_GOAL)).toBe(true);
    expect(goalRequiresPhase4SampleAndProposal(PHASE4_GOAL)).toBe(true);
    const next = {
      action: { tool: 'create_sample', args: { opportunityId: 'o1', sampleType: 'website' } },
      done: false,
    };
    const out = applyPhase3ControlFlow(PHASE4_GOAL, historyThroughSaveOpportunity, next);
    // Control flow must not override — agent continues Phase 4 tools.
    expect(out).toBeNull();
  });

  it('Phase 4 goal: browsing after save_opportunity is not forced to task_complete', () => {
    const next = {
      action: { tool: 'browser_navigate', args: { url: 'https://example.com' } },
      done: false,
    };
    const out = applyPhase3ControlFlow(PHASE4_GOAL, historyThroughSaveOpportunity, next);
    expect(out).toBeNull();
  });

  it('Phase 4 path remains open through sample and proposal tools (no early complete)', () => {
    const tools = [
      'create_sample',
      'save_sample',
      'generate_proposal',
      'save_proposal',
      'request_human_approval',
    ];
    for (const tool of tools) {
      const next = { action: { tool, args: { opportunityId: 'o1' } }, done: false };
      const out = applyPhase3ControlFlow(PHASE4_GOAL, historyThroughSaveOpportunity, next);
      expect(out).toBeNull();
    }
  });
  it('Phase 4 goal: after save_sample, forces proposal generation before completion', () => {
    const history = [
      { tool: 'save_prospect', status: 'success', observation: { prospectId: 'p1' } },
      { tool: 'analyze_opportunity', status: 'success', observation: { prospectId: 'p1', score: 70 } },
      { tool: 'save_opportunity', status: 'success', observation: { success: true, opportunityId: 'o1' } },
      { tool: 'save_sample', status: 'success', observation: { success: true, sampleId: 's1' } },
    ];
    const out = applyPhase3ControlFlow(PHASE4_GOAL, history, {
      action: { tool: 'task_complete', args: { result: 'Created sample and proposal.' } },
      done: true,
    });
    expect(out?.action?.tool).toBe('generate_proposal');
    expect(out?.action?.args).toEqual({ opportunityId: 'o1', sampleId: 's1' });
    expect(out?.done).toBe(false);
  });

  it('Phase 4 goal: after generate_proposal, forces save_proposal before completion', () => {
    const history = [
      { tool: 'save_prospect', status: 'success', observation: { prospectId: 'p1' } },
      { tool: 'analyze_opportunity', status: 'success', observation: { prospectId: 'p1', score: 70 } },
      { tool: 'save_opportunity', status: 'success', observation: { success: true, opportunityId: 'o1' } },
      { tool: 'save_sample', status: 'success', observation: { success: true, sampleId: 's1' } },
      {
        tool: 'generate_proposal',
        status: 'success',
        observation: {
          opportunityId: 'o1',
          sampleId: 's1',
          status: 'DRAFT',
          pitch: 'pitch',
          serviceRecommendation: 'service',
          valueProposition: 'value',
          suggestedPackage: 'package',
          callToAction: 'cta',
          assumptions: ['assumption'],
        },
      },
    ];
    const out = applyPhase3ControlFlow(PHASE4_GOAL, history, {
      action: { tool: 'task_complete', args: { result: 'Proposal created.' } },
      done: true,
    });
    expect(out?.action?.tool).toBe('save_proposal');
    expect(out?.action?.args).toEqual({
      opportunityId: 'o1',
      sampleId: 's1',
      pitch: 'pitch',
      serviceRecommendation: 'service',
      valueProposition: 'value',
      suggestedPackage: 'package',
      callToAction: 'cta',
      assumptions: ['assumption'],
    });
    expect(out?.done).toBe(false);
  });

  it('Phase 4 goal: after save_proposal, completion is allowed', () => {
    const history = [
      { tool: 'save_opportunity', status: 'success', observation: { opportunityId: 'o1' } },
      { tool: 'save_sample', status: 'success', observation: { sampleId: 's1' } },
      { tool: 'generate_proposal', status: 'success', observation: { opportunityId: 'o1', sampleId: 's1' } },
      { tool: 'save_proposal', status: 'success', observation: { success: true, proposalId: 'pr1', status: 'AWAITING_APPROVAL' } },
    ];
    const out = applyPhase3ControlFlow(PHASE4_GOAL, history, {
      action: { tool: 'task_complete', args: { result: 'Completed.' } },
      done: true,
    });
    expect(out).toBeNull();
  });

});
