// tests/unit/phase5a-outreach.test.js
// Phase 5A foundation: ownership, prepare_outreach, CRM transitions, no send.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildOutreachDraft } from '../../integrations/outreach-prep.js';

let migrate, closeDb, prospects, opportunities, samples, proposals;
let outreachMessages, outreachAttempts, assertOutreachOwnership;
let assertProspectStatusTransition, assertCanMarkContacted;
let isKnownTool;
let tmpDbPath;

beforeAll(async () => {
  tmpDbPath = path.join(os.tmpdir(), `phase5a-${Date.now()}.db`);
  process.env.DATABASE_PATH = tmpDbPath;
  process.env.AI_PROVIDER = 'stub';

  ({
    migrate,
    closeDb,
    prospects,
    opportunities,
    samples,
    proposals,
    outreachMessages,
    outreachAttempts,
    assertOutreachOwnership,
    assertProspectStatusTransition,
    assertCanMarkContacted,
  } = await import('../../database/index.js'));
  migrate();

  ({ isKnownTool } = await import('../../agent/ai/index.js'));
});

afterAll(() => {
  try { closeDb(); } catch {}
  try { fs.unlinkSync(tmpDbPath); } catch {}
});

function seedOwnedChain({ taskId = 'task-a', runId = 'run-a', email = 'public@example-realty.com' } = {}) {
  const prospect = prospects.create({
    taskId,
    runId,
    businessName: 'Example Realty',
    contactEmail: email,
    websiteUrl: 'https://example-realty.com',
  });
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
  return { prospect, opportunity, sample, proposal };
}

async function prepareOutreach(args, context = {}) {
  const channel = (args.channel || 'email').toLowerCase();
  if (channel !== 'email') throw new Error(`prepare_outreach supports only channel "email" in Phase 5A (got "${channel}")`);
  const opportunity = opportunities.getOpportunity(args.opportunityId);
  if (!opportunity) throw new Error(`Opportunity not found: ${args.opportunityId}`);
  const proposal = proposals.get(args.proposalId);
  if (!proposal) throw new Error(`Proposal not found: ${args.proposalId}`);
  if (proposal.status !== 'READY') throw new Error(`Proposal must be READY before prepare_outreach (status=${proposal.status})`);
  const prospect = prospects.get(opportunity.prospect_id);
  if (!prospect) throw new Error(`Prospect not found: ${opportunity.prospect_id}`);
  const sample = proposal.sample_id ? samples.get(proposal.sample_id) : null;
  assertOutreachOwnership({
    prospect, opportunity, proposal, sample: sample || undefined,
    taskId: context.taskId, runId: context.runId,
  });
  const oppStatus = opportunity.status || '';
  if (oppStatus && ['NEW', 'ANALYZED'].includes(oppStatus)) {
    throw new Error(`Opportunity status "${oppStatus}" is not ready for outreach preparation`);
  }
  const draft = buildOutreachDraft({ prospect, opportunity, proposal, channel: 'email' });
  const saved = outreachMessages.create({
    prospectId: prospect.id,
    opportunityId: opportunity.id,
    proposalId: proposal.id,
    sampleId: proposal.sample_id || null,
    taskId: context.taskId,
    runId: context.runId,
    channel: draft.channel,
    recipient: draft.recipient,
    subject: draft.subject,
    body: draft.body,
    contentHash: draft.contentHash,
    status: 'READY_FOR_APPROVAL',
  });
  return {
    success: true,
    outreachMessageId: saved.id,
    status: saved.status,
    recipient: saved.recipient,
    contentHash: saved.content_hash,
    sent: false,
    externalSideEffect: false,
  };
}

describe('tool registration', () => {
  it('registers prepare_outreach as a known tool', () => {
    expect(isKnownTool('prepare_outreach')).toBe(true);
  });
});

describe('CRM status transitions', () => {
  it('allows NEW → AWAITING_APPROVAL path used by later phases', () => {
    expect(() => assertProspectStatusTransition('NEW', 'AWAITING_APPROVAL')).not.toThrow();
    expect(() => assertProspectStatusTransition('AWAITING_APPROVAL', 'CONTACTED')).not.toThrow();
  });

  it('rejects invalid transitions', () => {
    expect(() => assertProspectStatusTransition('NEW', 'CONTACTED')).toThrow(/Invalid prospect status transition/);
    expect(() => assertProspectStatusTransition('NEW', 'WON')).toThrow(/Invalid prospect status transition/);
    expect(() => assertProspectStatusTransition('LOST', 'CONTACTED')).toThrow(/Invalid prospect status transition/);
  });

  it('assertCanMarkContacted requires confirmed send', () => {
    expect(() => assertCanMarkContacted({ hasConfirmedSend: false })).toThrow(/confirmed successful external send/);
    expect(() => assertCanMarkContacted({ hasConfirmedSend: true })).not.toThrow();
  });

  it('creating an outreach draft does not set CONTACTED', async () => {
    const { prospect, opportunity, proposal } = seedOwnedChain({ taskId: 't-contact', runId: 'r-contact' });
    expect(prospect.status).toBe('NEW');
    await prepareOutreach(
      { opportunityId: opportunity.id, proposalId: proposal.id },
      { taskId: 't-contact', runId: 'r-contact' },
    );
    expect(prospects.get(prospect.id).status).toBe('NEW');
  });
});

describe('ownership', () => {
  it('accepts consistent owned chain', () => {
    const { prospect, opportunity, proposal, sample } = seedOwnedChain({ taskId: 't1', runId: 'r1' });
    expect(() => assertOutreachOwnership({
      prospect, opportunity, proposal, sample, taskId: 't1', runId: 'r1',
    })).not.toThrow();
  });

  it('rejects proposal linked to different opportunity', () => {
    const a = seedOwnedChain({ taskId: 't-own-a', runId: 'r-own-a' });
    const b = seedOwnedChain({ taskId: 't-own-b', runId: 'r-own-b', email: 'other@example.com' });
    expect(() => assertOutreachOwnership({
      prospect: a.prospect,
      opportunity: a.opportunity,
      proposal: b.proposal,
      sample: a.sample,
    })).toThrow(/proposal does not belong to opportunity/);
  });

  it('rejects task_id mismatch when context provided', () => {
    const { prospect, opportunity, proposal, sample } = seedOwnedChain({ taskId: 'task-x', runId: 'run-x' });
    expect(() => assertOutreachOwnership({
      prospect, opportunity, proposal, sample, taskId: 'other-task', runId: 'run-x',
    })).toThrow(/task_id mismatch/);
  });
});

describe('prepare_outreach', () => {
  it('succeeds with valid owned prospect + opportunity + READY proposal', async () => {
    const { opportunity, proposal, prospect } = seedOwnedChain({ taskId: 't-ok', runId: 'r-ok' });
    const result = await prepareOutreach(
      { opportunityId: opportunity.id, proposalId: proposal.id, channel: 'email' },
      { taskId: 't-ok', runId: 'r-ok' },
    );
    expect(result.success).toBe(true);
    expect(result.sent).toBe(false);
    expect(result.externalSideEffect).toBe(false);
    expect(result.recipient).toBe('public@example-realty.com');
    expect(prospects.get(prospect.id).status).toBe('NEW');
    const stored = outreachMessages.get(result.outreachMessageId);
    expect(stored.status).toBe('READY_FOR_APPROVAL');
    expect(stored.content_hash).toBe(result.contentHash);
  });

  it('fails when proposal is missing', async () => {
    const { opportunity } = seedOwnedChain({ taskId: 't-miss', runId: 'r-miss' });
    await expect(prepareOutreach({
      opportunityId: opportunity.id,
      proposalId: 'does-not-exist',
    })).rejects.toThrow(/Proposal not found/);
  });

  it('fails when proposal is not READY', async () => {
    const chain = seedOwnedChain({ taskId: 't-draft', runId: 'r-draft' });
    const draftProp = proposals.create({
      prospectId: chain.prospect.id,
      opportunityId: chain.opportunity.id,
      sampleId: chain.sample.id,
      taskId: 't-draft',
      runId: 'r-draft',
      pitch: 'draft only',
    });
    await expect(prepareOutreach({
      opportunityId: chain.opportunity.id,
      proposalId: draftProp.id,
    }, { taskId: 't-draft', runId: 'r-draft' })).rejects.toThrow(/must be READY/);
  });

  it('fails when no public email exists', async () => {
    const chain = seedOwnedChain({ taskId: 't-noemail', runId: 'r-noemail', email: null });
    await expect(prepareOutreach({
      opportunityId: chain.opportunity.id,
      proposalId: chain.proposal.id,
    }, { taskId: 't-noemail', runId: 'r-noemail' })).rejects.toThrow(/verified public contact email/i);
  });

  it('fails when email is invalid', async () => {
    const chain = seedOwnedChain({ taskId: 't-bademail', runId: 'r-bademail', email: 'not-valid' });
    await expect(prepareOutreach({
      opportunityId: chain.opportunity.id,
      proposalId: chain.proposal.id,
    }, { taskId: 't-bademail', runId: 'r-bademail' })).rejects.toThrow(/verified public contact email/i);
  });

  it('fails on ownership mismatch across tasks', async () => {
    const a = seedOwnedChain({ taskId: 'task-1', runId: 'run-1' });
    await expect(prepareOutreach({
      opportunityId: a.opportunity.id,
      proposalId: a.proposal.id,
    }, { taskId: 'other-task', runId: 'run-1' })).rejects.toThrow(/task_id mismatch/);
  });

  it('does not perform external side effects', async () => {
    const chain = seedOwnedChain({ taskId: 't-side', runId: 'r-side' });
    const result = await prepareOutreach({
      opportunityId: chain.opportunity.id,
      proposalId: chain.proposal.id,
    }, { taskId: 't-side', runId: 'r-side' });
    expect(result.sent).toBe(false);
    expect(result.externalSideEffect).toBe(false);
    expect(outreachAttempts.listForMessage(result.outreachMessageId)).toHaveLength(0);
  });
});
