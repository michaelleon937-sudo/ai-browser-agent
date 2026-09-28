// integrations/commercial/refunds.js
// Refund architecture. Live provider execution is never invoked here.

import { invoices, payments, assertPaymentStatusTransition } from '../../database/index.js';
import { refundRecords, ledger, ensureCommercialSchema } from '../../database/commercial-store.js';
import { toCommercialState, transitionCommercialPayment } from './payment-machine.js';

export function requestRefund({ paymentId, amount, reason } = {}) {
  ensureCommercialSchema();
  const payment = payments.get(paymentId);
  if (!payment) throw new Error('payment not found');
  const commercial = toCommercialState(payment.status);
  if (commercial !== 'COMPLETED' && commercial !== 'REFUNDED') {
    throw new Error('refund requires a COMPLETED payment');
  }
  const invoice = invoices.get(payment.invoice_id);
  const refundAmount = amount != null ? Number(amount) : Number(payment.amount);
  if (refundAmount <= 0 || refundAmount > Number(payment.amount)) {
    throw new Error('invalid refund amount');
  }
  const existing = refundRecords.list({ paymentId }).find((r) =>
    ['REQUESTED', 'PENDING_APPROVAL', 'APPROVED', 'PROCESSING'].includes(r.status)
  );
  if (existing) return { refund: existing, duplicate: true };
  const refund = refundRecords.create({
    paymentId: payment.id,
    invoiceId: invoice?.id,
    amount: refundAmount,
    currency: payment.currency,
    reason,
  });
  ledger.post({
    invoiceId: invoice?.id,
    paymentId: payment.id,
    companyId: invoice?.company_id,
    entryType: 'REFUND_REQUESTED',
    direction: 'DEBIT',
    amount: refundAmount,
    currency: payment.currency,
    idempotencyKey: `refund_requested_${refund.id}`,
    description: reason || 'refund requested',
  });
  return { refund, duplicate: false };
}

export function approveRefund(id, { approvedBy } = {}) {
  const refund = refundRecords.get(id);
  if (!refund) throw new Error('refund not found');
  if (refund.status === 'REQUESTED') refundRecords.updateStatus(id, 'PENDING_APPROVAL');
  return refundRecords.updateStatus(id, 'APPROVED', { approvedBy: approvedBy || 'operator' });
}

export async function processRefund(id, { provider } = {}) {
  const refund = refundRecords.get(id);
  if (!refund) throw new Error('refund not found');
  if (refund.status !== 'APPROVED' && refund.status !== 'PROCESSING') {
    throw new Error(`refund cannot be processed from ${refund.status}`);
  }
  refundRecords.updateStatus(id, 'PROCESSING');

  if (provider && typeof provider.refundPayment === 'function') {
    const result = await provider.refundPayment({
      paymentId: refund.payment_id,
      amount: refund.amount,
      currency: refund.currency,
    });
    if (result && result.code === 'LIVE_EXECUTION_DISABLED') {
      refundRecords.updateStatus(id, 'FAILED');
      return { ok: false, refund: refundRecords.get(id), code: 'LIVE_EXECUTION_DISABLED' };
    }
    if (!result || result.ok !== true) {
      refundRecords.updateStatus(id, 'FAILED');
      return { ok: false, refund: refundRecords.get(id), error: result?.error || 'provider refund failed' };
    }
    refundRecords.updateStatus(id, 'COMPLETED', { providerRefundId: result.providerRefundId });
  } else {
    refundRecords.updateStatus(id, 'COMPLETED');
  }

  const payment = payments.get(refund.payment_id);
  if (payment && toCommercialState(payment.status) === 'COMPLETED') {
    try {
      transitionCommercialPayment(payment.status, 'REFUNDED', {});
      assertPaymentStatusTransition(payment.status, 'REFUNDED');
      payments.updateStatus(payment.id, 'REFUNDED');
    } catch { /* store may already be REFUNDED */ }
  }
  ledger.post({
    invoiceId: refund.invoice_id,
    paymentId: refund.payment_id,
    entryType: 'REFUND_COMPLETED',
    direction: 'DEBIT',
    amount: refund.amount,
    currency: refund.currency,
    idempotencyKey: `refund_completed_${refund.id}`,
    providerTxnId: refundRecords.get(id).provider_refund_id,
  });
  return { ok: true, refund: refundRecords.get(id) };
}

export function listRefunds(filters = {}) {
  ensureCommercialSchema();
  return refundRecords.list(filters);
}
