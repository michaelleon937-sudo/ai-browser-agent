// tests/unit/phase8a-sandbox-payments.test.js
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tmpDbPath, migrate, closeDb, invoices, payments, projects;
let createInvoice, sendInvoice, getPaymentProvider, _resetMockLedger, verifyStripeSignature;
let verifyPayment, handlePaymentWebhook, createProject, startProject, billingTools, assertPaymentExecutionAllowed;
const savedEnv = {};
function setEnv(key, val) { if (!(key in savedEnv)) savedEnv[key] = process.env[key]; if (val === undefined) delete process.env[key]; else process.env[key] = val; }
function restoreEnv() { for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }

beforeAll(async () => {
  tmpDbPath = path.join(os.tmpdir(), `p8a-${Date.now()}.db`);
  process.env.DATABASE_PATH = tmpDbPath; process.env.DATA_DIR = path.dirname(tmpDbPath); process.env.AI_PROVIDER = 'stub';
  setEnv('PAYMENT_MODE', 'mock'); setEnv('LIVE_PAYMENTS_ENABLED', 'false');
  delete process.env.STRIPE_WEBHOOK_SECRET; delete process.env.STRIPE_SECRET_KEY;
  const db = await import('../../database/index.js');
  ({ migrate, closeDb, invoices, payments, projects } = db); closeDb(); migrate();
  ({ createInvoice, sendInvoice } = await import('../../integrations/payments/invoice-service.js'));
  ({ getPaymentProvider, _resetMockLedger, verifyStripeSignature } = await import('../../integrations/payments/provider.js'));
  ({ assertPaymentExecutionAllowed } = await import('../../integrations/payments/mode.js'));
  ({ verifyPayment, handlePaymentWebhook } = await import('../../integrations/payments/verification.js'));
  ({ createProject, startProject } = await import('../../integrations/payments/project-service.js'));
  ({ billingTools } = await import('../../control/tools/billing.js'));
});
afterAll(() => { restoreEnv(); try { closeDb(); } catch {} try { fs.unlinkSync(tmpDbPath); } catch {} });
beforeEach(() => {
  _resetMockLedger(); setEnv('PAYMENT_MODE', 'mock'); setEnv('LIVE_PAYMENTS_ENABLED', 'false');
  delete process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.MPESA_API_URL; delete process.env.MPESA_CLIENT_ID; delete process.env.MPESA_CLIENT_SECRET; delete process.env.MPESA_BUSINESS_ID;
});

describe('payment mode', () => {
  it('defaults to mock when unset or invalid', async () => {
    const { getPaymentMode: gpm } = await import('../../integrations/payments/mode.js');
    delete process.env.PAYMENT_MODE; expect(gpm()).toBe('mock');
    process.env.PAYMENT_MODE = 'not-a-mode'; expect(gpm()).toBe('mock');
  });
  it('blocks live mode execution in Phase 8A', () => {
    setEnv('PAYMENT_MODE', 'live'); setEnv('LIVE_PAYMENTS_ENABLED', 'false');
    expect(() => assertPaymentExecutionAllowed()).toThrow(/disabled|LIVE/i);
    setEnv('LIVE_PAYMENTS_ENABLED', 'true');
    expect(() => assertPaymentExecutionAllowed()).toThrow(/not implemented/i);
  });
  it('mock mode returns mock providers', () => {
    setEnv('PAYMENT_MODE', 'mock');
    expect(getPaymentProvider('stripe').constructor.name).toBe('MockStripeProvider');
    expect(getPaymentProvider('mpesa').constructor.name).toBe('MockMpesaProvider');
  });
  it('sandbox mode returns sandbox providers', () => {
    setEnv('PAYMENT_MODE', 'sandbox');
    expect(getPaymentProvider('stripe').constructor.name).toBe('SandboxStripeProvider');
    expect(getPaymentProvider('mpesa').constructor.name).toBe('SandboxMpesaProvider');
  });
});

describe('sandbox stripe fail-closed without credentials', () => {
  it('createPaymentRequest fails without STRIPE_SECRET_KEY', async () => {
    setEnv('PAYMENT_MODE', 'sandbox');
    const r = await getPaymentProvider('stripe').createPaymentRequest({ amount: 10, currency: 'USD', invoiceId: 'inv1' });
    expect(r.ok).toBe(false); expect(r.error).toMatch(/STRIPE_SECRET_KEY/);
  });
  it('rejects sk_live_ keys in sandbox', async () => {
    setEnv('PAYMENT_MODE', 'sandbox'); setEnv('STRIPE_SECRET_KEY', 'sk_live_fake');
    const r = await getPaymentProvider('stripe').createPaymentRequest({ amount: 10, currency: 'USD', invoiceId: 'inv1' });
    expect(r.ok).toBe(false); expect(r.error).toMatch(/Live Stripe/i);
  });
});

describe('stripe signature verification', () => {
  it('accepts valid signature and rejects invalid', () => {
    const secret = 'whsec_test_secret';
    const rawBody = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded', data: { object: { id: 'pi_1', amount: 1000, currency: 'usd' } } });
    const t = Math.floor(Date.now() / 1000);
    const v1 = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest('hex');
    expect(verifyStripeSignature(rawBody, `t=${t},v1=${v1}`, secret).ok).toBe(true);
    expect(verifyStripeSignature(rawBody, 't=1,v1=deadbeef', secret).ok).toBe(false);
    expect(verifyStripeSignature(rawBody, `t=${t},v1=${v1}`, 'wrong').ok).toBe(false);
  });
  it('rejects unsigned webhook in sandbox stripe handler', async () => {
    setEnv('PAYMENT_MODE', 'sandbox'); setEnv('STRIPE_WEBHOOK_SECRET', 'whsec_test');
    const r = await getPaymentProvider('stripe').handleWebhook({ body: { id: 'evt_x', type: 'payment_intent.succeeded', data: { object: { id: 'pi_x' } } }, headers: {}, rawBody: '{}' });
    expect(r.ok).toBe(false); expect(r.reason).toMatch(/signature|missing/i);
  });
});

describe('sandbox mpesa fail-closed', () => {
  it('fails without credentials', async () => {
    setEnv('PAYMENT_MODE', 'sandbox');
    const r = await getPaymentProvider('mpesa').createPaymentRequest({ amount: 100, currency: 'KES', invoiceId: 'i1' });
    expect(r.ok).toBe(false); expect(r.error).toMatch(/credentials|MPESA/i);
  });
  it('rejects non-sandbox Safaricom production URL', async () => {
    setEnv('PAYMENT_MODE', 'sandbox');
    setEnv('MPESA_API_URL', 'https://api.safaricom.co.ke');
    setEnv('MPESA_CLIENT_ID', 'id'); setEnv('MPESA_CLIENT_SECRET', 'secret'); setEnv('MPESA_BUSINESS_ID', '123');
    const r = await getPaymentProvider('mpesa').createPaymentRequest({ amount: 100, currency: 'KES', invoiceId: 'i1' });
    expect(r.ok).toBe(false); expect(r.error).toMatch(/non-sandbox|Refusing/i);
  });
});

describe('phase 7 regression under mock mode', () => {
  it('client claim without provider confirmation does not pay or start project', async () => {
    setEnv('PAYMENT_MODE', 'mock');
    const inv = createInvoice({ subtotal: 50, currency: 'USD' }); sendInvoice(inv.id);
    const created = await billingTools['payment.create']({ invoiceId: inv.id, provider: 'stripe', idempotencyKey: 'p8a-claim' });
    expect((await verifyPayment(created.payment.id)).verified).toBe(false);
    expect(payments.get(created.payment.id).status).not.toBe('SUCCEEDED');
    expect(invoices.get(inv.id).status).not.toBe('PAID');
    const project = createProject({ invoiceId: inv.id, paymentId: created.payment.id });
    expect(() => startProject(project.id)).toThrow(/payment/i);
  });
  it('mock webhook success verifies and allows project start', async () => {
    setEnv('PAYMENT_MODE', 'mock');
    const inv = createInvoice({ subtotal: 80, currency: 'USD' }); sendInvoice(inv.id);
    const created = await billingTools['payment.create']({ invoiceId: inv.id, provider: 'stripe', idempotencyKey: 'p8a-ok' });
    await handlePaymentWebhook({ provider: 'stripe', body: { simulate: true, providerPaymentId: created.payment.provider_payment_id, forceStatus: 'SUCCEEDED', eventId: 'p8a-evt-1' } });
    expect(payments.get(created.payment.id).status).toBe('SUCCEEDED');
    expect(invoices.get(inv.id).status).toBe('PAID');
    expect(startProject(createProject({ invoiceId: inv.id, paymentId: created.payment.id, scope: 'From proposal' }).id).status).toBe('IN_PROGRESS');
  });
  it('duplicate webhook is idempotent', async () => {
    setEnv('PAYMENT_MODE', 'mock');
    const inv = createInvoice({ subtotal: 40, currency: 'USD' }); sendInvoice(inv.id);
    const created = await billingTools['payment.create']({ invoiceId: inv.id, provider: 'mpesa', idempotencyKey: 'p8a-dup' });
    const body = { simulate: true, providerPaymentId: created.payment.provider_payment_id, forceStatus: 'SUCCEEDED', eventId: 'p8a-dup-evt' };
    expect((await handlePaymentWebhook({ provider: 'mpesa', body })).ok).toBe(true);
    expect((await handlePaymentWebhook({ provider: 'mpesa', body })).duplicate).toBe(true);
    expect(payments.list({ invoiceId: inv.id }).length).toBe(1);
  });
});

describe('network / config failure semantics', () => {
  it('missing sandbox stripe credentials does not mark payment succeeded', async () => {
    setEnv('PAYMENT_MODE', 'sandbox');
    const inv = createInvoice({ subtotal: 15, currency: 'USD' }); sendInvoice(inv.id);
    const r = await billingTools['payment.create']({ invoiceId: inv.id, provider: 'stripe', idempotencyKey: 'p8a-nocr' });
    expect(r.ok).toBe(false);
  });
});
