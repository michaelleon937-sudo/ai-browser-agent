// tests/unit/web-search.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node-fetch', () => ({ default: vi.fn() }));

import fetchMock from 'node-fetch';
import { normalizeTavilyResponse, tavilySearch, webSearch } from '../../integrations/web-search.js';
import { isKnownTool, ACTION_TOOLS } from '../../agent/ai/index.js';
import { cloudflareProvider } from '../../agent/ai/cloudflare.js';

describe('tool registration', () => {
  it('registers web_search as a known tool', () => {
    expect(isKnownTool('web_search')).toBe(true);
  });

  it('exposes web_search in ACTION_TOOLS schema', () => {
    const tool = ACTION_TOOLS.find((t) => t.name === 'web_search');
    expect(tool).toBeTruthy();
    expect(tool.parameters.required).toContain('query');
  });
});

describe('normalizeTavilyResponse', () => {
  it('parses a successful Tavily response into structured results', () => {
    const out = normalizeTavilyResponse(
      {
        query: 'real estate agency austin',
        results: [
          {
            title: 'Austin Premier Realty',
            url: 'https://austinpremier.example/',
            content: 'Local real estate agency serving Austin TX.',
            score: 0.91,
          },
          {
            title: 'Hill Country Homes',
            url: 'https://hillcountry.example/listings',
            content: 'Property listings across central Texas.',
          },
        ],
      },
      'real estate agency austin',
    );
    expect(out.provider).toBe('tavily');
    expect(out.query).toBe('real estate agency austin');
    expect(out.resultCount).toBe(2);
    expect(out.results[0]).toEqual({
      title: 'Austin Premier Realty',
      url: 'https://austinpremier.example/',
      snippet: 'Local real estate agency serving Austin TX.',
      score: 0.91,
    });
    expect(out.results[1].url).toBe('https://hillcountry.example/listings');
    expect(out.note).toMatch(/browser_navigate/i);
  });

  it('handles empty results without inventing entries', () => {
    const out = normalizeTavilyResponse({ query: 'zzz', results: [] }, 'zzz');
    expect(out.resultCount).toBe(0);
    expect(out.results).toEqual([]);
    expect(out.note).toMatch(/zero/i);
    expect(out.note).toMatch(/Do not invent/i);
  });

  it('rejects malformed response missing results', () => {
    expect(() => normalizeTavilyResponse({ answer: 'something' }, 'q')).toThrow(
      /malformed|missing results/i,
    );
  });

  it('skips entries without real http(s) URLs (no fabrication)', () => {
    const out = normalizeTavilyResponse(
      {
        results: [
          { title: 'Bad', url: 'not-a-url', content: 'x' },
          { title: 'Good', url: 'https://good.example/', content: 'ok' },
          { title: 'Missing url', content: 'nope' },
        ],
      },
      'q',
    );
    expect(out.resultCount).toBe(1);
    expect(out.results[0].url).toBe('https://good.example/');
  });
});

describe('tavilySearch HTTP paths', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('parses successful API response via injected fetch', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        results: [
          { title: 'A', url: 'https://a.example/', content: 'alpha' },
        ],
      }),
    }));
    const out = await tavilySearch({
      apiKey: 'test-key',
      query: 'real estate',
      maxResults: 3,
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.api_key).toBe('test-key');
    expect(body.query).toBe('real estate');
    expect(out.resultCount).toBe(1);
    expect(out.results[0].url).toBe('https://a.example/');
  });

  it('surfaces HTTP errors without inventing results', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
    }));
    await expect(
      tavilySearch({ apiKey: 'bad', query: 'q', fetchImpl }),
    ).rejects.toThrow(/Tavily HTTP 401/i);
  });

  it('errors when API key is missing', async () => {
    await expect(tavilySearch({ apiKey: '', query: 'q' })).rejects.toThrow(
      /TAVILY_API_KEY/i,
    );
  });

  it('errors on empty query', async () => {
    await expect(tavilySearch({ apiKey: 'k', query: '  ' })).rejects.toThrow(
      /non-empty query/i,
    );
  });

  it('errors on non-JSON body', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => {
        throw new Error('not json');
      },
    }));
    await expect(
      tavilySearch({ apiKey: 'k', query: 'q', fetchImpl }),
    ).rejects.toThrow(/non-JSON/i);
  });
});

describe('webSearch respects process configuration', () => {
  it('errors when search provider is not configured (default none)', async () => {
    await expect(webSearch({ query: 'anything' })).rejects.toThrow(
      /not configured|TAVILY_API_KEY|not supported/i,
    );
  });
});

describe('Cloudflare parser accepts web_search id+params', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('parses {"id":"web_search","params":{"query":"..."}} from content', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: {
          response: JSON.stringify({
            id: 'web_search',
            params: { query: 'real estate agency website needs improvement', maxResults: 5 },
          }),
        },
      }),
    });

    const provider = cloudflareProvider({
      config: {
        ai: {
          cloudflare: { accountId: 'acc', apiToken: 'tok', model: '@cf/meta/llama-3.1-8b-instruct' },
        },
      },
    });

    const next = await provider.nextAction({
      goal: 'Find a real estate prospect',
      history: { steps: [] },
      observation: { url: '', title: '' },
      availableTools: ACTION_TOOLS,
    });
    expect(next.action.tool).toBe('web_search');
    expect(next.action.args.query).toMatch(/real estate/i);
    expect(next.done).toBe(false);
  });
});
