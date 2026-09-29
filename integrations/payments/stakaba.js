// integrations/payments/stakaba.js
// Stakaba Tanzania — mock + sandbox gate (official API: https://docs.stakaba.com/)
// Base: https://api.stakaba.com | Auth: x-api-key (sk_test_ only until live approved)

import { assertPaymentExecutionAllowed } from './mode.js';

const ledger = new Map();
export function _resetStakabaLedger() { ledger.clear(); }
export function _getStakabaLedger() { return ledger; }

export function normalizePhone(phone) {
  if (phone == null) return '';
  let s = String(phone).replace(/[\s+\-]/g, '');
  if (s.startsWith('0') && s.length === 10) s = '255' + s.slice(1);
  return s;
}

export function mapStakabaStatus(raw) {
  const s = String(raw || '').toUpperCase();
  if (['SUCCESS', 'SUCCEEDED', 'PAID', 'COMPLETED'].includes(s)) return 'SUCCEEDED';
  if (['FAILED', 'FAILURE', 'CANCELLED', 'CANCELED'].includes(s)) return 'FAILED';
  if (['PENDING', 'PROCESSING', 'CREATED'].includes(s)) return 'PENDING';
  return 'UNKNOWN';
}

export class MockStakabaProvider {
  get name() { return 'stakaba'; }
  async createPaymentRequest({ amount, currency = 'TZS', invoiceId, mobileNumber, network = 'Mpesa', channel = 'collection', customerEmail, customerName, customerPhone, metadata = {} } = {}) {
    const id = `stakaba_${invoiceId || 'x'}_${Date.now()}`;
    const gross = Math.round(Number(amount));
    if (!Number.isFinite(gross) || gross <= 0) return { ok: false, error: 'invalid amount' };
    if (String(currency).toUpperCase() !== 'TZS') return { ok: false, error: 'Stakaba supports TZS only' };
    ledger.set(id, { status: 'PENDING', amount: gross, currency: 'TZS', invoiceId, provider: 'stakaba', network });
    return {
      ok: true,
      providerPaymentId: id,
      status: 'PENDING',
      checkoutUrl: channel === 'card' ? `https://checkout.stakaba.com/pay/mock/${id}` : null,
      internalReference: id,
    };
  }
  async getPaymentStatus(id) {
    const row = ledger.get(id);
    if (!row) return { ok: false, status: 'UNKNOWN', error: 'not found' };
    return { ok: true, status: row.status, amount: row.amount, currency: row.currency, providerTransactionId: row.transactionId || null };
  }
  async verifyPayment({ providerPaymentId, amount, currency }) {
    const row = ledger.get(providerPaymentId);
    if (!row) return { ok: false, verified: false, status: 'UNKNOWN', reason: 'not found' };
    if (row.status !== 'SUCCEEDED') return { ok: true, verified: false, status: row.status, reason: 'not succeeded at provider' };
    if (Number(amount) !== Number(row.amount)) return { ok: false, verified: false, status: row.status, reason: 'amount mismatch' };
    if (currency && String(currency).toUpperCase() !== 'TZS') return { ok: false, verified: false, status: row.status, reason: 'currency mismatch' };
    return { ok: true, verified: true, status: 'SUCCEEDED', amount: row.amount, currency: row.currency, providerTransactionId: row.transactionId || `txn_${providerPaymentId}` };
  }
  async handleWebhook({ body } = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, verified: false, reason: 'malformed Stakaba webhook body' };
    const ref = body.internalReference || body.providerPaymentId || body.reference;
    if (!ref) return { ok: false, verified: false, reason: 'missing internalReference' };
    const row = ledger.get(String(ref));
    if (!row || row.provider !== 'stakaba') return { ok: false, verified: false, reason: 'unknown payment' };
    const event = String(body.event || '').toLowerCase();
    const mapped = mapStakabaStatus(body.status || (event.includes('success') ? 'SUCCESS' : event.includes('fail') ? 'FAILED' : ''));
    const gross = body.grossAmount != null ? Number(body.grossAmount) : Number(row.amount);
    const currency = String(body.currency || 'TZS').toUpperCase();
    if (mapped === 'SUCCEEDED') {
      if (!Number.isFinite(gross) || gross !== Number(row.amount)) return { ok: false, verified: false, reason: 'amount mismatch in Stakaba webhook' };
      if (currency !== 'TZS') return { ok: false, verified: false, reason: 'currency mismatch in Stakaba webhook' };
      row.transactionId = String(body.providerReference || body.providerTransactionId || `mock_${ref}`);
      row.status = 'SUCCEEDED';
      ledger.set(String(ref), row);
    } else if (mapped === 'FAILED') {
      row.status = 'FAILED';
      ledger.set(String(ref), row);
    }
    return {
      ok: true,
      verified: mapped === 'SUCCEEDED',
      eventId: `${ref}:${mapped}:${row.transactionId || ''}`,
      eventType: body.event || `stakaba.${mapped.toLowerCase()}`,
      providerPaymentId: String(ref),
      status: mapped === 'SUCCEEDED' ? 'SUCCEEDED' : mapped === 'FAILED' ? 'FAILED' : 'PENDING',
      amount: gross,
      currency,
      providerTransactionId: mapped === 'SUCCEEDED' ? row.transactionId : null,
    };
  }
  async refundPayment() { return { ok: false, error: 'refund not enabled for Stakaba in this phase' }; }
}

export class SandboxStakabaProvider {
  get name() { return 'stakaba'; }
  _require() {
    const key = process.env.STAKABA_API_KEY || '';
    if (!key) return { ok: false, error: 'STAKABA_API_KEY is required' };
    if (key.startsWith('sk_live_')) return { ok: false, error: 'Live Stakaba key (sk_live_) is blocked while LIVE_PAYMENTS_ENABLED is false' };
    if (!key.startsWith('sk_test_')) return { ok: false, error: 'STAKABA_API_KEY must be a sandbox key (sk_test_...) in PAYMENT_MODE=sandbox' };
    return { ok: true, key };
  }
  async createPaymentRequest(args = {}) {
    assertPaymentExecutionAllowed();
    const gate = this._require();
    if (!gate.ok) return gate;
    const amount = Math.round(Number(args.amount));
    if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'invalid amount' };
    if (String(args.currency || 'TZS').toUpperCase() !== 'TZS') return { ok: false, error: 'Stakaba supports TZS only' };
    const phone = normalizePhone(args.mobileNumber || args.customerPhone);
    const channel = args.channel || 'collection';
    const path = channel === 'card' ? '/api/v1/payments/card' : '/api/v1/payments/collection';
    const body = channel === 'card'
      ? { grossAmount: amount, currency: 'TZS', customerEmail: args.customerEmail, customerName: args.customerName, customerPhone: phone, metadata: { invoiceId: args.invoiceId, ...(args.metadata || {}) } }
      : { grossAmount: amount, currency: 'TZS', mobileNumber: phone, network: args.network || 'Mpesa', metadata: { invoiceId: args.invoiceId, ...(args.metadata || {}) } };
    let res;
    try {
      res = await fetch('https://api.stakaba.com' + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-api-key': gate.key },
        body: JSON.stringify(body),
      });
    } catch (e) {
      return { ok: false, error: 'Stakaba network error: ' + (e && e.message) };
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.message || data.error || ('Stakaba HTTP ' + res.status), data };
    const ref = data.internalReference || data.reference || data.id;
    if (!ref) return { ok: false, error: 'Stakaba response missing internalReference' };
    return { ok: true, providerPaymentId: String(ref), status: 'PENDING', checkoutUrl: data.checkoutUrl || null, internalReference: String(ref) };
  }
  async getPaymentStatus(providerPaymentId) {
    const gate = this._require();
    if (!gate.ok) return { ok: false, status: 'UNKNOWN', error: gate.error };
    let res;
    try {
      res = await fetch('https://api.stakaba.com/api/v1/transactions/' + encodeURIComponent(providerPaymentId), {
        headers: { Accept: 'application/json', 'x-api-key': gate.key },
      });
    } catch (e) {
      return { ok: false, status: 'UNKNOWN', error: e && e.message };
    }
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, status: 'UNKNOWN', error: d.message || ('HTTP ' + res.status) };
    const status = mapStakabaStatus(d.status || d.transactionStatus);
    const amount = d.grossAmount != null ? Number(d.grossAmount) : (d.amount != null ? Number(d.amount) : undefined);
    const txnId = d.providerReference || d.providerTransactionId || d.transactionId || (status === 'SUCCEEDED' ? String(providerPaymentId) : null);
    return { ok: true, status, amount, currency: String(d.currency || 'TZS').toUpperCase(), providerTransactionId: txnId };
  }
  async verifyPayment({ providerPaymentId, amount, currency }) {
    const st = await this.getPaymentStatus(providerPaymentId);
    if (!st.ok) return { ok: false, verified: false, status: 'UNKNOWN', reason: st.error };
    if (st.status !== 'SUCCEEDED') return { ok: true, verified: false, status: st.status, reason: 'not succeeded at provider' };
    if (amount != null && Number(st.amount) !== Number(amount)) return { ok: false, verified: false, status: st.status, reason: 'amount mismatch' };
    if (currency && String(st.currency).toUpperCase() !== String(currency).toUpperCase()) return { ok: false, verified: false, status: st.status, reason: 'currency mismatch' };
    if (!st.providerTransactionId) return { ok: false, verified: false, status: st.status, reason: 'missing provider transaction identity' };
    return { ok: true, verified: true, status: 'SUCCEEDED', amount: st.amount, currency: st.currency, providerTransactionId: st.providerTransactionId };
  }
  async handleWebhook({ body } = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, verified: false, reason: 'malformed Stakaba webhook body' };
    const ref = body.internalReference || body.providerPaymentId || body.reference;
    if (!ref) return { ok: false, verified: false, reason: 'missing internalReference' };
    const st = await this.getPaymentStatus(String(ref));
    if (!st.ok) {
      const mapped = mapStakabaStatus(body.status);
      if (mapped === 'FAILED') return { ok: true, verified: false, eventId: ref + ':FAILED', eventType: body.event || 'transaction.failed', providerPaymentId: String(ref), status: 'FAILED', amount: body.grossAmount, currency: body.currency || 'TZS', providerTransactionId: null };
      return { ok: false, verified: false, reason: st.error || 'transaction lookup failed' };
    }
    const success = st.status === 'SUCCEEDED';
    return { ok: true, verified: success, eventId: ref + ':' + st.status + ':' + (st.providerTransactionId || ''), eventType: body.event || (success ? 'transaction.success' : 'stakaba.event'), providerPaymentId: String(ref), status: success ? 'SUCCEEDED' : st.status, amount: st.amount, currency: st.currency, providerTransactionId: success ? st.providerTransactionId : null };
  }
  async refundPayment() { return { ok: false, error: 'refund not enabled for Stakaba in this phase' }; }
}

export const STAKABA_API_BASE = 'https://api.stakaba.com';
export const SUPPORTED_NETWORKS = new Set(['Mpesa', 'TigoPesa', 'AirtelMoney', 'HaloPesa']);
