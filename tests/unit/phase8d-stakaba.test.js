// tests/unit/phase8d-stakaba.test.js
// Phase 8D — Stakaba Tanzania payment provider (mock + safety)

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

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
    assert.equal(p.name, 'stakaba');
  });

  it('getPaymentProvider returns stakaba in mock mode', () => {
    process.env.PAYMENT_MODE = 'mock';
    const p = getPaymentProvider('stakaba');
    assert.equal(p.name, 'stakaba');
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
    assert.equal(r.ok, false);
    assert.match(String(r.error), /STAKABA_API_KEY/);
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
    assert.equal(r.ok, false);
    assert.match(String(r.error), /Live|sk_live_/i);
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
    assert.equal(r.ok, true);
    assert.ok(r.providerPaymentId);
    assert.equal(r.status, 'PENDING');
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
    assert.equal(r.ok, true);
    assert.ok(r.checkoutUrl);
    assert.match(r.checkoutUrl, /checkout\.stakaba\.com/);
  });

  it('rejects non-TZS currency', async () => {
    const p = new MockStakabaProvider();
    const r = await p.createPaymentRequest({
      amount: 1000,
      currency: 'USD',
      mobileNumber: '255742000331',
      network: 'Mpesa',
    });
    assert.equal(r.ok, false);
  });

  it('normalizePhone maps local formats to 255', () => {
    assert.equal(normalizePhone('0742000331'), '255742000331');
    assert.equal(normalizePhone('+255742000331'), '255742000331');
    assert.equal(normalizePhone('255742000331'), '255742000331');
  });

  it('mapStakabaStatus maps SUCCESS to SUCCEEDED', () => {
    assert.equal(mapStakabaStatus('SUCCESS'), 'SUCCEEDED');
    assert.equal(mapStakabaStatus('FAILED'), 'FAILED');
    assert.equal(mapStakabaStatus('PENDING'), 'PENDING');
    assert.equal(mapStakabaStatus('weird'), 'UNKNOWN');
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
    assert.equal(wh.ok, true);
    assert.equal(wh.verified, true);
    assert.equal(wh.status, 'SUCCEEDED');
    assert.equal(wh.providerTransactionId, 'MPESA12345');

    const v = await p.verifyPayment({
      providerPaymentId: created.providerPaymentId,
      amount: 5000,
      currency: 'TZS',
    });
    assert.equal(v.ok, true);
    assert.equal(v.verified, true);
    assert.equal(v.providerTransactionId, 'MPESA12345');

    assert.equal(
      canMarkCompleted({
        providerVerified: v.verified,
        providerTransactionId: v.providerTransactionId,
        amountMatch: true,
        currencyMatch: true,
      }),
      true,
    );
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
    assert.equal(wh.ok, false);
    assert.match(String(wh.reason), /amount mismatch/i);
    assert.equal(
      canMarkCompleted({
        providerVerified: false,
        providerTransactionId: 'X1',
        amountMatch: false,
        currencyMatch: true,
      }),
      false,
    );
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
    assert.equal(wh.ok, false);
    assert.match(String(wh.reason), /currency mismatch/i);
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
    assert.equal(wh.ok, false);
    assert.match(String(wh.reason), /unknown payment/i);
  });

  it('malformed callback rejected', async () => {
    const p = new MockStakabaProvider();
    const a = await p.handleWebhook({ body: null });
    assert.equal(a.ok, false);
    const b = await p.handleWebhook({ body: [] });
    assert.equal(b.ok, false);
    const c = await p.handleWebhook({ body: { status: 'SUCCESS' } });
    assert.equal(c.ok, false);
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
    assert.equal(wh.ok, true);
    assert.equal(wh.verified, false);
    assert.equal(wh.status, 'FAILED');
    const v = await p.verifyPayment({
      providerPaymentId: created.providerPaymentId,
      amount: 1000,
      currency: 'TZS',
    });
    assert.equal(v.verified, false);
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
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(a.eventId, b.eventId);
  });

  it('COMPLETED hard gate requires all four conditions', () => {
    assert.equal(
      canMarkCompleted({
        providerVerified: true,
        providerTransactionId: 't1',
        amountMatch: true,
        currencyMatch: true,
      }),
      true,
    );
    assert.equal(
      canMarkCompleted({
        providerVerified: true,
        providerTransactionId: '',
        amountMatch: true,
        currencyMatch: true,
      }),
      false,
    );
    assert.equal(
      canMarkCompleted({
        providerVerified: false,
        providerTransactionId: 't1',
        amountMatch: true,
        currencyMatch: true,
      }),
      false,
    );
  });

  it('secret redaction does not echo keys', () => {
    const redacted = redactSecrets('sk_test_abcdefghijklmnop');
    assert.notEqual(redacted, 'sk_test_abcdefghijklmnop');
    assert.ok(String(redacted).includes('***'));
  });

  it('live payment remains disabled for stakaba', () => {
    process.env.PAYMENT_MODE = 'live';
    process.env.LIVE_PAYMENTS_ENABLED = 'false';
    assert.throws(() => getPaymentProvider('stakaba'), /LIVE|not enabled|disabled|blocked/i);
  });

  it('refund not enabled', async () => {
    const p = new MockStakabaProvider();
    const r = await p.refundPayment({ providerPaymentId: 'x' });
    assert.equal(r.ok, false);
  });
});
