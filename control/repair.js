// control/repair.js
// Repair-session orchestrator. Lives outside agent/index.js.

import { repairSessions, runs } from '../database/index.js';
import { config } from '../config/index.js';

export const REPAIR_STATES = Object.freeze({
  STARTED: 'STARTED',
  FAILED: 'FAILED',
  DIAGNOSING: 'DIAGNOSING',
  PATCH_PENDING_APPROVAL: 'PATCH_PENDING_APPROVAL',
  TESTING: 'TESTING',
  TEST_FAILED: 'TEST_FAILED',
  STAGING_DEPLOY_PENDING_APPROVAL: 'STAGING_DEPLOY_PENDING_APPROVAL',
  STAGING_DEPLOYED: 'STAGING_DEPLOYED',
  RETRYING: 'RETRYING',
  VERIFIED: 'VERIFIED',
  STOPPED: 'STOPPED',
});

export function defaultMaxAttempts() {
  return config.control?.maxRepairAttempts || Number(process.env.MAX_REPAIR_ATTEMPTS || 3);
}

export function getOrCreateSession({ taskId, initialRunId, maxAttempts } = {}) {
  if (taskId) {
    const existing = repairSessions.getActiveForTask(taskId);
    if (existing) return existing;
  }
  return repairSessions.create({
    taskId,
    initialRunId,
    currentRunId: initialRunId,
    maxAttempts: maxAttempts || defaultMaxAttempts(),
    state: REPAIR_STATES.STARTED,
  });
}

export function getSession(id) {
  return repairSessions.get(id);
}

export function canRetry(session) {
  if (!session) return false;
  if (session.state === REPAIR_STATES.VERIFIED || session.state === REPAIR_STATES.STOPPED) return false;
  return Number(session.attempt_count || 0) < Number(session.max_attempts || defaultMaxAttempts());
}

export function incrementAttempt(id) {
  const session = repairSessions.get(id);
  if (!session) return null;
  const next = Number(session.attempt_count || 0) + 1;
  if (next > Number(session.max_attempts || defaultMaxAttempts())) {
    return repairSessions.update(id, { state: REPAIR_STATES.STOPPED, failureReason: 'max repair attempts exceeded' });
  }
  return repairSessions.update(id, { attemptCount: next });
}

export function setState(id, state, extra = {}) {
  return repairSessions.update(id, { state, ...extra });
}

export async function advanceRepair({ sessionId, runId, diagnosis, branchName, approvedModify, approvedDeploy } = {}) {
  const session = sessionId ? repairSessions.get(sessionId) : null;
  if (!session) {
    const err = new Error('repair session not found');
    err.status = 404;
    throw err;
  }
  if (session.state === REPAIR_STATES.VERIFIED) {
    return { ok: true, session, note: 'already verified' };
  }
  if (!canRetry(session) && session.state !== REPAIR_STATES.STAGING_DEPLOYED) {
    const stopped = setState(session.id, REPAIR_STATES.STOPPED, {
      failureReason: session.failure_reason || 'max repair attempts exceeded',
    });
    return { ok: false, stopped: true, session: stopped };
  }

  const run = runId ? runs.get(runId) : (session.current_run_id ? runs.get(session.current_run_id) : null);

  if (run && run.status === 'success') {
    const verified = setState(session.id, REPAIR_STATES.VERIFIED, { currentRunId: run.id });
    return { ok: true, session: verified };
  }

  if (run && run.status === 'failed') {
    setState(session.id, REPAIR_STATES.FAILED, {
      currentRunId: run.id,
      failureReason: run.error_message || 'run failed',
    });
    setState(session.id, REPAIR_STATES.DIAGNOSING, { diagnosis: diagnosis || run.error_message || null });
    const branch = branchName || session.branch_name || `repair/${session.id}`;
    setState(session.id, REPAIR_STATES.PATCH_PENDING_APPROVAL, { branchName: branch });
    if (!approvedModify) {
      return {
        ok: true,
        session: repairSessions.get(session.id),
        next: 'github.modify_file requires approved=true on a repair/* branch; production deploy is blocked',
      };
    }
    setState(session.id, REPAIR_STATES.TESTING);
    if (!approvedDeploy) {
      setState(session.id, REPAIR_STATES.STAGING_DEPLOY_PENDING_APPROVAL);
      return {
        ok: true,
        session: repairSessions.get(session.id),
        next: 'render.deploy staging requires approved=true; production remains blocked',
      };
    }
    setState(session.id, REPAIR_STATES.STAGING_DEPLOYED);
    return { ok: true, session: repairSessions.get(session.id), next: 'call agent.retry_run then agent.get_run' };
  }

  return { ok: true, session: repairSessions.get(session.id) };
}

export const repairTools = {
  async 'repair.start'(args = {}) {
    const session = getOrCreateSession(args);
    return { ok: true, session };
  },
  async 'repair.get'(args = {}) {
    const session = getSession(args.sessionId || args.id);
    if (!session) {
      const err = new Error('repair session not found');
      err.status = 404;
      throw err;
    }
    return { ok: true, session };
  },
  async 'repair.advance'(args = {}) {
    return advanceRepair(args);
  },
};
