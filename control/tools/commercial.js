// control/tools/commercial.js
// Phase 8 commercial Control tools. No auto-send. No live charge.

import { quotes, ledger, receipts, paymentReminders, refundRecords, ensureCommercialSchema } from '../../database/commercial-store.js';
import { payments } from '../../database/index.js';
import { createQuote, approveQuote, sendQuote, acceptQuote, convertQuoteToInvoice } from '../../integrations/commercial/quote-engine.js';
import { createCommercialInvoice } from '../../integrations/commercial/invoice-engine.js';
import { issueReceipt } from '../../integrations/commercial/receipts.js';
import { generatePaymentReminders } from '../../integrations/commercial/reminders.js';
import { requestRefund, approveRefund, processRefund } from '../../integrations/commercial/refunds.js';
import { reconcilePayment, reconcileInvoice } from '../../integrations/commercial/reconciliation.js';
import { toCommercialState, canMarkCompleted } from '../../integrations/commercial/payment-machine.js';

export const commercialTools = {
  'commercial.create_quote': async (args = {}) => {
    ensureCommercialSchema();
    return { ok: true, quote: createQuote(args) };
  },
  'commercial.get_quote': async (args = {}) => {
    ensureCommercialSchema();
    const id = args.id || args.quoteId;
    if (!id) throw new Error('id is required');
    const quote = quotes.get(id);
    return { ok: Boolean(quote), quote: quote || null };
  },
  'commercial.list_quotes': async (args = {}) => {
    ensureCommercialSchema();
    return { ok: true, quotes: quotes.list({ limit: Number(args.limit) || 50, status: args.status, companyId: args.companyId }) };
  },
  'commercial.approve_quote': async (args = {}) => {
    const id = args.id || args.quoteId;
    if (!id) throw new Error('id is required');
    return { ok: true, quote: approveQuote(id) };
  },
  'commercial.send_quote': async (args = {}) => {
    const id = args.id || args.quoteId;
    if (!id) throw new Error('id is required');
    return { ok: true, quote: sendQuote(id), externalSend: false };
  },
  'commercial.accept_quote': async (args = {}) => {
    const id = args.id || args.quoteId;
    if (!id) throw new Error('id is required');
    return { ok: true, quote: acceptQuote(id) };
  },
  'commercial.convert_quote': async (args = {}) => {
    const id = args.id || args.quoteId;
    if (!id) throw new Error('id is required');
    return { ok: true, ...convertQuoteToInvoice(id, { createInvoiceFn: (input) => createCommercialInvoice(input) }) };
  },
  'commercial.list_ledger': async (args = {}) => {
    ensureCommercialSchema();
    return { ok: true, entries: ledger.list({ invoiceId: args.invoiceId, paymentId: args.paymentId, limit: Number(args.limit) || 50 }) };
  },
  'commercial.issue_receipt': async (args = {}) => {
    const paymentId = args.paymentId;
    if (!paymentId) throw new Error('paymentId is required');
    return { ok: true, receipt: issueReceipt({ paymentId }) };
  },
  'commercial.list_receipts': async (args = {}) => {
    ensureCommercialSchema();
    return { ok: true, receipts: receipts.list({ invoiceId: args.invoiceId, limit: Number(args.limit) || 50 }) };
  },
  'commercial.generate_reminders': async (args = {}) => {
    if (!args.invoiceId) throw new Error('invoiceId is required');
    return generatePaymentReminders({ invoiceId: args.invoiceId });
  },
  'commercial.list_reminders': async (args = {}) => {
    ensureCommercialSchema();
    return { ok: true, reminders: paymentReminders.list({ invoiceId: args.invoiceId, status: args.status, limit: Number(args.limit) || 50 }) };
  },
  'commercial.request_refund': async (args = {}) => {
    if (!args.paymentId) throw new Error('paymentId is required');
    return { ok: true, ...requestRefund({ paymentId: args.paymentId, amount: args.amount, reason: args.reason }) };
  },
  'commercial.approve_refund': async (args = {}) => {
    const id = args.id || args.refundId;
    if (!id) throw new Error('id is required');
    return { ok: true, refund: approveRefund(id, { approvedBy: args.approvedBy }) };
  },
  'commercial.process_refund': async (args = {}) => {
    const id = args.id || args.refundId;
    if (!id) throw new Error('id is required');
    return processRefund(id, { provider: args.provider });
  },
  'commercial.list_refunds': async (args = {}) => {
    ensureCommercialSchema();
    return { ok: true, refunds: refundRecords.list({ paymentId: args.paymentId, limit: Number(args.limit) || 50 }) };
  },
  'commercial.reconcile_payment': async (args = {}) => {
    const paymentId = args.paymentId || args.id;
    if (!paymentId) throw new Error('paymentId is required');
    const payment = payments.get(paymentId);
    if (!payment) return { ok: false, error: 'payment not found' };
    const { invoices } = await import('../../database/index.js');
    const invoice = invoices.get(payment.invoice_id);
    return reconcilePayment({ payment, invoice, providerResult: args.providerResult });
  },
  'commercial.reconcile_invoice': async (args = {}) => {
    if (!args.invoiceId) throw new Error('invoiceId is required');
    return reconcileInvoice(args.invoiceId);
  },
  'commercial.payment_state': async (args = {}) => {
    const id = args.id || args.paymentId;
    if (!id) throw new Error('id is required');
    const payment = payments.get(id);
    if (!payment) return { ok: false, error: 'payment not found' };
    return {
      ok: true,
      payment,
      commercialState: toCommercialState(payment.status),
      canMarkCompleted: canMarkCompleted(args.evidence || {}),
    };
  },
};
