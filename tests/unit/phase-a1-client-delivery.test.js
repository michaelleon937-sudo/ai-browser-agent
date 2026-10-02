// Phase A1: approval-gated client delivery
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let migrate, closeDb, companies, contacts, conversations, inboundMessages;
let prepareClientDelivery, approveClientDelivery, sendApprovedClientDelivery;
let assertFinalDeliveryAllowed, resolvePaymentUrlFromPayment;
let assertSafeClientContent, renderTemplate;
let requiresApproval, evaluatePolicy;
let tmpDbPath;

beforeAll(async () => {
  tmpDbPath = path.join(os.tmpdir(), `phase-a1-${Date.now()}.db`);
  process.env.DATABASE_PATH = tmpDbPath;
  process.env.AI_PROVIDER = 'stub';
  process.env.PAYMENT_MODE = 'mock';
  process.env.LIVE_PAYMENTS_ENABLED = 'false';
  delete process.env.SMTP_HOST;
  process.env.NOTIFY_EMAIL_FROM = 'test@example.com';

  ({ migrate, closeDb, companies, contacts, conversations, inboundMessages } =
    await import('../../database/index.js'));
  migrate();

  ({
    prepareClientDelivery,
    approveClientDelivery,
    sendApprovedClientDelivery,
    assertFinalDeliveryAllowed,
    resolvePaymentUrlFromPayment,
  } = await import('../../integrations/comms/client-delivery.js'));

  ({ assertSafeClientContent, renderTemplate } =
    await import('../../integrations/comms/templates.js'));
  ({ requiresApproval, evaluatePolicy } = await import('../../control/policy.js'));
});

afterAll(() => {
  try { closeDb(); } catch { /* */ }
  delete process.env.NOTIFY_EMAIL_FROM;
  try { fs.unlinkSync(tmpDbPath); } catch { /* */ }
});

describe('Phase A1 templates', () => {
  it('renders invoice with payment URL', () => {
    const r = renderTemplate('INVOICE', {
      clientName: 'Asha', invoiceNumber: 'INV-1', amount: 50000, currency: 'TZS',
      paymentUrl: 'https://checkout.example.com/pay/abc', service: 'Website',
    });
    expect(r.bodyText).toContain('https://checkout.example.com/pay/abc');
    expect(() => assertSafeClientContent(r.bodyText)).not.toThrow();
  });
  it('rejects secrets and internal paths', () => {
    expect(() => assertSafeClientContent('x CONTROL_TOKEN=abc')).toThrow();
    expect(() => assertSafeClientContent('file /mnt/data/x.pdf')).toThrow();
  });
});

describe('Phase A1 approval and send', () => {
  it('policy requires approval for send', () => {
    expect(requiresApproval('client_delivery.send_approved')).toBe(true);
    expect(requiresApproval('client_delivery.approve')).toBe(true);
    expect(evaluatePolicy({
      toolName: 'client_delivery.send_approved',
      args: { deliveryId: 'x', approved: true },
    }).allow).toBe(true);
  });

  it('tool rejects send without approved=true', async () => {
    const { clientDeliveryTools } = await import('../../control/tools/client-delivery.js');
    await expect(
      clientDeliveryTools['client_delivery.send_approved']({
        deliveryId: 'x', approved: false, idempotencyKey: 'k',
      }),
    ).rejects.toThrow(/approved=true/);
  });

  it('blocks send until APPROVED', async () => {
    const prep = prepareClientDelivery({
      messageType: 'OUTREACH', recipient: 'client@example.com', service: 'Web',
    });
    expect(prep.delivery.status).toBe('READY_FOR_APPROVAL');
    await expect(
      sendApprovedClientDelivery(prep.delivery.id, { idempotencyKey: 'k-block' }),
    ).rejects.toThrow(/APPROVED/);
  });

  it('sends with mock transport and is idempotent', async () => {
    const prep = prepareClientDelivery({
      messageType: 'QUOTE', recipient: 'client@example.com',
      quoteNumber: 'Q-1', amount: 1000, currency: 'TZS', service: 'Logo',
    });
    approveClientDelivery(prep.delivery.id, { decidedBy: 'test' });
    const transport = { sendMail: async () => ({ messageId: 'mid-1' }) };
    const first = await sendApprovedClientDelivery(prep.delivery.id, {
      idempotencyKey: 'idem-a1-1', transport,
    });
    expect(first.sent).toBe(true);
    expect(first.delivery.status).toBe('SENT');
    const second = await sendApprovedClientDelivery(prep.delivery.id, {
      idempotencyKey: 'idem-a1-1', transport,
    });
    expect(second.replay).toBe(true);
  });

  it('fails when SMTP not configured', async () => {
    const prep = prepareClientDelivery({
      messageType: 'FOLLOW_UP', recipient: 'client@example.com', body: 'Hi',
    });
    approveClientDelivery(prep.delivery.id);
    const res = await sendApprovedClientDelivery(prep.delivery.id, { idempotencyKey: 'idem-no-smtp' });
    expect(res.sent).toBe(false);
    expect(res.delivery.status).toBe('FAILED');
  });

  it('rejects internal paths and non-http payment URLs', () => {
    expect(() => prepareClientDelivery({
      messageType: 'SAMPLE', recipient: 'client@example.com', artifactUrl: '/mnt/data/sample.pdf',
    })).toThrow();
    expect(() => prepareClientDelivery({
      messageType: 'PAYMENT_REQUEST', recipient: 'client@example.com', paymentUrl: 'pay/local',
    })).toThrow();
  });

  it('blocks FINAL_DELIVERY without verified payment', () => {
    expect(() => assertFinalDeliveryAllowed({ invoiceId: 'missing' })).toThrow();
    expect(() => prepareClientDelivery({
      messageType: 'FINAL_DELIVERY', recipient: 'client@example.com',
      artifactUrl: 'https://cdn.example.com/final.zip', invoiceId: 'missing',
    })).toThrow();
  });

  it('records outbound conversation history', async () => {
    const company = companies.create({ name: 'Acme TZ' });
    const contact = contacts.create({
      companyId: company.id, email: 'client@example.com', name: 'Asha',
    });
    const conv = conversations.create({
      companyId: company.id, contactId: contact.id, channel: 'email',
    });
    const prep = prepareClientDelivery({
      messageType: 'PROPOSAL', recipient: 'client@example.com',
      companyId: company.id, contactId: contact.id, conversationId: conv.id,
      service: 'Website', artifactUrl: 'https://cdn.example.com/proposal.pdf',
    });
    approveClientDelivery(prep.delivery.id);
    const res = await sendApprovedClientDelivery(prep.delivery.id, {
      idempotencyKey: 'idem-hist-1',
      transport: { sendMail: async () => ({ messageId: 'mid-hist' }) },
    });
    expect(res.sent).toBe(true);
    const msgs = inboundMessages.list({ conversationId: conv.id, limit: 20 });
    expect(msgs.some((m) => m.direction === 'outbound')).toBe(true);
  });

  it('does not invent payment URLs', () => {
    expect(resolvePaymentUrlFromPayment(null)).toBeNull();
    expect(resolvePaymentUrlFromPayment({ status: 'PENDING' })).toBeNull();
    expect(resolvePaymentUrlFromPayment({
      metadata_json: JSON.stringify({ checkoutUrl: 'https://checkout.stakaba.com/pay/x' }),
    })).toBe('https://checkout.stakaba.com/pay/x');
  });
});
