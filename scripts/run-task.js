#!/usr/bin/env node
// scripts/run-task.js
// CLI helper to run a single goal without the scheduler/dashboard, useful for
// local testing and for the one-shot deploy scripts.
//
// Usage:
//   node scripts/run-task.js "Go to example.com and tell me the page title"
//   node scripts/run-task.js --task-id abc123


import { ensureDirs } from '../config/index.js';
import { migrate, closeDb, tasks } from '../database/index.js';
import { runAgent } from '../agent/index.js';
import browser from '../browser/index.js';

async function main() {
  ensureDirs();
  migrate();

  const args = process.argv.slice(2);
  let taskId = null;
  let goal = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--task-id') { taskId = args[++i]; continue; }
    if (!goal && !args[i].startsWith('--')) goal = args[i];
  }

  if (!taskId && !goal) {
    console.error('Usage: node scripts/run-task.js "<goal text>"  OR  --task-id <id>');
    process.exit(1);
  }

  console.log(`[run-task] starting… ${taskId ? `task-id=${taskId}` : `goal="${goal}"`}`);

  const result = await runAgent({
    taskId,
    goal,
    onEvent: (e) => console.log(`[event] ${e.type}`, JSON.stringify({ ...e, type: undefined })),
  });

  console.log('[run-task] result:', JSON.stringify(result, null, 2));

  await browser.close();
  closeDb();
  process.exit(result.status === 'success' ? 0 : 1);
}

main().catch((err) => {
  console.error('[run-task] fatal:', err);
  process.exit(1);
});
