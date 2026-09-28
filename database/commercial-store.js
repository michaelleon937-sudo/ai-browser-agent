// database/commercial-store.js
// Phase 8 commercial schema — quotes, ledger, receipts, reminders, refunds.
// Additive CREATE TABLE IF NOT EXISTS only. No destructive migrations.

import { nanoid } from 'nanoid';
import { getDb } from './index.js';

const COMMERCIAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS quotes (
  id                TEXT PRIMARY KEY,
  company_id        TEXT,
  contact_id        TEXT,
  prospect_id       TEXT,
  opportunity_id    TEXT,
  proposal_id       TEXT,
  quote_number      TEXT NOT NULL UNIQUE,
  currency          TEXT NOT NULL DEFAULT 'KES',
  subtotal          REAL NOT NULL DEFAULT 0,
  tax               REAL NOT NULL DEFAULT 0,
  total             REAL NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'DRAFT',
  line_items_json   TEXT,
  valid_until       TEXT,
  notes             TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes (status);
CREATE INDEX IF NOT EXISTS idx_quotes_company ON quotes (company_id);

CREATE TABLE IF NOT EXISTS quote_sequences (
  year INTEGER PRIMARY KEY,
  last_seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS transaction_ledger (
  id                TEXT PRIMARY KEY,
  invoice_id        TEXT,
  payment_id        TEXT,
  quote_id          TEXT,
  receipt_id        TEXT,
  company_id        TEXT,
  entry_type        TEXT NOT NULL,
  direction         TEXT NOT NULL,
  amount            REAL NOT NULL DEFAULT 0,
  currency          TEXT NOT NULL DEFAULT 'KES',
  status            TEXT NOT NULL DEFAULT 'POSTED',
  idempotency_key   TEXT,
  provider          TEXT,
  provider_txn_id   TEXT,
  description       TEXT,
  metadata_json     TEXT,
  created_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_idempotency ON transaction_ledger (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ledger_payment ON transaction_ledger (payment_id);
CREATE INDEX IF NOT EXISTS idx_ledger_invoice ON transaction_ledger (invoice_id);

CREATE TABLE IF NOT EXISTS receipts (
  id                TEXT PRIMARY KEY,
  invoice_id        TEXT NOT NULL,
  payment_id        TEXT NOT NULL,
  receipt_number    TEXT NOT NULL UNIQUE,
  amount            REAL NOT NULL,
  currency          TEXT NOT NULL,
  issued_at         TEXT NOT NULL,
  verified          INTEGER NOT NULL DEFAULT 0,
  metadata_json     TEXT,
  created_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_receipts_payment ON receipts (payment_id);

CREATE TABLE IF NOT EXISTS payment_reminders (
  id                TEXT PRIMARY KEY,
  invoice_id        TEXT NOT NULL,
  company_id        TEXT,
  reminder_type     TEXT NOT NULL,
  due_at            TEXT,
  status            TEXT NOT NULL DEFAULT 'OPEN',
  suggested_action  TEXT NOT NULL,
  external_side_effect INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  resolved_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_reminders_invoice ON payment_reminders (invoice_id);
CREATE INDEX IF NOT EXISTS idx_reminders_status ON payment_reminders (status);

CREATE TABLE IF NOT EXISTS refund_records (
  id                TEXT PRIMARY KEY,
  payment_id        TEXT NOT NULL,
  invoice_id        TEXT,
  amount            REAL NOT NULL,
  currency          TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'REQUESTED',
  reason            TEXT,
  provider_refund_id TEXT,
  approved_by       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refunds_payment ON refund_records (payment_id);
`;

let _ready = false;
export function ensureCommercialSchema() {
  if (_ready) return;
  getDb().exec(COMMERCIAL_SCHEMA_SQL);
  _ready = true;
}

function db() {
  ensureCommercialSchema();
  return getDb();
}

export const QUOTE_STATUSES = Object.freeze([
  'DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CONVERTED',
]);

export const quotes = {
  create({
    companyId, contactId, prospectId, opportunityId, proposalId,
    currency = 'KES', subtotal = 0, tax = 0, total, lineItems, validUntil, notes, status = 'DRAFT',
  } = {}) {
    if (!QUOTE_STATUSES.includes(status)) throw new Error(`Invalid quote status: ${status}`);
    const id = nanoid(12);
    const now = new Date().toISOString();
    const year = new Date().getUTCFullYear();
    const seqRow = db().prepare('SELECT last_seq FROM quote_sequences WHERE year = ?').get(year);
    const next = (seqRow?.last_seq || 0) + 1;
    if (seqRow) db().prepare('UPDATE quote_sequences SET last_seq = ? WHERE year = ?').run(next, year);
    else db().prepare('INSERT INTO quote_sequences (year, last_seq) VALUES (?, ?)').run(year, next);
    const quoteNumber = `Q-${year}-${String(next).padStart(4, '0')}`;
    const tot = total != null ? Number(total) : Number(subtotal) + Number(tax);
    db().prepare(`
      INSERT INTO quotes (id, company_id, contact_id, prospect_id, opportunity_id, proposal_id,
        quote_number, currency, subtotal, tax, total, status, line_items_json, valid_until, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, companyId || null, contactId || null, prospectId || null, opportunityId || null, proposalId || null,
      quoteNumber, currency, Number(subtotal) || 0, Number(tax) || 0, tot, status,
      lineItems ? JSON.stringify(lineItems) : null, validUntil || null, notes || null, now, now,
    );
    return quotes.get(id);
  },
  get(id) {
    return db().prepare('SELECT * FROM quotes WHERE id = ?').get(id);
  },
  getByNumber(n) {
    return db().prepare('SELECT * FROM quotes WHERE quote_number = ?').get(n);
  },
  list({ limit = 50, status, companyId } = {}) {
    const c = []; const p = [];
    if (status) { c.push('status = ?'); p.push(status); }
    if (companyId) { c.push('company_id = ?'); p.push(companyId); }
    const w = c.length ? `WHERE ${c.join(' AND ')}` : '';
    p.push(limit);
    return db().prepare(`SELECT * FROM quotes ${w} ORDER BY created_at DESC LIMIT ?`).all(...p);
  },
  updateStatus(id, status) {
    if (!QUOTE_STATUSES.includes(status)) throw new Error(`Invalid quote status: ${status}`);
    const cur = quotes.get(id);
    if (!cur) throw new Error(`Quote not found: ${id}`);
    db().prepare('UPDATE quotes SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), id);
    return quotes.get(id);
  },
};

export const ledger = {
  post({
    invoiceId, paymentId, quoteId, receiptId, companyId, entryType, direction,
    amount, currency = 'KES', status = 'POSTED', idempotencyKey, provider, providerTxnId, description, metadata,
  } = {}) {
    if (!entryType) throw new Error('entryType is required');
    if (!direction) throw new Error('direction is required');
    if (idempotencyKey) {
      const existing = db().prepare('SELECT * FROM transaction_ledger WHERE idempotency_key = ?').get(idempotencyKey);
      if (existing) return { entry: existing, duplicate: true };
    }
    const id = nanoid(12);
    const now = new Date().toISOString();
    db().prepare(`
      INSERT INTO transaction_ledger
        (id, invoice_id, payment_id, quote_id, receipt_id, company_id, entry_type, direction,
         amount, currency, status, idempotency_key, provider, provider_txn_id, description, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, invoiceId || null, paymentId || null, quoteId || null, receiptId || null, companyId || null,
      entryType, direction, Number(amount) || 0, currency, status,
      idempotencyKey || null, provider || null, providerTxnId || null, description || null,
      metadata ? JSON.stringify(metadata) : null, now,
    );
    return { entry: ledger.get(id), duplicate: false };
  },
  get(id) {
    return db().prepare('SELECT * FROM transaction_ledger WHERE id = ?').get(id);
  },
  list({ invoiceId, paymentId, limit = 50 } = {}) {
    const c = []; const p = [];
    if (invoiceId) { c.push('invoice_id = ?'); p.push(invoiceId); }
    if (paymentId) { c.push('payment_id = ?'); p.push(paymentId); }
    const w = c.length ? `WHERE ${c.join(' AND ')}` : '';
    p.push(limit);
    return db().prepare(`SELECT * FROM transaction_ledger ${w} ORDER BY created_at DESC LIMIT ?`).all(...p);
  },
};

export const receipts = {
  issue({ invoiceId, paymentId, amount, currency, verified = false, metadata } = {}) {
    if (!invoiceId) throw new Error('invoiceId is required');
    if (!paymentId) throw new Error('paymentId is required');
    const existing = db().prepare('SELECT * FROM receipts WHERE payment_id = ?').get(paymentId);
    if (existing) return existing;
    const id = nanoid(12);
    const now = new Date().toISOString();
    const year = new Date().getUTCFullYear();
    const count = db().prepare("SELECT COUNT(*) AS n FROM receipts WHERE receipt_number LIKE ?").get(`R-${year}-%`).n || 0;
    const receiptNumber = `R-${year}-${String(count + 1).padStart(4, '0')}`;
    db().prepare(`
      INSERT INTO receipts (id, invoice_id, payment_id, receipt_number, amount, currency, issued_at, verified, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, invoiceId, paymentId, receiptNumber, Number(amount), currency, now, verified ? 1 : 0, metadata ? JSON.stringify(metadata) : null, now);
    return receipts.get(id);
  },
  get(id) {
    return db().prepare('SELECT * FROM receipts WHERE id = ?').get(id);
  },
  getByPayment(paymentId) {
    return db().prepare('SELECT * FROM receipts WHERE payment_id = ?').get(paymentId);
  },
  list({ invoiceId, limit = 50 } = {}) {
    if (invoiceId) {
      return db().prepare('SELECT * FROM receipts WHERE invoice_id = ? ORDER BY created_at DESC LIMIT ?').all(invoiceId, limit);
    }
    return db().prepare('SELECT * FROM receipts ORDER BY created_at DESC LIMIT ?').all(limit);
  },
};

export const paymentReminders = {
  create({ invoiceId, companyId, reminderType, dueAt, suggestedAction } = {}) {
    if (!invoiceId) throw new Error('invoiceId is required');
    if (!reminderType) throw new Error('reminderType is required');
    const id = nanoid(12);
    const now = new Date().toISOString();
    db().prepare(`
      INSERT INTO payment_reminders
        (id, invoice_id, company_id, reminder_type, due_at, status, suggested_action, external_side_effect, created_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, 'OPEN', ?, 0, ?, NULL)
    `).run(id, invoiceId, companyId || null, reminderType, dueAt || null, suggestedAction || 'Review invoice and request operator send', now);
    return paymentReminders.get(id);
  },
  get(id) {
    return db().prepare('SELECT * FROM payment_reminders WHERE id = ?').get(id);
  },
  list({ invoiceId, status, limit = 50 } = {}) {
    const c = []; const p = [];
    if (invoiceId) { c.push('invoice_id = ?'); p.push(invoiceId); }
    if (status) { c.push('status = ?'); p.push(status); }
    const w = c.length ? `WHERE ${c.join(' AND ')}` : '';
    p.push(limit);
    return db().prepare(`SELECT * FROM payment_reminders ${w} ORDER BY created_at DESC LIMIT ?`).all(...p);
  },
  resolve(id) {
    db().prepare("UPDATE payment_reminders SET status = 'RESOLVED', resolved_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
    return paymentReminders.get(id);
  },
};

export const REFUND_STATUSES = Object.freeze(['REQUESTED', 'PENDING_APPROVAL', 'APPROVED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED']);

export const refundRecords = {
  create({ paymentId, invoiceId, amount, currency, reason } = {}) {
    if (!paymentId) throw new Error('paymentId is required');
    if (amount == null) throw new Error('amount is required');
    const id = nanoid(12);
    const now = new Date().toISOString();
    db().prepare(`
      INSERT INTO refund_records
        (id, payment_id, invoice_id, amount, currency, status, reason, provider_refund_id, approved_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'REQUESTED', ?, NULL, NULL, ?, ?)
    `).run(id, paymentId, invoiceId || null, Number(amount), currency || 'KES', reason || null, now, now);
    return refundRecords.get(id);
  },
  get(id) {
    return db().prepare('SELECT * FROM refund_records WHERE id = ?').get(id);
  },
  list({ paymentId, limit = 50 } = {}) {
    if (paymentId) {
      return db().prepare('SELECT * FROM refund_records WHERE payment_id = ? ORDER BY created_at DESC LIMIT ?').all(paymentId, limit);
    }
    return db().prepare('SELECT * FROM refund_records ORDER BY created_at DESC LIMIT ?').all(limit);
  },
  updateStatus(id, status, extra = {}) {
    if (!REFUND_STATUSES.includes(status)) throw new Error(`Invalid refund status: ${status}`);
    const cur = refundRecords.get(id);
    if (!cur) throw new Error(`Refund not found: ${id}`);
    db().prepare('UPDATE refund_records SET status = ?, approved_by = ?, provider_refund_id = ?, updated_at = ? WHERE id = ?')
      .run(status, extra.approvedBy || cur.approved_by, extra.providerRefundId || cur.provider_refund_id, new Date().toISOString(), id);
    return refundRecords.get(id);
  },
};
