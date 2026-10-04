import { describe, expect, it } from 'vitest';
import { ingestWebsiteLead } from '../../integrations/website-leads.js';

describe('website lead capture', () => {
  it('validates required consent and contact fields', () => {
    expect(() => ingestWebsiteLead({ email: 'bad', name: 'A', message: 'Hi', consent: true })).toThrow(/valid email/);
    expect(() => ingestWebsiteLead({ email: 'a@example.com', name: 'A', message: 'Hi' })).toThrow(/consent/);
  });
  it('persists an enquiry through the CRM inbound pipeline and is idempotent', () => {
    const externalMessageId = 'test-website-lead-001';
    const first = ingestWebsiteLead({ name: 'Website Test', email: 'website-test@example.com', message: 'I need a website.', consent: true, externalMessageId });
    const second = ingestWebsiteLead({ name: 'Website Test', email: 'website-test@example.com', message: 'I need a website.', consent: true, externalMessageId });
    expect(first.ok).toBe(true);
    expect(first.leadId).toBeTruthy();
    expect(first.conversationId).toBeTruthy();
    expect(second.duplicate).toBe(true);
    expect(second.leadId).toBe(first.leadId);
  });
});
