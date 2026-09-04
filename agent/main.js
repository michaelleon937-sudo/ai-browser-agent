#!/usr/bin/env node
// agent/main.js
// Top-level entrypoint. Boots the dashboard, scheduler, and (optionally) a
// long-lived browser session. Designed to run inside Docker / cloud and stay
// up for days. SIGTERM / SIGINT trigger a clean shutdown.
//
// Usage:
//   node agent/main.js
//
// Environment variables: see .env.example.


import { ensureDirs, config } from '../config/index.js';
import { migrate, closeDb } from '../database/index.js';
import { startDashboard } from '../monitoring/dashboard.js';
import { startScheduler, stopScheduler } from '../scheduler/index.js';
import { notify } from '../notifications/index.js';
import browser from '../browser/index.js';


async function main() {
  ensureDirs();
  migrate();


  await startDashboard();
  startScheduler();


  // Light-touch heartbeat for visibility.
  const heartbeat = setInterval(() => {
    notify({
      level: 'debug',
      subject: 'agent-heartbeat',
      body: `uptime ${Math.round(process.uptime())}s`,
    }).catch(() => {});
  }, 60 * 60 * 1000); // hourly


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


  // Trap uncaught errors so the container restart loop gets a clean exit.
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
