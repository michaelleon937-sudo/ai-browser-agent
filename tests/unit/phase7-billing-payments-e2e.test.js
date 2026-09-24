// tests/unit/phase7-billing-payments-e2e.test.js
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tmpDbPath, migrate, closeDb, invoices, payments, projects, companies, prospects;
let assertInvoiceStatusTransition, createInvoice, approveInvoice, sendInvoice;
let getPaymentProvider, _resetMockLedger, verifyPayment, handlePaymentWebhook;
let createProject, startProject, completeProject, advanceProject, billingTools, evaluatePolicy;

beforeAll(async () => {
  tmpDbPath = path.join(os.tmpdir(), `p7-e2e-${Date.now()}.db`);
  process.env.DATABASE_PATH = tmpDbPath; process.env.DATA_DIR = path.dirname(tmpDbPath); process.env.AI_PROVIDER = 'stub';
  delete process.env.STRIPE_WEBHOOK_SECRET;
  const db = await import('../../database/index.js');
  ({ migrate, closeDb, invoices, payments, projects, companies, prospects, assertInvoiceStatusTransition } = db);
  closeDb(); migrate();
  ({ createInvoice, approveInvoice, sendInvoice } = await import('../../integrations/payments/invoice-service.js'));
  ({ getPaymentProvider, _resetMockLedger } = await import('../../integrations/payments/provider.js'));
  ({ verifyPayment, handlePaymentWebhook } = await import('../../integrations/payments/verification.js'));
  ({ createProject, startProject, completeProject, advanceProject } = await import('../../integrations/payments/project-service.js'));
  ({ billingTools } = await import('../../control/tools/billing.js'));
  ({ evaluatePolicy } = await import('../../control/policy.js'));
});
afterAll(() => { try { closeDb(); } catch {} try { fs.unlinkSync(tmpDbPath); } catch {} });
beforeEach(() => { _resetMockLedger(); });

describe('invoice engine', () => {
  it('creates unique sequential invoice numbers and rejects invalid transitions', () => {
    const a = createInvoice({ subtotal: 100, tax: 0, currency: 'USD', description: 'A' });
    const b = createInvoice({ subtotal: 200, tax: 0, currency: 'USD', description: 'B' });
    expect(a.invoice_number).toMatch(/^INV-\d{4}-\d{6}$/);
    expect(b.invoice_number).not.toBe(a.invoice_number);
    expect(() => assertInvoiceStatusTransition('DRAFT', 'PAID')).toThrow();
    expect(() => invoices.updateStatus(a.id, 'PAID')).toThrow();
  });
});

describe('payment verification', () => {
  it('does not mark SUCCEEDED on client claim alone', async () => {
    const inv = createInvoice({ subtotal: 50, currency: 'USD' }); sendInvoice(inv.id);
    const provider = getPaymentProvider('stripe');
    const req = await provider.createPaymentRequest({ amount: 50, currency: 'USD', invoiceId: inv.id, idempotencyKey: 'claim-1' });
    const payment = payments.create({ invoiceId: inv.id, provider: 'stripe', providerPaymentId: req.providerPaymentId, amount: 50, currency: 'USD', status: 'PENDING', idempotencyKey: 'claim-1' });
    const result = await verifyPayment(payment.id);
    expect(result.verified).toBe(false);
    expect(payments.get(payment.id).status).not.toBe('SUCCEEDED');
    expect(invoices.get(inv.id).status).not.toBe('PAID');
  });
  it('verifies amount/currency and activates on provider success', async () => {
    const inv = createInvoice({ subtotal: 75, currency: 'USD' }); sendInvoice(inv.id);
    const provider = getPaymentProvider('mpesa');
    const req = await provider.createPaymentRequest({ amount: 75, currency: 'USD', invoiceId: inv.id, idempotencyKey: 'ok-1' });
    await provider.handleWebhook({ body: { simulate: true, providerPaymentId: req.providerPaymentId, forceStatus: 'SUCCEEDED', eventId: 'evt-ok-1' } });
    const payment = payments.create({ invoiceId: inv.id, provider: 'mpesa', providerPaymentId: req.providerPaymentId, amount: 75, currency: 'USD', status: 'PENDING', idempotencyKey: 'ok-1' });
    const result = await verifyPayment(payment.id);
    expect(result.verified).toBe(true);
    expect(payments.get(payment.id).status).toBe('SUCCEEDED');
    expect(invoices.get(inv.id).status).toBe('PAID');
  });
  it('rejects amount mismatch', async () => {
    const inv = createInvoice({ subtotal: 100, currency: 'USD' }); sendInvoice(inv.id);
    const provider = getPaymentProvider('stripe');
    const req = await provider.createPaymentRequest({ amount: 50, currency: 'USD', invoiceId: inv.id, idempotencyKey: 'mm-1' });
    await provider.handleWebhook({ body: { simulate: true, providerPaymentId: req.providerPaymentId, forceStatus: 'SUCCEEDED', eventId: 'evt-mm-1' } });
    const payment = payments.create({ invoiceId: inv.id, provider: 'stripe', providerPaymentId: req.providerPaymentId, amount: 50, currency: 'USD', status: 'PENDING', idempotencyKey: 'mm-1' });
    const result = await verifyPayment(payment.id);
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/amount mismatch/);
  });
});

describe('webhook idempotency', () => {
  it('processes duplicate webhook events once', async () => {
    const inv = createInvoice({ subtotal: 40, currency: 'USD' }); sendInvoice(inv.id);
    const created = await billingTools['payment.create']({ invoiceId: inv.id, provider: 'stripe', idempotencyKey: 'wh-1' });
    const body = { simulate: true, providerPaymentId: created.payment.provider_payment_id, forceStatus: 'SUCCEEDED', eventId: 'dup-evt-1' };
    expect((await handlePaymentWebhook({ provider: 'stripe', body })).ok).toBe(true);
    expect((await handlePaymentWebhook({ provider: 'stripe', body })).duplicate).toBe(true);
    expect(payments.get(created.payment.id).status).toBe('SUCCEEDED');
  });
});

describe('project activation', () => {
  it('cannot start without verified payment', () => {
    const inv = createInvoice({ subtotal: 10, currency: 'USD' });
    const project = createProject({ invoiceId: inv.id, scope: 'Logo design from proposal' });
    expect(() => startProject(project.id)).toThrow(/payment/i);
  });
  it('starts after verified payment and completes delivery path', async () => {
    const inv = createInvoice({ subtotal: 90, currency: 'USD' }); sendInvoice(inv.id);
    const created = await billingTools['payment.create']({ invoiceId: inv.id, provider: 'stripe', idempotencyKey: 'proj-1' });
    await handlePaymentWebhook({ provider: 'stripe', body: { simulate: true, providerPaymentId: created.payment.provider_payment_id, forceStatus: 'SUCCEEDED', eventId: 'evt-proj-1' } });
    const project = createProject({ invoiceId: inv.id, paymentId: created.payment.id, scope: 'From proposal' });
    expect(startProject(project.id).status).toBe('IN_PROGRESS');
    advanceProject(project.id, 'IN_REVIEW'); advanceProject(project.id, 'APPROVED'); advanceProject(project.id, 'DELIVERED');
    expect(completeProject(project.id).status).toBe('COMPLETED');
  });
});

describe('full E2E lifecycle', () => {
  it('prospect → invoice → verified payment → project completion', async () => {
    const company = companies.create({ name: 'Pay Co', domain: 'payco.test' });
    const prospect = prospects.create({ businessName: 'Pay Co', contactEmail: 'cfo@payco.test', status: 'PROPOSAL_READY' });
    const inv = createInvoice({ companyId: company.id, prospectId: prospect.id, opportunityId: 'opp-e2e', proposalId: 'prop-e2e', subtotal: 500, currency: 'USD', description: 'Package' });
    approveInvoice(inv.id); sendInvoice(inv.id);
    const pay = await billingTools['payment.create']({ invoiceId: inv.id, provider: 'mpesa', idempotencyKey: 'e2e-full-1' });
    expect((await verifyPayment(pay.payment.id)).verified).toBe(false);
    await handlePaymentWebhook({ provider: 'mpesa', body: { simulate: true, providerPaymentId: pay.payment.provider_payment_id, forceStatus: 'SUCCEEDED', eventId: 'e2e-full-evt' } });
    expect(payments.get(pay.payment.id).status).toBe('SUCCEEDED');
    expect(invoices.get(inv.id).status).toBe('PAID');
    const project = createProject({ companyId: company.id, prospectId: prospect.id, invoiceId: inv.id, paymentId: pay.payment.id, scope: 'From approved proposal only' });
    startProject(project.id); advanceProject(project.id, 'IN_REVIEW'); advanceProject(project.id, 'APPROVED'); advanceProject(project.id, 'DELIVERED'); completeProject(project.id);
    expect(projects.get(project.id).status).toBe('COMPLETED');
    expect(evaluatePolicy({ toolName: 'email.send', args: {} }).allow).toBe(false);
  });
});

describe('payment idempotency', () => {
  it('returns same payment for same idempotency key', async () => {
    const inv = createInvoice({ subtotal: 15, currency: 'USD' });
    const a = await billingTools['payment.create']({ invoiceId: inv.id, provider: 'stripe', idempotencyKey: 'idem-x' });
    const b = await billingTools['payment.create']({ invoiceId: inv.id, provider: 'stripe', idempotencyKey: 'idem-x' });
    expect(a.payment.id).toBe(b.payment.id);
    expect(b.duplicate).toBe(true);
  });
});
