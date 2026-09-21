// agent/index.js
// Autonomous execution engine. Phase 3 control-flow + retry/loop protection.
// Full implementation restored after accidental empty push.

import browser from '../browser/index.js';
import { tasks, runs, steps, errors as dbErrors, websiteSamples, prospects, opportunities, samples, proposals } from '../database/index.js';
import { config, redact } from '../config/index.js';
import { getProvider, isKnownTool, ACTION_TOOLS, isSensitive } from './ai/index.js';
import { notify } from '../notifications/index.js';
import { enqueueApproval, awaitApproval } from './approval.js';
import { generateWebsite } from '../integrations/website-gen.js';
import { analyzeProspectPage } from '../integrations/prospecting.js';
import { analyzeOpportunity } from '../integrations/opportunity-intelligence.js';
import { createSample } from '../integrations/sample-generation.js';
import { generateProposal } from '../integrations/proposal-generation.js';
import { webSearch } from '../integrations/web-search.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runAgent({ taskId, goal: providedGoal, onEvent, runId: providedRunId } = {}) {
  const task = taskId ? tasks.get(taskId) : null;
  const goal = providedGoal || task?.goal;
  if (!goal) throw new Error('runAgent requires either taskId or goal');

  let run;
  if (providedRunId) run = runs.get(providedRunId);
  else if (task) run = runs.start({ taskId: task.id });
  else run = runs.start({ taskId: 'ad-hoc' });
  if (!run) throw new Error('Failed to start run');

  if (task) tasks.setStatus(task.id, 'running', { lastRunAt: new Date().toISOString() });

  const event = typeof onEvent === 'function' ? onEvent : () => {};
  const startedAt = Date.now();
  const provider = getProvider();

  const state = {
    runId: run.id, taskId: task?.id, goal, steps: [], observations: [],
    retriesTotal: 0, finished: false, finalStatus: null, finalResult: null, finalError: null,
    pendingObservation: null,
    blockedSearchHosts: new Set(),
  };

  event({ type: 'run_start', runId: run.id, taskId: task?.id, goal });

  try {
    while (true) {
      const elapsed = Date.now() - startedAt;
      if (elapsed > config.agent.totalTimeoutMs) throw new Error(`Total timeout exceeded (${config.agent.totalTimeoutMs} ms)`);
      if (state.steps.length >= config.agent.maxSteps) throw new Error(`Max steps exceeded (${config.agent.maxSteps})`);
      if (state.retriesTotal >= config.agent.maxRetriesTotal) throw new Error(`Total retries exceeded (${config.agent.maxRetriesTotal})`);

      let observation;
      if (state.pendingObservation) {
        observation = state.pendingObservation;
        state.pendingObservation = null;
      } else {
        try { observation = await observeLight(); }
        catch (err) { observation = { url: '', title: '', note: 'no browser context yet' }; }
      }

      let next;
      try {
        next = await provider.nextAction({
          goal, history: { steps: state.steps }, observation, availableTools: ACTION_TOOLS,
        });
      } catch (err) {
        dbErrors.record({ runId: run.id, level: 'error', message: `AI provider failed: ${err.message}`, stack: err.stack });
        state.steps.push({ tool: '(provider_error)', action: { tool: '(provider_error)', args: {} }, status: 'failed', errorMessage: err.message });
        state.retriesTotal++;
        const recentProviderFails = state.steps.slice(-4).filter((s) => s.tool === '(provider_error)' && s.status === 'failed').length;
        if (recentProviderFails >= 3) throw new Error(`AI provider failed repeatedly: ${err.message}`);
        continue;
      }

      let { action, done } = next || {};
      if (!action || !action.tool) throw new Error('AI provider returned empty action');

      const phase3Override = applyPhase3ControlFlow(goal, state.steps, { action, done });
      if (phase3Override) {
        action = phase3Override.action;
        done = phase3Override.done;
        next = phase3Override;
      }

      if (!isKnownTool(action.tool)) throw new Error(`AI returned unknown tool: ${action.tool}`);

      const searchGuard = applySearchRecoveryGuard(state, action);
      if (searchGuard?.softReject) {
        const stepRow = steps.create({
          runId: run.id, seq: state.steps.length + 1, action,
          reasoning: action.reasoning || 'search recovery soft-reject',
        });
        steps.start(stepRow.id);
        steps.finish(stepRow.id, { status: 'failed', errorMessage: searchGuard.reason });
        state.steps.push({
          tool: action.tool, action, status: 'failed', errorMessage: searchGuard.reason,
        });
        event({ type: 'step_failed', stepId: stepRow.id, error: searchGuard.reason, softReject: true });
        state.pendingObservation = {
          url: '', title: '', note: searchGuard.reason,
          blockedSearchHosts: [...(state.blockedSearchHosts || [])],
        };
        continue;
      }
      if (searchGuard) {
        action = searchGuard.action;
        done = searchGuard.done;
      }

      const stuck = detectStuckLoop(state.steps, action);
      if (stuck) {
        const stepRow = steps.create({ runId: run.id, seq: state.steps.length + 1, action, reasoning: action.reasoning });
        steps.start(stepRow.id);
        steps.finish(stepRow.id, { status: 'failed', errorMessage: stuck.reason });
        state.steps.push({ tool: action.tool, action, status: 'failed', errorMessage: stuck.reason });
        state.finished = true; state.finalStatus = 'failed'; state.finalError = stuck.reason;
        break;
      }

      event({ type: 'step_planned', step: { tool: action.tool, args: action.args, reasoning: action.reasoning } });

      if (action.tool === 'task_complete') {
        const stepRow = steps.create({ runId: run.id, seq: state.steps.length + 1, action, reasoning: action.reasoning });
        steps.start(stepRow.id);
        steps.finish(stepRow.id, { status: 'success', observation: { result: action.args?.result } });
        state.finished = true; state.finalStatus = 'success'; state.finalResult = action.args?.result || null;
        break;
      }
      if (action.tool === 'task_fail') {
        const stepRow = steps.create({ runId: run.id, seq: state.steps.length + 1, action, reasoning: action.reasoning });
        steps.start(stepRow.id);
        steps.finish(stepRow.id, { status: 'failed', errorMessage: action.args?.reason });
        state.finished = true; state.finalStatus = 'failed'; state.finalError = action.args?.reason || 'task failed';
        break;
      }

      if (isSensitive(action.tool, action.args)) {
        const approval = await enqueueApproval({ runId: run.id, tool: action.tool, args: action.args, reasoning: action.reasoning, goal });
        event({ type: 'awaiting_approval', approvalId: approval.id, tool: action.tool });
        runs.finish(run.id, { status: 'awaiting_approval' });
        if (task) tasks.setStatus(task.id, 'awaiting_approval');
        const decision = await awaitApproval(approval.id);
        if (decision !== 'approve') {
          const stepRow = steps.create({ runId: run.id, seq: state.steps.length + 1, action, reasoning: action.reasoning });
          steps.start(stepRow.id);
          steps.finish(stepRow.id, { status: 'failed', errorMessage: `Human denied approval: ${decision}` });
          state.finished = true; state.finalStatus = 'failed'; state.finalError = `Human denied approval: ${decision}`;
          break;
        }
      }

      const stepRow = steps.create({ runId: run.id, seq: state.steps.length + 1, action, reasoning: action.reasoning });
      steps.start(stepRow.id);
      event({ type: 'step_start', stepId: stepRow.id, tool: action.tool });

      const execResult = await executeWithRetry(action, {
        stepId: stepRow.id, stepTimeoutMs: config.agent.stepTimeoutMs,
        maxRetries: config.agent.maxRetriesPerStep, context: { taskId: task?.id, runId: run.id },
      });

      if (execResult.ok) {
        let observation = execResult.observation;
        if (action.tool === 'browser_navigate' && observation) {
          observation = annotateSearchUsability(observation, state);
        }
        steps.finish(stepRow.id, { status: 'success', observation });
        event({ type: 'step_success', stepId: stepRow.id, observation });
        state.steps.push({ tool: action.tool, action, status: 'success', observation });
        if (observation?.url || observation?.title || observation?.elements) {
          state.observations.push(observation);
          if (state.observations.length > 4) state.observations.shift();
        }
        if (action.tool === 'browser_navigate' && observation?.elements) {
          state.pendingObservation = observation;
        }
      } else {
        steps.finish(stepRow.id, { status: 'failed', errorMessage: execResult.error });
        dbErrors.record({ runId: run.id, stepId: stepRow.id, level: 'error', message: execResult.error, context: { tool: action.tool, args: redact(action.args), permanent: !!execResult.permanent, staleTarget: !!execResult.staleTarget } });
        event({ type: 'step_failed', stepId: stepRow.id, error: execResult.error, permanent: !!execResult.permanent, staleTarget: !!execResult.staleTarget });
        state.steps.push({ tool: action.tool, action, status: 'failed', errorMessage: execResult.error, permanent: !!execResult.permanent, staleTarget: !!execResult.staleTarget });
        if (execResult.staleTarget) {
          try {
            const snap = await browser.snapshot({});
            state.pendingObservation = {
              ...snap,
              note: `Previous action failed due to stale/missing target: ${execResult.error}. Use current element refs from this snapshot; do not reuse old refs or selectors from a previous page.`,
            };
          } catch {}
        } else if (!execResult.permanent) {
          state.retriesTotal++;
        }
      }
    }

    if (state.finalStatus === 'success') {
      runs.finish(run.id, { status: 'success', result: { result: state.finalResult } });
      if (task) tasks.setStatus(task.id, 'success', { lastStatus: 'success', lastRunAt: new Date().toISOString() });
      notify({ level: 'info', subject: `Task succeeded: ${task?.name || goal.slice(0, 40)}`, body: state.finalResult || '' });
    } else if (state.finalStatus === 'failed') {
      runs.finish(run.id, { status: 'failed', errorMessage: state.finalError });
      if (task) tasks.setStatus(task.id, 'failed', { lastStatus: 'failed', lastRunAt: new Date().toISOString(), errorMessage: state.finalError });
      notify({ level: 'error', subject: `Task failed: ${task?.name || goal.slice(0, 40)}`, body: state.finalError || '' });
    }
    event({ type: 'run_end', runId: run.id, status: state.finalStatus });
    return { runId: run.id, status: state.finalStatus, result: state.finalResult, error: state.finalError };
  } catch (err) {
    dbErrors.record({ runId: run.id, level: 'fatal', message: err.message, stack: err.stack });
    runs.finish(run.id, { status: 'failed', errorMessage: err.message });
    if (task) tasks.setStatus(task.id, 'failed', { lastStatus: 'failed', lastRunAt: new Date().toISOString(), errorMessage: err.message });
    notify({ level: 'fatal', subject: `Task crashed: ${task?.name || goal.slice(0, 40)}`, body: err.message });
    event({ type: 'run_end', runId: run.id, status: 'failed', error: err.message });
    return { runId: run.id, status: 'failed', error: err.message };
  } finally {
    runs.bumpSteps(run.id, { total: state.steps.length, done: state.steps.length, retries: state.retriesTotal });
  }
}

async function observeLight() {
  try {
    const info = await browser.getPageInfo();
    return { url: info.url, title: info.title, textPreview: (info.visibleText || '').slice(0, 1500) };
  } catch (err) {
    return { url: '', title: '', error: err.message };
  }
}

export function goalRequiresProspectAndOpportunity(goal) {
  const g = String(goal || '').toLowerCase();
  return /\bprospect\b/.test(g) && /\bopportunity\b/.test(g);
}

/** True when the goal explicitly requires sample + proposal (Phase 4), not only prospect + opportunity. */
export function goalRequiresPhase4SampleAndProposal(goal) {
  const g = String(goal || '').toLowerCase();
  return /\bsample\b/.test(g) && /\bproposal\b/.test(g);
}

export function findLastSuccessfulStep(historySteps, tool) {
  if (!Array.isArray(historySteps)) return null;
  for (let i = historySteps.length - 1; i >= 0; i--) {
    const s = historySteps[i];
    if (s && s.tool === tool && s.status === 'success') return s;
  }
  return null;
}

export function applyPhase3ControlFlow(goal, historySteps, next) {
  if (!goalRequiresProspectAndOpportunity(goal)) return null;
  if (!next || !next.action || !next.action.tool) return null;
  const saveProspect = findLastSuccessfulStep(historySteps, 'save_prospect');
  const saveOpportunity = findLastSuccessfulStep(historySteps, 'save_opportunity');
  const analyzeOpportunityStep = findLastSuccessfulStep(historySteps, 'analyze_opportunity');
  const tool = next.action.tool;
  if (saveOpportunity) {
    // Phase 4 goals must continue through sample/proposal; do not force task_complete yet.
    if (goalRequiresPhase4SampleAndProposal(goal)) return null;
    if (tool === 'task_complete' || tool === 'task_fail') return null;
    return {
      action: { tool: 'task_complete', args: { result: 'Prospect and opportunity saved successfully.' }, reasoning: 'Phase 3 control: required prospect + opportunity work is complete.' },
      done: true,
    };
  }
  if (saveProspect) {
    const prospectId = saveProspect.observation?.prospectId || saveProspect.action?.args?.prospectId || null;
    if (!analyzeOpportunityStep) {
      if (tool === 'analyze_opportunity' || tool === 'task_fail') return null;
      if (!prospectId) {
        return {
          action: { tool: 'task_fail', args: { reason: 'save_prospect succeeded but no prospectId was returned; cannot analyze opportunity.' }, reasoning: 'Phase 3 control: missing prospectId after save_prospect.' },
          done: true,
        };
      }
      return {
        action: { tool: 'analyze_opportunity', args: { prospectId }, reasoning: 'Phase 3 control: after save_prospect, analyze_opportunity is required next.' },
        done: false,
      };
    }
    if (tool === 'save_opportunity' || tool === 'task_fail') return null;
    const obs = analyzeOpportunityStep.observation || {};
    return {
      action: {
        tool: 'save_opportunity',
        args: {
          prospectId: obs.prospectId || prospectId,
          score: obs.score, priority: obs.priority, opportunityType: obs.opportunityType,
          summary: obs.summary, identifiedProblems: obs.identifiedProblems,
          recommendedServices: obs.recommendedServices, recommendedActions: obs.recommendedActions,
          recommendedSampleType: obs.recommendedSampleType, recommendedSampleReason: obs.recommendedSampleReason,
          estimatedValue: obs.estimatedValue, confidence: obs.confidence,
        },
        reasoning: 'Phase 3 control: after analyze_opportunity, save_opportunity is required next.',
      },
      done: false,
    };
  }
  return null;
}

export const MAX_BLOCKED_SEARCH_HOSTS = 3;
