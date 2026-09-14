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
});
