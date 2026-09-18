// tests/unit/database.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tasks, runs, steps, migrate, closeDb, websiteSamples, prospects, opportunities, samples, proposals;
let tmpDbPath;

beforeAll(async () => {
  tmpDbPath = path.join(os.tmpdir(), `agent-test-${Date.now()}.db`);
  process.env.DATABASE_PATH = tmpDbPath;
  ({ tasks, runs, steps, migrate, closeDb, websiteSamples, prospects, opportunities, samples, proposals } = await import('../../database/index.js'));
  migrate();
});

afterAll(() => {
  try { closeDb(); } catch {}
  try { fs.unlinkSync(tmpDbPath); } catch {}
});

describe('database/tasks', () => {
  it('creates and retrieves a task', () => {
    const t = tasks.create({ name: 't1', goal: 'do something' });
    expect(t.id).toBeTruthy();
    expect(tasks.get(t.id).name).toBe('t1');
  });
});

describe('database/prospects', () => {
  it('creates a prospect with default status NEW', () => {
    const p = prospects.create({ businessName: 'Test Realty' });
    expect(p.status).toBe('NEW');
  });
});

describe('database/opportunities', () => {
  it('creates an opportunity linked to a prospect', () => {
    const p = prospects.create({ businessName: 'Opp Realty' });
    const o = opportunities.createOpportunity({ prospectId: p.id, score: 70, priority: 'MEDIUM' });
    expect(o.prospect_id).toBe(p.id);
    expect(opportunities.getOpportunity('does-not-exist')).toBeUndefined();
  });
});

describe('database/samples', () => {
  it('creates a concept-brief sample with default status DRAFT', () => {
    const prospect = prospects.create({ businessName: 'Sample Target Realty' });
    const opportunity = opportunities.createOpportunity({ prospectId: prospect.id, score: 70, priority: 'MEDIUM' });
    const created = samples.create({
      prospectId: prospect.id,
      opportunityId: opportunity.id,
      sampleType: 'social-media',
      contentKind: 'CONCEPT_BRIEF',
      content: { headline: 'test' },
    });
    expect(created.status).toBe('DRAFT');
    expect(created.content_kind).toBe('CONCEPT_BRIEF');
    expect(created.sample_type).toBe('social-media');
    expect(JSON.parse(created.concept_content_json)).toEqual({ headline: 'test' });
  });

  it('markSaved transitions status to SAVED without touching content_kind', () => {
    const prospect = prospects.create({ businessName: 'Mark Saved Realty' });
    const opportunity = opportunities.createOpportunity({ prospectId: prospect.id, score: 70, priority: 'MEDIUM' });
    const created = samples.create({ prospectId: prospect.id, opportunityId: opportunity.id, sampleType: 'brand-design', contentKind: 'CONCEPT_BRIEF' });
    const saved = samples.markSaved(created.id);
    expect(saved.status).toBe('SAVED');
    expect(saved.content_kind).toBe('CONCEPT_BRIEF');
  });

  it('rejects creating a sample for a nonexistent website_sample_id', () => {
    const prospect = prospects.create({ businessName: 'Orphan Website Sample Realty' });
    const opportunity = opportunities.createOpportunity({ prospectId: prospect.id, score: 70, priority: 'MEDIUM' });
    expect(() => samples.create({
      prospectId: prospect.id,
      opportunityId: opportunity.id,
      sampleType: 'website',
      contentKind: 'SPECULATIVE_SAMPLE',
      websiteSampleId: 'website_does_not_exist',
    })).toThrow(/Website sample not found/);
  });

  it('lists samples filtered by status, contentKind, sampleType, opportunityId', () => {
    const prospect = prospects.create({ businessName: 'Filter Sample Realty' });
    const opportunity = opportunities.createOpportunity({ prospectId: prospect.id, score: 70, priority: 'MEDIUM' });
    const a = samples.create({ prospectId: prospect.id, opportunityId: opportunity.id, sampleType: 'social-media', contentKind: 'CONCEPT_BRIEF' });
    samples.markSaved(a.id);

    expect(samples.list({ status: 'SAVED', limit: 10 }).map((s) => s.id)).toContain(a.id);
    expect(samples.list({ contentKind: 'CONCEPT_BRIEF', limit: 10 }).map((s) => s.id)).toContain(a.id);
    expect(samples.list({ sampleType: 'social-media', limit: 10 }).map((s) => s.id)).toContain(a.id);
    expect(samples.getForOpportunity(opportunity.id).map((s) => s.id)).toContain(a.id);
  });

  it('returns undefined for an unknown sample id', () => {
    expect(samples.get('does-not-exist')).toBeUndefined();
  });

  describe('CRITICAL: website_sample_id ownership verification', () => {
    it('accepts a website_sample_id whose task/run context matches and links it to the correct opportunity', () => {
      const prospect = prospects.create({ businessName: 'Ownership A Realty' });
      const opportunityA = opportunities.createOpportunity({ prospectId: prospect.id, score: 90, priority: 'HIGH' });

      const websiteSampleA = websiteSamples.create({
        id: 'website_owner_a', taskId: 'task_A', runId: 'run_A',
        prospectName: 'Ownership A Realty', files: [], previewPath: '/website-samples/website_owner_a/',
      });

      const samplesA = samples.create({
        prospectId: prospect.id, opportunityId: opportunityA.id,
        taskId: 'task_A', runId: 'run_A',
        sampleType: 'website', contentKind: 'SPECULATIVE_SAMPLE',
        websiteSampleId: websiteSampleA.id, previewPath: websiteSampleA.preview_path,
      });

      expect(samplesA.website_sample_id).toBe('website_owner_a');
      expect(samplesA.opportunity_id).toBe(opportunityA.id);
    });

    it('rejects a website_sample_id whose task/run context does not match the caller\'s context', () => {
      const prospect = prospects.create({ businessName: 'Ownership Mismatch Realty' });
      const opportunity = opportunities.createOpportunity({ prospectId: prospect.id, score: 90, priority: 'HIGH' });

      const websiteSample = websiteSamples.create({
        id: 'website_mismatch_1', taskId: 'task_X', runId: 'run_X',
        prospectName: 'Ownership Mismatch Realty', files: [], previewPath: '/website-samples/website_mismatch_1/',
      });

      expect(() => samples.create({
        prospectId: prospect.id, opportunityId: opportunity.id,
        taskId: 'task_Y', runId: 'run_Y',
        sampleType: 'website', contentKind: 'SPECULATIVE_SAMPLE',
        websiteSampleId: websiteSample.id,
      })).toThrow(/does not belong to the current task\/run context/);
    });

    it('CRITICAL: opportunity B cannot link to opportunity A\'s already-linked website sample (swap rejected)', () => {
      const prospectA = prospects.create({ businessName: 'Swap Test A Realty' });
      const prospectB = prospects.create({ businessName: 'Swap Test B Realty' });
      const opportunityA = opportunities.createOpportunity({ prospectId: prospectA.id, score: 90, priority: 'HIGH' });
      const opportunityB = opportunities.createOpportunity({ prospectId: prospectB.id, score: 85, priority: 'HIGH' });

      const websiteSampleA = websiteSamples.create({ id: 'website_swap_a', taskId: 'task_swap', runId: 'run_swap', prospectName: 'A', files: [], previewPath: '/website-samples/website_swap_a/' });
      const websiteSampleB = websiteSamples.create({ id: 'website_swap_b', taskId: 'task_swap', runId: 'run_swap', prospectName: 'B', files: [], previewPath: '/website-samples/website_swap_b/' });

      const sampleA = samples.create({
        prospectId: prospectA.id, opportunityId: opportunityA.id, taskId: 'task_swap', runId: 'run_swap',
        sampleType: 'website', contentKind: 'SPECULATIVE_SAMPLE', websiteSampleId: websiteSampleA.id, previewPath: websiteSampleA.preview_path,
      });
      const sampleB = samples.create({
        prospectId: prospectB.id, opportunityId: opportunityB.id, taskId: 'task_swap', runId: 'run_swap',
        sampleType: 'website', contentKind: 'SPECULATIVE_SAMPLE', websiteSampleId: websiteSampleB.id, previewPath: websiteSampleB.preview_path,
      });

      expect(sampleA.website_sample_id).toBe(websiteSampleA.id);
      expect(sampleB.website_sample_id).toBe(websiteSampleB.id);

      expect(() => samples.create({
        prospectId: prospectB.id, opportunityId: opportunityB.id, taskId: 'task_swap', runId: 'run_swap',
        sampleType: 'website', contentKind: 'SPECULATIVE_SAMPLE', websiteSampleId: websiteSampleA.id,
      })).toThrow(/already linked to a different opportunity/);

      expect(() => samples.create({
        prospectId: prospectA.id, opportunityId: opportunityA.id, taskId: 'task_swap', runId: 'run_swap',
        sampleType: 'website', contentKind: 'SPECULATIVE_SAMPLE', websiteSampleId: websiteSampleB.id,
      })).toThrow(/already linked to a different opportunity/);
    });

    it('allows re-linking the SAME website_sample_id to the SAME opportunity (idempotent re-save is not treated as a swap)', () => {
      const prospect = prospects.create({ businessName: 'Same Opportunity Relink Realty' });
      const opportunity = opportunities.createOpportunity({ prospectId: prospect.id, score: 80, priority: 'HIGH' });
      const websiteSample = websiteSamples.create({ id: 'website_relink_1', taskId: 'task_relink', runId: 'run_relink', prospectName: 'X', files: [], previewPath: '/website-samples/website_relink_1/' });

      samples.create({
        prospectId: prospect.id, opportunityId: opportunity.id, taskId: 'task_relink', runId: 'run_relink',
        sampleType: 'website', contentKind: 'SPECULATIVE_SAMPLE', websiteSampleId: websiteSample.id,
      });

      expect(() => samples.create({
        prospectId: prospect.id, opportunityId: opportunity.id, taskId: 'task_relink', runId: 'run_relink',
        sampleType: 'website', contentKind: 'SPECULATIVE_SAMPLE', websiteSampleId: websiteSample.id,
      })).not.toThrow();
    });
  });
});

describe('database/proposals', () => {
  it('creates a proposal with default status DRAFT', () => {
    const prospect = prospects.create({ businessName: 'Proposal Target Realty' });
    const opportunity = opportunities.createOpportunity({ prospectId: prospect.id, score: 70, priority: 'MEDIUM' });
    const sample = samples.create({ prospectId: prospect.id, opportunityId: opportunity.id, sampleType: 'social-media', contentKind: 'CONCEPT_BRIEF' });

    const created = proposals.create({
      prospectId: prospect.id, opportunityId: opportunity.id, sampleId: sample.id,
      pitch: 'Test pitch', serviceRecommendation: 'Social Media', valueProposition: 'Value',
      suggestedPackage: 'Package', callToAction: 'CTA', assumptions: ['A1'],
    });
    expect(created.status).toBe('DRAFT');
    expect(JSON.parse(created.assumptions_json)).toEqual(['A1']);
  });

  it('markReady transitions status to READY', () => {
    const prospect = prospects.create({ businessName: 'Ready Proposal Realty' });
    const opportunity = opportunities.createOpportunity({ prospectId: prospect.id, score: 70, priority: 'MEDIUM' });
    const created = proposals.create({ prospectId: prospect.id, opportunityId: opportunity.id, pitch: 'x' });
    const ready = proposals.markReady(created.id);
    expect(ready.status).toBe('READY');
  });

  it('lists proposals filtered by status and opportunityId', () => {
    const prospect = prospects.create({ businessName: 'Filter Proposal Realty' });
    const opportunity = opportunities.createOpportunity({ prospectId: prospect.id, score: 70, priority: 'MEDIUM' });
    const created = proposals.create({ prospectId: prospect.id, opportunityId: opportunity.id, pitch: 'x' });
    proposals.markReady(created.id);

    expect(proposals.list({ status: 'READY', limit: 10 }).map((p) => p.id)).toContain(created.id);
    expect(proposals.getForOpportunity(opportunity.id).map((p) => p.id)).toContain(created.id);
  });

  it('returns undefined for an unknown proposal id', () => {
    expect(proposals.get('does-not-exist')).toBeUndefined();
  });
});
