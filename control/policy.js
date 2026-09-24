// control/policy.js
// Deny-by-default Control policy. Forbidden actions are never registered.

export const FORBIDDEN_TOOLS = Object.freeze([
  'outreach.send',
  'outreach.send_email',
  'email.send',
  'dm.send',
  'application.submit',
  'tender.submit',
  'payment.charge',
  'purchase.create',
  'money.spend',
  'production.delete',
  'production.database.delete',
  'production.volume.delete',
  'approval.bypass',
  'github.modify_master',
  'render.deploy_production',
]);

export const ALLOWED_TOOLS = Object.freeze([
  'agent.create_task',
  'agent.run_task',
  'agent.get_task',
  'agent.get_run',
  'agent.get_logs',
  'agent.retry_run',
  'agent.health_check',
  'browser.open',
  'browser.inspect',
  'browser.screenshot',
  'browser.extract',
  'browser.click',
  'browser.type',
  'github.inspect_repository',
  'github.read_file',
  'github.run_tests',
  'github.get_test_results',
  'github.modify_file',
  'render.get_status',
  'render.get_logs',
  'render.get_deployments',
  'render.deploy',
  'repair.start',
  'repair.get',
  'repair.advance',
  'outreach.list',
  'outreach.get',
  'outreach.list_pending',
  'outreach.approve',
  'outreach.deny',
  'outreach.send_approved',
  'crm.find_company',
  'crm.find_contact',
  'crm.find_conversation',
  'crm.get_conversation',
  'crm.list_messages',
  'crm.ingest_message',
]);

export const MUTATING_TOOLS = new Set([
  'agent.create_task',
  'agent.run_task',
  'agent.retry_run',
  'browser.open',
  'browser.click',
  'browser.type',
  'github.run_tests',
  'github.modify_file',
  'render.deploy',
  'repair.start',
  'repair.advance',
  'outreach.approve',
  'outreach.deny',
  'outreach.send_approved',
  'crm.ingest_message',
]);

export const TOOLS_REQUIRING_APPROVAL = new Set([
  'browser.click',
  'browser.type',
  'github.modify_file',
  'render.deploy',
  'outreach.approve',
  'outreach.send_approved',
]);

const BLOCKED_HOST_HINTS = [
  'checkout',
  'pay.',
  'payments',
  'stripe.com',
  'paypal.com',
  'squareup.com',
  'adyen.com',
];

export function isForbiddenTool(name) {
  return FORBIDDEN_TOOLS.includes(String(name || ''));
}

export function isAllowedTool(name) {
  return ALLOWED_TOOLS.includes(String(name || ''));
}

export function isMutatingTool(name) {
  return MUTATING_TOOLS.has(String(name || ''));
}

export function requiresApproval(name) {
  return TOOLS_REQUIRING_APPROVAL.has(String(name || ''));
}

export function evaluatePolicy({ toolName, args = {} } = {}) {
  const name = String(toolName || '');
  if (!name) {
    return { allow: false, status: 400, reason: 'tool name required' };
  }
  if (isForbiddenTool(name)) {
    return { allow: false, status: 403, reason: `Tool "${name}" is forbidden and is not registered` };
  }
  if (!isAllowedTool(name)) {
    return { allow: false, status: 403, reason: `Tool "${name}" is not registered` };
  }

  if (name === 'github.modify_file') {
    const branch = String(args.branch || '');
    if (!branch.startsWith('repair/')) {
      return { allow: false, status: 403, reason: 'github.modify_file may only target repair/* branches' };
    }
    if (branch === 'master' || branch === 'main') {
      return { allow: false, status: 403, reason: 'direct default-branch modification is forbidden' };
    }
    if (!args.approved) {
      return { allow: false, status: 403, reason: 'github.modify_file requires explicit approval (approved=true)' };
    }
  }

  if (name === 'render.deploy') {
    const target = String(args.target || args.environment || 'staging').toLowerCase();
    if (target === 'production' || target === 'prod') {
      return { allow: false, status: 403, reason: 'production Render deploy is blocked by default' };
    }
    if (!args.approved) {
      return { allow: false, status: 403, reason: 'render.deploy to staging requires explicit approval (approved=true)' };
    }
  }

  if ((name === 'browser.open' || name === 'browser.click' || name === 'browser.type') && args.url) {
    const hostCheck = checkBrowserHost(args.url);
    if (!hostCheck.allow) return hostCheck;
  }

  return { allow: true, status: 200, reason: 'ok' };
}

export function checkBrowserHost(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (BLOCKED_HOST_HINTS.some((h) => host.includes(h))) {
      return { allow: false, status: 403, reason: `host "${host}" is blocked (payment/checkout)` };
    }
    const fromEnv = process.env.CONTROL_BROWSER_ALLOWLIST;
    const allowlist = (fromEnv != null && fromEnv !== ''
      ? fromEnv
      : 'example.com,github.com,wikipedia.org,tavily.com')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (allowlist.length && !allowlist.some((d) => host === d || host.endsWith(`.${d}`))) {
      return { allow: false, status: 403, reason: `host "${host}" is not on CONTROL_BROWSER_ALLOWLIST` };
    }
    return { allow: true, status: 200, reason: 'ok' };
  } catch {
    return { allow: false, status: 400, reason: 'invalid URL' };
  }
}
