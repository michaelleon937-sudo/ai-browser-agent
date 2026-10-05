// control/tools/supervisor.js
// Control API surface for the autonomous supervisor.

import {
  runAutonomousJourney,
  createExecutionPlan,
  commandCenterQuestions,
  CAPABILITIES,
  LIFECYCLE_STATES,
} from '../../orchestration/supervisor.js';
import { selectCapabilities } from '../../orchestration/capabilities.js';
import { classifyInboundMessage } from '../../integrations/message-classification.js';

export const supervisorTools = {
  async 'supervisor.classify'(args = {}) {
    const result = classifyInboundMessage({
      subject: args.subject || '',
      body: args.body || args.text || '',
    });
    return { ok: true, ...result };
  },
  async 'supervisor.plan'(args = {}) {
    const classification = args.classification
      ? { classification: args.classification, extracted: args.extracted || {} }
      : classifyInboundMessage({ subject: args.subject || '', body: args.body || args.goal || '' });
    const plan = createExecutionPlan({
      classification,
      extracted: classification.extracted,
      goal: args.goal || args.body,
    });
    return { ok: true, plan, capabilities: plan.capabilities };
  },
  async 'supervisor.run_journey'(args = {}) {
    // Never auto-approve external send from control unless explicit approved=true
    const result = await runAutonomousJourney(
      {
        subject: args.subject,
        body: args.body || args.goal,
        goal: args.goal,
        approved: Boolean(args.approved),
      },
      { maxRepairAttempts: args.maxRepairAttempts },
    );
    return { ok: result.ok, ...result, externalSideEffect: false };
  },
  async 'supervisor.capabilities'(args = {}) {
    return {
      ok: true,
      capabilities: Object.values(CAPABILITIES),
      selected: selectCapabilities({
        classification: args.classification,
        requestedService: args.requestedService,
        goal: args.goal,
      }),
      lifecycleStates: Object.values(LIFECYCLE_STATES),
      commandCenter: commandCenterQuestions(),
    };
  },
};
