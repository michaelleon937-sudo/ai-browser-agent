// tests/unit/cloudflare-provider.test.js
//
// Covers the narrow fallback added to agent/ai/cloudflare.js: when a model
// response has no tool_calls and no {result: string} content, but the raw
// JSON content's keys uniquely identify exactly one available tool's
// parameter schema, treat it as a call to that tool. Includes the exact
// response shapes observed in the "Website engine test" production failure.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node-fetch', () => ({
  default: vi.fn(),
}));

import fetchMock from 'node-fetch';
import { cloudflareProvider } from '../../agent/ai/cloudflare.js';
import { ACTION_TOOLS } from '../../agent/ai/index.js';

function mockCloudflareResponse(content) {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      result: {
        response: {
          // No tool_calls at all — this is exactly the shape that caused
          // the production failure: the model wrote its intended call as
          // plain JSON text instead of using the tool-calling mechanism.
          content,
        },
      },
    }),
  });
}

describe('agent/ai/cloudflare — unique-schema-match fallback', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  const config = { ai: { cloudflare: { accountId: 'acc', apiToken: 'token', model: '@cf/openai/gpt-oss-20b' } } };

  it('reproduces and fixes the exact production failure: generate_website args sent as bare content', async () => {
    // Exact shape from the "Website engine test" crash log (truncated at
    // 300 chars there; full object reconstructed here for the test).
    const content = JSON.stringify({
      prospectName: 'Example Property Tanzania',
      businessType: 'Real Estate Agency',
      location: 'Tanzania',
      websiteGoal: 'Showcase properties and generate inquiries',
    });
    mockCloudflareResponse(content);

    const provider = cloudflareProvider({ config });
    const { action, done } = await provider.nextAction({
      goal: 'Generate a speculative real-estate website sample.',
      history: { steps: [] },
      observation: {},
      availableTools: ACTION_TOOLS,
    });

    expect(action.tool).toBe('generate_website');
    expect(action.args).toEqual({
      prospectName: 'Example Property Tanzania',
      businessType: 'Real Estate Agency',
      location: 'Tanzania',
      websiteGoal: 'Showcase properties and generate inquiries',
    });
    expect(done).toBe(false);
  });

  it('does NOT guess when content matches more than one tool schema (browser_navigate vs browser_new_tab)', async () => {
    // Exact second shape from the production crash log.
    const content = JSON.stringify({ url: 'https://localhost/website-samples/website_jsL5YGfzVfeV/' });
    mockCloudflareResponse(content);

    const provider = cloudflareProvider({ config });
    await expect(provider.nextAction({
      goal: 'irrelevant',
      history: { steps: [] },
      observation: {},
      availableTools: ACTION_TOOLS,
    })).rejects.toThrow(/Cloudflare AI returned no actionable response/);
  });

  it('still throws the original error for content matching no known tool schema', async () => {
    mockCloudflareResponse(JSON.stringify({ totallyUnknownField: 'nope' }));

    const provider = cloudflareProvider({ config });
    await expect(provider.nextAction({
      goal: 'irrelevant',
      history: { steps: [] },
      observation: {},
      availableTools: ACTION_TOOLS,
    })).rejects.toThrow(/Cloudflare AI returned no actionable response/);
  });

  it('still throws for empty/non-JSON content (no regression on the base case)', async () => {
    mockCloudflareResponse('');

    const provider = cloudflareProvider({ config });
    await expect(provider.nextAction({
      goal: 'irrelevant',
      history: { steps: [] },
      observation: {},
      availableTools: ACTION_TOOLS,
    })).rejects.toThrow(/Cloudflare AI returned no actionable response/);
  });

  it('regression: proper tool_calls responses still work unchanged', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: {
          response: {
            tool_calls: [{ function: { name: 'browser_navigate', arguments: JSON.stringify({ url: 'https://example.com' }) } }],
          },
        },
      }),
    });

    const provider = cloudflareProvider({ config });
    const { action } = await provider.nextAction({
      goal: 'irrelevant',
      history: { steps: [] },
      observation: {},
      availableTools: ACTION_TOOLS,
    });

    expect(action.tool).toBe('browser_navigate');
    expect(action.args).toEqual({ url: 'https://example.com' });
  });

  it('regression: the existing {result: string} fallback still works unchanged', async () => {
    mockCloudflareResponse(JSON.stringify({ result: 'All done.' }));

    const provider = cloudflareProvider({ config });
    const { action, done } = await provider.nextAction({
      goal: 'irrelevant',
      history: { steps: [] },
      observation: {},
      availableTools: ACTION_TOOLS,
    });

    expect(action.tool).toBe('task_complete');
    expect(action.args).toEqual({ result: 'All done.' });
    expect(done).toBe(true);
  });

  it('does not match on an empty object (never guesses with zero information)', async () => {
    mockCloudflareResponse(JSON.stringify({}));

    const provider = cloudflareProvider({ config });
    await expect(provider.nextAction({
      goal: 'irrelevant',
      history: { steps: [] },
      observation: {},
      availableTools: ACTION_TOOLS,
    })).rejects.toThrow(/Cloudflare AI returned no actionable response/);
  });
});
