import { describe, it, expect, afterEach, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

describe('config', () => {
afterEach(() => {
process.env = { ...ORIGINAL_ENV };
vi.resetModules();
});

it('defaults AI_PROVIDER to stub when unset', async () => {
delete process.env.AI_PROVIDER;

const { config } = await import('../../config/index.js');
expect(config.ai.provider).toBe('stub');

});

it('validate() flags missing Cloudflare credentials', async () => {
process.env.AI_PROVIDER = 'cloudflare';
delete process.env.CF_ACCOUNT_ID;
delete process.env.CF_API_TOKEN;

vi.resetModules();
const { validate } = await import('../../config/index.js');
const problems = validate();

expect(problems.some((p) => p.includes('CF_ACCOUNT_ID'))).toBe(true);
expect(problems.some((p) => p.includes('CF_API_TOKEN'))).toBe(true);

});

it('validate() passes when Cloudflare credentials are present', async () => {
process.env.AI_PROVIDER = 'cloudflare';
process.env.CF_ACCOUNT_ID = 'acct123';
process.env.CF_API_TOKEN = 'tok123';

vi.resetModules();
const { validate } = await import('../../config/index.js');

expect(validate()).toEqual([]);

});

it('redact() masks secret-shaped keys recursively', async () => {
const { redact } = await import('../../config/index.js');

const out = redact({
  apiToken: 'super-secret',
  nested: {
    password: 'p@ss',
    ok: 'fine',
  },
});

expect(out.apiToken).toBe('[REDACTED]');
expect(out.nested.password).toBe('[REDACTED]');
expect(out.nested.ok).toBe('fine');

});
});
