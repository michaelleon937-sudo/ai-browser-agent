// integrations/commercial/quote-engine.js
import { quotes, QUOTE_STATUSES, ledger, ensureCommercialSchema } from '../../database/commercial-store.js';
import { invoices } from '../../database/index.js';

const QUOTE_TRANSITIONS = {
  DRAFT: new Set(['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'DECLINED']),
  PENDING_APPROVAL: new Set(['PENDING_APPROVAL', 'APPROVED', 'DECLINED', 'DRAFT']),
  APPROVED: new Set(['APPROVED', 'SENT', 'DECLINED']),
  SENT: new Set(['SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED']),
  ACCEPTED: new Set(['ACCEPTED', 'CONVERTED']),
  DECLINED: new Set(['DECLINED']),
  EXPIRED: new Set(['EXPIRED']),
  CONVERTED: new Set(['CONVERTED']),
};

export function assertQuoteTransition(from, to) {
  if (from === to) return;
  const allowed = QUOTE_TRANSITIONS[from];
  if (!allowed || !allowed.has(to)) throw new Error(`Invalid quote status transition: ${from} → ${to}`);
}

export function createQuote(input = {}) {
  ensureCommercialSchema();
  const quote = quotes.create(input);
  ledger.post({
    quoteId: quote.id, companyId: quote.company_id, entryType: 'QUOTE_CREATED', direction: 'MEMO',
    amount: quote.total, currency: quote.currency, idempotencyKey: `quote_created_${quote.id}`, description: quote.quote_number,
  });
  return quote;
}

export function approveQuote(id) {
  const q = quotes.get(id);
  if (!q) throw new Error('quote not found');
  if (q.status === 'DRAFT') {
    assertQuoteTransition(q.status, 'PENDING_APPROVAL');
    quotes.updateStatus(id, 'PENDING_APPROVAL');
  }
  const current = quotes.get(id);
  assertQuoteTransition(current.status, 'APPROVED');
  return quotes.updateStatus(id, 'APPROVED');
}

export function sendQuote(id) {
  const q = quotes.get(id);
  if (!q) throw new Error('quote not found');
  if (q.status === 'DRAFT' || q.status === 'PENDING_APPROVAL') approveQuote(id);
  const current = quotes.get(id);
  assertQuoteTransition(current.status, 'SENT');
  return quotes.updateStatus(id, 'SENT');
}

export function acceptQuote(id) {
  const q = quotes.get(id);
  if (!q) throw new Error('quote not found');
  assertQuoteTransition(q.status, 'ACCEPTED');
  return quotes.updateStatus(id, 'ACCEPTED');
}

export function convertQuoteToInvoice(id, { createInvoiceFn } = {}) {
  const q = quotes.get(id);
  if (!q) throw new Error('quote not found');
  if (q.status !== 'ACCEPTED' && q.status !== 'SENT' && q.status !== 'APPROVED') {
    throw new Error(`Quote cannot be converted from ${q.status}`);
  }
  const factory = createInvoiceFn || ((input) => invoices.create(input));
  const invoice = factory({
    companyId: q.company_id, contactId: q.contact_id, prospectId: q.prospect_id,
    opportunityId: q.opportunity_id, proposalId: q.proposal_id, currency: q.currency,
    subtotal: q.subtotal, tax: q.tax, total: q.total,
    description: `Converted from ${q.quote_number}`,
    lineItems: q.line_items_json ? JSON.parse(q.line_items_json) : undefined, status: 'DRAFT',
  });
  quotes.updateStatus(id, 'CONVERTED');
  ledger.post({
    quoteId: q.id, invoiceId: invoice.id, companyId: q.company_id, entryType: 'QUOTE_CONVERTED', direction: 'MEMO',
    amount: q.total, currency: q.currency, idempotencyKey: `quote_converted_${q.id}`,
    description: `${q.quote_number} → ${invoice.invoice_number || invoice.id}`,
  });
  return { quote: quotes.get(id), invoice };
}

export { QUOTE_STATUSES };
