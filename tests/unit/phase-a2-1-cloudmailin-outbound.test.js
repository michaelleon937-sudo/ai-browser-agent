// tests/unit/phase-a2-1-cloudmailin-outbound.test.js
import { afterAll, describe, expect, it, vi } from 'vitest';

const CLOUDMAILIN_ENV_KEYS = [
  'CLOUDMAILIN_OUTBOUND_ACCOUNT_ID',
  'CLOUDMAILIN_OUTBOUND_API_TOKEN',
  'CLOUDMAILIN_OUTBOUND_FROM',
  'CLOUDMAILIN_OUTBOUND_TEST_MODE',
];

afterAll(() => {
  for (const key of CLOUDMAILIN_ENV_KEYS) delete process.env[key];
});

describe('CloudMailin outbound adapter', () => {
  it('uses the documented messages endpoint, bearer auth, and thread headers', async () => {
    vi.resetModules();
    process.env.CLOUDMAILIN_OUTBOUND_ACCOUNT_ID = 'acct-test';
    process.env.CLOUDMAILIN_OUTBOUND_API_TOKEN = 'api-token';
    process.env.CLOUDMAILIN_OUTBOUND_FROM = 'Agent <agent@example.com>';
    process.env.CLOUDMAILIN_OUTBOUND_TEST_MODE = 'true';

    const { sendCloudMailinMessage } = await import('../../integrations/cloudmailin-outbound.js');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'provider-123' }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    }));

    const result = await sendCloudMailinMessage({
      deliveryId: 'delivery-1',
      to: 'customer@example.com',
      subject: 'Re: Hello',
      plain: 'Hello customer',
      conversationId: null,
      fetchImpl: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.cloudmailin.com/api/v0.1/acct-test/messages');
    expect(options.headers.Authorization).toBe('Bearer api-token');

    const payload = JSON.parse(options.body);
    expect(payload.test_mode).toBe(true);
    expect(payload.to).toEqual(['customer@example.com']);
    expect(payload.headers['Message-ID']).toContain('<delivery-1@');
    expect(result.providerMessageId).toBe('provider-123');
  });

  it('fails closed when outbound credentials are incomplete', async () => {
    vi.resetModules();
    process.env.CLOUDMAILIN_OUTBOUND_ACCOUNT_ID = '';
    process.env.CLOUDMAILIN_OUTBOUND_API_TOKEN = '';
    process.env.CLOUDMAILIN_OUTBOUND_FROM = '';

    const { cloudMailinConfigured } = await import('../../integrations/cloudmailin-outbound.js');
    expect(cloudMailinConfigured()).toBe(false);
  });

  it('exposes the authenticated delivery-events webhook route', async () => {
    const { CLOUDMAILIN_OUTBOUND_EVENTS_ROUTE } =
      await import('../../integrations/cloudmailin-events-webhook.js');
    expect(CLOUDMAILIN_OUTBOUND_EVENTS_ROUTE).toBe('/api/outbound/email/cloudmailin/events');
  });
});
