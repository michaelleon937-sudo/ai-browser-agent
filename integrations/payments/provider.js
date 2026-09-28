// integrations/payments/provider.js
import crypto from 'node:crypto';
import { getPaymentMode, assertPaymentExecutionAllowed, redactSecrets } from './mode.js';
import { ProductionDarajaProvider } from '../commercial/daraja-production.js';

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
    // Support both simulate fixtures and real Daraja STK callback shape
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
