// tests/unit/phase3-control-flow.test.js
// Phase 3 milestone control-flow: after save_prospect, opportunity path is required.

import { describe, it, expect } from 'vitest';
import {
  goalRequiresProspectAndOpportunity,
  findLastSuccessfulStep,
  applyPhase3ControlFlow,
} from '../../agent/index.js';

describe('goalRequiresProspectAndOpportunity', () => {
  it('is true for the Phase 3 E2E goal wording', () => {
    const goal = `Find one legitimate real-estate business.\nAnalyze the business as a prospect.\nSave the prospect.\nAnalyze a potential business opportunity.\nSave the opportunity.`;
    expect(goalRequiresProspectAndOpportunity(goal)).toBe(true);
  });

  it('is false when opportunity is not required', () => {
    expect(goalRequiresProspectAndOpportunity('Just browse example.com')).toBe(false);
    expect(goalRequiresProspectAndOpportunity('Save a prospect only')).toBe(false);
  });
});

describe('applyPhase3ControlFlow', () => {
  const goal = 'Analyze prospect, save prospect, analyze opportunity, save opportunity.';

  it('A: after save_prospect succeeds, forces analyze_opportunity (blocks navigate)', () => {
    const history = [
      {
        tool: 'save_prospect',
        status: 'success',
        action: { tool: 'save_prospect', args: { businessName: 'Acme' } },
        observation: { success: true, prospectId: 'p123', status: 'NEW' },
      },
    ];
    const next = {
      action: { tool: 'browser_navigate', args: { url: 'https://duckduckgo.com/?q=more' } },
      done: false,
    };
    const out = applyPhase3ControlFlow(goal, history, next);
    expect(out).not.toBeNull();
    expect(out.action.tool).toBe('analyze_opportunity');
    expect(out.action.args.prospectId).toBe('p123');
    expect(out.done).toBe(false);
  });

  it('E: does not override when tool is already analyze_opportunity', () => {
    const history = [
      {
        tool: 'save_prospect',
        status: 'success',
        observation: { prospectId: 'p123' },
      },
    ];
    const next = {
      action: { tool: 'analyze_opportunity', args: { prospectId: 'p123' } },
      done: false,
    };
    expect(applyPhase3ControlFlow(goal, history, next)).toBeNull();
  });

  it('B: after analyze_opportunity, forces save_opportunity with analysis fields', () => {
    const history = [
      {
        tool: 'save_prospect',
        status: 'success',
        observation: { prospectId: 'p123' },
      },
      {
        tool: 'analyze_opportunity',
        status: 'success',
        observation: {
          prospectId: 'p123',
          score: 72,
          priority: 'HIGH',
          summary: 'Needs better web presence',
          recommendedServices: ['website'],
        },
      },
    ];
    const next = {
      action: { tool: 'browser_navigate', args: { url: 'https://example.com' } },
      done: false,
    };
    const out = applyPhase3ControlFlow(goal, history, next);
    expect(out.action.tool).toBe('save_opportunity');
    expect(out.action.args.prospectId).toBe('p123');
    expect(out.action.args.score).toBe(72);
    expect(out.action.args.priority).toBe('HIGH');
    expect(out.done).toBe(false);
  });

  it('B: after save_opportunity, forces task_complete', () => {
    const history = [
      { tool: 'save_prospect', status: 'success', observation: { prospectId: 'p123' } },
      { tool: 'analyze_opportunity', status: 'success', observation: { prospectId: 'p123', score: 50 } },
      {
        tool: 'save_opportunity',
        status: 'success',
        observation: { success: true, opportunityId: 'o1' },
      },
    ];
    const next = {
      action: { tool: 'browser_navigate', args: { url: 'https://example.com' } },
      done: false,
    };
    const out = applyPhase3ControlFlow(goal, history, next);
    expect(out.action.tool).toBe('task_complete');
    expect(out.done).toBe(true);
    expect(out.action.args.result).toMatch(/opportunity saved/i);
  });

  it('C: does not force task_complete if save_opportunity only failed', () => {
    const history = [
      { tool: 'save_prospect', status: 'success', observation: { prospectId: 'p123' } },
      {
        tool: 'analyze_opportunity',
        status: 'success',
        observation: { prospectId: 'p123', score: 50 },
      },
      {
        tool: 'save_opportunity',
        status: 'failed',
        errorMessage: 'Prospect not found',
      },
    ];
    const next = {
      action: { tool: 'browser_navigate', args: { url: 'https://example.com' } },
      done: false,
    };
    const out = applyPhase3ControlFlow(goal, history, next);
    expect(out.action.tool).toBe('save_opportunity');
    expect(out.done).toBe(false);
  });

  it('does nothing when goal does not require opportunity', () => {
    const history = [
      { tool: 'save_prospect', status: 'success', observation: { prospectId: 'p1' } },
    ];
    const next = {
      action: { tool: 'browser_navigate', args: { url: 'https://example.com' } },
      done: false,
    };
    expect(applyPhase3ControlFlow('Only find a prospect', history, next)).toBeNull();
  });

  it('findLastSuccessfulStep skips failures', () => {
    const steps = [
      { tool: 'save_opportunity', status: 'failed' },
      { tool: 'save_opportunity', status: 'success', observation: { opportunityId: 'x' } },
    ];
    expect(findLastSuccessfulStep(steps, 'save_opportunity').observation.opportunityId).toBe('x');
  });
});
