// integrations/composio-runtime.js
// Provider runtime adapter. Raw provider credentials never enter this process.
// Composio owns authentication; the agent only receives a project API key and
// the IDs/aliases of already-connected accounts.

const BASE_URL = String(process.env.COMPOSIO_API_BASE_URL || 'https://backend.composio.dev').replace(/\/$/, '');

const PROVIDER_CONFIG = Object.freeze({
  hubspot: { accountEnv: 'COMPOSIO_HUBSPOT_ACCOUNT_ID', tools: { search_contacts: 'HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA', create_contact: 'HUBSPOT_CREATE_CONTACT', update_contact: 'HUBSPOT_UPDATE_CONTACT', read_contact: 'HUBSPOT_READ_CONTACT' } },
  googlecalendar: { accountEnv: 'COMPOSIO_GOOGLECALENDAR_ACCOUNT_ID', tools: { create_event: 'GOOGLECALENDAR_CREATE_EVENT', get_event: 'GOOGLECALENDAR_EVENTS_GET', patch_event: 'GOOGLECALENDAR_PATCH_EVENT', delete_event: 'GOOGLECALENDAR_DELETE_EVENT' } },
  xero: { accountEnv: 'COMPOSIO_XERO_ACCOUNT_ID', tools: { create_draft_invoice: 'XERO_CREATE_INVOICE', get_invoice: 'XERO_GET_INVOICE' } },
});

function configurationError(message) {
  const err = new Error(message); err.status = 503; err.code = 'COMPOSIO_NOT_CONFIGURED'; return err;
}

function getConfig(provider, operation) {
  const config = PROVIDER_CONFIG[provider];
  if (!config) { const err = new Error(`Unsupported Composio provider: ${provider}`); err.status = 403; err.code = 'COMPOSIO_PROVIDER_NOT_ALLOWED'; throw err; }
  const toolSlug = config.tools[operation];
  if (!toolSlug) { const err = new Error(`Unsupported Composio operation: ${provider}.${operation}`); err.status = 403; err.code = 'COMPOSIO_OPERATION_NOT_ALLOWED'; throw err; }
  const configuredAccountId = process.env[config.accountEnv] || null;
  return { toolSlug, configuredAccountId };
}

async function resolveTenantConnectedAccount(apiKey, userId, provider, configuredAccountId = null) {
  const response = await fetch(`${BASE_URL}/api/v3.1/connected_accounts?limit=100&account_type=ALL`, { headers: { 'x-api-key': apiKey, accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw configurationError(`Unable to resolve the ${provider} account for this tenant (HTTP ${response.status})`);
  const payload = await response.json().catch(() => ({}));
  const root = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  const items = Array.isArray(root?.items) ? root.items : Array.isArray(payload?.items) ? payload.items : [];
  const expectedToolkit = provider === 'googlecalendar' ? 'googlecalendar' : provider;
  let matches = items.filter((item) => {
    const slug = String(item?.toolkit?.slug || item?.toolkit_slug || '').toLowerCase().replace(/[_-]/g, '');
    return item?.user_id === userId && slug === expectedToolkit && String(item?.status || '').toUpperCase() === 'ACTIVE';
  });
  if (configuredAccountId) matches = matches.filter((item) => item?.id === configuredAccountId);
  if (matches.length !== 1 || typeof matches[0]?.id !== 'string') {
    const err = new Error(matches.length > 1 ? `Multiple active ${provider} accounts exist for this tenant; select one explicitly` : `No active ${provider} connected account belongs to this tenant`);
    err.status = matches.length > 1 ? 409 : 403; err.code = 'COMPOSIO_TENANT_ACCOUNT_NOT_RESOLVED'; throw err;
  }
  return matches[0].id;
}

export async function migrateComposioConnectionsToShared() {
  const apiKey = process.env.COMPOSIO_API_KEY;
  const userId = process.env.COMPOSIO_USER_ID;
  if (!apiKey) throw configurationError('COMPOSIO_API_KEY is not configured');
  if (!userId) throw configurationError('COMPOSIO_USER_ID is not configured');
  const results = {};
  for (const [provider, config] of Object.entries(PROVIDER_CONFIG)) {
    const accountId = process.env[config.accountEnv];
    if (!accountId) { results[provider] = { ok: false, error: `${config.accountEnv} is not configured` }; continue; }
    const url = `${BASE_URL}/api/v3.1/connected_accounts/${encodeURIComponent(accountId)}`;
    const getResponse = await fetch(url, { headers: { 'x-api-key': apiKey } });
    const current = await getResponse.json().catch(() => ({}));
    if (!getResponse.ok) throw new Error(current?.error?.message || current?.message || `Failed to inspect ${provider} connected account`);
    const patchBody = {
      experimental: {
        account_type: 'SHARED',
        acl_config_for_shared: { allow_all_users: false, allowed_user_ids: [userId] },
      },
    };
    const patchResponse = await fetch(url, {
      method: 'PATCH',
      headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(patchBody),
    });
    const patched = await patchResponse.json().catch(() => ({}));
    if (!patchResponse.ok) throw new Error(patched?.error?.message || patched?.message || `Failed to share ${provider} connected account`);
    results[provider] = { ok: true, accountId, accountType: patched?.experimental?.account_type || 'SHARED', allowedUserIds: [userId] };
  }
  return results;
}

export async function composioRuntimeStatus() {
  const status = {
    configured: Boolean(process.env.COMPOSIO_API_KEY),
    userConfigured: Boolean(process.env.COMPOSIO_USER_ID),
    providers: Object.fromEntries(Object.entries(PROVIDER_CONFIG).map(([provider, config]) => [provider, { accountConfigured: Boolean(process.env[config.accountEnv]), operations: Object.keys(config.tools) }])),
  };
  if (process.env.COMPOSIO_MIGRATE_CONNECTIONS === '1') status.connectionMigration = await migrateComposioConnectionsToShared();
  return status;
}

export async function executeComposioOperation({ provider, operation, args = {}, requestId = null, tenantId = null } = {}) {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) throw configurationError('COMPOSIO_API_KEY is not configured');
  const userId = tenantId ? `nexora-tenant-${tenantId}` : process.env.COMPOSIO_USER_ID;
  if (!userId) throw configurationError('Verified tenant identity or COMPOSIO_USER_ID is required');
  const { toolSlug, configuredAccountId } = getConfig(provider, operation);
  const accountId = await resolveTenantConnectedAccount(apiKey, userId, provider, configuredAccountId);
  const url = `${BASE_URL}/api/v3.1/tools/execute/${encodeURIComponent(toolSlug)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ connected_account_id: accountId, user_id: userId, version: 'latest', arguments: args }),
  });
  let payload = null;
  try { payload = await response.json(); } catch { payload = { error: 'non-json response' }; }
  if (!response.ok || payload?.successful === false) {
    const err = new Error(payload?.error?.message || payload?.error || payload?.message || `Composio tool execution failed with HTTP ${response.status}`);
    err.status = response.status || 502; err.code = payload?.error?.code || 'COMPOSIO_TOOL_EXECUTION_FAILED'; throw err;
  }
  return { ok: true, provider, operation, toolSlug, requestId, logId: payload?.log_id || null, data: payload?.data ?? payload };
}
export const COMPOSIO_PROVIDER_CONFIG = PROVIDER_CONFIG;
