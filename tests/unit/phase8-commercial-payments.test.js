import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tmpDbPath, migrate, closeDb, invoices, payments;
let createQuote, approveQuote, sendQuote, acceptQuote, convertQuoteToInvoice;
let transitionCommercialPayment, canMarkCompleted, toCommercialState, toStoreStatus;
let issueReceipt, generatePaymentReminders, requestRefund, approveRefund, processRefund;
let reconcilePayment, ProductionDarajaProvider;
let commercialTools;
const savedEnv = {};
function setEnv(key, val) {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (val === undefined) delete process.env[key];
  else process.env[key] = val;
}

beforeAll(async () => {
  tmpDbPath = path.join(os.tmpdir(), `p8c-${Date.now()}.db`);
  process.env.DATABASE_PATH = tmpDbPath;
  process.env.DATA_DIR = path.dirname(tmpDbPath);
  process.env.AI_PROVIDER = 'stub';
  setEnv('PAYMENT_MODE', 'mock');
  setEnv('LIVE_PAYMENTS_ENABLED', 'false');
  const db = await import('../../database/index.js');
  ({ migrate, closeDb, invoices, payments } = db);
  closeDb();
  migrate();
  ({ createQuote, approveQuote, sendQuote, acceptQuote, convertQuoteToInvoice } = await import('../../integrations/commercial/quote-engine.js'));
  ({ transitionCommercialPayment, canMarkCompleted, toCommercialState, toStoreStatus } = await import('../../integrations/commercial/payment-machine.js'));
  ({ issueReceipt } = await import('../../integrations/commercial/receipts.js'));
  ({ generatePaymentReminders } = await import('../../integrations/commercial/reminders.js'));
  ({ requestRefund, approveRefund, processRefund } = await import('../../integrations/commercial/refunds.js'));
  ({ reconcilePayment } = await import('../../integrations/commercial/reconciliation.js'));
  ({ ProductionDarajaProvider } = await import('../../integrations/commercial/daraja-production.js'));
  ({ commercialTools } = await import('../../control/tools/commercial.js'));
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

describe('commercial payment state machine', () => {
  it('maps SUCCEEDED to COMPLETED and PROCESSING to AUTHORIZED', () => {
    expect(toCommercialState('SUCCEEDED')).toBe('COMPLETED');
    expect(toCommercialState('PROCESSING')).toBe('AUTHORIZED');
    expect(toCommercialState('UNKNOWN')).toBe('RECONCILIATION_REQUIRED');
    expect(toStoreStatus('COMPLETED')).toBe('SUCCEEDED');
    expect(toStoreStatus('AUTHORIZED')).toBe('PROCESSING');
  });

  it('never marks COMPLETED without verified provider evidence', () => {
    expect(canMarkCompleted({})).toBe(false);
    expect(canMarkCompleted({ providerVerified: true })).toBe(false);
    expect(() => transitionCommercialPayment('PENDING', 'COMPLETED', {})).toThrow(/verified provider/);
    const ok = transitionCommercialPayment('PENDING', 'COMPLETED', {
      providerVerified: true,
      providerTransactionId: 'txn_1',
      amountMatch: true,
      currencyMatch: true,
    });
    expect(ok.to).toBe('COMPLETED');
    expect(ok.storeStatus).toBe('SUCCEEDED');
  });
});

describe('quote engine', () => {
  it('creates, approves, sends, accepts, and converts a quote', () => {
    const q = createQuote({ companyId: null, currency: 'KES', subtotal: 1000, tax: 160, lineItems: [{ name: 'site', amount: 1000 }] });
    expect(q.status).toBe('DRAFT');
    expect(q.quote_number).toMatch(/^Q-/);
    const approved = approveQuote(q.id);
    expect(approved.status).toBe('APPROVED');
    const sent = sendQuote(q.id);
    expect(sent.status).toBe('SENT');
    const accepted = acceptQuote(q.id);
    expect(accepted.status).toBe('ACCEPTED');
    const { quote, invoice } = convertQuoteToInvoice(q.id);
    expect(quote.status).toBe('CONVERTED');
    expect(invoice.total).toBe(q.total);
    expect(invoice.status).toBe('DRAFT');
  });
});

describe('receipts reminders refunds', () => {
  it('issues a receipt only for COMPLETED payments and never auto-sends reminders', () => {
    const inv = invoices.create({ currency: 'KES', subtotal: 500, tax: 0, total: 500, status: 'SENT' });
    const pending = payments.create({ invoiceId: inv.id, provider: 'mpesa', amount: 500, currency: 'KES', status: 'PENDING' });
    expect(() => issueReceipt({ paymentId: pending.id })).toThrow(/COMPLETED/);
    const paid = payments.create({ invoiceId: inv.id, provider: 'mpesa', amount: 500, currency: 'KES', status: 'SUCCEEDED', providerTransactionId: 'txn_r1' });
    const receipt = issueReceipt({ paymentId: paid.id });
    expect(receipt.receipt_number).toMatch(/^R-/);
    const reminders = generatePaymentReminders({ invoiceId: inv.id });
    expect(reminders.externalSideEffect).toBe(false);
    expect(reminders.reminders.length).toBeGreaterThan(0);
  });

  it('requests and approves a refund without live provider execution', async () => {
    const inv = invoices.create({ currency: 'KES', subtotal: 200, total: 200, status: 'PAID' });
    const paid = payments.create({ invoiceId: inv.id, provider: 'mpesa', amount: 200, currency: 'KES', status: 'SUCCEEDED', providerTransactionId: 'txn_rf' });
    const { refund } = requestRefund({ paymentId: paid.id, amount: 200, reason: 'test' });
    expect(refund.status).toBe('REQUESTED');
    const approved = approveRefund(refund.id, { approvedBy: 'qa' });
    expect(approved.status).toBe('APPROVED');
    const live = new ProductionDarajaProvider();
    const processed = await processRefund(refund.id, { provider: live });
    expect(processed.ok).toBe(false);
    expect(processed.code).toBe('LIVE_EXECUTION_DISABLED');
  });
});

describe('production Daraja', () => {
  it('never executes live HTTP', async () => {
    const p = new ProductionDarajaProvider();
    const created = await p.createPaymentRequest({ amount: 1, currency: 'KES' });
    expect(created.code).toBe('LIVE_EXECUTION_DISABLED');
    expect(created.executed).toBe(false);
    const verified = await p.verifyPayment({});
    expect(verified.verified).toBe(false);
    const refund = await p.refundPayment({});
    expect(refund.code).toBe('LIVE_EXECUTION_DISABLED');
    expect(p.status().liveExecution).toBe(false);
  });
});

describe('reconciliation and control tools', () => {
  it('flags amount mismatch as RECONCILIATION_REQUIRED', () => {
    const inv = invoices.create({ currency: 'KES', subtotal: 100, total: 100, status: 'SENT' });
    const pay = payments.create({ invoiceId: inv.id, provider: 'mpesa', amount: 100, currency: 'KES', status: 'PENDING' });
    const r = reconcilePayment({
      payment: pay,
      invoice: inv,
      providerResult: { ok: true, verified: true, amount: 50, currency: 'KES', providerTransactionId: 'x' },
    });
    expect(r.status).toBe('RECONCILIATION_REQUIRED');
  });

  it('exposes commercial control tools without charging', async () => {
    const created = await commercialTools['commercial.create_quote']({ currency: 'KES', subtotal: 10, tax: 0 });
    expect(created.ok).toBe(true);
    const listed = await commercialTools['commercial.list_quotes']({});
    expect(listed.quotes.length).toBeGreaterThan(0);
  });
});

describe('ledger idempotency and evidence gaps', () => {
  it('posts ledger entries once per idempotency key', async () => {
    const { ledger, ensureCommercialSchema } = await import('../../database/commercial-store.js');
    ensureCommercialSchema();
    const first = ledger.post({ entryType: 'TEST', direction: 'MEMO', amount: 1, currency: 'KES', idempotencyKey: 'led_once' });
    const second = ledger.post({ entryType: 'TEST', direction: 'MEMO', amount: 1, currency: 'KES', idempotencyKey: 'led_once' });
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.entry.id).toBe(first.entry.id);
  });

  it('rejects COMPLETED when providerTransactionId is missing or provider is unverified', () => {
    expect(canMarkCompleted({
      providerVerified: true, providerTransactionId: '  ', amountMatch: true, currencyMatch: true,
    })).toBe(false);
    expect(canMarkCompleted({
      providerVerified: false, providerTransactionId: 'txn', amountMatch: true, currencyMatch: true,
    })).toBe(false);
    expect(() => transitionCommercialPayment('PENDING', 'COMPLETED', {
      providerVerified: true, providerTransactionId: 'txn', amountMatch: true, currencyMatch: false,
    })).toThrow(/verified provider/);
  });

  it('flags currency mismatch as RECONCILIATION_REQUIRED', () => {
    const inv = invoices.create({ currency: 'KES', subtotal: 80, total: 80, status: 'SENT' });
    const pay = payments.create({ invoiceId: inv.id, provider: 'mpesa', amount: 80, currency: 'KES', status: 'PENDING' });
    const r = reconcilePayment({
      payment: pay,
      invoice: inv,
      providerResult: { ok: true, verified: true, amount: 80, currency: 'USD', providerTransactionId: 'x' },
    });
    expect(r.status).toBe('RECONCILIATION_REQUIRED');
  });
});

describe('control policy and MCP registration', () => {
  it('allows commercial tools and keeps payment.charge forbidden', async () => {
    const { ALLOWED_TOOLS, FORBIDDEN_TOOLS, TOOLS_REQUIRING_APPROVAL } = await import('../../control/policy.js');
    expect(FORBIDDEN_TOOLS).toContain('payment.charge');
    expect(ALLOWED_TOOLS).toContain('commercial.create_quote');
    expect(ALLOWED_TOOLS).toContain('commercial.approve_refund');
    expect(TOOLS_REQUIRING_APPROVAL.has('commercial.send_quote')).toBe(true);
    expect(TOOLS_REQUIRING_APPROVAL.has('commercial.convert_quote')).toBe(true);
    expect(TOOLS_REQUIRING_APPROVAL.has('commercial.approve_refund')).toBe(true);
    expect(TOOLS_REQUIRING_APPROVAL.has('commercial.process_refund')).toBe(true);
  });

  it('registers 18 commercial MCP tools for a total of 104', async () => {
    const { MCP_TOOL_DEFINITIONS } = await import('../../mcp/tools.js');
    const commercial = MCP_TOOL_DEFINITIONS.filter((d) => d.mcpName.startsWith('commercial_'));
    expect(commercial).toHaveLength(18);
    expect(MCP_TOOL_DEFINITIONS).toHaveLength(104);
    expect(commercial.map((d) => d.controlName)).toContain('commercial.create_quote');
    expect(commercial.map((d) => d.controlName)).not.toContain('payment.charge');
  });

  it('documents read-only commercial dashboard routes', async () => {
    const src = fs.readFileSync(new URL('../../monitoring/dashboard.js', import.meta.url), 'utf8');
    for (const route of [
      "/api/commercial/quotes",
      "/api/commercial/ledger",
      "/api/commercial/receipts",
      "/api/commercial/reminders",
      "/api/commercial/refunds",
      "/api/commercial/payments/:id",
    ]) {
      expect(src).toContain(route);
    }
    expect(src).not.toMatch(/app\.post\('\/api\/commercial/);
  });
});
