#!/usr/bin/env node
// agent/main.js
// Top-level entrypoint. Boots the dashboard, scheduler, and optional browser
// session. SIGTERM / SIGINT trigger a clean shutdown.

import { ensureDirs, config } from '../config/index.js';
import { migrate, closeDb } from '../database/index.js';
import { startDashboard } from '../monitoring/dashboard.js';
import { startScheduler, stopScheduler } from '../scheduler/index.js';
import { notify } from '../notifications/index.js';
import browser from '../browser/index.js';
import { installInboundEmailWebhook } from '../integrations/inbound-webhook.js';
import { installCloudMailinOutboundEventsWebhook } from '../integrations/cloudmailin-events-webhook.js';
import { authenticateControlRequest } from '../control/auth.js';
import { invokeControlTool } from '../control/invoke.js';

async function runProductionOrchestrationSelfTest() {
  if (process.env.PRODUCTION_ORCHESTRATION_VERIFY !== '1') return;

  const token = process.env.CONTROL_TOKEN || '';
  const idempotencyKey = `prod-orch-selftest-${Date.now()}`;
  const requestId = `prod-orch-selftest-${Date.now()}`;

  try {
    const auth = authenticateControlRequest({
      headers: {
        authorization: `Bearer ${token}`,
        'x-operator-id': 'production-self-test',
      },
    });

    const result = await invokeControlTool({
      toolName: 'supervisor.run_journey',
      args: {
        subject: 'Production orchestration verification',
        body: 'Please classify this safe production test and prepare the workflow without sending anything.',
        goal: 'logo design',
        approved: false,
        maxRepairAttempts: 3,
      },
      operatorId: auth.operatorId,
      idempotencyKey,
      requestId,
      source: 'production-self-test',
    });

    console.log('[production-self-test]', JSON.stringify({
      authenticated: auth.authenticated === true,
      tool: 'supervisor.run_journey',
      ok: result?.ok === true,
      status: result?.status,
      sent: result?.body?.result?.sent ?? result?.body?.sent ?? null,
      externalSideEffect: result?.body?.result?.externalSideEffect ?? result?.body?.externalSideEffect ?? null,
      requiresHumanApproval: result?.body?.result?.requiresHumanApproval ?? result?.body?.requiresHumanApproval ?? null,
      requestId,
    }));
  } catch (error) {
    console.error('[production-self-test] FAILED', JSON.stringify({
      authenticated: false,
      tool: 'supervisor.run_journey',
      error: error?.message || String(error),
      requestId,
    }));
  }
}

async function main() {
  ensureDirs();
  migrate();

  const server = await startDashboard();
  installInboundEmailWebhook(server);
  installCloudMailinOutboundEventsWebhook(server);
  startScheduler();

  await runProductionOrchestrationSelfTest();

  const heartbeat = setInterval(() => {
    notify({
      level: 'debug',
      subject: 'agent-heartbeat',
      body: `uptime ${Math.round(process.uptime())}s`,
    }).catch(() => {});
  }, 60 * 60 * 1000);

  console.log(`[main] ai-browser-agent running. Dashboard on http://${config.dashboard.host}:${config.dashboard.port}`);

  const shutdown = async (signal) => {
    console.log(`\n[main] received ${signal}, shutting down…`);
    clearInterval(heartbeat);
    stopScheduler();
    try { await browser.close(); } catch {}
    try { closeDb(); } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    console.error('[main] uncaughtException:', err);
    notify({ level: 'fatal', subject: 'uncaughtException', body: err.message });
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[main] unhandledRejection:', reason);
    notify({ level: 'fatal', subject: 'unhandledRejection', body: String(reason) });
  });
}

main().catch((err) => {
  console.error('[main] boot failed:', err);
  process.exit(1);
});
