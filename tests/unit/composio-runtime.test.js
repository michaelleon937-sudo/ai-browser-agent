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
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      successful: true,
      data: { id: '123' },
      log_id: 'log_test',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const { executeComposioOperation } = await import('../../integrations/composio-runtime.js');
    const result = await executeComposioOperation({
      provider: 'hubspot',
      operation: 'create_contact',
      args: { email: 'synthetic@example.test', firstname: 'Synthetic' },
      requestId: 'req-1',
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
