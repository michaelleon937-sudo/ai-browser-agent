import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

describe('Composio runtime adapter', () => {
  const originalEnv = { ...process.env };
  let fetchMock;

  beforeEach(() => {
    process.env.COMPOSIO_API_KEY = 'test-key';
    process.env.COMPOSIO_USER_ID = 'test-user';
    process.env.COMPOSIO_HUBSPOT_ACCOUNT_ID = 'hubspot-test';
    process.env.COMPOSIO_GOOGLECALENDAR_ACCOUNT_ID = 'calendar-test';
    process.env.COMPOSIO_XERO_ACCOUNT_ID = 'xero-test';
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  it('allowlists provider operations and sends Composio auth context only', async () => {
    fetchMock.mockImplementation(async (url) => {
      if (String(url).includes('/connected_accounts?')) return new Response(JSON.stringify({ items: [{ id: 'hubspot-test', user_id: 'test-user', toolkit: { slug: 'hubspot' }, status: 'ACTIVE' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ successful: true, data: { id: '123' }, log_id: 'log_test' }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const { executeComposioOperation } = await import('../../integrations/composio-runtime.js');
    const result = await executeComposioOperation({
      provider: 'hubspot',
      operation: 'create_contact',
      args: { email: 'synthetic@example.test', firstname: 'Synthetic' },
      requestId: 'req-1',
      approvalVerified: true,
    });

    expect(result.ok).toBe(true);
    expect(result.toolSlug).toBe('HUBSPOT_CREATE_CONTACT');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/v3.1/tools/execute/HUBSPOT_CREATE_CONTACT');
    const body = JSON.parse(options.body);
    expect(body.connected_account_id).toBe('hubspot-test');
    expect(body.version).toBe('latest');
    expect(body.arguments.email).toBe('synthetic@example.test');
    expect(options.headers['x-api-key']).toBe('test-key');
  });


  it('requires a verified Nexora approval before any provider write', async () => {
    const { executeComposioOperation } = await import('../../integrations/composio-runtime.js');
    await expect(executeComposioOperation({ provider: 'hubspot', operation: 'create_contact', args: { email: 'no-approval@example.test' } }))
      .rejects.toMatchObject({ code: 'COMPOSIO_APPROVAL_REQUIRED', status: 403 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves an ACTIVE Composio account owned by the signed tenant', async () => {
    fetchMock.mockImplementation(async (url) => {
      if (String(url).includes('/connected_accounts?')) return new Response(JSON.stringify({ items: [{ id: 'tenant-hubspot-account', user_id: 'nexora-tenant-tenant-a', toolkit: { slug: 'hubspot' }, status: 'ACTIVE' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ successful: true, data: { id: 'tenant-write' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const { executeComposioOperation } = await import('../../integrations/composio-runtime.js');
    await executeComposioOperation({ provider: 'hubspot', operation: 'create_contact', tenantId: 'tenant-a', approvalVerified: true, args: { email: 'tenant@example.test' } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.connected_account_id).toBe('tenant-hubspot-account');
    expect(body.user_id).toBe('nexora-tenant-tenant-a');
  });

  it('denies unknown providers and operations before network access', async () => {
    const { executeComposioOperation } = await import('../../integrations/composio-runtime.js');
    await expect(executeComposioOperation({
      provider: 'slack',
      operation: 'send_message',
      args: {},
    })).rejects.toMatchObject({ code: 'COMPOSIO_PROVIDER_NOT_ALLOWED', status: 403 });

    await expect(executeComposioOperation({
      provider: 'hubspot',
      operation: 'delete_everything',
      args: {},
    })).rejects.toMatchObject({ code: 'COMPOSIO_OPERATION_NOT_ALLOWED', status: 403 });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when the project key is missing', async () => {
    delete process.env.COMPOSIO_API_KEY;
    const { executeComposioOperation } = await import('../../integrations/composio-runtime.js');
    await expect(executeComposioOperation({
      provider: 'xero',
      operation: 'get_invoice',
      args: { invoice_id: 'x' },
    })).rejects.toMatchObject({ code: 'COMPOSIO_NOT_CONFIGURED', status: 503 });
  });

  it('forces Xero invoice creation to DRAFT only', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ successful: true, data: { InvoiceID: 'i1' } }), { status: 200 }));
    const { xeroCreateDraftInvoice } = await import('../../control/tools/composio.js');
    await expect(xeroCreateDraftInvoice({ Type: 'ACCREC', Status: 'AUTHORISED', LineItems: [] }, {}))
      .rejects.toMatchObject({ code: 'XERO_DRAFT_ONLY', status: 403 });
  });
});
