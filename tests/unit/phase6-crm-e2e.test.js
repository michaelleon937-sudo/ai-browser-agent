// tests/unit/phase6-crm-e2e.test.js
// Phase 6 Master Prompt 3 — full mocked lifecycle + required client message + side-effect guards.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tmpDbPath;
let companies, contacts, conversations, inboundMessages, prospects, opportunities;
let samples, proposals, outreachMessages, outreachApprovals, outreachAttempts;
let clientMemory, migrate, closeDb, assertCanMarkCustomer, assertProspectStatusTransition;
let ingestInboundMessage;
let refreshConversationIntelligence;
let getAuthoritativeFacts;
let recommendNextAction;
let draftClientReply;
let crmTools;
let evaluatePolicy;

beforeAll(async () => {
  tmpDbPath = path.join(os.tmpdir(), `crm-e2e-${Date.now()}.db`);
  process.env.DATABASE_PATH = tmpDbPath;
  process.env.DATA_DIR = path.dirname(tmpDbPath);
  process.env.AI_PROVIDER = 'stub';

  const db = await import('../../database/index.js');
  ({
    companies, contacts, conversations, inboundMessages, prospects, opportunities,
    samples, proposals, outreachMessages, outreachApprovals, outreachAttempts,
    clientMemory, migrate, closeDb, assertCanMarkCustomer, assertProspectStatusTransition,
  } = db);
  closeDb();
  migrate();

  ({ ingestInboundMessage } = await import('../../integrations/inbound-ingestion.js'));
  ({ refreshConversationIntelligence } = await import('../../integrations/conversation-intelligence.js'));
  ({ getAuthoritativeFacts } = await import('../../integrations/client-memory.js'));
  ({ recommendNextAction } = await import('../../integrations/next-action.js'));
  ({ draftClientReply } = await import('../../integrations/response-draft.js'));
  ({ crmTools } = await import('../../control/tools/crm.js'));
  ({ evaluatePolicy } = await import('../../control/policy.js'));
});

afterAll(() => {
  try { closeDb(); } catch {}
  try { fs.unlinkSync(tmpDbPath); } catch {}
});

const CLIENT_MESSAGE =
  'Hi, I like the sample. Can you design 20 social media posts for my clothing brand? We would like them completed next week.';

describe('Phase 6 E2E mocked lifecycle', () => {
  it('runs prospect → outreach → inbound → intelligence → memory → REPLIED without side effects', async () => {
    const prospect = prospects.create({
      businessName: 'Cloth Co',
      websiteUrl: 'https://cloth-co.test',
      contactEmail: 'owner@cloth-co.test',
      contactName: 'Alex',
      status: 'NEW',
    });
    prospects.updateStatus(prospect.id, 'ANALYZED');
    prospects.updateStatus(prospect.id, 'SAMPLE_CREATED');
    prospects.updateStatus(prospect.id, 'PROPOSAL_READY');
    prospects.updateStatus(prospect.id, 'AWAITING_APPROVAL');

    const opp = opportunities.createOpportunity({
      prospectId: prospect.id,
      score: 80,
      priority: 'HIGH',
      opportunityType: 'web_design',
      summary: 'Clothing brand needs design',
      status: 'OPEN',
    });
    expect(opp.id).toBeTruthy();

    const sample = samples.create({
      prospectId: prospect.id,
      opportunityId: opp.id,
      sampleType: 'website_mock',
      contentKind: 'html',
      content: JSON.stringify({ html: '<div>sample</div>' }),
    });
    expect(sample.id).toBeTruthy();

    const proposal = proposals.create({
      prospectId: prospect.id,
      opportunityId: opp.id,
      sampleId: sample.id,
      pitch: 'We can help with your brand presence.',
    });
    expect(proposal.id).toBeTruthy();

    const outreach = outreachMessages.create({
      prospectId: prospect.id,
      opportunityId: opp.id,
      proposalId: proposal.id,
      channel: 'email',
      recipient: 'owner@cloth-co.test',
      subject: 'Sample for Cloth Co',
      body: 'Please review the sample.',
      status: 'READY_FOR_APPROVAL',
      contentHash: 'hash-e2e-1',
    });
    expect(outreach.id).toBeTruthy();

    outreachApprovals.create({
      outreachMessageId: outreach.id,
      contentHash: 'hash-e2e-1',
      decision: 'APPROVED',
      decidedBy: 'operator-test',
    });
    outreachMessages.updateStatus(outreach.id, 'APPROVED');
    outreachMessages.updateStatus(outreach.id, 'SENDING');
    outreachAttempts.create({
      outreachMessageId: outreach.id,
      idempotencyKey: 'e2e-send-1',
      status: 'SUCCESS',
      providerMessageId: 'mock-msg-1',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });
    outreachMessages.updateStatus(outreach.id, 'SENT');

    assertProspectStatusTransition('AWAITING_APPROVAL', 'CONTACTED');
    prospects.updateStatus(prospect.id, 'CONTACTED');
    expect(prospects.get(prospect.id).status).toBe('CONTACTED');

    const first = ingestInboundMessage({
      provider: 'mock',
      channel: 'email',
      sender: 'owner@cloth-co.test',
      recipient: 'agent@example.com',
      subject: 'Re: Sample for Cloth Co',
      body: CLIENT_MESSAGE,
      externalMessageId: 'e2e-client-reply-1',
      externalThreadId: 'thread-cloth-1',
      prospectId: prospect.id,
    });
    expect(first.ok).toBe(true);
    expect(first.duplicate).toBeFalsy();
    expect(first.classification).toBe('REQUEST_FOR_SERVICE');
    expect(first.contact?.email).toBe('owner@cloth-co.test');
    expect(first.conversation?.id).toBeTruthy();

    const second = ingestInboundMessage({
      provider: 'mock',
      channel: 'email',
      sender: 'owner@cloth-co.test',
      body: CLIENT_MESSAGE,
      externalMessageId: 'e2e-client-reply-1',
      prospectId: prospect.id,
    });
    expect(second.duplicate).toBe(true);
    const msgs = inboundMessages.list({ conversationId: first.conversation.id, limit: 20 });
    expect(msgs.filter((m) => m.external_message_id === 'e2e-client-reply-1').length).toBe(1);

    const intel = refreshConversationIntelligence(first.conversation.id);
    expect(intel.summary).toContain('Client:');

    if (prospects.get(prospect.id).status === 'CONTACTED') {
      assertProspectStatusTransition('CONTACTED', 'REPLIED');
      prospects.updateStatus(prospect.id, 'REPLIED');
    }
    expect(prospects.get(prospect.id).status).toBe('REPLIED');

    const next = recommendNextAction({
      classification: 'REQUEST_FOR_SERVICE',
      requestedService: 'social media design',
      unresolvedQuestions: [],
      hasBudget: false,
      messageCount: 1,
      prospectStatus: 'REPLIED',
    });
    expect(next.externalSideEffect).toBe(false);

    expect(prospects.get(prospect.id).status).not.toBe('WON');
    expect(prospects.get(prospect.id).status).not.toBe('CUSTOMER');
    expect(() => assertCanMarkCustomer({ explicitAction: false })).toThrow();

    const draft = draftClientReply({ conversationId: first.conversation.id });
    expect(draft.ok).toBe(true);
    expect(draft.autoSend).toBe(false);
    expect(draft.requiresHumanApproval).toBe(true);
    expect(draft.context.budget).toBe('UNKNOWN');

    const drafted = await crmTools['crm.draft_reply']({ conversationId: first.conversation.id });
    expect(drafted.autoSend).toBe(false);

    const blocked = evaluatePolicy({ toolName: 'email.send', args: {} });
    expect(blocked.allow).toBe(false);
  });

  it('extracts required fields from the canonical client message without inventing budget', async () => {
    const { classifyInboundMessage } = await import('../../integrations/message-classification.js');
    const r = classifyInboundMessage({ body: CLIENT_MESSAGE });
    expect(r.classification).toBe('REQUEST_FOR_SERVICE');
    expect(r.extracted.requestedService).toMatch(/social media/i);
    expect(r.extracted.quantity).toMatch(/20/);
    expect(r.extracted.industry).toMatch(/clothing|fashion/i);
    expect(r.extracted.deadline).toBe('next week');
    expect(r.extracted.budget).toBeNull();
  });
});
