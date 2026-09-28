// integrations/payments/webhooks.js
// Public HTTP webhook handlers for Stripe / M-Pesa (Daraja).
// Mounted by monitoring/dashboard.js — no secrets logged.
//
// Canonical M-Pesa callback route: POST /api/payments/mpesa/callback
// Legacy alias: POST /webhooks/mpesa
//
// Callback reception is allowed in all modes. Live STK/charge execution remains
// gated by LIVE_PAYMENTS_ENABLED + ProductionDaraja (no outbound live HTTP).
// Completion still requires the Phase 8 hard gate (providerVerified + txnId +
// amountMatch + currencyMatch) inside verification / reconciliation.

import { handlePaymentWebhook } from './verification.js';
import { getPaymentMode } from './mode.js';
import crypto from 'node:crypto';

export function captureRawBody(req, _res, buf) {
  if (buf && buf.length) {
    req.rawBody = buf.toString('utf8');
  }
}

/**
 * Optional shared-secret check for M-Pesa callbacks.
 * Daraja does not provide a cryptographic signature on STK callbacks;
 * when MPESA_CALLBACK_SECRET is set we require a matching header
 * (x-mpesa-callback-secret or x-callback-secret) using timing-safe compare.
 */
function checkMpesaCallbackAuth(headers = {}) {
  const secret = process.env.MPESA_CALLBACK_SECRET || '';
  if (!secret) return { ok: true };
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
    return { ok: false, reason: 'invalid M-Pesa callback authentication' };
  }
  return { ok: true };
}

async function handleMpesaCallbackHttp(req, res) {
  try {
    let body = req.body;
    if (body === undefined || body === null) {
      return res.status(400).json({ ResultCode: 1, ResultDesc: 'malformed JSON' });
    }
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        return res.status(400).json({ ResultCode: 1, ResultDesc: 'malformed JSON' });
      }
    }
    if (typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ ResultCode: 1, ResultDesc: 'malformed payload' });
    }

    const auth = checkMpesaCallbackAuth(req.headers || {});
    if (!auth.ok) {
      return res.status(401).json({ ResultCode: 1, ResultDesc: auth.reason || 'unauthorized' });
    }

    const stk = body?.Body?.stkCallback;
    const checkoutId =
      (stk && stk.CheckoutRequestID) ||
      body.CheckoutRequestID ||
      body.providerPaymentId ||
      null;
    if (!checkoutId) {
      return res.status(400).json({ ResultCode: 1, ResultDesc: 'missing CheckoutRequestID' });
    }

    const result = await handlePaymentWebhook({
      provider: 'mpesa',
      headers: req.headers || {},
      body,
      rawBody: req.rawBody,
    });

    if (!result.ok && !result.duplicate) {
      const reason = result.reason || 'rejected';
      const status =
        reason.includes('authentication') || reason.includes('unauthorized') ? 401 : 400;
      return res.status(status).json({
        ResultCode: 1,
        ResultDesc: reason,
        ok: false,
        reason,
      });
    }

    return res.status(200).json({
      ResultCode: 0,
      ResultDesc: 'Accepted',
      ok: true,
      duplicate: Boolean(result.duplicate),
    });
  } catch {
    return res.status(500).json({ ResultCode: 1, ResultDesc: 'callback handler error' });
  }
}

export function mountPaymentWebhooks(app) {
  app.post('/webhooks/stripe', expressRawJson(), async (req, res) => {
    try {
      const mode = getPaymentMode();
      if (mode === 'live') {
        return res.status(403).json({ error: 'live webhooks disabled in Phase 8A' });
      }
      const rawBody =
        req.rawBody != null
          ? req.rawBody
          : typeof req.body === 'string'
            ? req.body
            : JSON.stringify(req.body || {});
      let body = req.body;
      if (typeof body === 'string') {
        try {
          body = JSON.parse(body);
        } catch {
          return res.status(400).json({ error: 'malformed JSON' });
        }
      }
      const result = await handlePaymentWebhook({
        provider: 'stripe',
        headers: req.headers,
        body,
        rawBody,
      });
      if (!result.ok && !result.duplicate) {
        const status = (result.reason || '').includes('signature') ? 401 : 400;
        return res.status(status).json({ ok: false, reason: result.reason || 'rejected' });
      }
      return res.status(200).json({ ok: true, duplicate: Boolean(result.duplicate) });
    } catch {
      return res.status(500).json({ ok: false, error: 'webhook handler error' });
    }
  });

  // Canonical M-Pesa / Daraja STK callback
  app.post('/api/payments/mpesa/callback', expressJson(), handleMpesaCallbackHttp);

  // Legacy alias
  app.post('/webhooks/mpesa', expressJson(), handleMpesaCallbackHttp);
}

function expressJson() {
  return (req, res, next) => {
    if (req.body !== undefined && typeof req.body === 'object') return next();
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      data += c;
    });
    req.on('end', () => {
      req.rawBody = data;
      try {
        req.body = data ? JSON.parse(data) : {};
      } catch {
        return res.status(400).json({ error: 'malformed JSON', ResultCode: 1, ResultDesc: 'malformed JSON' });
      }
      next();
    });
  };
}

function expressRawJson() {
  return (req, res, next) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      data += c;
    });
    req.on('end', () => {
      req.rawBody = data;
      try {
        req.body = data ? JSON.parse(data) : {};
      } catch {
        return res.status(400).json({ error: 'malformed JSON' });
      }
      next();
    });
  };
}
