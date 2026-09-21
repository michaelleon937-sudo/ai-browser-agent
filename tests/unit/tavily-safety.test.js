// tests/unit/tavily-safety.test.js
// Hardening: empty/failed/malformed Tavily responses must never yield invented prospects.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node-fetch', () => ({ default: vi.fn() }));

import { normalizeTavilyResponse, tavilySearch, webSearch } from '../../integrations/web-search.js';

/**
 * Safety invariant: a web_search observation is never itself a prospect record.
 * Prospect creation only happens via explicit save_prospect with caller-supplied fields.
 */
function assertionNoProspectFabricated(searchOutcome) {
  if (searchOutcome && typeof searchOutcome === 'object') {
    expect(searchOutcome).not.toHaveProperty('prospectId');
    expect(searchOutcome).not.toHaveProperty('businessName');
    expect(searchOutcome).not.toHaveProperty('business_name');
    // Results (if any) must only be real http(s) URLs — never invented domains.
    const results = searchOutcome.results || [];
    for (const r of results) {
      expect(r.url).toMatch(/^https?:\/\//i);
    }
  }
}

describe('Tavily safety — no invented prospects', () => {
  it('empty Tavily results yield zero URLs and do not look like a prospect', () => {
    const out = normalizeTavilyResponse({ query: 'no hits', results: [] }, 'no hits');
    expect(out.resultCount).toBe(0);
    expect(out.results).toEqual([]);
    expect(out.note).toMatch(/Do not invent/i);
    assertionNoProspectFabricated(out);
  });

  it('malformed Tavily response throws rather than inventing results', () => {
    expect(() => normalizeTavilyResponse({ answer: 'x' }, 'q')).toThrow(
      /malformed|missing results/i,
    );
  });

  it('Tavily HTTP failure throws; caller must not treat it as a prospect', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 503,
      text: async () => 'unavailable',
    }));
    await expect(
      tavilySearch({ apiKey: 'k', query: 'real estate', fetchImpl }),
    ).rejects.toThrow(/Tavily HTTP 503/i);
  });

  it('non-JSON Tavily body throws rather than inventing results', async () => {
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

  it('results without http(s) URLs are dropped (no fabricated domains)', () => {
    const out = normalizeTavilyResponse(
      {
        results: [
          { title: 'Fake', url: 'ftp://not-http.example/', content: 'x' },
          { title: 'No url', content: 'y' },
          { title: 'Relative', url: '/path/only', content: 'z' },
        ],
      },
      'q',
    );
    expect(out.resultCount).toBe(0);
    expect(out.results).toEqual([]);
    assertionNoProspectFabricated(out);
  });

  it('webSearch with default config errors instead of inventing prospects', async () => {
    await expect(webSearch({ query: 'anything' })).rejects.toThrow(
      /not configured|TAVILY_API_KEY|not supported/i,
    );
  });
});
