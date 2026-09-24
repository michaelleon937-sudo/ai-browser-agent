// integrations/payments/provider.js
// Provider-independent payment abstraction. No real credentials.

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
  async handleWebhook({ body }) {
    if (!body || body.simulate !== true) return { ok: false, verified: false, reason: 'unverified or non-simulated mpesa webhook' };
    const providerPaymentId = body.providerPaymentId;
    const row = mockLedger.get(providerPaymentId);
    if (!row) return { ok: false, verified: false, reason: 'unknown payment' };
    if (body.forceStatus === 'SUCCEEDED') { row.status = 'SUCCEEDED'; mockLedger.set(providerPaymentId, row); }
    else if (body.forceStatus === 'FAILED') { row.status = 'FAILED'; mockLedger.set(providerPaymentId, row); }
    return { ok: true, verified: body.forceStatus === 'SUCCEEDED', eventId: body.eventId || `mpesa_evt_${providerPaymentId}`, eventType: body.eventType || 'payment.status', providerPaymentId, status: row.status, amount: row.amount, currency: row.currency, providerTransactionId: body.forceStatus === 'SUCCEEDED' ? `txn_${providerPaymentId}` : null };
  }
  async refundPayment() { return { ok: false, error: 'refund not implemented in mock' }; }
}

export class MockStripeProvider extends PaymentProvider {
  get name() { return 'stripe'; }
  async createPaymentRequest({ amount, currency, invoiceId, idempotencyKey }) {
    const id = `stripe_${idempotencyKey || invoiceId}_${Date.now()}`;
    mockLedger.set(id, { status: 'PENDING', amount: Number(amount), currency: (currency || 'USD').toUpperCase(), invoiceId, provider: 'stripe' });
    return { ok: true, providerPaymentId: id, status: 'PENDING', checkoutUrl: `https://checkout.stripe.test/mock/${id}` };
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
    if (currency && currency.toUpperCase() !== row.currency) return { ok: false, verified: false, status: row.status, reason: 'currency mismatch' };
    return { ok: true, verified: true, status: 'SUCCEEDED', amount: row.amount, currency: row.currency, providerTransactionId: `ch_${providerPaymentId}` };
  }
  async handleWebhook({ body, headers = {} }) {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (secret) {
      const sig = headers['stripe-signature'] || headers['Stripe-Signature'];
      if (sig !== `mock_sig_${secret}`) return { ok: false, verified: false, reason: 'invalid stripe signature' };
    } else if (!body || body.simulate !== true) {
      return { ok: false, verified: false, reason: 'unverified stripe webhook (no simulate flag)' };
    }
    const providerPaymentId = body.providerPaymentId || body.data?.object?.id;
    const row = mockLedger.get(providerPaymentId);
    if (!row) return { ok: false, verified: false, reason: 'unknown payment' };
    if (body.forceStatus === 'SUCCEEDED' || body.type === 'checkout.session.completed') { row.status = 'SUCCEEDED'; mockLedger.set(providerPaymentId, row); }
    else if (body.forceStatus === 'FAILED') { row.status = 'FAILED'; mockLedger.set(providerPaymentId, row); }
    return { ok: true, verified: row.status === 'SUCCEEDED', eventId: body.eventId || body.id || `stripe_evt_${providerPaymentId}`, eventType: body.eventType || body.type || 'payment_intent.succeeded', providerPaymentId, status: row.status, amount: row.amount, currency: row.currency, providerTransactionId: row.status === 'SUCCEEDED' ? `ch_${providerPaymentId}` : null };
  }
  async refundPayment() { return { ok: false, error: 'refund not implemented in mock' }; }
}

export function getPaymentProvider(name) {
  const n = String(name || '').toLowerCase();
  if (n === 'mpesa') return new MockMpesaProvider();
  if (n === 'stripe') return new MockStripeProvider();
  throw new Error(`Unknown payment provider: ${name}`);
}
