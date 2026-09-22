// tests/unit/cloudflare-provider.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node-fetch', () => ({ default: vi.fn() }));

import fetchMock from 'node-fetch';
import { cloudflareProvider, normalizeCloudflareResponse, describeCloudflareResponseShape } from '../../agent/ai/cloudflare.js';
import { ACTION_TOOLS } from '../../agent/ai/index.js';

function mockJson(json) {
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => json });
}

function mockCloudflareResponse(content) {
  mockJson({ result: { response: { content } } });
}

describe('normalizeCloudflareResponse', () => {
  it('treats result.response string as content', () => {
    const { content, toolCalls } = normalizeCloudflareResponse({
      result: { response: '{\"tool\":\"browser_navigate\",\"args\":{\"url\":\"https://example.com\"}}' },
      success: true,
    });
    expect(content).toContain('browser_navigate');
    expect(toolCalls).toEqual([]);
  });

  it('reads tool_calls from result.response object', () => {
    const { toolCalls, content } = normalizeCloudflareResponse({
      result: {
        response: {
          content: 'hello',
          tool_calls: [{ function: { name: 'browser_snapshot', arguments: '{}' } }],
        },
      },
    });
    expect(content).toBe('hello');
    expect(toolCalls[0].function.name).toBe('browser_snapshot');
  });

  it('treats empty tool_calls array as no tool calls', () => {
    const { toolCalls, content } = normalizeCloudflareResponse({
      result: {
        choices: [{
          message: {
            content: '{\"url\":\"https://www.yelp.com/search?find_desc=real+estate\"}',
            tool_calls: [],
          },
          finish_reason: 'stop',
        }],
      },
    });
    expect(toolCalls).toEqual([]);
    expect(content).toContain('yelp.com');
  });
});

describe('empty response diagnostics', () => {
  it('F: describeCloudflareResponseShape reports types without secrets', () => {
    const shape = describeCloudflareResponseShape({ result: { response: '' }, success: true });
    expect(shape.responseType).toBe('string');
    expect(shape.contentLength).toBe(0);
    expect(JSON.stringify(shape)).not.toMatch(/Bearer|api_token|CF_API/i);
  });

  it('F: empty tool_calls does not set hasToolCalls', () => {
    const shape = describeCloudflareResponseShape({
      result: {
        choices: [{ message: { content: '{\"url\":\"https://example.com\"}', tool_calls: [] } }],
      },
    });
    expect(shape.hasToolCalls).toBe(false);
    expect(shape.responseType).toBe('undefined');
  });

  it('F: empty string response error includes shape metadata', async () => {
    fetchMock.mockReset();
    mockJson({ result: { response: '' }, success: true });
    const config = { ai: { cloudflare: { accountId: 'acc', apiToken: 'SECRET_TOKEN_XYZ', model: '@cf/meta/llama-3.1-8b-instruct' } } };
    const provider = cloudflareProvider({ config });
    await expect(provider.nextAction({
      goal: 'x', history: { steps: [] }, observation: {}, availableTools: ACTION_TOOLS,
    })).rejects.toThrow(/no actionable response.*shape=string.*len=0/);
  });
});

describe('unique-schema-match fallback', () => {
  beforeEach(() => { fetchMock.mockReset(); });
  const config = { ai: { cloudflare: { accountId: 'acc', apiToken: 'token', model: '@cf/openai/gpt-oss-20b' } } };

  it('generate_website args as bare content', async () => {
    mockCloudflareResponse(JSON.stringify({
      prospectName: 'Example Property Tanzania',
      businessType: 'Real Estate Agency',
      location: 'Tanzania',
      websiteGoal: 'Showcase properties',
    }));
    const provider = cloudflareProvider({ config });
    const { action } = await provider.nextAction({
      goal: 'Generate website', history: { steps: [] }, observation: {}, availableTools: ACTION_TOOLS,
    });
    expect(action.tool).toBe('generate_website');
  });

  it('http(s) url-only content maps to browser_navigate', async () => {
    mockCloudflareResponse(JSON.stringify({ url: 'https://www.yelp.com/search?find_desc=real+estate+agency&find_loc=Austin' }));
    const provider = cloudflareProvider({ config });
    const { action, done } = await provider.nextAction({
      goal: 'Find real estate agencies in Austin', history: { steps: [] }, observation: {}, availableTools: ACTION_TOOLS,
    });
    expect(action.tool).toBe('browser_navigate');
    expect(action.args.url).toContain('yelp.com');
    expect(done).toBe(false);
  });

  it('tool_calls still work', async () => {
    mockJson({
      result: {
        response: {
          tool_calls: [{ function: { name: 'browser_navigate', arguments: JSON.stringify({ url: 'https://example.com' }) } }],
        },
      },
    });
    const provider = cloudflareProvider({ config });
    const { action } = await provider.nextAction({
      goal: 'x', history: { steps: [] }, observation: {}, availableTools: ACTION_TOOLS,
    });
    expect(action.tool).toBe('browser_navigate');
  });

  it('{result: string} -> task_complete', async () => {
    mockCloudflareResponse(JSON.stringify({ result: 'All done.' }));
    const provider = cloudflareProvider({ config });
    const { action, done } = await provider.nextAction({
      goal: 'x', history: { steps: [] }, observation: {}, availableTools: ACTION_TOOLS,
    });
    expect(action.tool).toBe('task_complete');
    expect(done).toBe(true);
  });
});

describe('production gpt-oss response shape (regression)', () => {
  beforeEach(() => { fetchMock.mockReset(); });
  const config = { ai: { cloudflare: { accountId: 'acc', apiToken: 'token', model: '@cf/openai/gpt-oss-20b' } } };

  it('object result, no result.response, empty tool_calls, url content -> browser_navigate', async () => {
    mockJson({
      success: true,
      result: {
        choices: [{
          message: {
            role: 'assistant',
            content: '{\"url\":\"https://www.yelp.com/search?find_desc=real+estate+agency&find_loc=Austin\"}',
            tool_calls: [],
          },
          finish_reason: 'stop',
        }],
      },
    });
    const provider = cloudflareProvider({ config });
    const { action, done } = await provider.nextAction({
      goal: 'Find real estate agencies in Austin TX',
      history: { steps: [] },
      observation: {},
      availableTools: ACTION_TOOLS,
    });
    expect(action.tool).toBe('browser_navigate');
    expect(action.args.url).toBe('https://www.yelp.com/search?find_desc=real+estate+agency&find_loc=Austin');
    expect(done).toBe(false);
  });

  it('content {\"name\":\"browser_navigate\",\"arguments\":{...}} is actionable', async () => {
    mockJson({
      result: {
        choices: [{
          message: {
            content: JSON.stringify({
              name: 'browser_navigate',
              arguments: { url: 'https://www.google.com/search?q=real+estate+Austin' },
            }),
            tool_calls: [],
          },
        }],
      },
    });
    const provider = cloudflareProvider({ config });
    const { action } = await provider.nextAction({
      goal: 'search', history: { steps: [] }, observation: {}, availableTools: ACTION_TOOLS,
    });
    expect(action.tool).toBe('browser_navigate');
    expect(action.args.url).toContain('google.com');
  });

  it('unknown name in content is not treated as a tool call', async () => {
    mockCloudflareResponse(JSON.stringify({ name: 'analysis', path: 'No external resources needed.' }));
    const provider = cloudflareProvider({ config });
    await expect(provider.nextAction({
      goal: 'x', history: { steps: [] }, observation: {}, availableTools: ACTION_TOOLS,
    })).rejects.toThrow(/no actionable response/);
  });

  it('top-level result.tool_calls without function wrapper still works', async () => {
    mockJson({
      result: {
        tool_calls: [
          { name: 'browser_navigate', arguments: { url: 'https://example.com/listings' } },
        ],
      },
    });
    const provider = cloudflareProvider({ config });
    const { action } = await provider.nextAction({
      goal: 'x', history: { steps: [] }, observation: {}, availableTools: ACTION_TOOLS,
    });
    expect(action.tool).toBe('browser_navigate');
    expect(action.args.url).toBe('https://example.com/listings');
  });

  // Production: gpt-oss returns tool intent as JSON in message.content:
  // {"id":"browser_type","params":{"target":"...","text":"..."}}
  it('content {"id":"browser_type","params":{...}} maps to browser_type', async () => {
    mockJson({
      success: true,
      result: {
        choices: [{
          message: {
            role: 'assistant',
            content: JSON.stringify({
              id: 'browser_type',
              params: {
                target: 'input[name="q"]',
                text: 'real estate agencies Austin TX',
              },
            }),
            tool_calls: [],
          },
          finish_reason: 'stop',
        }],
      },
    });
    const provider = cloudflareProvider({ config });
    const { action, done } = await provider.nextAction({
      goal: 'Search for real estate',
      history: { steps: [] },
      observation: {},
      availableTools: ACTION_TOOLS,
    });
    expect(action.tool).toBe('browser_type');
    expect(action.args.target).toBe('input[name="q"]');
    expect(action.args.text).toContain('real estate');
    expect(done).toBe(false);
  });

  it('content {"id":"browser_click","params":{...}} maps to browser_click', async () => {
    mockCloudflareResponse(JSON.stringify({
      id: 'browser_click',
      params: { target: 'e3', description: 'Search button' },
    }));
    const provider = cloudflareProvider({ config });
    const { action } = await provider.nextAction({
      goal: 'click search', history: { steps: [] }, observation: {}, availableTools: ACTION_TOOLS,
    });
    expect(action.tool).toBe('browser_click');
    expect(action.args.target).toBe('e3');
  });

  it('content {"id":"<unknown>","params":{...}} is not actionable', async () => {
    mockCloudflareResponse(JSON.stringify({
      id: 'not_a_real_tool',
      params: { foo: 'bar' },
    }));
    const provider = cloudflareProvider({ config });
    await expect(provider.nextAction({
      goal: 'x', history: { steps: [] }, observation: {}, availableTools: ACTION_TOOLS,
    })).rejects.toThrow(/no actionable response/);
  });

  it('malformed JSON content is not actionable', async () => {
    mockCloudflareResponse('{id:"browser_type",params:{target:"q"'); // truncated / invalid
    const provider = cloudflareProvider({ config });
    await expect(provider.nextAction({
      goal: 'x', history: { steps: [] }, observation: {}, availableTools: ACTION_TOOLS,
    })).rejects.toThrow(/no actionable response/);
  });
  it('empty required string argument is not actionable', async () => {
    mockCloudflareResponse(JSON.stringify({ target: '' }));
    const provider = cloudflareProvider({ config });
    await expect(provider.nextAction({
      goal: 'x', history: { steps: [] }, observation: {}, availableTools: ACTION_TOOLS,
    })).rejects.toThrow(/no actionable response/);
  });

  it('whitespace-only required string argument is not actionable', async () => {
    mockCloudflareResponse(JSON.stringify({ target: '   ' }));
    const provider = cloudflareProvider({ config });
    await expect(provider.nextAction({
      goal: 'x', history: { steps: [] }, observation: {}, availableTools: ACTION_TOOLS,
    })).rejects.toThrow(/no actionable response/);
  });

});
