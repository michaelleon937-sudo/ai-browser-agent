// tests/integration/agent-loop.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

let runAgent;
let migrate, closeDb;
let tmpDbPath;

beforeAll(async () => {
  tmpDbPath = path.join(os.tmpdir(), `agent-loop-${Date.now()}.db`);
  process.env.DATABASE_PATH = tmpDbPath;
  process.env.AI_PROVIDER = 'stub';
  process.env.HUMAN_APPROVAL_REQUIRED = 'false';
  ({ migrate, closeDb } = await import('../../database/index.js'));
  migrate();
  ({ runAgent } = await import('../../agent/index.js'));
});

afterAll(() => {
  try { closeDb(); } catch {}
  try { fs.unlinkSync(tmpDbPath); } catch {}
});

describe('agent loop integration', () => {
  it('completes a simple example.com goal via stub provider', async () => {
    const result = await runAgent({ goal: 'Visit example.com and report the status code' });
    expect(result.status).toBe('success');
  }, 60_000);

  it('PHASE 4: create sample and proposal for an opportunity (website sampleType)', async () => {
    const { prospects, opportunities } = await import('../../database/index.js');
    const prospect = prospects.create({ businessName: 'Phase4 Loop Realty', websiteUrl: null, location: 'Dar es Salaam' });
    const opportunity = opportunities.createOpportunity({
      prospectId: prospect.id,
      score: 85,
      priority: 'HIGH',
      recommendedSampleType: 'website',
    });

    const result = await runAgent({
      goal: `Create a sample and proposal for opportunity ${opportunity.id} using sampleType website`,
    });
    expect(result.status).toBe('success');

    const { samples: samplesRepo, proposals: proposalsRepo, steps, runs } = await import('../../database/index.js');
    const sample = samplesRepo.getForOpportunity(opportunity.id)[0];
    expect(sample).toBeTruthy();
    expect(sample.status).toBe('SAVED');
    expect(sample.content_kind).toBe('SPECULATIVE_SAMPLE');

    const proposal = proposalsRepo.getForOpportunity(opportunity.id)[0];
    expect(proposal).toBeTruthy();
    expect(proposal.status).toBe('READY');

    const updatedOpp = opportunities.getOpportunity(opportunity.id);
    expect(updatedOpp.status).toBe('AWAITING_APPROVAL');

    const runSteps = steps.listForRun(result.runId);
    const tools = runSteps.map((s) => s.tool);
    expect(tools).toContain('create_sample');
    expect(tools).toContain('save_sample');
    expect(tools).toContain('generate_proposal');
    expect(tools).toContain('save_proposal');
    expect(runSteps[runSteps.length - 1].tool).toBe('task_complete');
  }, 60_000);

  it('PHASE 4 CRITICAL: website sample ownership is correct across two different opportunities, and swapping is rejected', async () => {
    const { prospects, opportunities, samples: samplesRepo } = await import('../../database/index.js');

    const prospectA = prospects.create({ businessName: 'Ownership Integration A Realty', websiteUrl: null });
    const prospectB = prospects.create({ businessName: 'Ownership Integration B Realty', websiteUrl: null });
    const opportunityA = opportunities.createOpportunity({ prospectId: prospectA.id, score: 85, priority: 'HIGH', recommendedSampleType: 'website' });
    const opportunityB = opportunities.createOpportunity({ prospectId: prospectB.id, score: 80, priority: 'HIGH', recommendedSampleType: 'website' });

    const resultA = await runAgent({ goal: `Create a sample and proposal for opportunity ${opportunityA.id} using sampleType website` });
    const resultB = await runAgent({ goal: `Create a sample and proposal for opportunity ${opportunityB.id} using sampleType website` });

    expect(resultA.status).toBe('success');
    expect(resultB.status).toBe('success');

    const sampleA = samplesRepo.getForOpportunity(opportunityA.id)[0];
    const sampleB = samplesRepo.getForOpportunity(opportunityB.id)[0];

    expect(sampleA.website_sample_id).toBeTruthy();
    expect(sampleB.website_sample_id).toBeTruthy();
    expect(sampleA.website_sample_id).not.toBe(sampleB.website_sample_id);

    expect(sampleA.preview_path).toContain(sampleA.website_sample_id);
    expect(sampleB.preview_path).toContain(sampleB.website_sample_id);

    const { resolveSampleDir } = await import('../../integrations/website-gen.js');
    const fs = await import('node:fs');
    const pathMod = await import('node:path');
    expect(fs.existsSync(pathMod.join(resolveSampleDir(sampleA.website_sample_id), 'index.html'))).toBe(true);
    expect(fs.existsSync(pathMod.join(resolveSampleDir(sampleB.website_sample_id), 'index.html'))).toBe(true);

    const { samples: samplesRepoDirect } = await import('../../database/index.js');
    expect(() => samplesRepoDirect.create({
      prospectId: prospectB.id,
      opportunityId: opportunityB.id,
      sampleType: 'website',
      contentKind: 'SPECULATIVE_SAMPLE',
      websiteSampleId: sampleA.website_sample_id,
    })).toThrow(/does not belong to the current task\/run context|already linked to a different opportunity/);
  }, 90_000);
});
