// agent/index.js
// Autonomous execution engine. The agent runs a plan → execute → observe →
// verify loop for a single task. It honors budgets (max steps, total time,
// per-step retries), surfaces failures safely (no infinite loops), and pauses
// for human approval on sensitive actions.
//
// Public API:
//   import { runAgent } from './agent/index.js';
//   await runAgent({ taskId, goal, onEvent })


import browser from '../browser/index.js';
import { tasks, runs, steps, errors as dbErrors, kv, sessions, notifications } from '../database/index.js';
import { config, redact } from '../config/index.js';
import { getProvider, isKnownTool, ACTION_TOOLS, isSensitive } from './ai/index.js';
import { notify } from '../notifications/index.js';
import { enqueueApproval, awaitApproval } from './approval.js';


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


export async function runAgent({ taskId, goal: providedGoal, onEvent, runId: providedRunId } = {}) {
  const task = taskId ? tasks.get(taskId) : null;
  const goal = providedGoal || task?.goal;
  if (!goal) throw new Error('runAgent requires either taskId or goal');


  let run;
  if (providedRunId) {
    run = runs.get(providedRunId);
  } else if (task) {
    run = runs.start({ taskId: task.id });
  } else {
    run = runs.start({ taskId: 'ad-hoc' });
  }
  if (!run) throw new Error('Failed to start run');


  if (task) tasks.setStatus(task.id, 'running', { lastRunAt: new Date().toISOString() });


  const event = typeof onEvent === 'function' ? onEvent : () => {};
  const startedAt = Date.now();
  const provider = getProvider();


  const state = {
    runId: run.id,
    taskId: task?.id,
    goal,
    steps: [],          // accumulated step history (for AI prompt)
    observations: [],   // last few page observations
    retriesTotal: 0,
    finished: false,
    finalStatus: null,
    finalResult: null,
    finalError: null,
  };


  event({ type: 'run_start', runId: run.id, taskId: task?.id, goal });


  try {
    while (true) {
      // ── Budget guards ─────────────────────────────────────────
      const elapsed = Date.now() - startedAt;
      if (elapsed > config.agent.totalTimeoutMs) {
        throw new Error(`Total timeout exceeded (${config.agent.totalTimeoutMs} ms)`);
      }
      if (state.steps.length >= config.agent.maxSteps) {
        throw new Error(`Max steps exceeded (${config.agent.maxSteps})`);
      }
      if (state.retriesTotal >= config.agent.maxRetriesTotal) {
        throw new Error(`Total retries exceeded (${config.agent.maxRetriesTotal})`);
      }


      // ── Observe current page (cheap) ───────────────────────────
      let observation;
      try {
        observation = await observeLight();
      } catch (err) {
        // Browser may not be launched yet — that's OK on the first iteration.
        observation = { url: '', title: '', note: 'no browser context yet' };
      }


      // ── Ask the AI ─────────────────────────────────────────────
      let next;
      try {
        next = await provider.nextAction({
          goal,
          history: { steps: state.steps },
          observation,
          availableTools: ACTION_TOOLS,
        });
      } catch (err) {
        const wrapped = new Error(`AI provider failed: ${err.message}`);
        dbErrors.record({ runId: run.id, level: 'error', message: wrapped.message, stack: err.stack });
        throw wrapped;
      }


      const { action, done } = next || {};
      if (!action || !action.tool) {
        throw new Error('AI provider returned empty action');
      }
      if (!isKnownTool(action.tool)) {
        throw new Error(`AI returned unknown tool: ${action.tool}`);
      }


      event({ type: 'step_planned', step: { tool: action.tool, args: action.args, reasoning: action.reasoning } });


      // ── Terminal actions ──────────────────────────────────────
      if (action.tool === 'task_complete') {
        const stepRow = steps.create({ runId: run.id, seq: state.steps.length + 1, action, reasoning: action.reasoning });
        steps.start(stepRow.id);
        steps.finish(stepRow.id, { status: 'success', observation: { result: action.args?.result } });
        state.finished = true;
        state.finalStatus = 'success';
        state.finalResult = action.args?.result || null;
        break;
      }
      if (action.tool === 'task_fail') {
        const stepRow = steps.create({ runId: run.id, seq: state.steps.length + 1, action, reasoning: action.reasoning });
        steps.start(stepRow.id);
        steps.finish(stepRow.id, { status: 'failed', errorMessage: action.args?.reason });
        state.finished = true;
        state.finalStatus = 'failed';
        state.finalError = action.args?.reason || 'task failed';
        break;
      }


      // ── Sensitive-action gate ─────────────────────────────────
      if (isSensitive(action.tool, action.args)) {
        const approval = await enqueueApproval({
          runId: run.id,
          tool: action.tool,
          args: action.args,
          reasoning: action.reasoning,
          goal,
        });
        event({ type: 'awaiting_approval', approvalId: approval.id, tool: action.tool });
        runs.finish(run.id, { status: 'awaiting_approval' });
        if (task) tasks.setStatus(task.id, 'awaiting_approval');
        const decision = await awaitApproval(approval.id);
        if (decision !== 'approve') {
          // User denied — fail safely.
          const stepRow = steps.create({ runId: run.id, seq: state.steps.length + 1, action, reasoning: action.reasoning });
          steps.start(stepRow.id);
          steps.finish(stepRow.id, { status: 'failed', errorMessage: `Human denied approval: ${decision}` });
          state.finished = true;
          state.finalStatus = 'failed';
          state.finalError = `Human denied approval: ${decision}`;
          break;
        }
      }


      // ── Execute with retry ────────────────────────────────────
      const stepRow = steps.create({ runId: run.id, seq: state.steps.length + 1, action, reasoning: action.reasoning });
      steps.start(stepRow.id);
      event({ type: 'step_start', stepId: stepRow.id, tool: action.tool });


      const execResult = await executeWithRetry(action, {
        stepId: stepRow.id,
        stepTimeoutMs: config.agent.stepTimeoutMs,
        maxRetries: config.agent.maxRetriesPerStep,
        onAttempt: (attempt) => { state.retriesTotal++; },
      });


      if (execResult.ok) {
        steps.finish(stepRow.id, { status: 'success', observation: execResult.observation });
        event({ type: 'step_success', stepId: stepRow.id, observation: execResult.observation });
        state.steps.push({
          tool: action.tool,
          action,
          status: 'success',
          observation: execResult.observation,
        });
        // Stash latest page observation for next AI prompt.
        if (execResult.observation?.url || execResult.observation?.title) {
          state.observations.push(execResult.observation);
          if (state.observations.length > 4) state.observations.shift();
        }
      } else {
        steps.finish(stepRow.id, { status: 'failed', errorMessage: execResult.error });
        dbErrors.record({
          runId: run.id,
          stepId: stepRow.id,
          level: 'error',
          message: execResult.error,
          context: { tool: action.tool, args: redact(action.args) },
        });
        event({ type: 'step_failed', stepId: stepRow.id, error: execResult.error });
        // Give the AI one chance to recover, then bail out if we keep failing on the same tool.
        const recentSameToolFails = state.steps.slice(-4).filter((s) => s.tool === action.tool && s.status === 'failed').length;
        state.steps.push({ tool: action.tool, action, status: 'failed', errorMessage: execResult.error });
        if (recentSameToolFails >= 2) {
          state.finished = true;
          state.finalStatus = 'failed';
          state.finalError = `Repeated failures for ${action.tool}: ${execResult.error}`;
          break;
        }
      }
    }


    // ── Persist run result ────────────────────────────────────
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


async function executeWithRetry(action, { stepTimeoutMs, maxRetries, onAttempt }) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (attempt > 1) onAttempt(attempt - 1);
    try {
      const observation = await withTimeout(executeAction(action), stepTimeoutMs);
      return { ok: true, observation };
    } catch (err) {
      lastErr = err;
      // Exponential backoff before next attempt
      if (attempt <= maxRetries) {
        await sleep(Math.min(2000 * 2 ** (attempt - 1), 8000));
      }
    }
  }
  return { ok: false, error: lastErr?.message || 'unknown error' };
}


function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Step timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}


// Maps a tool-call action to a browser call.
async function executeAction(action) {
  const { tool, args = {} } = action;
  switch (tool) {
    case 'browser_navigate':           return browser.navigate(args.url, args);
    case 'browser_snapshot':           return browser.snapshot(args);
    case 'browser_click':              return browser.click(args.target, args);
    case 'browser_hover':              return browser.hover(args.target, args);
    case 'browser_type':               return browser.type(args.target, args.text, args);
    case 'browser_fill':               return browser.fill(args.target, args.value, args);
    case 'browser_select_option':      return browser.selectOption(args.target, args.value, args);
    case 'browser_press':              return browser.press(args.key, args);
    case 'browser_upload_file':        return browser.uploadFile(args.target, args.paths, args);
    case 'browser_drag':               return browser.drag(args.startTarget, args.endTarget, args);
    case 'browser_evaluate':           return browser.evaluate(args.fn, args);
    case 'browser_get_text':           return browser.getText(args.target, args);
    case 'browser_get_page_info':      return browser.getPageInfo();
    case 'browser_screenshot':         return browser.screenshot(args);
    case 'browser_tabs':               return browser.tabs();
    case 'browser_new_tab':            return browser.newTab(args.url);
    case 'browser_close_tab':          return browser.closeTab(args.index);
    case 'browser_wait_for':           return browser.waitFor(args.target, args);
    case 'browser_wait_for_text':      return browser.waitForText(args.text, args);
    case 'browser_wait_ms':            return browser.waitMs(args.ms);
    case 'request_human_approval':     return { requested: true, ...args };
    default:
      throw new Error(`Tool not implemented in executor: ${tool}`);
  }
}


// Helper for ad-hoc CLI use: create a task + run it once.
export async function runGoal(goal, opts = {}) {
  const task = tasks.create({
    name: opts.name || `ad-hoc-${Date.now()}`,
    goal,
    metadata: opts.metadata,
  });
  return runAgent({ taskId: task.id, goal, onEvent: opts.onEvent });
}
