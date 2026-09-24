// tests/unit/phase6-outreach-approval.test.js
// Phase 6: human approval + gated send (no auto-send, no fake success).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { computeOutreachContentHash, buildOutreachDraft } from '../../integrations/outreach-prep.js';

let migrate, closeDb, prospects, opportunities, samples, proposals;
let outreachMessages, outreachAttempts;
let approveOutreachMessage, denyOutreachMessage, sendApprovedOutreach;
let assertCanMarkContacted;
let outreachTools;
let tmpDbPath;

beforeAll(async () => {
  tmpDbPath = path.join(os.tmpdir(), `phase6-${Date.now()}.db`);
  process.env.DATABASE_PATH = tmpDbPath;
  process.env.AI_PROVIDER = 'stub';
  delete process.env.SMTP_HOST;

  ({
    migrate,
    closeDb,
    prospects,
    opportunities,
    samples,
    proposals,
    outreachMessages,
    outreachAttempts,
    assertCanMarkContacted,
  } = await import('../../database/index.js'));
  migrate();

  ({
    approveOutreachMessage,
    denyOutreachMessage,
    sendApprovedOutreach,
  } = await import('../../integrations/outreach-delivery.js'));

  ({ outreachTools } = await import('../../control/tools/outreach.js'));
});

afterAll(() => {
  try { closeDb(); } catch {}
  try { fs.unlinkSync(tmpDbPath); } catch {}
});

function seedDraft({ taskId = 'task-p6', runId = 'run-p6' } = {}) {
  const prospect = prospects.create({
    taskId,
    runId,
    businessName: 'Phase6 Realty',
    contactEmail: 'contact@phase6-realty.example',
    websiteUrl: 'https://phase6-realty.example',
  });
  prospects.updateStatus(prospect.id, 'ANALYZED');
  prospects.updateStatus(prospect.id, 'SAMPLE_CREATED');
  prospects.updateStatus(prospect.id, 'PROPOSAL_READY');
  prospects.updateStatus(prospect.id, 'AWAITING_APPROVAL');

  const opportunity = opportunities.createOpportunity({
    prospectId: prospect.id,
    taskId,
    runId,
    score: 80,
    priority: 'HIGH',
    status: 'AWAITING_APPROVAL',
  });
  const sample = samples.create({
    prospectId: prospect.id,
    opportunityId: opportunity.id,
    taskId,
    runId,
    sampleType: 'social-media',
    contentKind: 'CONCEPT_BRIEF',
  });
  samples.markSaved(sample.id);
  const proposal = proposals.create({
    prospectId: prospect.id,
    opportunityId: opportunity.id,
    sampleId: sample.id,
    taskId,
    runId,
    pitch: 'Likely gap in online presentation.',
    serviceRecommendation: 'Website improvements',
    valueProposition: 'Clearer listings.',
    callToAction: 'Happy to share more.',
    assumptions: ['Pricing not included'],
  });
  proposals.markReady(proposal.id);

  const draft = buildOutreachDraft({
    prospect: prospects.get(prospect.id),
    opportunity: opportunities.getOpportunity(opportunity.id),
    proposal: proposals.get(proposal.id),
    channel: 'email',
  });
  const message = outreachMessages.create({
    prospectId: prospect.id,
    opportunityId: opportunity.id,
    proposalId: proposal.id,
    sampleId: sample.id,
    taskId,
    runId,
    channel: draft.channel,
    recipient: draft.recipient,
    subject: draft.subject,
    body: draft.body,
    contentHash: draft.contentHash,
    status: 'READY_FOR_APPROVAL',
  });
  return { prospect, opportunity, sample, proposal, message };
}

describe('Phase 6 outreach approval', () => {
  it('approves READY_FOR_APPROVAL and records approval with content hash', () => {
    const { message } = seedDraft({ taskId: 't-appr', runId: 'r-appr' });
    const result = approveOutreachMessage(message.id, { decidedBy: 'tester' });
    expect(result.message.status).toBe('APPROVED');
    expect(result.approval.decision).toBe('approve');
    expect(result.approval.content_hash).toBe(message.content_hash);
    expect(result.approval.decided_by).toBe('tester');
  });

  it('denies READY_FOR_APPROVAL', () => {
    const { message } = seedDraft({ taskId: 't-deny', runId: 'r-deny' });
    const result = denyOutreachMessage(message.id, { decidedBy: 'tester' });
    expect(result.message.status).toBe('REJECTED');
    expect(result.approval.decision).toBe('deny');
  });

  it('rejects send without APPROVED status', async () => {
    const { message } = seedDraft({ taskId: 't-nosend', runId: 'r-nosend' });
    await expect(
      sendApprovedOutreach(message.id, { idempotencyKey: 'k-nosend' }),
    ).rejects.toThrow(/APPROVED/);
  });

  it('rejects send without idempotency key', async () => {
    const { message } = seedDraft({ taskId: 't-noidem', runId: 'r-noidem' });
    approveOutreachMessage(message.id, { decidedBy: 'tester' });
    await expect(sendApprovedOutreach(message.id, {})).rejects.toThrow(/idempotencyKey/);
  });

  it('fails clearly when SMTP is not configured (no fake success)', async () => {
    const { message } = seedDraft({ taskId: 't-smtp', runId: 'r-smtp' });
    approveOutreachMessage(message.id, { decidedBy: 'tester' });
    const result = await sendApprovedOutreach(message.id, { idempotencyKey: 'k-smtp-1' });
    expect(result.sent).toBe(false);
    expect(result.externalSideEffect).toBe(false);
    expect(result.message.status).toBe('FAILED');
    expect(result.attempt.status).toBe('FAILED');
    expect(result.error).toMatch(/SMTP not configured/i);
    expect(outreachAttempts.listForMessage(message.id)).toHaveLength(1);
  });

  it('replays identical idempotency key without double-send attempt', async () => {
    const { message } = seedDraft({ taskId: 't-replay', runId: 'r-replay' });
    approveOutreachMessage(message.id, { decidedBy: 'tester' });
    const first = await sendApprovedOutreach(message.id, { idempotencyKey: 'k-replay-1' });
    const second = await sendApprovedOutreach(message.id, { idempotencyKey: 'k-replay-1' });
    expect(second.replay).toBe(true);
    expect(second.attempt.id).toBe(first.attempt.id);
    expect(outreachAttempts.listForMessage(message.id)).toHaveLength(1);
  });

  it('sends successfully with mock transport and marks CONTACTED', async () => {
    const { message, prospect } = seedDraft({ taskId: 't-ok', runId: 'r-ok' });
    approveOutreachMessage(message.id, { decidedBy: 'tester' });

    const mockTransport = {
      async sendMail(opts) {
        expect(opts.to).toBe('contact@phase6-realty.example');
        expect(opts.subject).toContain('Phase6 Realty');
        return { messageId: 'mock-msg-1' };
      },
    };

    const result = await sendApprovedOutreach(message.id, {
      idempotencyKey: 'k-ok-1',
      transport: mockTransport,
    });
    expect(result.sent).toBe(true);
    expect(result.externalSideEffect).toBe(true);
    expect(result.message.status).toBe('SENT');
    expect(result.attempt.status).toBe('SUCCESS');
    expect(result.providerMessageId).toBe('mock-msg-1');

    const refreshed = prospects.get(prospect.id);
    expect(refreshed.status).toBe('CONTACTED');
  });

  it('assertCanMarkContacted blocks without confirmed send', () => {
    expect(() => assertCanMarkContacted({ hasConfirmedSend: false })).toThrow(/confirmed/);
    expect(() => assertCanMarkContacted({ hasConfirmedSend: true })).not.toThrow();
  });

  it('requires approved=true on control approve tool', async () => {
    const { message } = seedDraft({ taskId: 't-ctrl', runId: 'r-ctrl' });
    await expect(outreachTools['outreach.approve']({ messageId: message.id })).rejects.toThrow(/approved=true/);
    const ok = await outreachTools['outreach.approve']({ messageId: message.id, approved: true });
    expect(ok.status).toBe('APPROVED');
  });

  it('content hash helper remains stable for approval binding', () => {
    const h1 = computeOutreachContentHash({
      recipient: 'a@b.com', channel: 'email', subject: 'S', body: 'B', proposalId: 'p1',
    });
    const h2 = computeOutreachContentHash({
      recipient: 'a@b.com', channel: 'email', subject: 'S', body: 'B', proposalId: 'p1',
    });
    const h3 = computeOutreachContentHash({
      recipient: 'a@b.com', channel: 'email', subject: 'S', body: 'B-changed', proposalId: 'p1',
    });
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
  });
});
