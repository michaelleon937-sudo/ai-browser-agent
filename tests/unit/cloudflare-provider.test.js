// tests/unit/cloudflare-provider.test.js
//
// Covers response-shape normalization for Cloudflare Workers AI REST API and
// the unique-schema-match fallback: when a model response has no tool_calls
// but the raw JSON content's keys uniquely identify exactly one available
// tool's parameter schema, treat it as a call to that tool.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node-fetch', () => ({
  default: vi.fn(),
}));

import fetchMock from 'node-fetch';
import { cloudflareProvider, normalizeCloudflareResponse } from '../../agent/ai/cloudflare.js';
import { ACTION_TOOLS } from '../../agent/ai/index.js';

function mockJson(json) {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => json,
  });
}

/** Legacy helper: object-shaped result.response with a content string. */
function mockCloudflareResponse(content) {
  mockJson({
    result: {
      response: {
        content,
      },
    },
  });
}

describe('agent/ai/cloudflare — normalizeCloudflareResponse', () => {
  it('treats result.response string as content (documented CF REST shape)', () => {
    const { toolCalls, content } = normalizeCloudflareResponse({
      result: { response: '{"tool":"browser_navigate","args":{"url":"https://example.com"}}' },
      success: true,
    });
    expect(content).toBe('{"tool":"browser_navigate","args":{"url":"https://example.com"}}');
    expect(toolCalls).toEqual([]);
  });

  it('reads content and tool_calls from result.response object', () => {
    const { toolCalls, content } = normalizeCloudflareResponse({
      result: {
        response: {
          content: 'hello',
          tool_calls: [{ function: { name: 'browser_snapshot', arguments: '{}' } }],
        },
      },
    });
    expect(content).toBe('hello');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].function.name).toBe('browser_snapshot');
  });

  it('reads result.choices[0].message', () => {
    const { toolCalls, content } = normalizeCloudflareResponse({
      result: {
        choices: [{
          message: {
            content: '',
            tool_calls: [{ function: { name: 'task_complete', arguments: '{"result":"ok"}' } }],
          },
        }],
      },
    });
    expect(toolCalls[0].function.name).toBe('task_complete');
    expect(content).toBe('');
  });

  it('reads result.response.choices[0].message', () => {
    const { toolCalls, content } = normalizeCloudflareResponse({
      result: {
        response: {
          choices: [{
            message: {
              content: '{"tool":"task_fail","args":{"reason":"blocked"}}',
            },
          }],
        },
      },
    });
    expect(content).toContain('task_fail');
    expect(toolCalls).toEqual([]);
  });

  it('reads top-level result.tool_calls', () => {
    const { toolCalls } = normalizeCloudflareResponse({
      result: {
        tool_calls: [{ name: 'browser_get_page_info', arguments: {} }],
        response: 'ignored when tool_calls present',
      },
    });
    expect(toolCalls[0].name).toBe('browser_get_page_info');
  });
});

describe('agent/ai/cloudflare — response-shape end-to-end via nextAction', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  const config = { ai: { cloudflare: { accountId: 'acc', apiToken: 'token', model: '@cf/meta/llama-3.1-8b-instruct' } } };

  it('parses documented CF string response containing JSON action', async () => {
    mockJson({
      result: {
        response: JSON.stringify({
          tool: 'browser_navigate',
          args: { url: 'https://www.google.com/search?q=real+estate+tanzania' },
        }),
      },
      success: true,
    });

    const provider = cloudflareProvider({ config });
    const { action, done } = await provider.nextAction({
      goal: 'Find a real-estate prospect',
      history: { steps: [] },
      observation: {},
      availableTools: ACTION_TOOLS,
    });

    expect(action.tool).toBe('browser_navigate');
    expect(action.args.url).toContain('google.com');
    expect(done).toBe(false);
  });

  it('parses result.response object with content JSON action', async () => {
    mockJson({
      result: {
        response: {
          content: JSON.stringify({
            tool: 'analyze_prospect_page',
            args: { pageUrl: 'https://example.com', pageText: 'We sell homes' },
          }),
        },
      },
    });

    const provider = cloudflareProvider({ config });
    const { action } = await provider.nextAction({
      goal: 'irrelevant',
      history: { steps: [] },
      observation: {},
      availableTools: ACTION_TOOLS,
    });

    expect(action.tool).toBe('analyze_prospect_page');
  });

  it('parses result.choices[0].message tool_calls', async () => {
    mockJson({
      result: {
        choices: [{
          message: {
            tool_calls: [{
              function: {
                name: 'save_prospect',
                arguments: JSON.stringify({ businessName: 'Acme Realty' }),
              },
            }],
          },
        }],
      },
    });

    const provider = cloudflareProvider({ config });
    const { action } = await provider.nextAction({
      goal: 'irrelevant',
      history: { steps: [] },
      observation: {},
      availableTools: ACTION_TOOLS,
    });

    expect(action.tool).toBe('save_prospect');
    expect(action.args.businessName).toBe('Acme Realty');
  });

  it('parses result.response.choices[0].message content action', async () => {
    mockJson({
      result: {
        response: {
          choices: [{
            message: {
              content: JSON.stringify({
                tool: 'save_opportunity',
                args: { prospectId: 'p1', score: 80 },
              }),
            },
          }],
        },
      },
    });

    const provider = cloudflareProvider({ config });
    const { action } = await provider.nextAction({
      goal: 'irrelevant',
      history: { steps: [] },
      observation: {},
      availableTools: ACTION_TOOLS,
    });

    expect(action.tool).toBe('save_opportunity');
    expect(action.args.prospectId).toBe('p1');
  });

  it('parses tool_calls on result.response object', async () => {
    mockJson({
      result: {
        response: {
          tool_calls: [{
            function: {
              name: 'browser_navigate',
              arguments: JSON.stringify({ url: 'https://example.com' }),
            },
          }],
        },
      },
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

  it('throws for non-actionable string response (plain prose)', async () => {
    mockJson({
      result: { response: 'I am thinking about what to do next.' },
      success: true,
    });

    const provider = cloudflareProvider({ config });
    await expect(provider.nextAction({
      goal: 'irrelevant',
      history: { steps: [] },
      observation: {},
      availableTools: ACTION_TOOLS,
    })).rejects.toThrow(/Cloudflare AI returned no actionable response/);
  });
});

describe('agent/ai/cloudflare — unique-schema-match fallback', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  const config = { ai: { cloudflare: { accountId: 'acc', apiToken: 'token', model: '@cf/openai/gpt-oss-20b' } } };

  it('reproduces and fixes the exact production failure: generate_website args sent as bare content', async () => {
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
    mockJson({
      result: {
        response: {
          tool_calls: [{ function: { name: 'browser_navigate', arguments: JSON.stringify({ url: 'https://example.com' }) } }],
        },
      },
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
