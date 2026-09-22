// control/tools/agent.js
// Adapters over existing tasks/runs/steps/errors/runAgent. Does not reimplement the loop.

import { tasks, runs, steps, errors as dbErrors, notifications, getDb, repairSessions } from '../../database/index.js';
import { runAgent } from '../../agent/index.js';
import { isSchedulerRunning } from '../../scheduler/index.js';
import { config } from '../../config/index.js';
import { getOrCreateSession, incrementAttempt, canRetry, REPAIR_STATES } from '../repair.js';

export async function createTask(args = {}) {
  const { name, goal, cronExpression, timezone, metadata } = args;
  if (!name || !goal) {
    const err = new Error('name and goal are required');
    err.status = 400;
    throw err;
  }
  const task = tasks.create({ name, goal, cronExpression, timezone, metadata });
  return { ok: true, task };
}

export async function getTask(args = {}) {
  const task = tasks.get(args.taskId || args.id);
  if (!task) {
    const err = new Error('task not found');
    err.status = 404;
    throw err;
  }
  return { ok: true, task };
}

export async function runTask(args = {}) {
  const taskId = args.taskId || args.id;
  const task = tasks.get(taskId);
  if (!task) {
    const err = new Error('task not found');
    err.status = 404;
    throw err;
  }
  const run = runs.start({ taskId: task.id });
  runAgent({ taskId: task.id, runId: run.id }).catch((err) => {
    console.error('[control] runAgent failed:', err?.message || err);
  });
  return { ok: true, started: true, runId: run.id, taskId: task.id, status: run.status };
}

export async function getRun(args = {}) {
  const run = runs.get(args.runId || args.id);
  if (!run) {
    const err = new Error('run not found');
    err.status = 404;
    throw err;
  }
  return { ok: true, run };
}

export async function getLogs(args = {}) {
  const runId = args.runId || args.id;
  const run = runs.get(runId);
  if (!run) {
    const err = new Error('run not found');
    err.status = 404;
    throw err;
  }
  const listForRun = typeof notifications.listForRun === 'function'
    ? notifications.listForRun({ runId, limit: 50 })
    : [];
  return {
    ok: true,
    runId,
    steps: steps.listForRun(runId),
    errors: dbErrors.listRecent({ limit: 200 }).filter((e) => e.run_id === runId),
    notifications: listForRun,
  };
}

export async function retryRun(args = {}) {
  const failed = runs.get(args.runId || args.id);
  if (!failed) {
    const err = new Error('run not found');
    err.status = 404;
    throw err;
  }
  if (failed.status !== 'failed') {
    const err = new Error(`run ${failed.id} is not failed (status=${failed.status})`);
    err.status = 400;
    throw err;
  }
  const session = getOrCreateSession({
    taskId: failed.task_id,
    initialRunId: failed.id,
    maxAttempts: config.control?.maxRepairAttempts,
  });
  if (!canRetry(session)) {
    const err = new Error(`repair session ${session.id} cannot retry (state=${session.state}, attempts=${session.attempt_count}/${session.max_attempts})`);
    err.status = 403;
    throw err;
  }
  incrementAttempt(session.id);
  const run = runs.start({ taskId: failed.task_id });
  repairSessions.update(session.id, {
    currentRunId: run.id,
    state: REPAIR_STATES.RETRYING,
  });
  runAgent({ taskId: failed.task_id, runId: run.id }).catch((err) => {
    console.error('[control] retry runAgent failed:', err?.message || err);
  });
  return {
    ok: true,
    started: true,
    runId: run.id,
    taskId: failed.task_id,
    repairSessionId: session.id,
    attemptCount: (session.attempt_count || 0) + 1,
    maxAttempts: session.max_attempts,
  };
}

export async function healthCheck() {
  let databaseOk = false;
  try {
    getDb().prepare('SELECT 1 AS ok').get();
    databaseOk = true;
  } catch {
    databaseOk = false;
  }
  const latest = runs.listRecent({ limit: 1 })[0] || null;
  return {
    ok: databaseOk,
    process: { uptime: process.uptime(), pid: process.pid, node: process.version },
    database: { ok: databaseOk, path: config.database.path },
    scheduler: { running: isSchedulerRunning() },
    latestRun: latest ? { id: latest.id, taskId: latest.task_id, status: latest.status, startedAt: latest.started_at } : null,
  };
}

export const agentTools = {
  'agent.create_task': createTask,
  'agent.run_task': runTask,
  'agent.get_task': getTask,
  'agent.get_run': getRun,
  'agent.get_logs': getLogs,
  'agent.retry_run': retryRun,
  'agent.health_check': healthCheck,
};
