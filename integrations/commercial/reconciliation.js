// integrations/commercial/reconciliation.js
import { invoices, payments } from '../../database/index.js';
import { ledger, ensureCommercialSchema } from '../../database/commercial-store.js';
import { toCommercialState, canMarkCompleted } from './payment-machine.js';

export function reconcilePayment({ payment, invoice, providerResult } = {}) {
  ensureCommercialSchema();
  if (!payment) return { ok: false, status: 'RECONCILIATION_REQUIRED', reason: 'payment missing' };
  if (!invoice) return { ok: false, status: 'RECONCILIATION_REQUIRED', reason: 'invoice missing' };

  const amountMatch = providerResult && Number(providerResult.amount) === Number(invoice.total);
  const currencyMatch = providerResult
    && String(providerResult.currency || '').toUpperCase() === String(invoice.currency || '').toUpperCase();
  const providerVerified = Boolean(providerResult?.verified && providerResult?.ok);
  const providerTransactionId = providerResult?.providerTransactionId;

  if (providerResult && !amountMatch) {
    return {
      ok: false,
      status: 'RECONCILIATION_REQUIRED',
      reason: `amount mismatch provider=${providerResult.amount} invoice=${invoice.total}`,
    };
  }
  if (providerResult && !currencyMatch) {
    return {
      ok: false,
      status: 'RECONCILIATION_REQUIRED',
      reason: `currency mismatch provider=${providerResult.currency} invoice=${invoice.currency}`,
    };
  }

  if (canMarkCompleted({ providerVerified, providerTransactionId, amountMatch, currencyMatch })) {
    return { ok: true, status: 'COMPLETED', verified: true };
  }

  const commercial = toCommercialState(payment.status);
  if (commercial === 'COMPLETED' && !providerVerified) {
    return { ok: false, status: 'RECONCILIATION_REQUIRED', reason: 'store marked complete without provider evidence' };
  }

  return {
    ok: true,
    status: commercial === 'COMPLETED' ? 'RECONCILIATION_REQUIRED' : commercial,
    verified: false,
    reason: providerResult?.reason || 'awaiting verified provider confirmation',
  };
}

export function reconcileInvoice(invoiceId) {
  const invoice = invoices.get(invoiceId);
  if (!invoice) return { ok: false, error: 'invoice not found' };
  const pays = payments.list({ invoiceId, limit: 100 });
  const entries = ledger.list({ invoiceId, limit: 100 });
  const paid = pays.filter((p) => toCommercialState(p.status) === 'COMPLETED');
  const paidSum = paid.reduce((s, p) => s + Number(p.amount || 0), 0);
  const balanced = Number(paidSum.toFixed(2)) === Number(Number(invoice.total).toFixed(2));
  return {
    ok: true,
    invoice,
    payments: pays,
    ledger: entries,
    paidSum,
    balanced,
    requiresReconciliation: !balanced && pays.length > 0,
  };
}
