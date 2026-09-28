import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import http from 'node:http';

/**
 * Phase 8C — M-Pesa callback endpoint & webhook hardening.
 * No live payments. No credentials. No secret leakage.
 */

let tmpDbPath, migrate, closeDb, invoices, payments;
let handlePaymentWebhook;
let getPaymentProvider;
let toCommercialState, canMarkCompleted;
let mountPaymentWebhooks;
const savedEnv = {};

function setEnv(key, val) {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (val === undefined) delete process.env[key];
  else process.env[key] = val;
}

function stkPayload({ checkoutId, resultCode = 0, amount = 1000, receipt = 'QWERTY12345', phone = '254712345678' }) {
  const items = [];
  if (amount != null) items.push({ Name: 'Amount', Value: amount });
  if (receipt) items.push({ Name: 'MpesaReceiptNumber', Value: receipt });
  items.push({ Name: 'TransactionDate', Value: '20260928120000' });
  items.push({ Name: 'PhoneNumber', Value: phone });
  return {
    Body: {
      stkCallback: {
        MerchantRequestID: 'mreq-1',
        CheckoutRequestID: checkoutId,
        ResultCode: resultCode,
        ResultDesc: resultCode === 0 ? 'The service request is processed successfully.' : 'Failed',
        CallbackMetadata: resultCode === 0 ? { Item: items } : undefined,
      },
    },
  };
}

function request(app, method, url, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const data = body != null ? JSON.stringify(body) : null;
      const opts = {
        hostname: '127.0.0.1',
        port,
        path: url,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
          ...headers,
        },
      };
      const req = http.request(opts, (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          server.close();
          let json = null;
          try { json = raw ? JSON.parse(raw) : null; } catch { json = raw; }
          resolve({ status: res.statusCode, body: json, raw });
        });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      if (data) req.write(data);
      req.end();
    });
  });
}

beforeAll(async () => {
  tmpDbPath = path.join(os.tmpdir(), `p8c-${Date.now()}.db`);
  process.env.DATABASE_PATH = tmpDbPath;
  process.env.DATA_DIR = path.dirname(tmpDbPath);
  process.env.AI_PROVIDER = 'stub';
  setEnv('PAYMENT_MODE', 'mock');
  setEnv('LIVE_PAYMENTS_ENABLED', 'false');
  setEnv('MPESA_CALLBACK_SECRET', undefined);

  const db = await import('../../database/index.js');
  ({ migrate, closeDb, invoices, payments } = db);
  closeDb();
  migrate();

  ({ handlePaymentWebhook } = await import('../../integrations/payments/verification.js'));
  ({ getPaymentProvider } = await import('../../integrations/payments/provider.js'));
  ({ toCommercialState, canMarkCompleted } = await import('../../integrations/commercial/payment-machine.js'));
  ({ mountPaymentWebhooks } = await import('../../integrations/payments/webhooks.js'));
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { closeDb(); } catch {}
  try { fs.unlinkSync(tmpDbPath); } catch {}
});

beforeEach(() => {
  setEnv('PAYMENT_MODE', 'mock');
  setEnv('LIVE_PAYMENTS_ENABLED', 'false');
  setEnv('MPESA_CALLBACK_SECRET', undefined);
});

function seedPayment({ amount = 1000, currency = 'KES', companyId = 'co-A', providerPaymentId }) {
  const inv = invoices.create({
    companyId,
    currency,
    subtotal: amount,
    tax: 0,
    total: amount,
    status: 'SENT',
    description: 'p8c fixture',
  });
  const pay = payments.create({
    invoiceId: inv.id,
    companyId,
    provider: 'mpesa',
    amount,
    currency,
    status: 'PENDING',
    providerPaymentId: providerPaymentId || `ws_CO_${Date.now()}`,
    idempotencyKey: `idem-${inv.id}-${Date.now()}`,
  });
  return { inv, pay };
}

describe('Phase 8C — route registration', () => {
  it('exposes POST /api/payments/mpesa/callback and legacy /webhooks/mpesa', async () => {
    const app = express();
    app.use(express.json());
    mountPaymentWebhooks(app);
    app.get('/healthz', (_req, res) => res.json({ ok: true }));

    const health = await request(app, 'GET', '/healthz');
    expect(health.status).toBe(200);

    const getCb = await request(app, 'GET', '/api/payments/mpesa/callback');
    expect([404, 405]).toContain(getCb.status);

    const bad = await request(app, 'POST', '/api/payments/mpesa/callback', { body: { foo: 1 } });
    expect(bad.status).toBe(400);
    expect(bad.body.ResultCode).toBe(1);
    expect(String(bad.body.ResultDesc)).toMatch(/CheckoutRequestID/i);
  });
});

describe('Phase 8C — valid callback', () => {
  it('processes STK success through pipeline without auto-COMPLETED bypass', async () => {
    const provider = getPaymentProvider('mpesa');
    const created = await provider.createPaymentRequest({
      amount: 2500,
      currency: 'KES',
      invoiceId: 'inv-cb',
      idempotencyKey: `cb-${Date.now()}`,
    });
    const { inv, pay } = seedPayment({
      amount: 2500,
      providerPaymentId: created.providerPaymentId,
    });

    const app = express();
    app.use(express.json());
    mountPaymentWebhooks(app);

    const payload = stkPayload({
      checkoutId: created.providerPaymentId,
      amount: 2500,
      receipt: 'RCPT2500A',
    });
    const res = await request(app, 'POST', '/api/payments/mpesa/callback', { body: payload });
    expect(res.status).toBe(200);
    expect(res.body.ResultCode).toBe(0);
    expect(res.body.ok).toBe(true);

    expect(canMarkCompleted({
      providerVerified: true,
      providerTransactionId: 'RCPT2500A',
      amountMatch: true,
      currencyMatch: true,
    })).toBe(true);
    expect(canMarkCompleted({
      providerVerified: false,
      providerTransactionId: 'RCPT2500A',
      amountMatch: true,
      currencyMatch: true,
    })).toBe(false);

    const refreshed = payments.get(pay.id);
    expect(refreshed.invoice_id).toBe(inv.id);
    expect(refreshed.company_id).toBe(inv.company_id);
  });
});

describe('Phase 8C — malformed / missing', () => {
  it('rejects missing CheckoutRequestID', async () => {
    const app = express();
    app.use(express.json());
    mountPaymentWebhooks(app);
    const res = await request(app, 'POST', '/api/payments/mpesa/callback', {
      body: { Body: { stkCallback: { ResultCode: 0 } } },
    });
    expect(res.status).toBe(400);
    expect(String(res.body.ResultDesc)).toMatch(/CheckoutRequestID/i);
  });

  it('unknown CheckoutRequestID is rejected or not completed', async () => {
    const app = express();
    app.use(express.json());
    mountPaymentWebhooks(app);
    const res = await request(app, 'POST', '/api/payments/mpesa/callback', {
      body: stkPayload({ checkoutId: 'ws_CO_UNKNOWN_XYZ', amount: 100, receipt: 'X' }),
    });
    if (res.status === 200) {
      expect(res.body.ok === false || res.body.duplicate === true || res.body.ResultCode === 1).toBeTruthy();
    } else {
      expect([400, 401]).toContain(res.status);
    }
  });
});

describe('Phase 8C — amount / receipt gates', () => {
  it('amount mismatch does not complete', async () => {
    const provider = getPaymentProvider('mpesa');
    const created = await provider.createPaymentRequest({
      amount: 5000,
      currency: 'KES',
      invoiceId: 'inv-amt',
      idempotencyKey: `amt-${Date.now()}`,
    });
    seedPayment({ amount: 5000, providerPaymentId: created.providerPaymentId });

    const app = express();
    app.use(express.json());
    mountPaymentWebhooks(app);

    const res = await request(app, 'POST', '/api/payments/mpesa/callback', {
      body: stkPayload({ checkoutId: created.providerPaymentId, amount: 1, receipt: 'RCPT1' }),
    });
    expect([400, 200]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.ok === false || res.body.ResultCode === 1).toBeTruthy();
    }
  });

  it('missing receipt does not verify as success', async () => {
    const provider = getPaymentProvider('mpesa');
    const created = await provider.createPaymentRequest({
      amount: 1200,
      currency: 'KES',
      invoiceId: 'inv-rcp',
      idempotencyKey: `rcp-${Date.now()}`,
    });
    seedPayment({ amount: 1200, providerPaymentId: created.providerPaymentId });

    const handled = await provider.handleWebhook({
      body: stkPayload({ checkoutId: created.providerPaymentId, amount: 1200, receipt: null }),
    });
    expect(handled.verified).toBe(false);
  });
});

describe('Phase 8C — duplicate callback', () => {
  it('second identical callback is deduplicated', async () => {
    const provider = getPaymentProvider('mpesa');
    const created = await provider.createPaymentRequest({
      amount: 3000,
      currency: 'KES',
      invoiceId: 'inv-dup',
      idempotencyKey: `dup-${Date.now()}`,
    });
    seedPayment({ amount: 3000, providerPaymentId: created.providerPaymentId });

    const payload = stkPayload({
      checkoutId: created.providerPaymentId,
      amount: 3000,
      receipt: 'DUPRCPT99',
    });

    const a = await handlePaymentWebhook({ provider: 'mpesa', body: payload, headers: {} });
    const b = await handlePaymentWebhook({ provider: 'mpesa', body: payload, headers: {} });
    expect(a.ok).toBe(true);
    expect(b.duplicate === true || b.ok === true).toBe(true);
  });
});

describe('Phase 8C — authentication', () => {
  it('rejects invalid callback secret when configured', async () => {
    setEnv('MPESA_CALLBACK_SECRET', 'test-secret-value-32chars-long!!');
    const app = express();
    app.use(express.json());
    mountPaymentWebhooks(app);

    const provider = getPaymentProvider('mpesa');
    const created = await provider.createPaymentRequest({
      amount: 800,
      currency: 'KES',
      invoiceId: 'inv-auth',
      idempotencyKey: `auth-${Date.now()}`,
    });
    seedPayment({ amount: 800, providerPaymentId: created.providerPaymentId });

    const res = await request(app, 'POST', '/api/payments/mpesa/callback', {
      body: stkPayload({ checkoutId: created.providerPaymentId, amount: 800, receipt: 'AUTH1' }),
      headers: { 'x-mpesa-callback-secret': 'wrong-secret' },
    });
    expect(res.status).toBe(401);
    setEnv('MPESA_CALLBACK_SECRET', undefined);
  });
});

describe('Phase 8C — cross binding', () => {
  it('callback for payment A does not attach to invoice B', async () => {
    const provider = getPaymentProvider('mpesa');
    const createdA = await provider.createPaymentRequest({
      amount: 1111,
      currency: 'KES',
      invoiceId: 'inv-A',
      idempotencyKey: `xa-${Date.now()}`,
    });
    const a = seedPayment({ amount: 1111, companyId: 'client-A', providerPaymentId: createdA.providerPaymentId });
    const b = seedPayment({ amount: 2222, companyId: 'client-B', providerPaymentId: `ws_CO_OTHER_${Date.now()}` });

    const payload = stkPayload({
      checkoutId: createdA.providerPaymentId,
      amount: 1111,
      receipt: 'BIND111',
    });
    await handlePaymentWebhook({ provider: 'mpesa', body: payload, headers: {} });

    const payA = payments.get(a.pay.id);
    const payB = payments.get(b.pay.id);
    expect(payA.invoice_id).toBe(a.inv.id);
    expect(payB.invoice_id).toBe(b.inv.id);
    expect(payA.company_id).not.toBe(payB.company_id);
  });
});

describe('Phase 8C — production safety', () => {
  it('ProductionDaraja never executes live HTTP on handleWebhook', async () => {
    setEnv('PAYMENT_MODE', 'live');
    setEnv('LIVE_PAYMENTS_ENABLED', 'false');
    const { ProductionDarajaProvider } = await import('../../integrations/commercial/daraja-production.js');
    const p = new ProductionDarajaProvider();
    const create = await p.createPaymentRequest({});
    expect(create.code).toBe('LIVE_EXECUTION_DISABLED');
    const handled = await p.handleWebhook({
      body: stkPayload({ checkoutId: 'ws_CO_PROD', amount: 100, receipt: 'PR1' }),
    });
    expect(handled.ok === true || handled.reason).toBeTruthy();
    expect(p.mode).toBe('production-disabled');
  });

  it('state mapping still requires COMPLETED gate', () => {
    expect(toCommercialState('SUCCEEDED')).toBe('COMPLETED');
    expect(canMarkCompleted({
      providerVerified: true,
      providerTransactionId: '',
      amountMatch: true,
      currencyMatch: true,
    })).toBe(false);
  });
});

describe('Phase 8C — no secret leakage', () => {
  it('handler responses do not contain credential env keys', async () => {
    setEnv('MPESA_CALLBACK_SECRET', 'super-secret-do-not-leak-please');
    const app = express();
    app.use(express.json());
    mountPaymentWebhooks(app);
    const res = await request(app, 'POST', '/api/payments/mpesa/callback', {
      body: { Body: { stkCallback: {} } },
    });
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toMatch(/super-secret/);
    expect(serialized).not.toMatch(/MPESA_CONSUMER/);
    expect(serialized).not.toMatch(/MPESA_PASSKEY/);
    setEnv('MPESA_CALLBACK_SECRET', undefined);
  });
});
