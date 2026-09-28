// integrations/commercial/daraja-production.js
// Production M-Pesa / Daraja abstraction. LIVE EXECUTION IS DISABLED.
// No STK push, query, refund, or callback HTTP is performed.

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
    };
  }

  async createPaymentRequest() { return liveBlocked('STK push'); }
  async getPaymentStatus() { return liveBlocked('status query'); }
  async verifyPayment() {
    return { ok: false, verified: false, status: 'FAILED', reason: 'LIVE_EXECUTION_DISABLED', code: 'LIVE_EXECUTION_DISABLED' };
  }
  async handleWebhook() {
    return { ok: false, verified: false, reason: 'LIVE_EXECUTION_DISABLED', code: 'LIVE_EXECUTION_DISABLED' };
  }
  async refundPayment() { return liveBlocked('refund'); }
}
