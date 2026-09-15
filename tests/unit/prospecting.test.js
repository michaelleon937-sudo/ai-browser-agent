// tests/unit/prospecting.test.js
import { describe, it, expect } from 'vitest';
import { analyzeProspectPage } from '../../integrations/prospecting.js';

describe('integrations/prospecting — analyzeProspectPage', () => {
  it('extracts an email address present in the page text', () => {
    const result = analyzeProspectPage({
      pageText: 'Contact us at info@example-realty.com for more details.',
    });
    expect(result.contactEmail).toBe('info@example-realty.com');
  });

  it('extracts a phone number present in the page text', () => {
    const result = analyzeProspectPage({
      pageText: 'Call us today at +255 754 123 456 for a free consultation.',
    });
    expect(result.contactPhone).toBeTruthy();
    expect(result.contactPhone.replace(/\D/g, '').length).toBeGreaterThanOrEqual(7);
  });

  it('does not invent contact info when none is present', () => {
    const result = analyzeProspectPage({ pageText: 'Welcome to our real estate agency. We sell properties.' });
    expect(result.contactEmail).toBeNull();
    expect(result.contactPhone).toBeNull();
  });

  it('extracts social profile links by platform', () => {
    const result = analyzeProspectPage({
      pageText: 'Follow us: https://www.facebook.com/exampleagency and https://instagram.com/example_agency',
    });
    const platforms = result.socialProfiles.map((s) => s.platform);
    expect(platforms).toContain('facebook');
    expect(platforms).toContain('instagram');
  });

  it('flags missing contact info as a service gap', () => {
    const result = analyzeProspectPage({ pageText: 'A real estate agency with no listed contact information here at all whatsoever for anyone.' });
    expect(result.serviceGaps).toContain('No public contact information found on the page (no email or phone detected).');
  });

  it('flags missing social presence as a service gap', () => {
    const result = analyzeProspectPage({
      pageText: 'Contact us at info@example.com. We are a real estate agency selling properties.',
    });
    expect(result.serviceGaps).toContain('No linked social media profiles detected — potential social media marketing opportunity.');
  });

  it('flags plain HTTP (no HTTPS) as a service gap', () => {
    const result = analyzeProspectPage({
      pageText: 'Contact us at info@example.com, follow us at https://facebook.com/example, we sell real estate property listings.',
      pageUrl: 'http://example-realty.com',
    });
    expect(result.serviceGaps).toContain('Site is served over plain HTTP (no HTTPS) — a basic website-improvement opportunity.');
  });

  it('does not flag HTTPS sites for the HTTP gap', () => {
    const result = analyzeProspectPage({
      pageText: 'Contact us at info@example.com, follow us at https://facebook.com/example, we sell real estate property listings that are quite long and detailed indeed.',
      pageUrl: 'https://example-realty.com',
    });
    expect(result.serviceGaps).not.toContain('Site is served over plain HTTP (no HTTPS) — a basic website-improvement opportunity.');
  });

  it('flags a lack of property/listing content', () => {
    const result = analyzeProspectPage({
      pageText: 'Contact us at info@example.com, follow us at https://facebook.com/example. We are a generic business with lots of text content here to avoid the short-page gap triggering incorrectly in this specific test case.',
    });
    expect(result.serviceGaps.some((g) => /property\/listing content/.test(g))).toBe(true);
  });

  it('flags very short page text as a possible thin/outdated site', () => {
    const result = analyzeProspectPage({ pageText: 'Coming soon.' });
    expect(result.serviceGaps).toContain('Page text content is very short — may indicate a thin, outdated, or under-developed website.');
  });

  it('handles empty/missing input without throwing', () => {
    expect(() => analyzeProspectPage({})).not.toThrow();
    expect(() => analyzeProspectPage()).not.toThrow();
    const result = analyzeProspectPage();
    expect(result.contactEmail).toBeNull();
    expect(result.contactPhone).toBeNull();
    expect(result.socialProfiles).toEqual([]);
  });

  it('deduplicates repeated emails and social links', () => {
    const result = analyzeProspectPage({
      pageText: 'info@example.com info@example.com https://facebook.com/x https://facebook.com/x',
    });
    expect(result.socialProfiles.filter((s) => s.platform === 'facebook').length).toBe(1);
  });
});
