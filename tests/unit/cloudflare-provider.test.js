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
      result: { response: '{"tool":"browser_navigate","args":{"url":"https://example.com"}}' },
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
});

describe('empty response diagnostics', () => {
  it('F: describeCloudflareResponseShape reports types without secrets', () => {
    const shape = describeCloudflareResponseShape({ result: { response: '' }, success: true });
    expect(shape.responseType).toBe('string');
    expect(shape.contentLength).toBe(0);
    expect(JSON.stringify(shape)).not.toMatch(/Bearer|api_token|CF_API/i);
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

  it('throws for ambiguous url-only content', async () => {
    mockCloudflareResponse(JSON.stringify({ url: 'https://localhost/x/' }));
    const provider = cloudflareProvider({ config });
    await expect(provider.nextAction({
      goal: 'x', history: { steps: [] }, observation: {}, availableTools: ACTION_TOOLS,
    })).rejects.toThrow(/no actionable response/);
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
