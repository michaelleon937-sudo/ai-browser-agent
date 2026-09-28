// integrations/commercial/receipts.js
import { invoices, payments } from '../../database/index.js';
import { receipts, ledger, ensureCommercialSchema } from '../../database/commercial-store.js';
import { toCommercialState } from './payment-machine.js';

export function issueReceipt({ paymentId } = {}) {
  ensureCommercialSchema();
  const payment = payments.get(paymentId);
  if (!payment) throw new Error('payment not found');
  if (toCommercialState(payment.status) !== 'COMPLETED') {
    throw new Error('receipt requires a COMPLETED (verified) payment');
  }
  const invoice = invoices.get(payment.invoice_id);
  if (!invoice) throw new Error('invoice not found');
  const receipt = receipts.issue({
    invoiceId: invoice.id, paymentId: payment.id, amount: payment.amount, currency: payment.currency, verified: true,
  });
  ledger.post({
    invoiceId: invoice.id, paymentId: payment.id, receiptId: receipt.id, companyId: invoice.company_id,
    entryType: 'RECEIPT_ISSUED', direction: 'CREDIT', amount: payment.amount, currency: payment.currency,
    idempotencyKey: `receipt_${payment.id}`, description: receipt.receipt_number,
  });
  return receipt;
}

export function getReceipt(id) {
  ensureCommercialSchema();
  return receipts.get(id);
}
