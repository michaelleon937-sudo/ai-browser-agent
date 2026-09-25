// integrations/payments/webhooks.js
// Public HTTP webhook handlers for sandbox Stripe / M-Pesa.
// Mounted by monitoring/dashboard.js — no secrets logged.

import { handlePaymentWebhook } from './verification.js';
import { getPaymentMode } from './mode.js';

export function captureRawBody(req, _res, buf) {
  if (buf && buf.length) {
    req.rawBody = buf.toString('utf8');
  }
}

export function mountPaymentWebhooks(app) {
  app.post('/webhooks/stripe', expressRawJson(), async (req, res) => {
    try {
      const mode = getPaymentMode();
      if (mode === 'live') {
        return res.status(403).json({ error: 'live webhooks disabled in Phase 8A' });
      }
      const rawBody = req.rawBody != null ? req.rawBody : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch {
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
    } catch (err) {
      return res.status(500).json({ ok: false, error: 'webhook handler error' });
    }
  });

  app.post('/webhooks/mpesa', expressJson(), async (req, res) => {
    try {
      const mode = getPaymentMode();
      if (mode === 'live') {
        return res.status(403).json({ ok: false, error: 'live webhooks disabled in Phase 8A' });
      }
      const result = await handlePaymentWebhook({
        provider: 'mpesa',
        headers: req.headers,
        body: req.body || {},
        rawBody: req.rawBody,
      });
      if (!result.ok && !result.duplicate) {
        const status = (result.reason || '').includes('authentication') ? 401 : 400;
        return res.status(status).json({ ok: false, reason: result.reason || 'rejected' });
      }
      return res.status(200).json({ ok: true, duplicate: Boolean(result.duplicate) });
    } catch (err) {
      return res.status(500).json({ ok: false, error: 'webhook handler error' });
    }
  });
}

function expressJson() {
  return (req, res, next) => {
    if (req.body !== undefined && typeof req.body === 'object') return next();
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      req.rawBody = data;
      try { req.body = data ? JSON.parse(data) : {}; } catch {
        return res.status(400).json({ error: 'malformed JSON' });
      }
      next();
    });
  };
}

function expressRawJson() {
  return (req, res, next) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      req.rawBody = data;
      try { req.body = data ? JSON.parse(data) : {}; } catch {
        return res.status(400).json({ error: 'malformed JSON' });
      }
      next();
    });
  };
}
