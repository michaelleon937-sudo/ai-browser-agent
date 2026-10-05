// orchestration/supervisor.js
// Thin production supervisor: classifies, plans, selects capabilities,
// executes via existing modules, applies bounded repair, gates approval,
// prepares delivery, updates memory signals, recommends next action.
// Does NOT send outbound or process payments.

import { nanoid } from 'nanoid';
import { classifyInboundMessage } from '../integrations/message-classification.js';
import { recommendNextAction } from '../integrations/next-action.js';
import { CAPABILITIES, selectCapabilities, describeCapability } from './capabilities.js';
import {
  LIFECYCLE_STATES,
  advanceLifecycle,
  defaultPathForService,
  canTransition,
} from './lifecycle.js';
import {
  defaultMaxAttempts as repairMaxAttempts,
  REPAIR_STATES,
  getOrCreateSession as createRepairSession,
  canRetry as repairCanRetry,
  incrementAttempt,
  setState as setRepairState,
} from '../control/repair.js';

export const SUPERVISOR_STATES = Object.freeze({
  RECEIVED: 'RECEIVED',
  CLASSIFIED: 'CLASSIFIED',
  PLANNED: 'PLANNED',
  EXECUTING: 'EXECUTING',
  QA: 'QA',
  REPAIRING: 'REPAIRING',
  AWAITING_APPROVAL: 'AWAITING_APPROVAL',
  DELIVERY_PREPARED: 'DELIVERY_PREPARED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  STOPPED: 'STOPPED',
});

const MAX_REPAIR = () => Math.min(3, repairMaxAttempts());

function auditPush(trail, event, detail = {}) {
  trail.push({
    event,
    at: new Date().toISOString(),
    ...detail,
  });
}

/**
 * Build an execution plan from classification + capability selection.
 */
export function createExecutionPlan({ classification, extracted, goal } = {}) {
  const capabilities = selectCapabilities({
    classification: classification?.classification,
    requestedService: extracted?.requestedService || classification?.extracted?.requestedService,
    goal,
  });
  const service = extracted?.requestedService || classification?.extracted?.requestedService || goal || '';
  const lifecyclePath = defaultPathForService(service);
  const steps = capabilities.map((cap) => ({
    capability: cap,
    description: describeCapability(cap),
    status: 'pending',
  }));
  return {
    planId: nanoid(10),
    capabilities,
    steps,
    lifecyclePath,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Execute one capability step using real modules where available.
 * External network/credentials are mocked only when the caller injects executors.
 */
export async function executeCapabilityStep(step, context, executors = {}) {
  const name = step.capability;
  if (typeof executors[name] === 'function') {
    return executors[name](context);
  }

  // Default internal executors (no external side effects)
  if (name === CAPABILITIES.CRM) {
    return {
      ok: true,
      capability: name,
      classification: context.classification,
      extracted: context.extracted,
    };
  }
  if (name === CAPABILITIES.SALES) {
    return {
      ok: true,
      capability: name,
      opportunityDraft: {
        service: context.extracted?.requestedService || null,
        budget: context.extracted?.budget || null,
        urgency: context.extracted?.urgency || null,
      },
    };
  }
  if (name === CAPABILITIES.CREATIVE) {
    const { createCreativeProject, validateCreativeProject } = await import('../creative-engine/index.js');
    const project = createCreativeProject({
      type: 'graphic',
      description: context.goal || context.extracted?.requestedService || 'brand creative',
      brand: context.extracted?.brandOrBusinessName || undefined,
    });
    const validation = validateCreativeProject(project);
    return { ok: validation.passed !== false, capability: name, project, validation };
  }
  if (name === CAPABILITIES.WEBSITE) {
    const { createWebsiteProject } = await import('../website-engine/production.js');
    const project = createWebsiteProject({
      name: context.extracted?.brandOrBusinessName || 'Client Project',
      industry: context.extracted?.industry || 'professional',
      description: context.goal || context.body || 'Professional website',
      services: context.extracted?.requestedDeliverables || [],
    });
    return { ok: true, capability: name, project };
  }
  if (name === CAPABILITIES.QA) {
    if (context.websiteProject) {
      const { runProductionQa } = await import('../website-engine/production.js');
      const qa = runProductionQa(context.websiteProject);
      return { ok: qa.passed, capability: name, qa };
    }
    if (context.creativeProject) {
      return { ok: true, capability: name, qa: { passed: true, note: 'creative plan validated upstream' } };
    }
    return { ok: true, capability: name, qa: { passed: true, note: 'no asset under QA' } };
  }
  if (name === CAPABILITIES.DELIVERY) {
    return {
      ok: true,
      capability: name,
      deliveryPrepared: true,
      requiresHumanApproval: true,
      sent: false,
    };
  }
  if (name === CAPABILITIES.RELATIONSHIP) {
    return { ok: true, capability: name, followUpSuggested: true };
  }
  if (name === CAPABILITIES.RESEARCH || name === CAPABILITIES.BROWSER) {
    return { ok: true, capability: name, deferred: true, note: 'requires external tool invocation via control layer' };
  }
  return { ok: true, capability: name, note: 'no-op' };
}

/**
 * Bounded repair for website projects (uses engine selfRepair, capped at MAX_REPAIR).
 */
export async function boundedRepair({ websiteProject, maxAttempts } = {}) {
  const limit = Math.min(Number(maxAttempts) || MAX_REPAIR(), MAX_REPAIR());
  if (!websiteProject) {
    return { ok: false, repaired: false, attempts: 0, stopped: true, reason: 'no project' };
  }
  const { selfRepair, runProductionQa } = await import('../website-engine/production.js');
  const result = selfRepair(websiteProject, limit);
  const attempts = result.repairs?.length || 0;
  if (result.qa?.passed) {
    return { ok: true, repaired: attempts > 0, attempts, project: result.project, qa: result.qa, stopped: false };
  }
  if (attempts >= limit) {
    return {
      ok: false,
      repaired: attempts > 0,
      attempts,
      project: result.project,
      qa: result.qa,
      stopped: true,
      reason: 'max repair attempts exceeded',
      escalate: true,
    };
  }
  return { ok: false, repaired: attempts > 0, attempts, project: result.project, qa: result.qa, stopped: false };
}

/**
 * Full autonomous business journey for an inbound request.
 * @param {object} input - { subject, body, goal, approved }
 * @param {object} options - { executors, maxRepairAttempts, autoApprove }
 */
export async function runAutonomousJourney(input = {}, options = {}) {
  const audit = [];
  const journeyId = nanoid(12);
  let state = SUPERVISOR_STATES.RECEIVED;
  auditPush(audit, 'journey.received', { journeyId });

  const subject = input.subject || '';
  const body = input.body || input.goal || '';
  const classification = classifyInboundMessage({ subject, body });
  state = SUPERVISOR_STATES.CLASSIFIED;
  auditPush(audit, 'journey.classified', {
    classification: classification.classification,
    confidence: classification.confidence,
  });

  const extracted = classification.extracted || {};
  const plan = createExecutionPlan({
    classification,
    extracted,
    goal: input.goal || body,
  });
  state = SUPERVISOR_STATES.PLANNED;
  auditPush(audit, 'journey.planned', {
    planId: plan.planId,
    capabilities: plan.capabilities,
    lifecyclePath: plan.lifecyclePath,
  });

  const context = {
    journeyId,
    classification,
    extracted,
    goal: input.goal || body,
    body,
    subject,
    websiteProject: null,
    creativeProject: null,
  };

  const stepResults = [];
  state = SUPERVISOR_STATES.EXECUTING;
  for (const step of plan.steps) {
    const result = await executeCapabilityStep(step, context, options.executors || {});
    step.status = result.ok ? 'success' : 'failed';
    stepResults.push({ ...step, result });
    auditPush(audit, 'capability.executed', {
      capability: step.capability,
      ok: result.ok,
    });
    if (result.project && step.capability === CAPABILITIES.WEBSITE) {
      context.websiteProject = result.project;
    }
    if (result.project && step.capability === CAPABILITIES.CREATIVE) {
      context.creativeProject = result.project;
    }
  }

  // QA phase
  state = SUPERVISOR_STATES.QA;
  let qaResult = stepResults.find((s) => s.capability === CAPABILITIES.QA)?.result;
  if (!qaResult && context.websiteProject) {
    qaResult = await executeCapabilityStep({ capability: CAPABILITIES.QA }, context, options.executors || {});
  }
  auditPush(audit, 'journey.qa', { passed: qaResult?.ok ?? qaResult?.qa?.passed ?? true });

  // Bounded repair if QA failed on website
  let repairOutcome = null;
  if (context.websiteProject && qaResult && (qaResult.ok === false || qaResult.qa?.passed === false)) {
    state = SUPERVISOR_STATES.REPAIRING;
    repairOutcome = await boundedRepair({
      websiteProject: context.websiteProject,
      maxAttempts: options.maxRepairAttempts || MAX_REPAIR(),
    });
    context.websiteProject = repairOutcome.project || context.websiteProject;
    auditPush(audit, 'journey.repair', {
      attempts: repairOutcome.attempts,
      stopped: repairOutcome.stopped,
      escalate: repairOutcome.escalate || false,
    });
    if (repairOutcome.stopped && !repairOutcome.ok) {
      state = SUPERVISOR_STATES.STOPPED;
      const nextAction = recommendNextAction({
        classification: classification.classification,
        requestedService: extracted.requestedService,
        unresolvedQuestions: extracted.explicitQuestions || [],
      });
      return {
        ok: false,
        journeyId,
        state,
        classification,
        plan,
        stepResults,
        repair: repairOutcome,
        requiresHumanApproval: true,
        nextAction,
        lifecycle: { current: LIFECYCLE_STATES.REVISION, path: plan.lifecyclePath },
        audit,
        memoryUpdate: {
          key: 'last_journey',
          value: { journeyId, state, classification: classification.classification },
          confidence: 'CONFIRMED_BY_SYSTEM',
        },
      };
    }
  }

  // Approval gate — never auto-send
  const approved = Boolean(input.approved || options.autoApprove);
  if (!approved) {
    state = SUPERVISOR_STATES.AWAITING_APPROVAL;
    auditPush(audit, 'journey.awaiting_approval');
  } else {
    state = SUPERVISOR_STATES.DELIVERY_PREPARED;
    auditPush(audit, 'journey.delivery_prepared', { sent: false });
  }

  // Lifecycle progress (in-memory trail)
  let lifecycleState = LIFECYCLE_STATES.LEAD;
  const lifecycleTrail = [];
  for (const next of plan.lifecyclePath.slice(1)) {
    if (canTransition(lifecycleState, next)) {
      lifecycleTrail.push(advanceLifecycle(lifecycleState, next));
      lifecycleState = next;
    }
    if (!approved && next === LIFECYCLE_STATES.DELIVERY) break;
  }

  const nextAction = recommendNextAction({
    classification: classification.classification,
    intent: classification.intent,
    requestedService: extracted.requestedService,
    unresolvedQuestions: extracted.explicitQuestions || [],
    messageCount: 1,
  });

  if (approved) state = SUPERVISOR_STATES.COMPLETED;
  else if (state !== SUPERVISOR_STATES.STOPPED) state = SUPERVISOR_STATES.AWAITING_APPROVAL;

  auditPush(audit, 'journey.finished', { state });

  return {
    ok: true,
    journeyId,
    state,
    classification,
    plan,
    stepResults,
    repair: repairOutcome,
    requiresHumanApproval: !approved,
    deliveryPrepared: approved,
    sent: false,
    nextAction,
    lifecycle: { current: lifecycleState, trail: lifecycleTrail, path: plan.lifecyclePath },
    audit,
    memoryUpdate: {
      key: 'last_journey',
      value: {
        journeyId,
        state,
        classification: classification.classification,
        capabilities: plan.capabilities,
      },
      confidence: 'CONFIRMED_BY_SYSTEM',
    },
  };
}

/** Command-center style status from existing BI/CRM signals (pass-through helpers). */
export function commandCenterQuestions() {
  return [
    'What leads need attention?',
    'What opportunities are hot?',
    'What follow-ups are due?',
    'What projects are active?',
    'What projects are waiting for approval?',
    'What deliverables are ready?',
    'What failed?',
    'What requires human intervention?',
    'What should the agent do next?',
  ];
}

export { CAPABILITIES, LIFECYCLE_STATES, MAX_REPAIR, REPAIR_STATES, createRepairSession, repairCanRetry, incrementAttempt, setRepairState };
