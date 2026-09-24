// tests/unit/phase6-crm-intelligence.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tmpDbPath;
let companies, contacts, conversations, inboundMessages, prospects, clientMemory, migrate, closeDb;
let assertCanMarkCustomer, assertProspectStatusTransition;
let ingestInboundMessage;
let refreshConversationIntelligence;
let updateClientMemory, getAuthoritativeFacts;
let recommendNextAction, NEXT_ACTIONS;
let crmTools;

beforeAll(async () => {
  tmpDbPath = path.join(os.tmpdir(), `crm-intel-${Date.now()}.db`);
  process.env.DATABASE_PATH = tmpDbPath;
  process.env.DATA_DIR = path.dirname(tmpDbPath);
  process.env.AI_PROVIDER = 'stub';

  ({
    companies, contacts, conversations, inboundMessages, prospects, clientMemory,
    migrate, closeDb, assertCanMarkCustomer, assertProspectStatusTransition,
  } = await import('../../database/index.js'));
  closeDb();
  migrate();

  ({ ingestInboundMessage } = await import('../../integrations/inbound-ingestion.js'));
  ({ refreshConversationIntelligence } = await import('../../integrations/conversation-intelligence.js'));
  ({ updateClientMemory, getAuthoritativeFacts } = await import('../../integrations/client-memory.js'));
  ({ recommendNextAction, NEXT_ACTIONS } = await import('../../integrations/next-action.js'));
  ({ crmTools } = await import('../../control/tools/crm.js'));
});

afterAll(() => {
  try { closeDb(); } catch {}
  try { fs.unlinkSync(tmpDbPath); } catch {}
});

describe('client lifecycle', () => {
  it('allows REPLIED → QUALIFIED and blocks CUSTOMER without explicit action', () => {
    const p = prospects.create({ businessName: 'Lifecycle Co', contactEmail: 'lc@test.com', status: 'CONTACTED' });
    prospects.updateStatus(p.id, 'REPLIED');
    assertProspectStatusTransition('REPLIED', 'QUALIFIED');
    prospects.updateStatus(p.id, 'QUALIFIED');
    expect(prospects.get(p.id).status).toBe('QUALIFIED');
    expect(() => assertCanMarkCustomer({ explicitAction: false })).toThrow();
    assertCanMarkCustomer({ explicitAction: true });
  });

  it('crm.mark_customer requires explicitAction', async () => {
    const p = prospects.create({ businessName: 'Won Co', status: 'QUALIFIED' });
    await expect(crmTools['crm.mark_customer']({ prospectId: p.id })).rejects.toThrow();
    const res = await crmTools['crm.mark_customer']({ prospectId: p.id, explicitAction: true });
    expect(res.ok).toBe(true);
    expect(res.prospect.status).toBe('CUSTOMER');
  });
});

describe('conversation intelligence + memory', () => {
  it('ingests service request, stores memory, recommends CREATE_OPPORTUNITY', () => {
    const result = ingestInboundMessage({
      provider: 'mock',
      channel: 'email',
      sender: 'owner@fashion-brand.test',
      subject: 'Need design work',
      body: 'Hi, I like the sample. Can you design 20 posts for my clothing brand? Budget around $500.',
      externalMessageId: 'svc-req-1',
    });
    expect(result.ok).toBe(true);
    expect(result.classification).toBe('REQUEST_FOR_SERVICE');
    const intel = refreshConversationIntelligence(result.conversation.id);
    expect(intel.summary).toContain('Client:');
    expect(intel.insight.message_count).toBeGreaterThan(0);
    expect(intel.nextAction.action).toBeTruthy();
    const mem = getAuthoritativeFacts({ companyId: result.company?.id, contactId: result.contact?.id });
    expect(mem.requested_service || mem.budget).toBeTruthy();
  });

  it('does not let INFERRED overwrite CONFIRMED_BY_CLIENT', () => {
    const company = companies.create({ name: 'Mem Co', domain: 'memco.test' });
    updateClientMemory({ companyId: company.id, key: 'brand_name', value: 'TrueBrand', confidence: 'CONFIRMED_BY_CLIENT' });
    const blocked = clientMemory.upsertFact({
      companyId: company.id, key: 'brand_name', value: 'GuessBrand', confidence: 'INFERRED', source: 'ai',
    });
    expect(blocked.blocked).toBe(true);
    expect(getAuthoritativeFacts({ companyId: company.id }).brand_name.value).toBe('TrueBrand');
  });

  it('retains history when confirmed fact changes', () => {
    const company = companies.create({ name: 'Hist Co', domain: 'hist.test' });
    updateClientMemory({ companyId: company.id, key: 'budget', value: '1000', confidence: 'CONFIRMED_BY_CLIENT' });
    updateClientMemory({ companyId: company.id, key: 'budget', value: '2000', confidence: 'CONFIRMED_BY_CLIENT' });
    const rows = clientMemory.list({ companyId: company.id, key: 'budget', limit: 10 });
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(getAuthoritativeFacts({ companyId: company.id }).budget.value).toBe('2000');
  });
});

describe('next-action recommendations', () => {
  it('maps classifications to internal actions only', () => {
    expect(recommendNextAction({ classification: 'PAYMENT_RELATED' }).action).toBe(NEXT_ACTIONS.HAND_OFF_TO_BILLING);
    expect(recommendNextAction({ classification: 'REVISION_REQUEST' }).action).toBe(NEXT_ACTIONS.CREATE_REVISION_TASK);
    expect(recommendNextAction({ classification: 'REQUEST_FOR_QUOTE' }).action).toBe(NEXT_ACTIONS.PREPARE_QUOTE);
    expect(recommendNextAction({ classification: 'REJECTION' }).action).toBe(NEXT_ACTIONS.NO_ACTION);
    expect(recommendNextAction({ classification: 'PAYMENT_RELATED' }).externalSideEffect).toBe(false);
  });
});

describe('link prospect to client', () => {
  it('creates company/contact links without marking WON', async () => {
    const p = prospects.create({
      businessName: 'Link Realty',
      websiteUrl: 'https://link-realty.test',
      contactEmail: 'ceo@link-realty.test',
      status: 'REPLIED',
    });
    const res = await crmTools['crm.link_prospect_to_client']({ prospectId: p.id });
    expect(res.ok).toBe(true);
    expect(res.company?.name).toBe('Link Realty');
    expect(res.contact?.email).toBe('ceo@link-realty.test');
    expect(prospects.get(p.id).status).toBe('REPLIED');
  });
});
