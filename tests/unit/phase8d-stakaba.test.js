// tests/unit/phase8d-stakaba.test.js
// Phase 8D — Stakaba Tanzania payment provider (mock + safety)

import { describe, it, expect, beforeEach } from 'vitest';

import {
  MockStakabaProvider,
  SandboxStakabaProvider,
  _resetStakabaLedger,
  normalizePhone,
  mapStakabaStatus,
} from '../../integrations/payments/stakaba.js';
import { getPaymentProvider } from '../../integrations/payments/provider.js';
import { canMarkCompleted } from '../../integrations/commercial/payment-machine.js';
import { redactSecrets } from '../../integrations/payments/mode.js';

describe('Phase 8D Stakaba', () => {
  beforeEach(() => {
    _resetStakabaLedger();
    process.env.PAYMENT_MODE = 'mock';
    process.env.LIVE_PAYMENTS_ENABLED = 'false';
    process.env.STAKABA_ENV = 'sandbox';
  });

  it('provider construction (mock)', () => {
    const p = new MockStakabaProvider();
    expect(p.name).toBe('stakaba');
  });

  it('getPaymentProvider returns stakaba in mock mode', () => {
    process.env.PAYMENT_MODE = 'mock';
    const p = getPaymentProvider('stakaba');
    expect(p.name).toBe('stakaba');
  });

  it('sandbox configuration requires sk_test_ key', async () => {
    process.env.PAYMENT_MODE = 'sandbox';
    delete process.env.STAKABA_API_KEY;
    const p = new SandboxStakabaProvider();
    const r = await p.createPaymentRequest({
      amount: 1000,
      currency: 'TZS',
      mobileNumber: '255742000331',
      network: 'Mpesa',
    });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/STAKABA_API_KEY/);
  });

  it('sandbox rejects sk_live_ while live disabled', async () => {
    process.env.PAYMENT_MODE = 'sandbox';
    process.env.STAKABA_API_KEY = 'sk_live_fake';
    process.env.LIVE_PAYMENTS_ENABLED = 'false';
    const p = new SandboxStakabaProvider();
    const r = await p.createPaymentRequest({
      amount: 1000,
      currency: 'TZS',
      mobileNumber: '255742000331',
      network: 'Mpesa',
    });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/Live|sk_live_/i);
  });

  it('checkout creation (mock collection)', async () => {
    const p = new MockStakabaProvider();
    const r = await p.createPaymentRequest({
      amount: 5000,
      currency: 'TZS',
      invoiceId: 'inv_1',
      mobileNumber: '0742000331',
      network: 'Mpesa',
      metadata: { orderId: 'ORD-1' },
    });
    expect(r.ok).toBe(true);
    expect(r.providerPaymentId).toBeTruthy();
    expect(r.status).toBe('PENDING');
  });

  it('card channel returns checkoutUrl (mock)', async () => {
    const p = new MockStakabaProvider();
    const r = await p.createPaymentRequest({
      amount: 120000,
      currency: 'TZS',
      invoiceId: 'inv_card',
      channel: 'card',
      customerEmail: 'jane@example.com',
      customerName: 'Jane Doe',
      customerPhone: '255742000331',
    });
    expect(r.ok).toBe(true);
    expect(r.checkoutUrl).toBeTruthy();
    expect(r.checkoutUrl).toMatch(/checkout\.stakaba\.com/);
  });

  it('rejects non-TZS currency', async () => {
    const p = new MockStakabaProvider();
    const r = await p.createPaymentRequest({
      amount: 1000,
      currency: 'USD',
      mobileNumber: '255742000331',
      network: 'Mpesa',
    });
    expect(r.ok).toBe(false);
  });

  it('normalizePhone maps local formats to 255', () => {
    expect(normalizePhone('0742000331')).toBe('255742000331');
    expect(normalizePhone('+255742000331')).toBe('255742000331');
    expect(normalizePhone('255742000331')).toBe('255742000331');
  });

  it('mapStakabaStatus maps SUCCESS to SUCCEEDED', () => {
    expect(mapStakabaStatus('SUCCESS')).toBe('SUCCEEDED');
    expect(mapStakabaStatus('FAILED')).toBe('FAILED');
    expect(mapStakabaStatus('PENDING')).toBe('PENDING');
    expect(mapStakabaStatus('weird')).toBe('UNKNOWN');
  });

  it('successful payment via webhook + verify', async () => {
    const p = new MockStakabaProvider();
    const created = await p.createPaymentRequest({
      amount: 5000,
      currency: 'TZS',
      invoiceId: 'inv_ok',
      mobileNumber: '255742000331',
      network: 'Mpesa',
    });
    const wh = await p.handleWebhook({
      body: {
        event: 'transaction.success',
        internalReference: created.providerPaymentId,
        status: 'SUCCESS',
        type: 'COLLECTION',
        grossAmount: 5000,
        currency: 'TZS',
        providerReference: 'MPESA12345',
        createdAt: '2026-06-05T14:22:00Z',
      },
    });
    expect(wh.ok).toBe(true);
    expect(wh.verified).toBe(true);
    expect(wh.status).toBe('SUCCEEDED');
    expect(wh.providerTransactionId).toBe('MPESA12345');

    const v = await p.verifyPayment({
      providerPaymentId: created.providerPaymentId,
      amount: 5000,
      currency: 'TZS',
    });
    expect(v.ok).toBe(true);
    expect(v.verified).toBe(true);
    expect(v.providerTransactionId).toBe('MPESA12345');

    expect(
      canMarkCompleted({
        providerVerified: v.verified,
        providerTransactionId: v.providerTransactionId,
        amountMatch: true,
        currencyMatch: true,
      }),
    ).toBe(true);
  });

  it('wrong amount rejects completion', async () => {
    const p = new MockStakabaProvider();
    const created = await p.createPaymentRequest({
      amount: 5000,
      currency: 'TZS',
      invoiceId: 'inv_amt',
      mobileNumber: '255742000331',
      network: 'Mpesa',
    });
    const wh = await p.handleWebhook({
      body: {
        event: 'transaction.success',
        internalReference: created.providerPaymentId,
        status: 'SUCCESS',
        grossAmount: 4000,
        currency: 'TZS',
        providerReference: 'X1',
      },
    });
    expect(wh.ok).toBe(false);
    expect(String(wh.reason)).toMatch(/amount mismatch/i);
    expect(
      canMarkCompleted({
        providerVerified: false,
        providerTransactionId: 'X1',
        amountMatch: false,
        currencyMatch: true,
      }),
    ).toBe(false);
  });

  it('wrong currency rejects', async () => {
    const p = new MockStakabaProvider();
    const created = await p.createPaymentRequest({
      amount: 5000,
      currency: 'TZS',
      invoiceId: 'inv_cur',
      mobileNumber: '255742000331',
      network: 'Mpesa',
    });
    const wh = await p.handleWebhook({
      body: {
        event: 'transaction.success',
        internalReference: created.providerPaymentId,
        status: 'SUCCESS',
        grossAmount: 5000,
        currency: 'KES',
        providerReference: 'X2',
      },
    });
    expect(wh.ok).toBe(false);
    expect(String(wh.reason)).toMatch(/currency mismatch/i);
  });

  it('unknown payment rejected', async () => {
    const p = new MockStakabaProvider();
    const wh = await p.handleWebhook({
      body: {
        event: 'transaction.success',
        internalReference: 'does-not-exist',
        status: 'SUCCESS',
        grossAmount: 1000,
        currency: 'TZS',
      },
    });
    expect(wh.ok).toBe(false);
    expect(String(wh.reason)).toMatch(/unknown payment/i);
  });

  it('malformed callback rejected', async () => {
    const p = new MockStakabaProvider();
    const a = await p.handleWebhook({ body: null });
    expect(a.ok).toBe(false);
    const b = await p.handleWebhook({ body: [] });
    expect(b.ok).toBe(false);
    const c = await p.handleWebhook({ body: { status: 'SUCCESS' } });
    expect(c.ok).toBe(false);
  });

  it('failed payment does not complete', async () => {
    const p = new MockStakabaProvider();
    const created = await p.createPaymentRequest({
      amount: 1000,
      currency: 'TZS',
      invoiceId: 'inv_fail',
      mobileNumber: '255000000001',
      network: 'Mpesa',
    });
    const wh = await p.handleWebhook({
      body: {
        event: 'transaction.failed',
        internalReference: created.providerPaymentId,
        status: 'FAILED',
        grossAmount: 1000,
        currency: 'TZS',
      },
    });
    expect(wh.ok).toBe(true);
    expect(wh.verified).toBe(false);
    expect(wh.status).toBe('FAILED');
    const v = await p.verifyPayment({
      providerPaymentId: created.providerPaymentId,
      amount: 1000,
      currency: 'TZS',
    });
    expect(v.verified).toBe(false);
  });

  it('duplicate webhook is deterministic (same eventId)', async () => {
    const p = new MockStakabaProvider();
    const created = await p.createPaymentRequest({
      amount: 2000,
      currency: 'TZS',
      invoiceId: 'inv_dup',
      mobileNumber: '255742000331',
      network: 'Mpesa',
    });
    const payload = {
      event: 'transaction.success',
      internalReference: created.providerPaymentId,
      status: 'SUCCESS',
      grossAmount: 2000,
      currency: 'TZS',
      providerReference: 'DUP1',
      createdAt: '2026-01-01T00:00:00Z',
    };
    const a = await p.handleWebhook({ body: payload });
    const b = await p.handleWebhook({ body: payload });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a.eventId).toBe(b.eventId);
  });

  it('COMPLETED hard gate requires all four conditions', () => {
    expect(
      canMarkCompleted({
        providerVerified: true,
        providerTransactionId: 't1',
        amountMatch: true,
        currencyMatch: true,
      }),
    ).toBe(true);
    expect(
      canMarkCompleted({
        providerVerified: true,
        providerTransactionId: '',
        amountMatch: true,
        currencyMatch: true,
      }),
    ).toBe(false);
    expect(
      canMarkCompleted({
        providerVerified: false,
        providerTransactionId: 't1',
        amountMatch: true,
        currencyMatch: true,
      }),
    ).toBe(false);
  });

  it('secret redaction does not echo keys', () => {
    const redacted = redactSecrets('sk_test_abcdefghijklmnop');
    expect(redacted).not.toBe('sk_test_abcdefghijklmnop');
    expect(String(redacted)).toMatch(/\*\*\*/);
  });

  it('live payment remains disabled for stakaba', () => {
    process.env.PAYMENT_MODE = 'live';
    process.env.LIVE_PAYMENTS_ENABLED = 'false';
    expect(() => getPaymentProvider('stakaba')).toThrow(/LIVE|not enabled|disabled|blocked/i);
  });

  it('refund not enabled', async () => {
    const p = new MockStakabaProvider();
    const r = await p.refundPayment({ providerPaymentId: 'x' });
    expect(r.ok).toBe(false);
  });
});
