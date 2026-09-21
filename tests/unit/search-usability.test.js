// tests/unit/search-usability.test.js
// Regression: production burned MAX_STEPS on DuckDuckGo bot challenges and
// empty Bing SERPs because navigation success was treated as search success.
import { describe, it, expect } from 'vitest';
import {
  assessSearchPageUsability,
  isSearchEngineUrl,
  annotateSearchUsability,
  applySearchRecoveryGuard,
  MAX_BLOCKED_SEARCH_HOSTS,
} from '../../agent/index.js';

describe('isSearchEngineUrl', () => {
  it('detects DuckDuckGo, Bing, Google search URLs', () => {
    expect(isSearchEngineUrl('https://duckduckgo.com/?q=real+estate')).toBe(true);
    expect(isSearchEngineUrl('https://www.bing.com/search?q=foo')).toBe(true);
    expect(isSearchEngineUrl('https://www.google.com/search?q=foo')).toBe(true);
  });

  it('does not treat ordinary sites as search engines', () => {
    expect(isSearchEngineUrl('https://example.com/listings')).toBe(false);
    expect(isSearchEngineUrl('https://yelp.com/search?find_desc=agency')).toBe(false);
  });
});

describe('assessSearchPageUsability', () => {
  it('A: DuckDuckGo bot challenge is blocked/unusable', () => {
    const assessment = assessSearchPageUsability({
      url: 'https://duckduckgo.com/?q=real+estate+agency+website+needs+improvement',
      title: 'DuckDuckGo',
      textPreview:
        'Unfortunately, bots use DuckDuckGo too. Please complete the following challenge to confirm this search was made by a human. Select all squares containing a duck: Submit',
      elements: [
        { ref: 'e0', tag: 'input', name: 'Search' },
        { ref: 'e1', tag: 'button', name: 'Submit' },
      ],
    });
    expect(assessment.isSearchPage).toBe(true);
    expect(assessment.usable).toBe(false);
    expect(assessment.reason).toBe('bot_challenge');
  });

  it('B: search page with only chrome and no result links is no_results', () => {
    const assessment = assessSearchPageUsability({
      url: 'https://www.bing.com/search?q=real+estate+agency+website+needs+redesign',
      title: 'real estate - Search',
      textPreview: 'Skip to content Accessibility Feedback ALL WEB SEARCH IMAGES VIDEOS MAPS MORE Privacy Terms',
      elements: [
        { ref: 'e6', tag: 'input', name: 'Enter your search here - Search suggestions will show as you type', type: 'search' },
        { ref: 'e7', tag: 'a', name: 'Privacy', href: 'https://www.bing.com/privacy' },
        { ref: 'e8', tag: 'a', name: 'Terms', href: 'https://www.bing.com/terms' },
      ],
    });
    expect(assessment.isSearchPage).toBe(true);
    expect(assessment.usable).toBe(false);
    expect(assessment.reason).toBe('no_results');
  });

  it('E: normal search results page remains usable', () => {
    const assessment = assessSearchPageUsability({
      url: 'https://www.bing.com/search?q=real+estate+austin',
      title: 'real estate austin - Search',
      textPreview: 'About 1,200,000 results  Austin Real Estate Agencies — top firms in the area',
      elements: [
        { ref: 'e0', tag: 'input', name: 'Search', type: 'search' },
        { ref: 'e1', tag: 'a', name: 'Austin Premier Realty', href: 'https://austinpremierrealty.example/' },
        { ref: 'e2', tag: 'a', name: 'Hill Country Homes', href: 'https://hillcountryhomes.example/listings' },
        { ref: 'e3', tag: 'a', name: 'Privacy', href: 'https://www.bing.com/privacy' },
      ],
    });
    expect(assessment.isSearchPage).toBe(true);
    expect(assessment.usable).toBe(true);
    expect(assessment.resultLinkCount).toBeGreaterThanOrEqual(2);
  });

  it('non-search pages are not classified as search', () => {
    const assessment = assessSearchPageUsability({
      url: 'https://example-realty.com/',
      title: 'Example Realty',
      textPreview: 'Welcome to Example Realty',
      elements: [{ ref: 'e0', tag: 'a', name: 'Contact', href: '/contact' }],
    });
    expect(assessment.isSearchPage).toBe(false);
    expect(assessment.usable).toBe(null);
  });
});

describe('annotateSearchUsability + recovery guard', () => {
  it('records blocked host and annotates observation note', () => {
    const state = { blockedSearchHosts: new Set() };
    const obs = annotateSearchUsability({
      url: 'https://duckduckgo.com/?q=test',
      textPreview: 'Unfortunately, bots use DuckDuckGo too. Please complete the following challenge',
      elements: [],
    }, state);
    expect(state.blockedSearchHosts.has('duckduckgo.com')).toBe(true);
    expect(obs.searchUsability.usable).toBe(false);
    expect(obs.note).toMatch(/SEARCH NOT USABLE/);
    expect(obs.note).toMatch(/Do NOT click CAPTCHA/i);
  });

  it('C: does not allow re-navigate to the same blocked search host (soft-reject while budget remains)', () => {
    const state = {
      blockedSearchHosts: new Set(['duckduckgo.com']),
      steps: [{
        tool: 'browser_navigate',
        status: 'success',
        action: { tool: 'browser_navigate', args: { url: 'https://duckduckgo.com/?q=a' } },
        observation: { url: 'https://duckduckgo.com/?q=a', searchUsability: { usable: false, reason: 'bot_challenge' } },
      }],
    };
    const guard = applySearchRecoveryGuard(state, {
      tool: 'browser_navigate',
      args: { url: 'https://duckduckgo.com/?q=real+estate+redesign' },
    });
    expect(guard).not.toBeNull();
    // Soft-reject: do not burn the run; allow remaining engines (e.g. google) within budget.
    expect(guard.softReject).toBe(true);
    expect(guard.action).toBeUndefined();
    expect(guard.reason).toMatch(/duckduckgo\.com/i);
    expect(guard.reason).toMatch(/different public search engine/i);
  });

  it('D: search-engine fallback has a finite bound', () => {
    const hosts = ['duckduckgo.com', 'bing.com', 'google.com'];
    const state = {
      blockedSearchHosts: new Set(hosts.slice(0, MAX_BLOCKED_SEARCH_HOSTS)),
      steps: [],
    };
    expect(state.blockedSearchHosts.size).toBeGreaterThanOrEqual(MAX_BLOCKED_SEARCH_HOSTS);
    const guard = applySearchRecoveryGuard(state, {
      tool: 'browser_navigate',
      args: { url: 'https://www.google.com/search?q=another' },
    });
    expect(guard).not.toBeNull();
    expect(guard.action.tool).toBe('task_fail');
    expect(guard.action.args.reason).toMatch(/blocked or returned no usable results/i);
  });

  it('allows first navigation to a fresh search host', () => {
    const state = { blockedSearchHosts: new Set(['duckduckgo.com']), steps: [] };
    const guard = applySearchRecoveryGuard(state, {
      tool: 'browser_navigate',
      args: { url: 'https://www.bing.com/search?q=real+estate' },
    });
    // Under budget and different host — allowed (null guard)
    expect(guard).toBeNull();
  });
});
