// integrations/commercial/daraja-production.js
// Production M-Pesa / Daraja abstraction. LIVE EXECUTION IS DISABLED.
// No STK push, query, or refund HTTP is performed.
// handleWebhook may parse an inbound STK callback payload (no outbound calls)
// so the HTTP callback endpoint can accept Daraja posts and feed reconciliation.
// Completion still requires Phase 8 hard gate in verification/reconciliation.

import crypto from 'node:crypto';
import { redactSecrets } from '../payments/mode.js';

function liveBlocked(op) {
  return {
    ok: false,
    executed: false,
    code: 'LIVE_EXECUTION_DISABLED',
    error: `Production Daraja ${op} is disabled. No live HTTP was sent.`,
    status: 'FAILED',
  };
}

export class ProductionDarajaProvider {
  get name() { return 'mpesa'; }
  get mode() { return 'production-disabled'; }

  _cfg() {
    return {
      apiUrl: process.env.MPESA_API_URL || '',
      consumerKey: process.env.MPESA_CONSUMER_KEY || process.env.MPESA_CLIENT_ID || '',
      consumerSecret: process.env.MPESA_CONSUMER_SECRET || process.env.MPESA_CLIENT_SECRET || '',
      shortcode: process.env.MPESA_SHORTCODE || process.env.MPESA_BUSINESS_ID || '',
      passkey: process.env.MPESA_PASSKEY || '',
      callbackUrl: process.env.MPESA_CALLBACK_URL || '',
      callbackSecret: process.env.MPESA_CALLBACK_SECRET || '',
    };
  }

  status() {
    const c = this._cfg();
    return {
      provider: 'mpesa',
      mode: 'production-disabled',
      liveExecution: false,
      configured: Boolean(c.consumerKey && c.consumerSecret && c.shortcode),
      apiUrl: c.apiUrl || null,
      shortcode: c.shortcode ? redactSecrets(c.shortcode) : null,
      consumerKey: c.consumerKey ? redactSecrets(c.consumerKey) : null,
      callbackUrlConfigured: Boolean(c.callbackUrl),
    };
  }

  async createPaymentRequest() { return liveBlocked('STK push'); }
  async getPaymentStatus() { return liveBlocked('status query'); }
  async verifyPayment() {
    return { ok: false, verified: false, status: 'FAILED', reason: 'LIVE_EXECUTION_DISABLED', code: 'LIVE_EXECUTION_DISABLED' };
  }

  /**
   * Parse inbound Daraja STK callback only. No outbound HTTP.
   * Does not mark payments COMPLETED by itself — verification layer applies
   * amount/currency/txn gates and reconciliation.
   */
  async handleWebhook({ body, headers = {} }) {
    const secret = this._cfg().callbackSecret;
    if (secret) {
      const got =
        headers['x-mpesa-callback-secret'] ||
        headers['x-callback-secret'] ||
        headers['X-Mpesa-Callback-Secret'] ||
        headers['X-Callback-Secret'] ||
        '';
      const expected = String(secret);
      const candidate = String(got);
      if (
        !candidate ||
        expected.length !== candidate.length ||
        !crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(candidate, 'utf8'))
      ) {
        return { ok: false, verified: false, reason: 'invalid M-Pesa callback authentication' };
      }
    }

    const stk = body?.Body?.stkCallback;
    if (!stk || !stk.CheckoutRequestID) {
      return { ok: false, verified: false, reason: 'malformed M-Pesa STK callback' };
    }

    const checkoutId = String(stk.CheckoutRequestID);
    const items = Array.isArray(stk.CallbackMetadata?.Item) ? stk.CallbackMetadata.Item : [];
    const valueOf = (name) => items.find((i) => i && i.Name === name)?.Value;
    const success = Number(stk.ResultCode) === 0;
    const callbackAmount = valueOf('Amount') != null ? Number(valueOf('Amount')) : undefined;
    const receipt = valueOf('MpesaReceiptNumber');
    const currency = valueOf('Currency') || 'KES';

    if (success && !receipt) {
      return {
        ok: true,
        verified: false,
        eventId: `${checkoutId}:${stk.ResultCode}:`,
        eventType: 'mpesa.stk.callback',
        providerPaymentId: checkoutId,
        status: 'PENDING',
        amount: callbackAmount,
        currency,
        providerTransactionId: null,
        reason: 'missing M-Pesa receipt number',
      };
    }

    const eventId = `${checkoutId}:${stk.ResultCode}:${receipt || ''}`;
    return {
      ok: true,
      verified: success && Boolean(receipt),
      eventId,
      eventType: 'mpesa.stk.callback',
      providerPaymentId: checkoutId,
      status: success ? 'SUCCEEDED' : 'FAILED',
      amount: callbackAmount,
      currency,
      providerTransactionId: success && receipt ? String(receipt) : null,
    };
  }

  async refundPayment() { return liveBlocked('refund'); }
}
