// integrations/commercial/reminders.js
// Recommendations only — never auto-sends email/SMS/WhatsApp.
import { invoices } from '../../database/index.js';
import { paymentReminders, ensureCommercialSchema } from '../../database/commercial-store.js';

export function generatePaymentReminders({ invoiceId } = {}) {
  ensureCommercialSchema();
  const invoice = invoices.get(invoiceId);
  if (!invoice) throw new Error('invoice not found');
  const created = [];
  if (['SENT', 'OVERDUE', 'PARTIALLY_PAID'].includes(invoice.status)) {
    const existing = paymentReminders.list({ invoiceId, status: 'OPEN' });
    if (!existing.length) {
      created.push(paymentReminders.create({
        invoiceId,
        companyId: invoice.company_id,
        reminderType: invoice.status === 'OVERDUE' ? 'OVERDUE' : 'DUE',
        dueAt: invoice.due_date || null,
        suggestedAction: 'Operator may send a payment reminder after approval. System will not send automatically.',
      }));
    }
  }
  return { ok: true, invoice, reminders: paymentReminders.list({ invoiceId }), created, externalSideEffect: false };
}

export function listPaymentReminders(filters = {}) {
  ensureCommercialSchema();
  return paymentReminders.list(filters);
}
