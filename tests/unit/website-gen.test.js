// tests/unit/website-gen.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let generateWebsite, isValidSampleId, resolveSampleDir, config;
let tmpDir;

beforeAll(async () => {
  tmpDir = path.join(os.tmpdir(), `website-gen-test-${Date.now()}`);
  process.env.WEBSITE_SAMPLES_DIR = tmpDir;
  ({ generateWebsite, isValidSampleId, resolveSampleDir } = await import('../../integrations/website-gen.js'));
  ({ config } = await import('../../config/index.js'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('integrations/website-gen', () => {
  it('creates all expected files for a full input', () => {
    const result = generateWebsite({
      prospectName: 'Example Property Tanzania',
      businessType: 'Real Estate Agency',
      location: 'Dar es Salaam, Tanzania',
      services: ['Sales', 'Rentals'],
      propertyListings: [{ title: 'Sample Villa', location: 'Masaki', price: 'TBD', description: 'Placeholder.' }],
      contactInformation: { phone: '+255 000 000', email: 'info@example.com' },
      callToAction: 'Book a viewing',
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe('SPECULATIVE_SAMPLE');
    expect(result.sampleId).toMatch(/^website_[A-Za-z0-9_-]+$/);
    expect(result.files).toEqual(['index.html', 'styles.css', 'script.js', 'metadata.json']);
    expect(result.previewPath).toBe(`/website-samples/${result.sampleId}/`);

    for (const file of result.files) {
      expect(fs.existsSync(path.join(result.dir, file))).toBe(true);
    }
  });

  it('generated index.html exists and contains the speculative-sample banner', () => {
    const result = generateWebsite({ prospectName: 'Acme Realty' });
    const html = fs.readFileSync(path.join(result.dir, 'index.html'), 'utf8');
    expect(html).toContain('SPECULATIVE SAMPLE');
    expect(html).toContain('Acme Realty');
  });

  it('generated styles.css exists and is non-empty', () => {
    const result = generateWebsite({ prospectName: 'Acme Realty' });
    const css = fs.readFileSync(path.join(result.dir, 'styles.css'), 'utf8');
    expect(css.length).toBeGreaterThan(50);
  });

  it('generated script.js exists and is non-empty', () => {
    const result = generateWebsite({ prospectName: 'Acme Realty' });
    const js = fs.readFileSync(path.join(result.dir, 'script.js'), 'utf8');
    expect(js.length).toBeGreaterThan(10);
  });

  it('uses clearly marked placeholders instead of fabricating missing info', () => {
    const result = generateWebsite({}); // nothing provided
    const html = fs.readFileSync(path.join(result.dir, 'index.html'), 'utf8');
    expect(html).toMatch(/\[.*add.*\]/i);
  });

  it('escapes HTML in user-supplied fields to prevent injection', () => {
    const result = generateWebsite({ prospectName: '<script>alert(1)</script>' });
    const html = fs.readFileSync(path.join(result.dir, 'index.html'), 'utf8');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('every generated sample lives inside the configured samples root', () => {
    const result = generateWebsite({ prospectName: 'Containment Check' });
    const root = path.resolve(config.storage.websiteSamplesDir);
    expect(path.resolve(result.dir).startsWith(root + path.sep)).toBe(true);
  });

  it('isValidSampleId rejects path traversal and malformed ids', () => {
    expect(isValidSampleId('website_abc123')).toBe(true);
    expect(isValidSampleId('../../etc/passwd')).toBe(false);
    expect(isValidSampleId('website_../../etc/passwd')).toBe(false);
    expect(isValidSampleId('random-id')).toBe(false);
    expect(isValidSampleId('')).toBe(false);
    expect(isValidSampleId(undefined)).toBe(false);
  });

  it('resolveSampleDir throws on an invalid/traversal id instead of resolving it', () => {
    expect(() => resolveSampleDir('../../etc/passwd')).toThrow();
    expect(() => resolveSampleDir('website_../evil')).toThrow();
  });

  it('resolveSampleDir returns a path safely contained under the samples root for a valid id', () => {
    const result = generateWebsite({ prospectName: 'Resolve Check' });
    const resolved = resolveSampleDir(result.sampleId);
    expect(resolved).toBe(result.dir);
  });
});
