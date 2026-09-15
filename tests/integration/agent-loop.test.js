// tests/integration/agent-loop.test.js
// Exercises the full plan → execute → observe loop against a real headless
// Chromium (via the stub AI provider so no external API calls are made).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';

let runAgent, browser, migrate, closeDb;

beforeAll(async () => {
  process.env.AI_PROVIDER = 'stub';
  process.env.DATABASE_PATH = path.join(os.tmpdir(), `agent-loop-${Date.now()}.db`);
  process.env.BROWSER_USER_DATA_DIR = path.join(os.tmpdir(), `agent-loop-profile-${Date.now()}`);
  process.env.WEBSITE_SAMPLES_DIR = path.join(os.tmpdir(), `agent-loop-samples-${Date.now()}`);
  process.env.HUMAN_APPROVAL_REQUIRED = 'false';
  ({ runAgent } = await import('../../agent/index.js'));
  ({ migrate, closeDb } = await import('../../database/index.js'));
  browser = (await import('../../browser/index.js')).default;
  migrate();
});

afterAll(async () => {
  await browser.close();
  closeDb();
});

describe('agent loop (integration)', () => {
  it('completes a simple navigation goal end to end', async () => {
    const result = await runAgent({
      goal: 'Go to example.com and check the status code',
    });
    expect(result.status).toBe('success');
    expect(result.runId).toBeTruthy();
  }, 60_000);

  it('fails safely instead of looping forever on a forced failure', async () => {
    const result = await runAgent({
      goal: 'force failure of the browser action',
    });
    expect(['failed']).toContain(result.status);
  }, 60_000);

  it('completes a website-generation goal end to end via the generate_website tool', async () => {
    const result = await runAgent({
      goal: 'Generate a speculative real-estate website sample for a fictional company called Example Property Tanzania. Create a professional responsive website with a hero section, services, featured properties using clearly marked sample data, about section, contact section and call to action. Do not contact anyone and do not publish the website.',
    });
    expect(result.status).toBe('success');
    expect(result.runId).toBeTruthy();

    // Verify the tool actually reached the executor and produced a step.
    const { steps } = await import('../../database/index.js');
    const runSteps = steps.listForRun(result.runId);
    const genStep = runSteps.find((s) => s.tool === 'generate_website');
    expect(genStep).toBeTruthy();
    expect(genStep.status).toBe('success');

    // Verify the SQLite record and files exist on disk.
    const { websiteSamples } = await import('../../database/index.js');
    const observation = JSON.parse(genStep.observation_json);
    expect(observation.status).toBe('SPECULATIVE_SAMPLE');

    const sample = websiteSamples.get(observation.sampleId);
    expect(sample).toBeTruthy();
    expect(sample.run_id).toBe(result.runId);

    const { resolveSampleDir } = await import('../../integrations/website-gen.js');
    const fs = await import('node:fs');
    const pathMod = await import('node:path');
    const dir = resolveSampleDir(observation.sampleId);
    expect(fs.existsSync(pathMod.join(dir, 'index.html'))).toBe(true);
  }, 60_000);

  it('existing browser tools still work after adding generate_website', async () => {
    const result = await runAgent({
      goal: 'Go to example.com and check the status code',
    });
    expect(result.status).toBe('success');
  }, 60_000);

  it('completes a full prospect → opportunity-analysis → save pipeline end to end', async () => {
    const result = await runAgent({
      goal: 'Find a real estate prospect, analyze the opportunity, and save the opportunity for this prospect.',
    });
    expect(result.status).toBe('success');
    expect(result.runId).toBeTruthy();

    const { steps, prospects, opportunities } = await import('../../database/index.js');
    const runSteps = steps.listForRun(result.runId);

    const saveProspectStep = runSteps.find((s) => s.tool === 'save_prospect');
    expect(saveProspectStep).toBeTruthy();
    expect(saveProspectStep.status).toBe('success');
    const prospectObs = JSON.parse(saveProspectStep.observation_json);
    expect(prospectObs.prospectId).toBeTruthy();

    const prospect = prospects.get(prospectObs.prospectId);
    expect(prospect).toBeTruthy();
    expect(prospect.business_name).toBe('Example Property Tanzania');

    const analyzeStep = runSteps.find((s) => s.tool === 'analyze_opportunity');
    expect(analyzeStep).toBeTruthy();
    expect(analyzeStep.status).toBe('success');
    const analysisObs = JSON.parse(analyzeStep.observation_json);
    expect(typeof analysisObs.score).toBe('number');
    expect(['HIGH', 'MEDIUM', 'LOW']).toContain(analysisObs.priority);

    const saveOppStep = runSteps.find((s) => s.tool === 'save_opportunity');
    expect(saveOppStep).toBeTruthy();
    expect(saveOppStep.status).toBe('success');
    const oppObs = JSON.parse(saveOppStep.observation_json);
    expect(oppObs.opportunityId).toBeTruthy();

    const savedOpp = opportunities.getOpportunity(oppObs.opportunityId);
    expect(savedOpp).toBeTruthy();
    expect(savedOpp.prospect_id).toBe(prospectObs.prospectId);
    expect(['NEW', 'ANALYZED', 'SAMPLE_RECOMMENDED']).toContain(savedOpp.status);
  }, 60_000);

  it('fails cleanly (not silently) when analyzing an opportunity for a prospect that does not exist', async () => {
    const result = await runAgent({
      goal: 'Attempt to analyze the opportunity for a prospect that does not exist (missing prospect test).',
    });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/Prospect not found/i);
  }, 60_000);
});
