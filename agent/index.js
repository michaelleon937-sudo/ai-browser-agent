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
    // When a stale selector/ref fails, we capture a fresh snapshot here so the
    // next plan sees current DOM refs instead of blindly retrying the old target.
    pendingObservation: null,
  };

  event({ type: 'run_start', runId: run.id, taskId: task?.id, goal });

  try {
    while (true) {
      const elapsed = Date.now() - startedAt;
      if (elapsed > config.agent.totalTimeoutMs) throw new Error(`Total timeout exceeded (${config.agent.totalTimeoutMs} ms)}`);
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
