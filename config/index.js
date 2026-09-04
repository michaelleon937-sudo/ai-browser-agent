// config/index.js
// Central configuration loaded from environment variables. Validates required
// values for the selected AI_PROVIDER and creates required directories.
// See .env.example for the full list of supported variables.


import fs from 'node:fs';
import path from 'node:path';


function bool(v, def = false) {
  if (v === undefined) return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}


function num(v, def) {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}


const DATA_DIR = process.env.DATA_DIR || '/data';


export const config = {
  env: process.env.NODE_ENV || 'production',


  dashboard: {
    host: process.env.DASHBOARD_HOST || '0.0.0.0',
    port: num(process.env.PORT || process.env.DASHBOARD_PORT, 8080),
    user: process.env.DASHBOARD_USER || '',
    pass: process.env.DASHBOARD_PASS || '',
  },


  agent: {
    maxSteps: num(process.env.AGENT_MAX_STEPS, 40),
    stepTimeoutMs: num(process.env.AGENT_STEP_TIMEOUT_MS, 30_000),
    totalTimeoutMs: num(process.env.AGENT_TOTAL_TIMEOUT_MS, 10 * 60 * 1000),
    maxRetriesPerStep: num(process.env.AGENT_MAX_RETRIES_PER_STEP, 2),
    maxRetriesTotal: num(process.env.AGENT_MAX_RETRIES_TOTAL, 8),
    humanApprovalRequired: bool(process.env.HUMAN_APPROVAL_REQUIRED, true),
  },


  ai: {
    provider: process.env.AI_PROVIDER || 'stub', // stub | cloudflare | openai-compatible
    cloudflare: {
      accountId: process.env.CF_ACCOUNT_ID || '',
      apiToken: process.env.CF_API_TOKEN || '',
      model: process.env.CF_MODEL || '@cf/meta/llama-3.1-8b-instruct',
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY || '',
      baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    },
  },


  browser: {
    headless: bool(process.env.BROWSER_HEADLESS, true),
    userDataDir: process.env.BROWSER_USER_DATA_DIR || path.join(DATA_DIR, 'browser-profile'),
    screenshotDir: process.env.SCREENSHOT_DIR || path.join(DATA_DIR, 'screenshots'),
    viewportWidth: num(process.env.BROWSER_VIEWPORT_WIDTH, 1366),
    viewportHeight: num(process.env.BROWSER_VIEWPORT_HEIGHT, 900),
    launchTimeoutMs: num(process.env.BROWSER_LAUNCH_TIMEOUT_MS, 30_000),
    navigationTimeoutMs: num(process.env.BROWSER_NAVIGATION_TIMEOUT_MS, 30_000),
    actionTimeoutMs: num(process.env.BROWSER_ACTION_TIMEOUT_MS, 15_000),
  },


  database: {
    path: process.env.DATABASE_PATH || path.join(DATA_DIR, 'agent.db'),
  },


  scheduler: {
    tickMs: num(process.env.SCHEDULER_TICK_MS, 15_000),
    defaultTimezone: process.env.SCHEDULER_DEFAULT_TZ || 'UTC',
  },


  notifications: {
    webhookUrl: process.env.NOTIFY_WEBHOOK_URL || '',
    smtp: {
      host: process.env.SMTP_HOST || '',
      port: num(process.env.SMTP_PORT, 587),
      secure: bool(process.env.SMTP_SECURE, false),
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
    },
    email: {
      from: process.env.NOTIFY_EMAIL_FROM || '',
      to: process.env.NOTIFY_EMAIL_TO || '',
    },
  },
};


export function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(config.browser.userDataDir, { recursive: true });
  fs.mkdirSync(config.browser.screenshotDir, { recursive: true });
  fs.mkdirSync(path.dirname(config.database.path), { recursive: true });
}


export function validate() {
  const problems = [];
  if (config.ai.provider === 'cloudflare') {
    if (!config.ai.cloudflare.accountId) problems.push('CF_ACCOUNT_ID is required when AI_PROVIDER=cloudflare');
    if (!config.ai.cloudflare.apiToken) problems.push('CF_API_TOKEN is required when AI_PROVIDER=cloudflare');
  }
  if (config.ai.provider === 'openai-compatible') {
    if (!config.ai.openai.apiKey) problems.push('OPENAI_API_KEY is required when AI_PROVIDER=openai-compatible');
  }
  if (!['stub', 'cloudflare', 'openai-compatible'].includes(config.ai.provider)) {
    problems.push(`Unknown AI_PROVIDER "${config.ai.provider}"`);
  }
  return problems;
}


// Removes obvious secret-shaped values from an object before logging/notifying.
const SECRET_KEY_PATTERN = /token|key|password|pass|secret|cookie|authorization/i;
export function redact(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redact);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SECRET_KEY_PATTERN.test(k) ? '[REDACTED]' : redact(v);
  }
  return out;
}
