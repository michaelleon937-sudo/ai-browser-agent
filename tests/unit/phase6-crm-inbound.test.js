// tests/unit/phase6-crm-inbound.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tmpDbPath;
let companies, contacts, conversations, inboundMessages, prospects, migrate, closeDb;
let ingestInboundMessage, classifyInboundMessage, normalizeInboundPayload, validateNormalizedInbound;

beforeAll(async () => {
  tmpDbPath = path.join(os.tmpdir(), `crm-inbound-${Date.now()}.db`);
  process.env.DATABASE_PATH = tmpDbPath;
  process.env.DATA_DIR = path.dirname(tmpDbPath);
  process.env.AI_PROVIDER = 'stub';
  ({ companies, contacts, conversations, inboundMessages, prospects, migrate, closeDb }
    = await import('../../database/index.js'));
  closeDb();
  migrate();
  ({ ingestInboundMessage } = await import('../../integrations/inbound-ingestion.js'));
  ({ classifyInboundMessage } = await import('../../integrations/message-classification.js'));
  ({ normalizeInboundPayload, validateNormalizedInbound } = await import('../../integrations/inbound-adapters.js'));
});

afterAll(() => {
  try { closeDb(); } catch {}
  try { fs.unlinkSync(tmpDbPath); } catch {}
});

describe('Phase 6 CRM repositories', () => {
  it('creates company, contact, conversation', () => {
    const company = companies.create({ name: 'Acme Realty', domain: 'acme-realty.test', website: 'https://acme-realty.test' });
    expect(company.id).toBeTruthy();
    expect(companies.findByDomain('acme-realty.test')?.id).toBe(company.id);
    const contact = contacts.create({ companyId: company.id, name: 'Jane Doe', email: 'jane@acme-realty.test' });
    expect(contacts.findByEmail('jane@acme-realty.test')?.id).toBe(contact.id);
    const conv = conversations.create({ companyId: company.id, contactId: contact.id, channel: 'email', subject: 'Website inquiry' });
    expect(conversations.get(conv.id).status).toBe('OPEN');
  });
});

describe('Phase 6 CRM inbound ingestion', () => {
  it('ingests inbound message and classifies interest', () => {
    const result = ingestInboundMessage({
      provider: 'mock', channel: 'email', sender: 'client@example-biz.test',
      recipient: 'agent@localhost', subject: 'Interested in a website',
      body: 'Hi, we are interested. Can we schedule a call next week?',
      externalMessageId: 'msg-interest-1',
    });
    expect(result.ok).toBe(true);
    expect(result.duplicate).toBe(false);
    expect(result.classification).toBe('INTERESTED');
    expect(result.contact?.email).toBe('client@example-biz.test');
  });

  it('prevents duplicate external message ids', () => {
    const payload = { provider: 'mock', channel: 'email', sender: 'dup@example.test', body: 'Hello again', externalMessageId: 'dup-msg-99' };
    const a = ingestInboundMessage(payload);
    const b = ingestInboundMessage(payload);
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(true);
    expect(b.message.id).toBe(a.message.id);
  });

  it('resolves contact by email and links prospect CONTACTED → REPLIED', () => {
    const prospect = prospects.create({
      businessName: 'Summit Homes', websiteUrl: 'https://summit-homes.test',
      contactEmail: 'owner@summit-homes.test', status: 'CONTACTED',
    });
    const result = ingestInboundMessage({
      provider: 'mock', channel: 'email', sender: 'Owner <owner@summit-homes.test>',
      subject: 'Re: your proposal', body: 'Thanks for reaching out. We have a few questions about pricing?',
      externalMessageId: 'reply-1',
    });
    expect(result.prospect?.id).toBe(prospect.id);
    expect(result.prospectStatusUpdated).toBe(true);
    expect(prospects.get(prospect.id).status).toBe('REPLIED');
  });

  it('does not mark WON on simple reply', () => {
    const prospect = prospects.create({ businessName: 'Lake View Realty', contactEmail: 'hi@lakeview.test', status: 'CONTACTED' });
    ingestInboundMessage({ provider: 'mock', sender: 'hi@lakeview.test', body: 'Sounds interesting.', externalMessageId: 'reply-2', channel: 'email' });
    expect(prospects.get(prospect.id).status).toBe('REPLIED');
  });

  it('handles unknown sender without failing', () => {
    const result = ingestInboundMessage({
      provider: 'mock', channel: 'email', sender: 'mystery-person-no-email',
      body: 'Just saying hello from a form', externalMessageId: 'unknown-1',
    });
    expect(result.ok).toBe(true);
  });

  it('rejects malformed inbound payloads', () => {
    expect(() => ingestInboundMessage({})).toThrow();
    expect(validateNormalizedInbound({}).ok).toBe(false);
  });

  it('normalizes mock adapter payload', () => {
    const n = normalizeInboundPayload('mock', { id: 'x1', from: 'a@b.test', text: 'hello', threadId: 't1' });
    expect(n.provider).toBe('mock');
    expect(n.sender).toBe('a@b.test');
    expect(n.body).toBe('hello');
  });

  it('reuses conversation by external thread id', () => {
    const a = ingestInboundMessage({ provider: 'mock', channel: 'email', sender: 'thread@example.test', body: 'First', externalMessageId: 't-msg-1', externalThreadId: 'thread-abc' });
    const b = ingestInboundMessage({ provider: 'mock', channel: 'email', sender: 'thread@example.test', body: 'Second', externalMessageId: 't-msg-2', externalThreadId: 'thread-abc' });
    expect(a.conversation.id).toBe(b.conversation.id);
  });

  it('invalid prospect transition is not forced', () => {
    const prospect = prospects.create({ businessName: 'New Only', contactEmail: 'new@only.test', status: 'NEW' });
    const result = ingestInboundMessage({ provider: 'mock', channel: 'email', sender: 'new@only.test', body: 'Hi there', externalMessageId: 'new-only-1' });
    expect(result.prospectStatusUpdated).toBe(false);
    expect(prospects.get(prospect.id).status).toBe('NEW');
  });
});

describe('Phase 6 message classification', () => {
  it('classifies rejection and payment-related messages', () => {
    expect(classifyInboundMessage({ body: 'Please do not contact us, not interested.' }).classification).toBe('REJECTION');
    expect(classifyInboundMessage({ body: 'Where should we send payment for the invoice?' }).classification).toBe('PAYMENT_RELATED');
    expect(classifyInboundMessage({ body: 'Can you send a quote for a 5 page website?' }).classification).toBe('REQUEST_FOR_QUOTE');
  });

  it('extracts structured fields without inventing data', () => {
    const { extracted } = classifyInboundMessage({
      body: 'We need a website redesign for our company BrandCo. Budget around $3000 by next week. How long does it take?',
    });
    expect(extracted.requestedService).toBeTruthy();
    expect(extracted.budget).toBe('3000');
    expect(extracted.deadline).toBeTruthy();
    expect(extracted.quantity).toBeNull();
  });
});
