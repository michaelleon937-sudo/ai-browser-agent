import { describe, it, expect } from 'vitest';
import {
  selectCapabilities,
  CAPABILITIES,
  describeCapability,
} from '../../orchestration/capabilities.js';
import {
  LIFECYCLE_STATES,
  canTransition,
  assertTransition,
  advanceLifecycle,
  defaultPathForService,
} from '../../orchestration/lifecycle.js';
import {
  createExecutionPlan,
  runAutonomousJourney,
  boundedRepair,
  commandCenterQuestions,
  SUPERVISOR_STATES,
  MAX_REPAIR,
} from '../../orchestration/supervisor.js';
import { classifyInboundMessage } from '../../integrations/message-classification.js';

describe('capability model', () => {
  it('selects website + sales for service website request', () => {
    const caps = selectCapabilities({
      classification: 'REQUEST_FOR_SERVICE',
      requestedService: 'website redesign',
    });
    expect(caps).toContain(CAPABILITIES.CRM);
    expect(caps).toContain(CAPABILITIES.WEBSITE);
    expect(caps).toContain(CAPABILITIES.SALES);
    expect(caps).toContain(CAPABILITIES.QA);
    expect(caps).toContain(CAPABILITIES.DELIVERY);
  });

  it('selects creative for branding work', () => {
    const caps = selectCapabilities({
      classification: 'REQUEST_FOR_SERVICE',
      requestedService: 'logo and social media posts',
    });
    expect(caps).toContain(CAPABILITIES.CREATIVE);
  });

  it('describes capabilities without side effects by default', () => {
    const d = describeCapability(CAPABILITIES.DELIVERY);
    expect(d.module).toMatch(/client-delivery/);
    expect(String(d.sideEffects)).toMatch(/none|false/i);
  });
});

describe('lifecycle state machine', () => {
  it('allows lead -> client and rejects completion -> lead', () => {
    expect(canTransition(LIFECYCLE_STATES.LEAD, LIFECYCLE_STATES.CLIENT)).toBe(true);
    expect(canTransition(LIFECYCLE_STATES.COMPLETION, LIFECYCLE_STATES.LEAD)).toBe(false);
  });

  it('assertTransition throws on invalid path', () => {
    expect(() => assertTransition(LIFECYCLE_STATES.APPROVAL, LIFECYCLE_STATES.LEAD)).toThrow(/Invalid lifecycle/);
  });

  it('advanceLifecycle records trail', () => {
    const step = advanceLifecycle(LIFECYCLE_STATES.LEAD, LIFECYCLE_STATES.BRIEF);
    expect(step.from).toBe(LIFECYCLE_STATES.LEAD);
    expect(step.to).toBe(LIFECYCLE_STATES.BRIEF);
    expect(step.at).toBeTruthy();
  });

  it('defaultPathForService includes approval and delivery for websites', () => {
    const path = defaultPathForService('website');
    expect(path).toContain(LIFECYCLE_STATES.APPROVAL);
    expect(path).toContain(LIFECYCLE_STATES.DELIVERY);
    expect(path).toContain(LIFECYCLE_STATES.COMPLETION);
  });
});

describe('supervisor planning', () => {
  it('createExecutionPlan builds capabilities and lifecycle path', () => {
    const classification = classifyInboundMessage({
      subject: 'Need a website',
      body: 'Can you build a website for our clothing brand next week?',
    });
    const plan = createExecutionPlan({
      classification,
      extracted: classification.extracted,
      goal: classification.extracted.requestedService,
    });
    expect(plan.planId).toBeTruthy();
    expect(plan.capabilities.length).toBeGreaterThan(2);
    expect(plan.lifecyclePath[0]).toBe(LIFECYCLE_STATES.LEAD);
  });
});

describe('autonomous business journey integration', () => {
  it('runs classify → plan → execute → QA → approval gate → next action without sending', async () => {
    const result = await runAutonomousJourney({
      subject: 'Website project',
      body: 'We need a website redesign for our fashion brand. Budget around 2000. Can you build it?',
      goal: 'website redesign',
      approved: false,
    });

    expect(result.ok).toBe(true);
    expect(result.journeyId).toBeTruthy();
    expect(result.classification.classification).toMatch(/REQUEST_FOR_SERVICE|REQUEST_FOR_QUOTE|INTERESTED|GENERAL/);
    expect(result.plan.capabilities).toContain(CAPABILITIES.CRM);
    expect(result.stepResults.length).toBeGreaterThan(0);
    expect(result.sent).toBe(false);
    expect(result.requiresHumanApproval).toBe(true);
    expect(result.state).toBe(SUPERVISOR_STATES.AWAITING_APPROVAL);
    expect(result.nextAction).toBeTruthy();
    expect(result.nextAction.action).toBeTruthy();
    expect(result.memoryUpdate.key).toBe('last_journey');
    expect(result.audit.some((a) => a.event === 'journey.classified')).toBe(true);
    expect(result.audit.some((a) => a.event === 'journey.planned')).toBe(true);
  });

  it('with approved=true prepares delivery but never sets sent=true', async () => {
    const result = await runAutonomousJourney({
      body: 'Please design 10 social media posts for our brand',
      goal: 'social media design',
      approved: true,
    });
    expect(result.sent).toBe(false);
    expect(result.deliveryPrepared).toBe(true);
    expect(result.state).toBe(SUPERVISOR_STATES.COMPLETED);
  });

  it('accepts injected executors for external tools', async () => {
    let called = false;
    const result = await runAutonomousJourney(
      { body: 'research competitors for our brand', goal: 'research competitors' },
      {
        executors: {
          [CAPABILITIES.RESEARCH]: async () => {
            called = true;
            return { ok: true, capability: CAPABILITIES.RESEARCH, findings: ['mock'] };
          },
        },
      },
    );
    expect(result.ok).toBe(true);
    if (result.plan.capabilities.includes(CAPABILITIES.RESEARCH)) {
      expect(called).toBe(true);
    }
  });
});

describe('bounded self-repair', () => {
  it('MAX_REPAIR is at most 3', () => {
    expect(MAX_REPAIR()).toBeLessThanOrEqual(3);
  });

  it('boundedRepair stops and escalates after max attempts when QA cannot pass', async () => {
    // Force failing QA via executor-style path: empty project yields stopped
    const outcome = await boundedRepair({ websiteProject: null, maxAttempts: 3 });
    expect(outcome.stopped).toBe(true);
    expect(outcome.attempts).toBe(0);
  });

  it('website selfRepair respects numeric maxRepairs cap via boundedRepair', async () => {
    const { createWebsiteProject } = await import('../../website-engine/production.js');
    const project = createWebsiteProject({
      name: 'Repair Test Co',
      industry: 'professional',
      description: 'Test site for bounded repair',
    });
    const outcome = await boundedRepair({ websiteProject: project, maxAttempts: 3 });
    expect(outcome.attempts).toBeLessThanOrEqual(3);
    if (!outcome.ok) {
      expect(outcome.stopped || outcome.escalate).toBeTruthy();
    }
  });
});

describe('business OS readiness', () => {
  it('exposes command-center question catalog', () => {
    const qs = commandCenterQuestions();
    expect(qs).toEqual(expect.arrayContaining([
      'What leads need attention?',
      'What opportunities are hot?',
      'What follow-ups are due?',
      'What projects are waiting for approval?',
      'What should the agent do next?',
    ]));
  });
});
