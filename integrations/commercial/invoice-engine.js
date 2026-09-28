// integrations/commercial/invoice-engine.js
import { invoices } from '../../database/index.js';
import { ledger, ensureCommercialSchema } from '../../database/commercial-store.js';
import { createInvoice, approveInvoice, sendInvoice } from '../payments/invoice-service.js';

export function createCommercialInvoice(input = {}) {
  ensureCommercialSchema();
  const invoice = createInvoice(input);
  ledger.post({
    invoiceId: invoice.id, companyId: invoice.company_id, entryType: 'INVOICE_CREATED', direction: 'DEBIT',
    amount: invoice.total, currency: invoice.currency, idempotencyKey: `invoice_created_${invoice.id}`,
    description: invoice.invoice_number,
  });
  return invoice;
}

export function approveCommercialInvoice(id) {
  const invoice = approveInvoice(id);
  ledger.post({
    invoiceId: invoice.id, companyId: invoice.company_id, entryType: 'INVOICE_APPROVED', direction: 'MEMO',
    amount: invoice.total, currency: invoice.currency, idempotencyKey: `invoice_approved_${invoice.id}`,
    description: invoice.invoice_number,
  });
  return invoice;
}

export function sendCommercialInvoice(id) {
  const invoice = sendInvoice(id);
  ledger.post({
    invoiceId: invoice.id, companyId: invoice.company_id, entryType: 'INVOICE_SENT', direction: 'MEMO',
    amount: invoice.total, currency: invoice.currency, idempotencyKey: `invoice_sent_${invoice.id}`,
    description: invoice.invoice_number,
  });
  return invoice;
}

export function getInvoice(id) { return invoices.get(id); }
export function listInvoices(filters = {}) { return invoices.list(filters); }
