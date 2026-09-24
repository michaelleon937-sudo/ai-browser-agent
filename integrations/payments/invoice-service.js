// integrations/payments/invoice-service.js
import { invoices, billingRecords, assertInvoiceStatusTransition } from '../../database/index.js';

export function createInvoice(input = {}) {
  const inv = invoices.create(input);
  billingRecords.create({
    invoiceId: inv.id, companyId: inv.company_id, recordType: 'INVOICE_CREATED',
    amount: inv.total, currency: inv.currency, description: inv.invoice_number,
  });
  return inv;
}

export function approveInvoice(id) {
  const inv = invoices.get(id);
  if (!inv) throw new Error('invoice not found');
  if (inv.status === 'DRAFT') invoices.updateStatus(id, 'PENDING_APPROVAL');
  const current = invoices.get(id);
  assertInvoiceStatusTransition(current.status, 'APPROVED');
  return invoices.updateStatus(id, 'APPROVED');
}

export function sendInvoice(id) {
  const inv = invoices.get(id);
  if (!inv) throw new Error('invoice not found');
  if (inv.status === 'DRAFT') { invoices.updateStatus(id, 'PENDING_APPROVAL'); invoices.updateStatus(id, 'APPROVED'); }
  else if (inv.status === 'PENDING_APPROVAL') invoices.updateStatus(id, 'APPROVED');
  return invoices.updateStatus(id, 'SENT');
}
