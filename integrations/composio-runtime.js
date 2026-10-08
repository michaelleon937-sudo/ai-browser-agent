// integrations/composio-runtime.js
// Provider runtime adapter. Raw provider credentials never enter this process.
// Composio owns authentication; the agent only receives a project API key and
// the IDs/aliases of already-connected accounts.

const BASE_URL = String(process.env.COMPOSIO_API_BASE_URL || 'https://backend.composio.dev').replace(/\/$/, '');

const PROVIDER_CONFIG = Object.freeze({
  hubspot: {
    accountEnv: 'COMPOSIO_HUBSPOT_ACCOUNT_ID',
    tools: {
      search_contacts: 'HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA',
      create_contact: 'HUBSPOT_CREATE_CONTACT',
      update_contact: 'HUBSPOT_UPDATE_CONTACT',
      read_contact: 'HUBSPOT_READ_CONTACT',
    },
  },
  googlecalendar: {
    accountEnv: 'COMPOSIO_GOOGLECALENDAR_ACCOUNT_ID',
    tools: {
      create_event: 'GOOGLECALENDAR_CREATE_EVENT',
      get_event: 'GOOGLECALENDAR_EVENTS_GET',
      patch_event: 'GOOGLECALENDAR_PATCH_EVENT',
      delete_event: 'GOOGLECALENDAR_DELETE_EVENT',
    },
  },
  xero: {
    accountEnv: 'COMPOSIO_XERO_ACCOUNT_ID',
    tools: {
      create_draft_invoice: 'XERO_CREATE_INVOICE',
      get_invoice: 'XERO_GET_INVOICE',
    },
  },
});

function configurationError(message) {
  const err = new Error(message);
  err.status = 503;
  err.code = 'COMPOSIO_NOT_CONFIGURED';
  return err;
}

function getConfig(provider, operation) {
  const config = PROVIDER_CONFIG[provider];
  if (!config) {
    const err = new Error(`Unsupported Composio provider: ${provider}`);
    err.status = 403;
    err.code = 'COMPOSIO_PROVIDER_NOT_ALLOWED';
    throw err;
  }
  const toolSlug = config.tools[operation];
  if (!toolSlug) {
    const err = new Error(`Unsupported Composio operation: ${provider}.${operation}`);
    err.status = 403;
    err.code = 'COMPOSIO_OPERATION_NOT_ALLOWED';
    throw err;
  }
  const accountId = process.env[config.accountEnv];
  if (!accountId) {
    throw configurationError(`${config.accountEnv} is not configured`);
  }
  return { toolSlug, accountId };
}

export function composioRuntimeStatus() {
  return {
    configured: Boolean(process.env.COMPOSIO_API_KEY),
    providers: Object.fromEntries(
      Object.entries(PROVIDER_CONFIG).map(([provider, config]) => [
        provider,
        {
          accountConfigured: Boolean(process.env[config.accountEnv]),
          operations: Object.keys(config.tools),
        },
      ]),
    ),
  };
}

export async function executeComposioOperation({ provider, operation, args = {}, requestId = null } = {}) {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) throw configurationError('COMPOSIO_API_KEY is not configured');

  const { toolSlug, accountId } = getConfig(provider, operation);
  const url = `${BASE_URL}/api/v3.1/tools/execute/${encodeURIComponent(toolSlug)}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      connected_account_id: accountId,
      version: 'latest',
      arguments: args,
    }),
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = { error: 'non-json response' };
  }

  if (!response.ok || payload?.successful === false) {
    const err = new Error(
      payload?.error?.message ||
      payload?.error ||
      payload?.message ||
      `Composio tool execution failed with HTTP ${response.status}`,
    );
    err.status = response.status || 502;
    err.code = payload?.error?.code || 'COMPOSIO_TOOL_EXECUTION_FAILED';
    throw err;
  }

  return {
    ok: true,
    provider,
    operation,
    toolSlug,
    requestId,
    logId: payload?.log_id || null,
    data: payload?.data ?? payload,
  };
}

export const COMPOSIO_PROVIDER_CONFIG = PROVIDER_CONFIG;
