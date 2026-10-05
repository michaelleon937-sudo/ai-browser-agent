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

async function main() {
  ensureDirs();
  migrate();

  const server = await startDashboard();
  installInboundEmailWebhook(server);
  installCloudMailinOutboundEventsWebhook(server);
  startScheduler();

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
