import { describe, it, expect } from 'vitest';
import { runAutonomousJourney, SUPERVISOR_STATES } from '../../orchestration/supervisor.js';
import { CAPABILITIES } from '../../orchestration/capabilities.js';
import { LIFECYCLE_STATES } from '../../orchestration/lifecycle.js';
import { invokeControlTool } from '../../control/invoke.js';

describe('integration: full autonomous journey', () => {
  it('module-to-module: classification through delivery prep', async () => {
    const result = await runAutonomousJourney({
      subject: 'New lead',
      body: 'Hi, we need a website and branding for our agro business. Looking for a quote.',
      goal: 'website and branding',
    });

    expect(result.classification).toBeTruthy();
    expect(result.plan.capabilities).toEqual(
      expect.arrayContaining([CAPABILITIES.CRM, CAPABILITIES.QA, CAPABILITIES.DELIVERY]),
    );
    expect(result.stepResults.every((s) => s.status === 'success' || s.status === 'failed')).toBe(true);
    expect(result.lifecycle.path).toContain(LIFECYCLE_STATES.APPROVAL);
    expect(result.sent).toBe(false);
    expect(result.requiresHumanApproval).toBe(true);
    expect(result.audit.length).toBeGreaterThan(3);
  });

  it('control tool supervisor.run_journey is registered and policy-safe', async () => {
    const outcome = await invokeControlTool({
      toolName: 'supervisor.run_journey',
      args: {
        body: 'Can you design a logo for my clothing brand?',
        goal: 'logo design',
      },
      operatorId: 'test-operator',
      idempotencyKey: `orch-journey-${Date.now()}`,
      source: 'test',
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe(200);
  });

  it('supervisor.capabilities returns capability catalog', async () => {
    const outcome = await invokeControlTool({
      toolName: 'supervisor.capabilities',
      args: { classification: 'REQUEST_FOR_SERVICE', requestedService: 'website' },
      operatorId: 'test-operator',
      source: 'test',
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.body.result.capabilities).toContain('website');
    expect(outcome.body.result.commandCenter.length).toBeGreaterThan(5);
  });
});
