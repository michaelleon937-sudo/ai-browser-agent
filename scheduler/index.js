// scheduler/index.js
// Lightweight in-process scheduler. Polls the `tasks` table every
// SCHEDULER_TICK_MS for due scheduled tasks (cron expression stored per task)
// and enqueues a run. Designed to survive process restarts: cron state is
// recomputed from `next_run_at` stored in the DB, not from memory.


import cronParser from 'cron-parser';
import { tasks, runs, listTenantIds } from '../database/index.js';
import { runWithTenantContext } from '../database/tenant-context.js';
import { runAgent } from '../agent/index.js';
import { config } from '../config/index.js';
import { notify } from '../notifications/index.js';


let timer = null;
let ticking = false;


export function startScheduler() {
  if (timer) return;
  console.log(`[scheduler] starting, tick=${config.scheduler.tickMs}ms`);
  timer = setInterval(tick, config.scheduler.tickMs);
  // Fire once immediately on boot so a restart doesn't wait a full tick.
  tick().catch((err) => console.error('[scheduler] initial tick failed:', err));
}


export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

export function isSchedulerRunning() {
  return Boolean(timer);
}


async function tick() {
  if (ticking) return; // avoid overlapping ticks if a run is slow to enqueue
  ticking = true;
  try {
    const tenantIds = listTenantIds();
    if (tenantIds.length === 0) {
      await processTenantTasks(null); // legacy single-tenant mode before any tenant is registered
    } else {
      for (const tenantId of tenantIds) {
        await runWithTenantContext({ tenantId, operatorId: 'scheduler' }, () => processTenantTasks(tenantId));
      }
    }
  } finally {
    ticking = false;
  }
}

async function processTenantTasks(tenantId) {
  const due = tasks.dueForRun(new Date().toISOString());
  for (const task of due) {
    try {
      await runDueTask(task, tenantId);
    } catch (err) {
      console.error(`[scheduler] tenant ${tenantId || 'legacy'} task ${task.id} failed to run:`, err);
      // Never send one tenant's task details to the platform owner's global Telegram channel.
      if (!tenantId || tenantId === String(process.env.AGENT_LEGACY_TENANT_ID || '')) {
        notify({ level: 'error', subject: `Scheduler error: ${task.name}`, body: err.message });
      }
    }
  }
}


async function runDueTask(task, tenantId = null) {
  const next = computeNextRun(task.cron_expression, task.timezone);
  tasks.setNextRun(task.id, next);


  if (task.status === 'running') {
    console.warn(`[scheduler] skipping ${task.name}: previous run still in progress`);
    return;
  }


  console.log(`[scheduler] running due task: ${task.name} (${task.id})`);
  runAgent({ taskId: task.id, tenantId }).catch((err) => {
    console.error(`[scheduler] tenant ${tenantId || 'legacy'} runAgent crashed for ${task.id}:`, err);
  });
}


export function computeNextRun(cronExpression, timezone) {
  if (!cronExpression) return null;
  try {
    const interval = cronParser.parseExpression(cronExpression, {
      currentDate: new Date(),
      tz: timezone || config.scheduler.defaultTimezone,
    });
    return interval.next().toISOString();
  } catch (err) {
    console.error(`[scheduler] invalid cron expression "${cronExpression}":`, err.message);
    return null;
  }
}


export function scheduleTask(taskId, cronExpression, timezone) {
  const next = computeNextRun(cronExpression, timezone);
  tasks.update(taskId, { cronExpression, timezone, nextRunAt: next });
  return { nextRunAt: next };
}


export function unscheduleTask(taskId) {
  tasks.update(taskId, { cronExpression: null, nextRunAt: null });
}
