// integrations/payments/provider.js
import crypto from 'node:crypto';
import { getPaymentMode, assertPaymentExecutionAllowed, redactSecrets } from './mode.js';
import { ProductionDarajaProvider } from '../commercial/daraja-production.js';
import { MockStakabaProvider, SandboxStakabaProvider } from './stakaba.js';

export class PaymentProvider {
  get name() { return 'base'; }
  async createPaymentRequest() { throw new Error('createPaymentRequest not implemented'); }
  async getPaymentStatus() { throw new Error('getPaymentStatus not implemented'); }
  async verifyPayment() { throw new Error('verifyPayment not implemented'); }
  async handleWebhook() { throw new Error('handleWebhook not implemented'); }
  async refundPayment() { throw new Error('refundPayment not implemented'); }
}

const mockLedger = new Map();
export function _resetMockLedger() { mockLedger.clear(); }
export function _getMockLedger() { return mockLedger; }

export class MockMpesaProvider extends PaymentProvider {
  get name() { return 'mpesa'; }
  async createPaymentRequest({ amount, currency, invoiceId, idempotencyKey }) {
    const id = `mpesa_${idempotencyKey || invoiceId}_${Date.now()}`;
    mockLedger.set(id, { status: 'PENDING', amount: Number(amount), currency: currency || 'KES', invoiceId, provider: 'mpesa' });
    return { ok: true, providerPaymentId: id, status: 'PENDING', checkoutUrl: null };
  }
  async getPaymentStatus(providerPaymentId) {
    const row = mockLedger.get(providerPaymentId);
    if (!row) return { ok: false, status: 'UNKNOWN', error: 'not found' };
    return { ok: true, status: row.status, amount: row.amount, currency: row.currency };
  }
  async verifyPayment({ providerPaymentId, amount, currency }) {
    const row = mockLedger.get(providerPaymentId);
    if (!row) return { ok: false, verified: false, status: 'UNKNOWN', reason: 'not found' };
    if (row.status !== 'SUCCEEDED') return { ok: true, verified: false, status: row.status, reason: 'not succeeded at provider' };
    if (Number(amount) !== Number(row.amount)) return { ok: false, verified: false, status: row.status, reason: 'amount mismatch' };
    if (currency && currency !== row.currency) return { ok: false, verified: false, status: row.status, reason: 'currency mismatch' };
    return { ok: true, verified: true, status: 'SUCCEEDED', amount: row.amount, currency: row.currency, providerTransactionId: `txn_${providerPaymentId}` };
  }
  async handleWebhook({ body, headers = {} }) {
    const stk = body?.Body?.stkCallback;
    if (stk && stk.CheckoutRequestID) {
      const checkoutId = String(stk.CheckoutRequestID);
      const row = mockLedger.get(checkoutId);
      if (!row) return { ok: false, verified: false, reason: 'unknown payment' };
      const items = Array.isArray(stk.CallbackMetadata?.Item) ? stk.CallbackMetadata.Item : [];
      const valueOf = (name) => items.find((i) => i && i.Name === name)?.Value;
      const success = Number(stk.ResultCode) === 0;
      const callbackAmount = valueOf('Amount') != null ? Number(valueOf('Amount')) : undefined;
      const receipt = valueOf('MpesaReceiptNumber');
      if (success) {
        if (!Number.isFinite(callbackAmount) || callbackAmount !== Number(row.amount)) {
          return { ok: false, verified: false, reason: 'amount mismatch in M-Pesa callback' };
        }
        if (!receipt) return { ok: false, verified: false, reason: 'missing M-Pesa receipt number' };
        row.status = 'SUCCEEDED';
        row.transactionId = String(receipt);
        mockLedger.set(checkoutId, row);
      } else {
        row.status = 'FAILED';
        mockLedger.set(checkoutId, row);
      }
      const eventId = `${checkoutId}:${stk.ResultCode}:${receipt || ''}`;
      return {
        ok: true,
        verified: success,
        eventId,
        eventType: 'mpesa.stk.callback',
        providerPaymentId: checkoutId,
        status: success ? 'SUCCEEDED' : 'FAILED',
        amount: callbackAmount != null ? callbackAmount : row.amount,
        currency: row.currency,
        providerTransactionId: success ? row.transactionId : null,
      };
    }
    const providerPaymentId = body?.providerPaymentId || body?.CheckoutRequestID;
    const status = body?.status || 'SUCCEEDED';
    if (!providerPaymentId) return { ok: false, verified: false, reason: 'missing providerPaymentId' };
    const row = mockLedger.get(providerPaymentId);
    if (!row) return { ok: false, verified: false, reason: 'unknown payment' };
    if (status === 'SUCCEEDED' || status === 'success') {
      row.status = 'SUCCEEDED';
      row.transactionId = body.transactionId || body.MpesaReceiptNumber || `txn_${providerPaymentId}`;
      mockLedger.set(providerPaymentId, row);
      return {
        ok: true,
        verified: true,
        eventId: `${providerPaymentId}:${row.transactionId}`,
        eventType: 'mpesa.payment',
        providerPaymentId,
        status: 'SUCCEEDED',
        amount: row.amount,
        currency: row.currency,
        providerTransactionId: row.transactionId,
      };
    }
    row.status = 'FAILED';
    mockLedger.set(providerPaymentId, row);
    return {
      ok: true,
      verified: false,
      eventId: `${providerPaymentId}:failed`,
      eventType: 'mpesa.payment',
      providerPaymentId,
      status: 'FAILED',
      amount: row.amount,
      currency: row.currency,
      providerTransactionId: null,
    };
  }
  async refundPayment() { return { ok: false, error: 'refund not implemented in mock' }; }
}

export class MockStripeProvider extends PaymentProvider {
  get name() { return 'stripe'; }
  async createPaymentRequest({ amount, currency, invoiceId, idempotencyKey }) {
    const id = `stripe_${idempotencyKey || invoiceId}_${Date.now()}`;
    mockLedger.set(id, { status: 'PENDING', amount: Number(amount), currency: currency || 'USD', invoiceId, provider: 'stripe' });
    return { ok: true, providerPaymentId: id, status: 'PENDING', checkoutUrl: `https://checkout.stripe.com/mock/${id}` };
  }
  async getPaymentStatus(providerPaymentId) {
    const row = mockLedger.get(providerPaymentId);
    if (!row) return { ok: false, status: 'UNKNOWN', error: 'not found' };
    return { ok: true, status: row.status, amount: row.amount, currency: row.currency };
  }
  async verifyPayment({ providerPaymentId, amount, currency }) {
    const row = mockLedger.get(providerPaymentId);
    if (!row) return { ok: false, verified: false, status: 'UNKNOWN', reason: 'not found' };
    if (row.status !== 'SUCCEEDED') return { ok: true, verified: false, status: row.status, reason: 'not succeeded at provider' };
    if (Number(amount) !== Number(row.amount)) return { ok: false, verified: false, status: row.status, reason: 'amount mismatch' };
    if (currency && currency !== row.currency) return { ok: false, verified: false, status: row.status, reason: 'currency mismatch' };
    return { ok: true, verified: true, status: 'SUCCEEDED', amount: row.amount, currency: row.currency, providerTransactionId: `ch_${providerPaymentId}` };
  }
  async handleWebhook({ body, headers = {}, rawBody }) {
    const eventId = body?.id || body?.eventId || `stripe_${Date.now()}`;
    const obj = body?.data?.object || body;
    const providerPaymentId = obj?.id || body?.providerPaymentId;
    if (!providerPaymentId) return { ok: false, verified: false, reason: 'missing payment id' };
    const row = mockLedger.get(providerPaymentId);
    if (!row) return { ok: false, verified: false, reason: 'unknown payment' };
    const paid = body?.type === 'payment_intent.succeeded' || body?.status === 'succeeded' || obj?.status === 'succeeded';
    if (paid) {
      row.status = 'SUCCEEDED';
      row.transactionId = obj?.latest_charge || `ch_${providerPaymentId}`;
      mockLedger.set(providerPaymentId, row);
    }
    return {
      ok: true,
      verified: paid,
      eventId: String(eventId),
      eventType: body?.type || 'stripe.event',
      providerPaymentId,
      status: paid ? 'SUCCEEDED' : 'PENDING',
      amount: row.amount,
      currency: row.currency,
      providerTransactionId: paid ? row.transactionId : null,
    };
  }
  async refundPayment() { return { ok: false, error: 'refund not implemented in mock' }; }
}

export function verifyStripeSignature(rawBody, signatureHeader, webhookSecret, toleranceSec = 300) {
  if (!webhookSecret || !signatureHeader) return false;
  try {
    const parts = String(signatureHeader).split(',').map((p) => p.trim());
    const tsPart = parts.find((p) => p.startsWith('t='));
    const sigPart = parts.find((p) => p.startsWith('v1='));
    if (!tsPart || !sigPart) return false;
    const ts = Number(tsPart.slice(2));
    if (!Number.isFinite(ts)) return false;
    if (Math.abs(Math.floor(Date.now() / 1000) - ts) > toleranceSec) return false;
    const signed = `${ts}.${rawBody}`;
    const expected = crypto.createHmac('sha256', webhookSecret).update(signed, 'utf8').digest('hex');
    const got = sigPart.slice(3);
    return expected.length === got.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(got));
  } catch {
    return false;
  }
}

export class SandboxStripeProvider extends PaymentProvider {
  get name() { return 'stripe'; }
  _cfg() {
    return {
      secretKey: process.env.STRIPE_SECRET_KEY || '',
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    };
  }
  async createPaymentRequest({ amount, currency, invoiceId, idempotencyKey }) {
    assertPaymentExecutionAllowed();
    const key = this._cfg().secretKey;
    if (!key || !key.startsWith('sk_test_')) {
      return { ok: false, error: 'STRIPE_SECRET_KEY must be sk_test_ in sandbox' };
    }
    const id = `pi_sandbox_${idempotencyKey || invoiceId}_${Date.now()}`;
    mockLedger.set(id, { status: 'PENDING', amount: Number(amount), currency: currency || 'USD', invoiceId, provider: 'stripe' });
    return { ok: true, providerPaymentId: id, status: 'PENDING', checkoutUrl: `https://checkout.stripe.com/c/pay/${id}` };
  }
  async getPaymentStatus(providerPaymentId) {
    const row = mockLedger.get(providerPaymentId);
    if (!row) return { ok: false, status: 'UNKNOWN', error: 'not found' };
    return { ok: true, status: row.status, amount: row.amount, currency: row.currency };
  }
  async verifyPayment({ providerPaymentId, amount, currency }) {
    const row = mockLedger.get(providerPaymentId);
    if (!row) return { ok: false, verified: false, status: 'UNKNOWN', reason: 'not found' };
    if (row.status !== 'SUCCEEDED') return { ok: true, verified: false, status: row.status, reason: 'not succeeded at provider' };
    if (Number(amount) !== Number(row.amount)) return { ok: false, verified: false, status: row.status, reason: 'amount mismatch' };
    if (currency && String(currency).toUpperCase() !== String(row.currency).toUpperCase()) {
      return { ok: false, verified: false, status: row.status, reason: 'currency mismatch' };
    }
    return { ok: true, verified: true, status: 'SUCCEEDED', amount: row.amount, currency: row.currency, providerTransactionId: row.transactionId || `ch_${providerPaymentId}` };
  }
  async handleWebhook({ body, headers = {}, rawBody }) {
    const secret = this._cfg().webhookSecret;
    if (secret) {
      const sig = headers['stripe-signature'] || headers['Stripe-Signature'] || '';
      if (!verifyStripeSignature(rawBody || JSON.stringify(body || {}), sig, secret)) {
        return { ok: false, verified: false, reason: 'invalid stripe signature' };
      }
    }
    const eventId = body?.id || `stripe_${Date.now()}`;
    const obj = body?.data?.object || body;
    const providerPaymentId = obj?.id || body?.providerPaymentId;
    if (!providerPaymentId) return { ok: false, verified: false, reason: 'missing payment id' };
    let row = mockLedger.get(providerPaymentId);
    if (!row) {
      row = { status: 'PENDING', amount: Number(obj?.amount_received || obj?.amount || 0) / 100, currency: (obj?.currency || 'usd').toUpperCase(), provider: 'stripe' };
      mockLedger.set(providerPaymentId, row);
    }
    const paid = body?.type === 'payment_intent.succeeded' || obj?.status === 'succeeded';
    if (paid) {
      row.status = 'SUCCEEDED';
      row.transactionId = obj?.latest_charge || `ch_${providerPaymentId}`;
      if (obj?.amount_received != null) row.amount = Number(obj.amount_received) / 100;
      mockLedger.set(providerPaymentId, row);
    }
    return {
      ok: true,
      verified: paid,
      eventId: String(eventId),
      eventType: body?.type || 'stripe.event',
      providerPaymentId,
      status: paid ? 'SUCCEEDED' : 'PENDING',
      amount: row.amount,
      currency: row.currency,
      providerTransactionId: paid ? row.transactionId : null,
    };
  }
  async refundPayment() { return { ok: false, error: 'refund not implemented in Phase 8B sandbox' }; }
}

export class SandboxMpesaProvider extends PaymentProvider {
  get name() { return 'mpesa'; }
  _cfg() {
    return {
      apiUrl: process.env.MPESA_API_URL || 'https://sandbox.safaricom.co.ke',
      consumerKey: process.env.MPESA_CONSUMER_KEY || process.env.MPESA_CLIENT_ID || '',
      consumerSecret: process.env.MPESA_CONSUMER_SECRET || process.env.MPESA_CLIENT_SECRET || '',
      shortcode: process.env.MPESA_SHORTCODE || process.env.MPESA_BUSINESS_ID || '',
      passkey: process.env.MPESA_PASSKEY || '',
      callbackUrl: process.env.MPESA_CALLBACK_URL || '',
      callbackSecret: process.env.MPESA_CALLBACK_SECRET || '',
      phoneNumber: process.env.MPESA_PHONE_NUMBER || '',
    };
  }
  _requireSandboxCreds() {
    const c = this._cfg();
    const missing = [];
    if (!c.consumerKey) missing.push('MPESA_CONSUMER_KEY');
    if (!c.consumerSecret) missing.push('MPESA_CONSUMER_SECRET');
    if (!c.shortcode) missing.push('MPESA_SHORTCODE');
    if (!c.passkey) missing.push('MPESA_PASSKEY');
    if (!c.callbackUrl) missing.push('MPESA_CALLBACK_URL');
    if (!c.phoneNumber) missing.push('MPESA_PHONE_NUMBER');
    if (missing.length) return { ok: false, error: 'M-Pesa sandbox credentials incomplete (' + missing.join(', ') + ')' };
    return { ok: true, cfg: c };
  }
  async createPaymentRequest({ amount, currency, invoiceId, idempotencyKey }) {
    assertPaymentExecutionAllowed();
    const gate = this._requireSandboxCreds();
    if (!gate.ok) return gate;
    const id = `ws_CO_sandbox_${idempotencyKey || invoiceId}_${Date.now()}`;
    mockLedger.set(id, { status: 'PENDING', amount: Number(amount), currency: currency || 'KES', invoiceId, provider: 'mpesa' });
    return { ok: true, providerPaymentId: id, status: 'PENDING', checkoutUrl: null };
  }
  async getPaymentStatus(providerPaymentId) {
    const row = mockLedger.get(providerPaymentId);
    if (!row) return { ok: false, status: 'UNKNOWN', error: 'not found' };
    return { ok: true, status: row.status, amount: row.amount, currency: row.currency, providerTransactionId: row.transactionId || null };
  }
  async verifyPayment({ providerPaymentId, amount, currency }) {
    const row = mockLedger.get(providerPaymentId);
    if (!row) return { ok: false, verified: false, status: 'UNKNOWN', reason: 'not found' };
    if (row.status !== 'SUCCEEDED') return { ok: true, verified: false, status: row.status, reason: 'not succeeded at provider' };
    if (Number(amount) !== Number(row.amount)) return { ok: false, verified: false, status: row.status, reason: 'amount mismatch' };
    if (currency && String(currency).toUpperCase() !== String(row.currency).toUpperCase()) {
      return { ok: false, verified: false, status: row.status, reason: 'currency mismatch' };
    }
    return { ok: true, verified: true, status: 'SUCCEEDED', amount: row.amount, currency: row.currency, providerTransactionId: row.transactionId || `txn_${providerPaymentId}` };
  }
  async handleWebhook({ body, headers = {} }) {
    if (!body || typeof body !== 'object') return { ok: false, verified: false, reason: 'malformed M-Pesa callback body' };
    const stk = body.Body?.stkCallback;
    if (!stk || !stk.CheckoutRequestID || stk.ResultCode == null) {
      return { ok: false, verified: false, reason: 'malformed M-Pesa STK callback' };
    }
    const checkoutId = String(stk.CheckoutRequestID);
    const row = mockLedger.get(checkoutId);
    if (!row || row.provider !== 'mpesa') return { ok: false, verified: false, reason: 'unknown payment' };
    const items = Array.isArray(stk.CallbackMetadata?.Item) ? stk.CallbackMetadata.Item : [];
    const valueOf = (name) => items.find((i) => i && i.Name === name)?.Value;
    const success = Number(stk.ResultCode) === 0;
    const callbackAmount = valueOf('Amount') != null ? Number(valueOf('Amount')) : undefined;
    const receipt = valueOf('MpesaReceiptNumber');
    if (success) {
      if (!Number.isFinite(callbackAmount) || callbackAmount !== Number(row.amount)) {
        return { ok: false, verified: false, reason: 'amount mismatch in M-Pesa callback' };
      }
      if (!receipt) return { ok: false, verified: false, reason: 'missing M-Pesa receipt number' };
      row.status = 'SUCCEEDED';
      row.transactionId = String(receipt);
      mockLedger.set(checkoutId, row);
    } else {
      row.status = 'FAILED';
      mockLedger.set(checkoutId, row);
    }
    const eventId = String(stk.CheckoutRequestID) + ':' + String(stk.ResultCode) + ':' + String(receipt || '');
    return {
      ok: true,
      verified: success,
      eventId,
      eventType: 'mpesa.stk.callback',
      providerPaymentId: checkoutId,
      status: success ? 'SUCCEEDED' : 'FAILED',
      amount: callbackAmount != null ? callbackAmount : row.amount,
      currency: row.currency,
      providerTransactionId: success ? row.transactionId : null,
    };
  }
  async refundPayment() { return { ok: false, error: 'refund not implemented in Phase 8B sandbox' }; }
}

export function getPaymentProvider(name) {
  const mode = getPaymentMode();
  const n = String(name || '').toLowerCase();
  if (mode === 'mock') {
    if (n === 'mpesa') return new MockMpesaProvider();
    if (n === 'stripe') return new MockStripeProvider();
    if (n === 'stakaba') return new MockStakabaProvider();
    throw new Error(`Unknown payment provider: ${name}`);
  }
  if (mode === 'sandbox') {
    if (n === 'mpesa') return new SandboxMpesaProvider();
    if (n === 'stripe') return new SandboxStripeProvider();
    if (n === 'stakaba') return new SandboxStakabaProvider();
    throw new Error(`Unknown sandbox payment provider: ${name}`);
  }
  if (mode === 'live') {
    if (n === 'mpesa') return new ProductionDarajaProvider();
    if (n === 'stakaba') {
      assertPaymentExecutionAllowed();
      throw new Error('Live Stakaba is not enabled. Keep PAYMENT_MODE=sandbox and STAKABA_ENV=sandbox until explicit authorization.');
    }
    assertPaymentExecutionAllowed();
    throw new Error('Live Stripe providers are not implemented. Use PAYMENT_MODE=mock or PAYMENT_MODE=sandbox.');
  }
  throw new Error('Unsupported PAYMENT_MODE for provider selection');
}

export { getPaymentMode, redactSecrets, ProductionDarajaProvider, MockStakabaProvider, SandboxStakabaProvider };
