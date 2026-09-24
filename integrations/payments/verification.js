// integrations/payments/verification.js
import { invoices, payments, billingRecords, assertPaymentStatusTransition } from '../../database/index.js';
import { getPaymentProvider } from './provider.js';

export async function verifyPayment(paymentId) {
  const payment = payments.get(paymentId);
  if (!payment) return { ok: false, error: 'payment not found' };
  const invoice = invoices.get(payment.invoice_id);
  if (!invoice) return { ok: false, error: 'invoice not found' };
  const provider = getPaymentProvider(payment.provider);
  const result = await provider.verifyPayment({ providerPaymentId: payment.provider_payment_id, amount: payment.amount, currency: payment.currency });
  if (!result.ok) return { ok: false, payment, invoice, verified: false, reason: result.reason || result.error || 'provider verification failed', status: result.status || 'UNKNOWN' };
  if (!result.verified) {
    if (payment.status === 'CREATED') { try { payments.updateStatus(payment.id, 'PENDING'); } catch {} }
    return { ok: true, payment: payments.get(payment.id), invoice, verified: false, reason: result.reason || 'not verified by provider', status: result.status || payment.status };
  }
  if (Number(result.amount) !== Number(invoice.total)) return { ok: false, payment, invoice, verified: false, reason: `amount mismatch: provider=${result.amount} invoice=${invoice.total}` };
  if (String(result.currency).toUpperCase() !== String(invoice.currency).toUpperCase()) return { ok: false, payment, invoice, verified: false, reason: `currency mismatch: provider=${result.currency} invoice=${invoice.currency}` };
  if (payment.status !== 'SUCCEEDED') {
    assertPaymentStatusTransition(payment.status, 'SUCCEEDED');
    payments.updateStatus(payment.id, 'SUCCEEDED', { verifiedAt: new Date().toISOString(), providerTransactionId: result.providerTransactionId });
  }
  if (invoice.status !== 'PAID') {
    if (['SENT', 'PARTIALLY_PAID', 'OVERDUE', 'APPROVED'].includes(invoice.status)) {
      if (invoice.status === 'APPROVED') invoices.updateStatus(invoice.id, 'SENT');
      const inv = invoices.get(invoice.id);
      if (['SENT', 'PARTIALLY_PAID', 'OVERDUE'].includes(inv.status)) invoices.updateStatus(invoice.id, 'PAID');
    }
  }
  billingRecords.create({ invoiceId: invoice.id, paymentId: payment.id, companyId: invoice.company_id, recordType: 'PAYMENT_CONFIRMED', amount: payment.amount, currency: payment.currency, description: `Verified via ${payment.provider}` });
  return { ok: true, payment: payments.get(payment.id), invoice: invoices.get(invoice.id), verified: true, status: 'SUCCEEDED' };
}

export async function handlePaymentWebhook({ provider: providerName, headers, body, rawBody }) {
  const provider = getPaymentProvider(providerName);
  const handled = await provider.handleWebhook({ headers, body, rawBody });
  if (!handled.ok) return { ok: false, reason: handled.reason || 'webhook rejected' };
  const { paymentWebhookEvents, payments: payRepo } = await import('../../database/index.js');
  const { event, duplicate } = paymentWebhookEvents.create({ provider: providerName, eventId: handled.eventId, eventType: handled.eventType, paymentId: null, payloadHash: handled.eventId });
  if (duplicate && event.processed) return { ok: true, duplicate: true, event };
  let payment = payRepo.list({ limit: 100, provider: providerName }).find((p) => p.provider_payment_id === handled.providerPaymentId);
  if (!payment) { paymentWebhookEvents.markProcessed(event.id); return { ok: false, reason: 'payment not found for webhook', event }; }
  if (handled.verified && handled.status === 'SUCCEEDED') {
    const verified = await verifyPayment(payment.id);
    paymentWebhookEvents.markProcessed(event.id);
    return { ok: true, duplicate: false, event, verification: verified };
  }
  if (handled.status === 'FAILED' && payment.status !== 'FAILED') { try { payRepo.updateStatus(payment.id, 'FAILED'); } catch {} }
  paymentWebhookEvents.markProcessed(event.id);
  return { ok: true, duplicate: false, event, payment: payRepo.get(payment.id), verified: false };
}
