// tests/unit/samples-proposals-safety.test.js
//
// A structural test, not a behavioral one, per the approved Phase 4 spec
// (§8): Phase 4's safety guarantee rests on these two modules having no
// import path to anything that could reach outside the local machine.
// This inspects the actual source text of both files rather than mocking
// and observing behavior, so it can't be fooled by a code path that merely
// isn't exercised in other tests.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SAMPLE_GEN_PATH = path.resolve('integrations/sample-generation.js');
const PROPOSAL_GEN_PATH = path.resolve('integrations/proposal-generation.js');

const FORBIDDEN_IMPORT_PATTERNS = [
  /from\s+['"].*\/browser\/index\.js['"]/,
  /from\s+['"]playwright['"]/,
  /from\s+['"]node-fetch['"]/,
  /from\s+['"].*\/notifications\/index\.js['"]/,
  /from\s+['"]nodemailer['"]/,
  /\bfetch\s*\(/,
  /\brequire\(\s*['"]https?['"]\s*\)/,
  /\brequire\(\s*['"]node:https?['"]\s*\)/,
  /from\s+['"]node:https?['"]/,
];

function readSource(p) {
  return fs.readFileSync(p, 'utf8');
}

describe('Phase 4 safety — sample-generation.js has no external-communication capability', () => {
  const source = readSource(SAMPLE_GEN_PATH);

  it('does not import the browser module', () => {
    expect(source).not.toMatch(/from\s+['"].*\/browser\/index\.js['"]/);
  });

  it('does not import any network/HTTP client', () => {
    expect(source).not.toMatch(/from\s+['"]node-fetch['"]/);
    expect(source).not.toMatch(/from\s+['"]node:https?['"]/);
  });

  it('does not call a global fetch', () => {
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });

  it('does not import any notification/messaging module', () => {
    expect(source).not.toMatch(/from\s+['"].*\/notifications\/index\.js['"]/);
  });

  it('imports only the expected, local, non-network module (website-gen)', () => {
    const importLines = source.match(/^import .*/gm) || [];
    for (const line of importLines) {
      expect(line).toMatch(/from\s+['"]\.\/website-gen\.js['"]/);
    }
  });
});

describe('Phase 4 safety — proposal-generation.js has no external-communication capability and no imports at all', () => {
  const source = readSource(PROPOSAL_GEN_PATH);

  it('has zero import statements (pure function, no dependencies)', () => {
    const importLines = source.match(/^import .*/gm) || [];
    expect(importLines).toHaveLength(0);
  });

  it('matches none of the forbidden network/browser/messaging patterns', () => {
    for (const pattern of FORBIDDEN_IMPORT_PATTERNS) {
      expect(source).not.toMatch(pattern);
    }
  });
});

describe('Phase 4 safety — neither module matches any forbidden pattern', () => {
  it.each([
    ['sample-generation.js', SAMPLE_GEN_PATH],
    ['proposal-generation.js', PROPOSAL_GEN_PATH],
  ])('%s has no forbidden import/network pattern', (_name, filePath) => {
    const source = readSource(filePath);
    for (const pattern of FORBIDDEN_IMPORT_PATTERNS) {
      expect(source).not.toMatch(pattern);
    }
  });
});
