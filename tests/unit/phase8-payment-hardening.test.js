import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Phase 8 Master Prompt 2 — Payment hardening & sandbox/live readiness.
 * Covers duplicate payment/callback, amount/currency/txn validation,
 * provider timeout/failure, reconciliation, refunds, auth, and M-Pesa separation.
 * No live payments. No credentials.
 */

let tmpDbPath, migrate, closeDb, invoices, payments;
let toCommercialState, canMarkCompleted, transitionCommercialPayment;
let reconcilePayment, reconcileInvoice;
let issueReceipt, requestRefund, approveRefund, processRefund;
let ProductionDarajaProvider, getPaymentProvider, getPaymentMode, assertPaymentExecutionAllowed;
let ledger, receipts, ensureCommercialSchema;
let evaluatePolicy, requiresApproval, isForbiddenTool;
const savedEnv = {};
function setEnv(key, val) {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (val === undefined) delete process.env[key];
  else process.env[key] = val;
}

beforeAll(async () => {
  tmpDbPath = path.join(os.tmpdir(), `p8h-${Date.now()}.db`);
  process.env.DATABASE_PATH = tmpDbPath;
  process.env.DATA_DIR = path.dirname(tmpDbPath);
  process.env.AI_PROVIDER = 'stub';
  setEnv('PAYMENT_MODE', 'mock');
  setEnv('LIVE_PAYMENTS_ENABLED', 'false');
  const db = await import('../../database/index.js');
  ({ migrate, closeDb, invoices, payments } = db);
  closeDb();
  migrate();
  ({ toCommercialState, canMarkCompleted, transitionCommercialPayment } = await import('../../integrations/commercial/payment-machine.js'));
  ({ reconcilePayment, reconcileInvoice } = await import('../../integrations/commercial/reconciliation.js'));
  ({ issueReceipt } = await import('../../integrations/commercial/receipts.js'));
  ({ requestRefund, approveRefund, processRefund } = await import('../../integrations/commercial/refunds.js'));
  ({ ProductionDarajaProvider } = await import('../../integrations/commercial/daraja-production.js'));
  ({ getPaymentProvider } = await import('../../integrations/payments/provider.js'));
  ({ getPaymentMode, assertPaymentExecutionAllowed } = await import('../../integrations/payments/mode.js'));
  ({ ledger, receipts, ensureCommercialSchema } = await import('../../database/commercial-store.js'));
  ({ evaluatePolicy, requiresApproval, isForbiddenTool } = await import('../../control/policy.js'));
  ensureCommercialSchema();
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
});

function seedInvoicePayment({ amount = 10000, currency = 'KES', companyId = 'co-A', status = 'PENDING', idempotencyKey } = {}) {
  const inv = invoices.create({
    companyId,
    currency,
    subtotal: amount,
    tax: 0,
    total: amount,
    status: 'SENT',
    description: 'hardening fixture',
  });
  const pay = payments.create({
    invoiceId: inv.id,
    companyId,
    provider: 'mpesa',
    amount,
    currency,
    status,
    idempotencyKey: idempotencyKey || `idem-${inv.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  });
  return { inv, pay };
}

describe('Phase 8 hardening — relationships', () => {
  it('payment is bound to its invoice and company; cannot silently switch', () => {
    const a = seedInvoicePayment({ companyId: 'client-A', amount: 5000 });
    const b = seedInvoicePayment({ companyId: 'client-B', amount: 7000 });
    expect(a.pay.invoice_id).toBe(a.inv.id);
    expect(a.inv.company_id).toBe('client-A');
    expect(b.pay.invoice_id).toBe(b.inv.id);
    expect(a.pay.invoice_id).not.toBe(b.inv.id);
    expect(b.inv.company_id).toBe('client-B');
    // reconciling A with B invoice evidence must not complete
    const r = reconcilePayment({
      payment: a.pay,
      invoice: b.inv,
      providerResult: { ok: true, verified: true, amount: a.pay.amount, currency: a.pay.currency, providerTransactionId: 'txn-x' },
    });
    expect(r.status).toBe('RECONCILIATION_REQUIRED');
    expect(r.ok).toBe(false);
  });
});

describe('Phase 8 hardening — COMPLETED gate', () => {
  it('requires providerVerified + txnId + amountMatch + currencyMatch', () => {
    expect(canMarkCompleted({ providerVerified: true, providerTransactionId: 't1', amountMatch: true, currencyMatch: true })).toBe(true);
    expect(canMarkCompleted({ providerVerified: false, providerTransactionId: 't1', amountMatch: true, currencyMatch: true })).toBe(false);
    expect(canMarkCompleted({ providerVerified: true, providerTransactionId: '', amountMatch: true, currencyMatch: true })).toBe(false);
    expect(canMarkCompleted({ providerVerified: true, providerTransactionId: 't1', amountMatch: false, currencyMatch: true })).toBe(false);
    expect(canMarkCompleted({ providerVerified: true, providerTransactionId: 't1', amountMatch: true, currencyMatch: false })).toBe(false);
  });

  it('transition to COMPLETED throws without evidence', () => {
    expect(() => transitionCommercialPayment('PENDING', 'COMPLETED', {})).toThrow(/COMPLETION_NOT_VERIFIED|verified/);
  });
});

describe('Phase 8 hardening — amount and currency', () => {
  it('wrong amount cannot COMPLETE', () => {
    const { inv, pay } = seedInvoicePayment({ amount: 10000, currency: 'KES' });
    const r = reconcilePayment({
      payment: pay,
      invoice: inv,
      providerResult: { ok: true, verified: true, amount: 9000, currency: 'KES', providerTransactionId: 'txn-1' },
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('RECONCILIATION_REQUIRED');
    expect(String(r.reason)).toMatch(/amount mismatch/i);
  });

  it('matching amount and currency can COMPLETE', () => {
    const { inv, pay } = seedInvoicePayment({ amount: 10000, currency: 'KES' });
    const r = reconcilePayment({
      payment: pay,
      invoice: inv,
      providerResult: { ok: true, verified: true, amount: 10000, currency: 'KES', providerTransactionId: 'txn-2' },
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('COMPLETED');
  });

  it('wrong currency cannot COMPLETE', () => {
    const { inv, pay } = seedInvoicePayment({ amount: 10000, currency: 'TZS' });
    const r = reconcilePayment({
      payment: pay,
      invoice: inv,
      providerResult: { ok: true, verified: true, amount: 10000, currency: 'USD', providerTransactionId: 'txn-3' },
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('RECONCILIATION_REQUIRED');
    expect(String(r.reason)).toMatch(/currency mismatch/i);
  });
});

describe('Phase 8 hardening — transaction validation', () => {
  it('missing provider transaction id cannot COMPLETE', () => {
    expect(canMarkCompleted({ providerVerified: true, providerTransactionId: null, amountMatch: true, currencyMatch: true })).toBe(false);
    const { inv, pay } = seedInvoicePayment();
    const r = reconcilePayment({
      payment: pay,
      invoice: inv,
      providerResult: { ok: true, verified: true, amount: pay.amount, currency: pay.currency, providerTransactionId: null },
    });
    expect(r.status).not.toBe('COMPLETED');
  });

  it('providerVerified=false cannot COMPLETE', () => {
    const { inv, pay } = seedInvoicePayment();
    const r = reconcilePayment({
      payment: pay,
      invoice: inv,
      providerResult: { ok: true, verified: false, amount: pay.amount, currency: pay.currency, providerTransactionId: 'txn-4' },
    });
    expect(r.status).not.toBe('COMPLETED');
  });
});

describe('Phase 8 hardening — unknown / invalid provider evidence', () => {
  it('unknown unmatched evidence yields RECONCILIATION_REQUIRED', () => {
    const { inv, pay } = seedInvoicePayment();
    const r = reconcilePayment({
      payment: pay,
      invoice: inv,
      providerResult: { ok: false, verified: false, reason: 'unknown transaction' },
    });
    expect(r.status).toBe('RECONCILIATION_REQUIRED');
  });

  it('store marked complete without provider evidence is RECONCILIATION_REQUIRED', () => {
    const { inv, pay } = seedInvoicePayment();
    // simulate inconsistent store state
    const fake = { ...pay, status: 'SUCCEEDED' };
    const r = reconcilePayment({ payment: fake, invoice: inv, providerResult: null });
    expect(r.status).toBe('RECONCILIATION_REQUIRED');
  });
});

describe('Phase 8 hardening — ledger idempotency', () => {
  it('duplicate ledger post with same idempotency key does not double-write', () => {
    ensureCommercialSchema();
    const key = `led-${Date.now()}`;
    const a = ledger.post({
      invoiceId: 'inv-x', paymentId: 'pay-x', entryType: 'PAYMENT', direction: 'CREDIT',
      amount: 1000, currency: 'KES', idempotencyKey: key,
    });
    const b = ledger.post({
      invoiceId: 'inv-x', paymentId: 'pay-x', entryType: 'PAYMENT', direction: 'CREDIT',
      amount: 1000, currency: 'KES', idempotencyKey: key,
    });
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(true);
    expect(b.entry.id).toBe(a.entry.id);
    const rows = ledger.list({ paymentId: 'pay-x', limit: 50 }).filter((e) => e.idempotency_key === key);
    expect(rows.length).toBe(1);
  });
});

describe('Phase 8 hardening — receipt uniqueness', () => {
  it('one receipt per payment', () => {
    const { inv, pay } = seedInvoicePayment({ amount: 2500, status: 'PENDING' });
    payments.updateStatus(pay.id, 'SUCCEEDED', { providerTransactionId: 'txn-rcpt', verifiedAt: new Date().toISOString() });
    const r1 = issueReceipt({ paymentId: pay.id });
    expect(r1).toBeTruthy();
    expect(r1.payment_id || r1.id).toBeTruthy();
    const r2 = issueReceipt({ paymentId: pay.id });
    expect(r2.id).toBe(r1.id);
    const listed = receipts.list({ invoiceId: inv.id, limit: 20 });
    const forPay = listed.filter((x) => x.payment_id === pay.id);
    expect(forPay.length).toBe(1);
  });
});

describe('Phase 8 hardening — refund authorization', () => {
  it('refund requires COMPLETED payment and cannot exceed amount', () => {
    const { pay } = seedInvoicePayment({ amount: 3000, status: 'PENDING' });
    expect(() => requestRefund({ paymentId: pay.id, amount: 100 })).toThrow(/COMPLETED/i);
    payments.updateStatus(pay.id, 'SUCCEEDED', { providerTransactionId: 'txn-rf', verifiedAt: new Date().toISOString() });
    expect(() => requestRefund({ paymentId: pay.id, amount: 99999 })).toThrow(/invalid refund amount/i);
    const { refund } = requestRefund({ paymentId: pay.id, amount: 1000, reason: 'test' });
    expect(refund.status).toMatch(/REQUESTED|PENDING/);
    const dup = requestRefund({ paymentId: pay.id, amount: 1000 });
    expect(dup.duplicate).toBe(true);
  });

  it('processRefund without approval fails; ProductionDaraja never executes live', async () => {
    const { pay } = seedInvoicePayment({ amount: 4000, status: 'PENDING' });
    payments.updateStatus(pay.id, 'SUCCEEDED', { providerTransactionId: 'txn-rf2', verifiedAt: new Date().toISOString() });
    const { refund } = requestRefund({ paymentId: pay.id, amount: 500 });
    await expect(processRefund(refund.id)).rejects.toThrow(/cannot be processed/i);
    approveRefund(refund.id, { approvedBy: 'operator' });
    const prod = new ProductionDarajaProvider();
    const result = await processRefund(refund.id, { provider: prod });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('LIVE_EXECUTION_DISABLED');
  });
});

describe('Phase 8 hardening — authorization policy', () => {
  it('payment.charge remains forbidden', () => {
    expect(isForbiddenTool('payment.charge')).toBe(true);
    const r = evaluatePolicy({ toolName: 'payment.charge', args: {} });
    expect(r.allow).toBe(false);
  });

  it('commercial tools are registered and mutating ones require approval', () => {
    expect(evaluatePolicy({ toolName: 'commercial.list_quotes', args: {} }).allow).toBe(true);
    expect(requiresApproval('commercial.send_quote')).toBe(true);
    expect(requiresApproval('commercial.convert_quote')).toBe(true);
    expect(requiresApproval('commercial.process_refund')).toBe(true);
  });
});

describe('Phase 8 hardening — M-Pesa sandbox/live separation', () => {
  it('default mode is mock; live blocked without LIVE_PAYMENTS_ENABLED', () => {
    setEnv('PAYMENT_MODE', undefined);
    setEnv('LIVE_PAYMENTS_ENABLED', 'false');
    expect(getPaymentMode()).toBe('mock');
    setEnv('PAYMENT_MODE', 'live');
    expect(() => assertPaymentExecutionAllowed()).toThrow(/LIVE_PAYMENTS_BLOCKED|disabled|not implemented/i);
  });

  it('ProductionDarajaProvider never performs live HTTP', async () => {
    const p = new ProductionDarajaProvider();
    const create = await p.createPaymentRequest({ amount: 100, currency: 'KES' });
    expect(create.ok).toBe(false);
    expect(create.code).toBe('LIVE_EXECUTION_DISABLED');
    const verify = await p.verifyPayment({ providerPaymentId: 'x' });
    expect(verify.verified).toBe(false);
    expect(verify.code).toBe('LIVE_EXECUTION_DISABLED');
    const refund = await p.refundPayment({ paymentId: 'x' });
    expect(refund.ok).toBe(false);
    expect(refund.code).toBe('LIVE_EXECUTION_DISABLED');
    const st = p.status();
    expect(st.liveExecution).toBe(false);
    expect(st.mode).toBe('production-disabled');
  });

  it('live mpesa selects ProductionDarajaProvider (disabled execution)', () => {
    setEnv('PAYMENT_MODE', 'live');
    setEnv('LIVE_PAYMENTS_ENABLED', 'false');
    const p = getPaymentProvider('mpesa');
    expect(p).toBeInstanceOf(ProductionDarajaProvider);
  });

  it('sandbox mode does not select production endpoint host for mpesa config defaults', () => {
    setEnv('PAYMENT_MODE', 'sandbox');
    // SandboxMpesaProvider validates hostname sandbox.safaricom.co.ke — covered in phase8b tests;
    // here we only assert mode selection is not production-disabled class.
    const p = getPaymentProvider('mpesa');
    expect(p.name).toBe('mpesa');
    expect(p.mode === 'production-disabled').toBe(false);
  });
});

describe('Phase 8 hardening — webhook event dedup surface', () => {
  it('duplicate provider webhook is idempotent', async () => {
    setEnv('PAYMENT_MODE', 'mock');
    const provider = getPaymentProvider('mpesa');
    const created = await provider.createPaymentRequest({ amount: 1500, currency: 'KES', invoiceId: 'inv-wh', idempotencyKey: `wh-${Date.now()}` });
    const { inv } = seedInvoicePayment({ amount: 1500, status: 'PENDING' });
    // bind provider payment id onto a real payment row
    const pay = payments.create({
      invoiceId: inv.id, provider: 'mpesa', amount: 1500, currency: 'KES', status: 'PENDING',
      providerPaymentId: created.providerPaymentId,
      idempotencyKey: `pay-wh-${Date.now()}`,
    });
    const body = { simulate: true, providerPaymentId: created.providerPaymentId, forceStatus: 'SUCCEEDED', eventId: `evt-hard-${Date.now()}` };
    const { handlePaymentWebhook } = await import('../../integrations/payments/verification.js');
    const a = await handlePaymentWebhook({ provider: 'mpesa', body });
    const b = await handlePaymentWebhook({ provider: 'mpesa', body });
    expect(a.ok).toBe(true);
    expect(b.duplicate).toBe(true);
  });
});

describe('Phase 8 hardening — provider timeout / failure semantics', () => {
  it('mock provider failure and non-succeeded status never imply COMPLETED', async () => {
    setEnv('PAYMENT_MODE', 'mock');
    const provider = getPaymentProvider('mpesa');
    const created = await provider.createPaymentRequest({ amount: 1000, currency: 'KES', invoiceId: 'inv-t', idempotencyKey: `t-${Date.now()}` });
    expect(created.ok).toBe(true);
    // without simulating success, verify must not be verified
    const v = await provider.verifyPayment({ providerPaymentId: created.providerPaymentId, amount: 1000, currency: 'KES' });
    expect(v.verified).toBe(false);
    expect(toCommercialState(v.status === 'SUCCEEDED' ? 'SUCCEEDED' : 'PENDING')).not.toBe('COMPLETED');
  });
});

describe('Phase 8 hardening — state mapping', () => {
  it('maps legacy and commercial states correctly', () => {
    expect(toCommercialState('SUCCEEDED')).toBe('COMPLETED');
    expect(toCommercialState('PROCESSING')).toBe('AUTHORIZED');
    expect(toCommercialState('UNKNOWN')).toBe('RECONCILIATION_REQUIRED');
    expect(toCommercialState('PENDING')).toBe('PENDING');
    expect(toCommercialState('FAILED')).toBe('FAILED');
  });
});
