// integrations/web-search.js
// Legitimate web search via Tavily Search API (https://docs.tavily.com/).
// Production code always calls the real API when configured — never fabricates results.

import fetch from 'node-fetch';
import { config } from '../config/index.js';

const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';

/**
 * Run a web search through the configured provider.
 * Currently supports SEARCH_PROVIDER=tavily with TAVILY_API_KEY.
 *
 * @param {{ query: string, maxResults?: number }} args
 * @returns {Promise<{
 *   provider: string,
 *   query: string,
 *   resultCount: number,
 *   results: Array<{ title: string, url: string, snippet: string, score?: number }>,
 *   note?: string,
 * }>
 */
export async function webSearch(args = {}) {
  const query = String(args.query || '').trim();
  if (!query) {
    throw new Error('web_search requires a non-empty query');
  }

  const provider = (config.search?.provider || '').toLowerCase();
  if (!provider || provider === 'none') {
    throw new Error(
      'web_search is not configured. Set SEARCH_PROVIDER=tavily and TAVILY_API_KEY to enable legitimate search.',
    );
  }
  if (provider !== 'tavily') {
    throw new Error(
      `web_search provider "${provider}" is not supported. Supported: tavily.`,
    );
  }

  const apiKey = config.search?.tavily?.apiKey || '';
  if (!apiKey) {
    throw new Error(
      'TAVILY_API_KEY is required when SEARCH_PROVIDER=tavily. Do not invent search results.',
    );
  }

  const maxResults = clampInt(args.maxResults, 1, 10, 5);
  return tavilySearch({ apiKey, query, maxResults, fetchImpl: fetch });
}

/**
 * Low-level Tavily call. Exported for unit tests (inject fetchImpl / apiKey).
 * Always hits the real Tavily endpoint unless fetchImpl is injected in tests.
 */
export async function tavilySearch({ apiKey, query, maxResults = 5, fetchImpl = fetch } = {}) {
  if (!apiKey) {
    throw new Error(
      'TAVILY_API_KEY is required when SEARCH_PROVIDER=tavily. Do not invent search results.',
    );
  }
  const q = String(query || '').trim();
  if (!q) throw new Error('web_search requires a non-empty query');

  let res;
  try {
    res = await fetchImpl(TAVILY_SEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query: q,
        search_depth: 'basic',
        include_answer: false,
        include_images: false,
        max_results: clampInt(maxResults, 1, 10, 5),
      }),
    });
  } catch (err) {
    throw new Error(`Tavily request failed: ${err.message}`);
  }

  if (!res.ok) {
    const body = typeof res.text === 'function' ? await res.text().catch(() => '') : '';
    throw new Error(
      `Tavily HTTP ${res.status}: ${String(body).slice(0, 300)}. Do not invent search results.`,
    );
  }

  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error('Tavily returned non-JSON response. Do not invent search results.');
  }

  return normalizeTavilyResponse(json, q);
}

/**
 * Pure parser for Tavily JSON. Exported for unit tests.
 * Only accepts results that include a real http(s) URL — never fabricates entries.
 */
export function normalizeTavilyResponse(json, query = '') {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('Tavily returned a malformed response body. Do not invent search results.');
  }

  const raw = Array.isArray(json.results) ? json.results : null;
  if (raw === null) {
    if (Object.prototype.hasOwnProperty.call(json, 'results')) {
      return {
        provider: 'tavily',
        query: String(query || json.query || ''),
        resultCount: 0,
        results: [],
        note: 'Search returned zero results. Do not invent prospects or URLs.',
      };
    }
    throw new Error('Tavily response missing results array. Do not invent search results.');
  }

  const results = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const url = String(item.url || '').trim();
    if (!/^https?:\/\//i.test(url)) continue;
    const title = String(item.title || '').trim() || url;
    const snippet = String(item.content || item.snippet || '').trim().slice(0, 500);
    const entry = { title, url, snippet };
    if (typeof item.score === 'number') entry.score = item.score;
    results.push(entry);
  }

  return {
    provider: 'tavily',
    query: String(query || json.query || ''),
    resultCount: results.length,
    results,
    note:
      results.length === 0
        ? 'Search returned zero usable results. Do not invent prospects or URLs.'
        : `Use browser_navigate on a real candidate URL from these results, then analyze_prospect_page. Never invent a domain.`,
  };
}

function clampInt(v, min, max, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
