import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

let db;
let invoices;
let payments;
let billingRecords;
let createInvoice;
let sendInvoice;
let billingTools;
let verifyPayment;
let handlePaymentWebhook;
let getPaymentProvider;
let _getMockLedger;
let _resetMockLedger;
let verifyStripeSignature;

const savedEnv = {};

function setEnv(key, value) {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function restoreEnv() {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeAll(async () => {
  const tmp = path.join(os.tmpdir(), 'phase8b-' + Date.now() + '.db');
  process.env.DATABASE_PATH = tmp;
  process.env.DATA_DIR = path.dirname(tmp);
  process.env.AI_PROVIDER = 'stub';
  process.env.PAYMENT_MODE = 'mock';
  process.env.LIVE_PAYMENTS_ENABLED = 'false';

  db = await import('../../database/index.js');
  ({ invoices, payments, billingRecords } = db);
  ({ createInvoice, sendInvoice } = await import('../../integrations/payments/invoice-service.js'));
  ({ billingTools } = await import('../../control/tools/billing.js'));
  ({ verifyPayment, handlePaymentWebhook } = await import('../../integrations/payments/verification.js'));
  ({ getPaymentProvider, _getMockLedger, _resetMockLedger, verifyStripeSignature } = await import('../../integrations/payments/provider.js'));
  db.migrate();
});

beforeEach(() => {
  _resetMockLedger();
  process.env.PAYMENT_MODE = 'mock';
  process.env.LIVE_PAYMENTS_ENABLED = 'false';
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.MPESA_API_URL;
  delete process.env.MPESA_CLIENT_ID;
  delete process.env.MPESA_CLIENT_SECRET;
  delete process.env.MPESA_SHORTCODE;
  delete process.env.MPESA_PASSKEY;
  delete process.env.MPESA_CALLBACK_URL;
  delete process.env.MPESA_CALLBACK_SECRET;
  delete process.env.MPESA_PHONE_NUMBER;
  vi.restoreAllMocks();
});

afterAll(() => {
  restoreEnv();
  try { db.closeDb(); } catch {}
});

describe('Phase 8B payment mode safety', () => {
  it('selects sandbox providers explicitly and never live by default', () => {
    process.env.PAYMENT_MODE = 'sandbox';
    expect(getPaymentProvider('stripe').constructor.name).toBe('SandboxStripeProvider');
    expect(getPaymentProvider('mpesa').constructor.name).toBe('SandboxMpesaProvider');

    process.env.PAYMENT_MODE = 'live';
    expect(() => getPaymentProvider('stripe')).toThrow(/disabled|not implemented/i);
  });

  it('rejects live Stripe keys before network execution', async () => {
    process.env.PAYMENT_MODE = 'sandbox';
    process.env.STRIPE_SECRET_KEY = 'sk_live_test_only';
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await getPaymentProvider('stripe').createPaymentRequest({
      amount: 10, currency: 'USD', invoiceId: 'inv-live-reject',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Live Stripe keys are not allowed/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('Phase 8B Stripe sandbox', () => {
  it('creates a Stripe test PaymentIntent with an idempotency key', async () => {
    process.env.PAYMENT_MODE = 'sandbox';
    process.env.STRIPE_SECRET_KEY = 'sk_test_unit';
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      expect(url).toBe('https://api.stripe.com/v1/payment_intents');
      expect(options.headers.Authorization).toBe('Bearer sk_test_unit');
      expect(options.headers['Idempotency-Key']).toBe('phase8b-stripe-1');
      return new Response(JSON.stringify({ id: 'pi_test_1', status: 'requires_payment_method' }), { status: 200 });
    }));

    const result = await getPaymentProvider('stripe').createPaymentRequest({
      amount: 25, currency: 'USD', invoiceId: 'inv-1', idempotencyKey: 'phase8b-stripe-1',
    });

    expect(result.ok).toBe(true);
    expect(result.providerPaymentId).toBe('pi_test_1');
    expect(result.status).toBe('PENDING');
  });

  it('validates Stripe webhook signatures and rejects invalid signatures', () => {
    const secret = 'whsec_phase8b';
    const raw = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded' });
    const timestamp = Math.floor(Date.now() / 1000);
    const digest = crypto.createHmac('sha256', secret).update(timestamp + '.' + raw).digest('hex');

    expect(verifyStripeSignature(raw, 't=' + timestamp + ',v1=' + digest, secret).ok).toBe(true);
    expect(verifyStripeSignature(raw, 't=' + timestamp + ',v1=bad', secret).ok).toBe(false);
  });

  it('does not verify a Stripe payment unless provider status is succeeded', async () => {
    process.env.PAYMENT_MODE = 'sandbox';
    process.env.STRIPE_SECRET_KEY = 'sk_test_unit';

    const invoice = createInvoice({ subtotal: 10, tax: 0, total: 10, currency: 'USD' });
    sendInvoice(invoice.id);

    const created = await billingTools['payment.create']({
      invoiceId: invoice.id, provider: 'stripe', idempotencyKey: 'phase8b-status-1',
    });

    expect(created.ok).toBe(false);
  });
});

describe('Phase 8B M-Pesa sandbox', () => {
  it('rejects missing sandbox credentials and production endpoints', async () => {
    process.env.PAYMENT_MODE = 'sandbox';
    let result = await getPaymentProvider('mpesa').createPaymentRequest({
      amount: 100, currency: 'KES', invoiceId: 'mp-1',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/credentials incomplete/i);

    process.env.MPESA_API_URL = 'https://api.safaricom.co.ke';
    process.env.MPESA_CLIENT_ID = 'test';
    process.env.MPESA_CLIENT_SECRET = 'test';
    process.env.MPESA_SHORTCODE = '174379';
    process.env.MPESA_PASSKEY = 'test';
    process.env.MPESA_CALLBACK_URL = 'https://example.test/webhooks/mpesa';

    result = await getPaymentProvider('mpesa').createPaymentRequest({
      amount: 100, currency: 'KES', invoiceId: 'mp-2',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/non-sandbox/i);
  });

  it('uses the Daraja sandbox endpoint and refuses to mark a wrong amount successful', async () => {
    process.env.PAYMENT_MODE = 'sandbox';
    process.env.MPESA_API_URL = 'https://sandbox.safaricom.co.ke';
    process.env.MPESA_CLIENT_ID = 'client';
    process.env.MPESA_CLIENT_SECRET = 'secret';
    process.env.MPESA_SHORTCODE = '174379';
    process.env.MPESA_PASSKEY = 'passkey';
    process.env.MPESA_CALLBACK_URL = 'https://example.test/webhooks/mpesa';
    process.env.MPESA_PHONE_NUMBER = '254700000000';

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'sandbox-token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ResponseCode: '0', MerchantRequestID: 'mr_1', CheckoutRequestID: 'ws_CO_1',
      }), { status: 200 })));

    const provider = getPaymentProvider('mpesa');
    const created = await provider.createPaymentRequest({
      amount: 100, currency: 'KES', invoiceId: 'mp-3', idempotencyKey: 'mp-3-key',
    });

    expect(created.ok).toBe(true);
    expect(created.providerPaymentId).toBe('ws_CO_1');

    const ledger = _getMockLedger();
    ledger.get('ws_CO_1').status = 'SUCCEEDED';

    const verification = await provider.verifyPayment({
      providerPaymentId: 'ws_CO_1', amount: 101, currency: 'KES',
    });

    expect(verification.verified).toBe(false);
    expect(verification.reason).toMatch(/amount mismatch/i);
  });

  it('rejects invalid M-Pesa callback authentication and unknown transactions', async () => {
    process.env.PAYMENT_MODE = 'sandbox';
    process.env.MPESA_CALLBACK_SECRET = 'callback-secret';
    const provider = getPaymentProvider('mpesa');

    const invalid = await provider.handleWebhook({
      headers: { 'x-mpesa-signature': 'wrong' },
      body: { providerPaymentId: 'unknown', ResultCode: 0 },
    });
    expect(invalid.ok).toBe(false);

    const unknown = await provider.handleWebhook({
      headers: { 'x-mpesa-signature': 'callback-secret' },
      body: { providerPaymentId: 'unknown', ResultCode: 0 },
    });
    expect(unknown.ok).toBe(false);
    expect(unknown.reason).toMatch(/unknown payment/i);
  });
});

describe('Phase 8B settlement idempotency and execution gate', () => {
  it('settles invoice, creates one billing confirmation, and permits project start only after verification', async () => {
    process.env.PAYMENT_MODE = 'mock';

    const invoice = createInvoice({ subtotal: 80, tax: 0, total: 80, currency: 'USD' });
    sendInvoice(invoice.id);

    const created = await billingTools['payment.create']({
      invoiceId: invoice.id, provider: 'stripe', idempotencyKey: 'phase8b-settle-1',
    });

    const providerPaymentId = created.payment.provider_payment_id;
    _getMockLedger().get(providerPaymentId).status = 'SUCCEEDED';

    const first = await verifyPayment(created.payment.id);
    const second = await verifyPayment(created.payment.id);

    expect(first.verified).toBe(true);
    expect(second.verified).toBe(true);
    expect(payments.get(created.payment.id).status).toBe('SUCCEEDED');
    expect(invoices.get(invoice.id).status).toBe('PAID');

    const confirmations = billingRecords.list({ invoiceId: invoice.id, limit: 100 })
      .filter((r) => r.record_type === 'PAYMENT_CONFIRMED' && r.payment_id === created.payment.id);
    expect(confirmations).toHaveLength(1);

    const project = await billingTools['project.create']({ invoiceId: invoice.id, paymentId: created.payment.id });
    const started = await billingTools['project.start']({ projectId: project.project.id });
    expect(started.project.status).toBe('IN_PROGRESS');
  });

  it('duplicate webhook event is idempotent', async () => {
    process.env.PAYMENT_MODE = 'mock';
    const invoice = createInvoice({ subtotal: 40, tax: 0, total: 40, currency: 'USD' });
    sendInvoice(invoice.id);

    const created = await billingTools['payment.create']({
      invoiceId: invoice.id, provider: 'mpesa', idempotencyKey: 'phase8b-webhook-1',
    });

    const body = {
      simulate: true,
      providerPaymentId: created.payment.provider_payment_id,
      forceStatus: 'SUCCEEDED',
      eventId: 'phase8b-event-1',
    };

    const first = await handlePaymentWebhook({ provider: 'mpesa', body });
    const second = await handlePaymentWebhook({ provider: 'mpesa', body });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.duplicate).toBe(true);
    expect(payments.list({ invoiceId: invoice.id }).filter((p) => p.status === 'SUCCEEDED')).toHaveLength(1);
  });
});
