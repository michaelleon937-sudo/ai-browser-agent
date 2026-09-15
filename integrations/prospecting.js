// integrations/prospecting.js
// Phase 2 — Real Estate Prospecting.
//
// Pure, deterministic extraction. This module never fetches anything itself
// — it only reads text/URL/title that the agent already obtained via its
// existing browser tools (browser_get_page_info, browser_snapshot,
// browser_get_text), all of which only ever see PUBLIC page content the
// browser is already looking at. No network calls, no credentials, no
// third-party APIs. Nothing here is invented: every field returned is either
// directly extracted from the given text or explicitly left null/empty.

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Loosely matches common phone formats (E.164-ish, US/local with
// separators). Intentionally conservative — false negatives (missing a
// phone number) are safe; false positives are not, so we require at least
// 7 digits and typical separator characters only.
const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{2,4}[\s.-]?\d{2,4}[\s.-]?\d{2,4}(?:[\s.-]?\d{2,4})?/g;

const SOCIAL_DOMAINS = [
  { key: 'facebook', pattern: /https?:\/\/(?:www\.)?facebook\.com\/[^\s"'<>)]+/gi },
  { key: 'instagram', pattern: /https?:\/\/(?:www\.)?instagram\.com\/[^\s"'<>)]+/gi },
  { key: 'twitter', pattern: /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[^\s"'<>)]+/gi },
  { key: 'tiktok', pattern: /https?:\/\/(?:www\.)?tiktok\.com\/[^\s"'<>)]+/gi },
  { key: 'linkedin', pattern: /https?:\/\/(?:www\.)?linkedin\.com\/[^\s"'<>)]+/gi },
  { key: 'youtube', pattern: /https?:\/\/(?:www\.)?youtube\.com\/[^\s"'<>)]+/gi },
];

function dedupe(arr) {
  return [...new Set(arr)];
}

function isPlausiblePhone(candidate) {
  const digits = candidate.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

/**
 * Extract a business's public contact info, social profiles, and basic
 * service gaps from page text the agent already fetched via its browser
 * tools. Everything returned is directly traceable to the input text —
 * nothing is guessed or fabricated.
 *
 * @param {object} input
 * @param {string} [input.pageText] - visible text content of the page
 * @param {string} [input.pageTitle]
 * @param {string} [input.pageUrl]
 * @returns {{
 *   contactEmail: string|null,
 *   contactPhone: string|null,
 *   socialProfiles: Array<{platform:string, url:string}>,
 *   serviceGaps: string[],
 * }}
 */
export function analyzeProspectPage({ pageText = '', pageTitle = '', pageUrl = '' } = {}) {
  const text = String(pageText || '');

  const emails = dedupe((text.match(EMAIL_RE) || []).map((e) => e.toLowerCase()));
  const contactEmail = emails[0] || null;

  const phoneCandidates = (text.match(PHONE_RE) || []).filter(isPlausiblePhone);
  const contactPhone = phoneCandidates[0]?.trim() || null;

  const socialProfiles = [];
  for (const { key, pattern } of SOCIAL_DOMAINS) {
    const found = dedupe(text.match(pattern) || []);
    for (const url of found) socialProfiles.push({ platform: key, url });
  }

  const serviceGaps = [];
  if (!contactEmail && !contactPhone) {
    serviceGaps.push('No public contact information found on the page (no email or phone detected).');
  }
  if (socialProfiles.length === 0) {
    serviceGaps.push('No linked social media profiles detected — potential social media marketing opportunity.');
  }
  if (text.trim().length > 0 && text.trim().length < 200) {
    serviceGaps.push('Page text content is very short — may indicate a thin, outdated, or under-developed website.');
  }
  if (pageUrl && pageUrl.startsWith('http://')) {
    serviceGaps.push('Site is served over plain HTTP (no HTTPS) — a basic website-improvement opportunity.');
  }
  if (!/property|listing|for sale|for rent|real estate|realtor|realty/i.test(text) && text.trim().length > 0) {
    serviceGaps.push('No property/listing content detected on this page — may indicate weak property marketing.');
  }

  return { contactEmail, contactPhone, socialProfiles, serviceGaps };
}
