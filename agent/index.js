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
        steps.finish(stepRow.id, { status: 'success', observation: execResult.observation });
        event({ type: 'step_success', stepId: stepRow.id, observation: execResult.observation });
        state.steps.push({ tool: action.tool, action, status: 'success', observation: execResult.observation });
        if (execResult.observation?.url || execResult.observation?.title || execResult.observation?.elements) {
          state.observations.push(execResult.observation);
          if (state.observations.length > 4) state.observations.shift();
        }
        // Prefer the rich post-navigate snapshot (with element refs) for the next plan.
        if (action.tool === 'browser_navigate' && execResult.observation?.elements) {
          state.pendingObservation = execResult.observation;
        }
      } else {
        steps.finish(stepRow.id, { status: 'failed', errorMessage: execResult.error });
        dbErrors.record({ runId: run.id, stepId: stepRow.id, level: 'error', message: execResult.error, context: { tool: action.tool, args: redact(action.args), permanent: !!execResult.permanent, staleTarget: !!execResult.staleTarget } });
        event({ type: 'step_failed', stepId: stepRow.id, error: execResult.error, permanent: !!execResult.permanent, staleTarget: !!execResult.staleTarget });
        state.steps.push({ tool: action.tool, action, status: 'failed', errorMessage: execResult.error, permanent: !!execResult.permanent, staleTarget: !!execResult.staleTarget });
        // Stale selector/ref failures do not burn global retries — they replan with a fresh snapshot.
        if (execResult.staleTarget) {
          try {
            const snap = await browser.snapshot({});
            state.pendingObservation = {
              ...snap,
              note: `Previous action failed due to stale/missing target: ${execResult.error}. Use current element refs from this snapshot; do not reuse old refs or selectors from a previous page.`,
            };
          } catch {
            // best-effort; observeLight will still run next loop
          }
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

const OBSERVATIONAL_TOOLS = new Set([
  'browser_snapshot', 'browser_get_page_info', 'browser_get_text',
  'browser_wait_ms', 'browser_wait_for', 'browser_wait_for_text', 'browser_tabs',
]);

export function actionSignature(action) {
  const args = action?.args || {};
  const sorted = {};
  for (const k of Object.keys(args).sort()) sorted[k] = args[k];
  return `${action?.tool}:${JSON.stringify(sorted)}`;
}

export function detectStuckLoop(historySteps, action) {
  const sig = actionSignature(action);
  const threshold = OBSERVATIONAL_TOOLS.has(action.tool) ? 5 : 2;
  let consecutive = 0;
  for (let i = historySteps.length - 1; i >= 0; i--) {
    if (actionSignature(historySteps[i].action) === sig) consecutive++;
    else break;
  }
  if (consecutive >= threshold) {
    return { reason: `Repeated identical action with no progress: ${action.tool}(${JSON.stringify(action.args || {})}) attempted ${consecutive + 1} times in a row with no change in approach.` };
  }
  return null;
}

const PERMANENT_ERROR_PATTERNS = [
  /ERR_NAME_NOT_RESOLVED/i, /ENOTFOUND/i, /ERR_CONNECTION_REFUSED/i,
  /DNS_PROBE_FINISHED_NXDOMAIN/i, /ERR_CERT_/i, /ERR_SSL_/i, /getaddrinfo/i,
];

// Playwright locator timeouts and our ensureTargetPresent messages indicate the
// target is gone or never existed on the current page. Retrying the same
// selector burns the global retry budget; the correct recovery is a fresh snapshot.
const STALE_TARGET_PATTERNS = [
  /Stale or missing (?:ref|target)/i,
  /No element has data-agent-ref=/i,
  /Timeout \d+ms exceeded/i,
  /waiting for (?:locator|selector)/i,
  /page\.(?:click|fill|type|press|waitFor|locator)/i,
  /Locator\.(?:click|fill|type|press|waitFor)/i,
  /element\(s\) not found/i,
  /strict mode violation/i,
];

export function isStaleTargetError(message) {
  const msg = String(message || '');
  return STALE_TARGET_PATTERNS.some((re) => re.test(msg));
}

export function classifyError(message) {
  const msg = String(message || '');
  if (isStaleTargetError(msg)) return 'stale_target';
  return PERMANENT_ERROR_PATTERNS.some((re) => re.test(msg)) ? 'permanent' : 'transient';
}

async function executeWithRetry(action, { stepTimeoutMs, maxRetries, context }) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const observation = await withTimeout(executeAction(action, context), stepTimeoutMs);
      return { ok: true, observation };
    } catch (err) {
      lastErr = err;
      const kind = classifyError(err.message);
      // Stale targets: fail this step immediately so the outer loop can replan
      // with a fresh snapshot. Do not burn per-step or global retries.
      if (kind === 'stale_target') {
        return { ok: false, error: err.message, permanent: false, staleTarget: true };
      }
      if (kind === 'permanent') return { ok: false, error: err.message, permanent: true };
      if (attempt <= maxRetries) await sleep(Math.min(2000 * 2 ** (attempt - 1), 8000));
    }
  }
  return { ok: false, error: lastErr?.message || 'unknown error', permanent: false };
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Step timed out after ${ms} ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function executeAction(action, context = {}) {
  const { tool, args = {} } = action;
  switch (tool) {
    case 'browser_navigate': {
      const pageInfo = await browser.navigate(args.url, args);
      // Auto-snapshot after navigation so the next plan has valid data-agent-ref
      // values for the new page. Production burned retries on stale eN refs and
      // Bing/DDG CSS selectors that only exist after a snapshot on the current DOM.
      try {
        const snap = await browser.snapshot({});
        return {
          ...pageInfo,
          ...snap,
          note: 'Auto-snapshot after navigate. Use element refs (e0, e1, …) from this snapshot for subsequent click/type/fill actions.',
        };
      } catch {
        return pageInfo;
      }
    }
    case 'browser_snapshot': return browser.snapshot(args);
    case 'browser_click': return browser.click(args.target, args);
    case 'browser_hover': return browser.hover(args.target, args);
    case 'browser_type': return browser.type(args.target, args.text, args);
    case 'browser_fill': return browser.fill(args.target, args.value, args);
    case 'browser_select_option': return browser.selectOption(args.target, args.value, args);
    case 'browser_press': return browser.press(args.key, args);
    case 'browser_upload_file': return browser.uploadFile(args.target, args.paths, args);
    case 'browser_drag': return browser.drag(args.startTarget, args.endTarget, args);
    case 'browser_evaluate': return browser.evaluate(args.fn, args);
    case 'browser_get_text': return browser.getText(args.target, args);
    case 'browser_get_page_info': return browser.getPageInfo();
    case 'browser_screenshot': return browser.screenshot(args);
    case 'browser_tabs': return browser.tabs();
    case 'browser_new_tab': return browser.newTab(args.url);
    case 'browser_close_tab': return browser.closeTab(args.index);
    case 'browser_wait_for': return browser.waitFor(args.target, args);
    case 'browser_wait_for_text': return browser.waitForText(args.text, args);
    case 'browser_wait_ms': return browser.waitMs(args.ms);
    case 'request_human_approval': return { requested: true, ...args };
    case 'generate_website': {
      const result = generateWebsite(args);
      websiteSamples.create({
        id: result.sampleId, taskId: context.taskId, runId: context.runId,
        prospectName: args.prospectName, status: result.status, businessType: args.businessType,
        location: args.location, websiteGoal: args.websiteGoal, style: args.brandStyle,
        files: result.files, previewPath: result.previewPath,
      });
      const { dir, ...observation } = result;
      return observation;
    }
    case 'analyze_prospect_page': return analyzeProspectPage(args);
    case 'save_prospect': {
      const saved = prospects.create({
        taskId: context.taskId, runId: context.runId, businessName: args.businessName,
        websiteUrl: args.websiteUrl, location: args.location, contactEmail: args.contactEmail,
        contactPhone: args.contactPhone, socialProfiles: args.socialProfiles, serviceGaps: args.serviceGaps,
        sourceUrl: args.sourceUrl, notes: args.notes,
      });
      return { success: true, prospectId: saved.id, status: saved.status };
    }
    case 'analyze_opportunity': {
      const prospect = prospects.get(args.prospectId);
      if (!prospect) throw new Error(`Prospect not found: ${args.prospectId}`);
      const result = analyzeOpportunity(prospect, {
        propertyListingsCount: args.propertyListingsCount, hasPromoVideo: args.hasPromoVideo,
        has3DVisualization: args.has3DVisualization, mobileFriendly: args.mobileFriendly,
      });
      return { prospectId: args.prospectId, ...result };
    }
    case 'save_opportunity': {
      const prospect = prospects.get(args.prospectId);
      if (!prospect) throw new Error(`Prospect not found: ${args.prospectId}`);
      const saved = opportunities.createOpportunity({
        prospectId: args.prospectId, taskId: context.taskId, runId: context.runId,
        score: args.score, priority: args.priority, opportunityType: args.opportunityType,
        summary: args.summary, identifiedProblems: args.identifiedProblems,
        recommendedServices: args.recommendedServices, recommendedActions: args.recommendedActions,
        recommendedSampleType: args.recommendedSampleType, recommendedSampleReason: args.recommendedSampleReason,
        estimatedValue: args.estimatedValue, confidence: args.confidence, status: 'ANALYZED',
      });
      prospects.updateStatus(args.prospectId, 'ANALYZED');
      if (saved.recommended_sample_type && saved.recommended_sample_type !== 'none') {
        opportunities.updateOpportunity(saved.id, { status: 'SAMPLE_RECOMMENDED' });
      }
      return { success: true, opportunityId: saved.id, status: saved.recommended_sample_type && saved.recommended_sample_type !== 'none' ? 'SAMPLE_RECOMMENDED' : saved.status };
    }
    case 'create_sample': {
      const opportunity = opportunities.getOpportunity(args.opportunityId);
      if (!opportunity) throw new Error(`Opportunity not found: ${args.opportunityId}`);
      const prospect = prospects.get(opportunity.prospect_id);
      if (!prospect) throw new Error(`Prospect not found: ${opportunity.prospect_id}`);

      const result = createSample({ prospect, opportunity, sampleType: args.sampleType, notes: args.notes });

      if (result.sampleType === 'website') {
        websiteSamples.create({
          id: result.websiteSampleId,
          taskId: context.taskId,
          runId: context.runId,
          prospectName: prospect.business_name,
          status: 'SPECULATIVE_SAMPLE',
          businessType: 'Real Estate',
          location: prospect.location,
          websiteGoal: 'Showcase properties and generate inquiries',
          files: ['index.html', 'styles.css', 'script.js', 'metadata.json'],
          previewPath: result.previewPath,
        });
      }
      return result;
    }
    case 'save_sample': {
      const opportunity = opportunities.getOpportunity(args.opportunityId);
      if (!opportunity) throw new Error(`Opportunity not found: ${args.opportunityId}`);
      const expectedContentKind = args.sampleType === 'website' ? 'SPECULATIVE_SAMPLE' : 'CONCEPT_BRIEF';
      if (args.contentKind !== expectedContentKind) {
        throw new Error(`Invalid contentKind "${args.contentKind}" for sampleType "${args.sampleType}" — expected "${expectedContentKind}"`);
      }
      const saved = samples.create({
        prospectId: opportunity.prospect_id,
        opportunityId: args.opportunityId,
        taskId: context.taskId,
        runId: context.runId,
        sampleType: args.sampleType,
        contentKind: args.contentKind,
        websiteSampleId: args.websiteSampleId,
        content: args.content,
        previewPath: args.previewPath,
      });
      samples.markSaved(saved.id);
      opportunities.updateOpportunity(args.opportunityId, { status: 'SAMPLE_CREATED' });
      return { success: true, sampleId: saved.id, status: 'SAVED' };
    }
    case 'generate_proposal': {
      const opportunity = opportunities.getOpportunity(args.opportunityId);
      if (!opportunity) throw new Error(`Opportunity not found: ${args.opportunityId}`);
      const prospect = prospects.get(opportunity.prospect_id);
      if (!prospect) throw new Error(`Prospect not found: ${opportunity.prospect_id}`);
      const sample = samples.get(args.sampleId);
      if (!sample) throw new Error(`Sample not found: ${args.sampleId}`);
      const result = generateProposal({ prospect, opportunity, sample });
      return { opportunityId: args.opportunityId, sampleId: args.sampleId, ...result };
    }
    case 'save_proposal': {
      const opportunity = opportunities.getOpportunity(args.opportunityId);
      if (!opportunity) throw new Error(`Opportunity not found: ${args.opportunityId}`);
      const saved = proposals.create({
        prospectId: opportunity.prospect_id,
        opportunityId: args.opportunityId,
        sampleId: args.sampleId,
        taskId: context.taskId,
        runId: context.runId,
        pitch: args.pitch,
        serviceRecommendation: args.serviceRecommendation,
        valueProposition: args.valueProposition,
        suggestedPackage: args.suggestedPackage,
        callToAction: args.callToAction,
        assumptions: args.assumptions,
      });
      proposals.markReady(saved.id);
      opportunities.updateOpportunity(args.opportunityId, { status: 'AWAITING_APPROVAL' });
      return { success: true, proposalId: saved.id, status: 'AWAITING_APPROVAL' };
    }
    default:
      throw new Error(`Tool not implemented in executor: ${tool}`);
  }
}
