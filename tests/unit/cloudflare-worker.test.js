import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import worker from '../../cloudflare/worker.js';

const sharedKey = 'unit-test-key-with-more-than-thirty-two-characters';
const bearer = 'unit-test-control-bearer-token';
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
function tenantToken(extra = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = b64({ iss: 'nexora-intelligence', aud: 'ai-browser-agent-control', typ: 'tenant', tenantId: 'test-tenant', sub: 'test-profile', jti: 'unit-jti', iat: now, exp: now + 300, ...extra });
  const signature = createHmac('sha256', sharedKey).update(payload).digest('base64url');
  return `v1.${payload}.${signature}`;
}
function toolRequest(tool, args = {}, options = {}) {
  return new Request(`https://agent.test/api/control/v1/tools/${tool}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.bearer || bearer}`,
      'content-type': 'application/json',
      'x-nexora-tenant-token': options.token || tenantToken(),
      'x-operator-id': options.operator || 'test-profile',
    },
    body: JSON.stringify(args),
  });
}
const env = { CONTROL_TOKEN: bearer, NEXORA_AGENT_SHARED_SECRET: sharedKey };

describe('Cloudflare browser execution Worker', () => {
  it('exposes a non-sensitive health endpoint', async () => {
    const response = await worker.fetch(new Request('https://agent.test/healthz'), {});
    expect(response.status).toBe(200);
    const health = await response.json();
    expect(health.runtime).toBe('cloudflare-workers');
    expect(health.controlConfigured).toBe(false);
    expect(health.aiConfigured).toBe(false);
    expect(health.sentryConfigured).toBe(false);
  });

  it('reports configured Sentry and browser bindings without exposing their values', async () => {
    const response = await worker.fetch(new Request('https://agent.test/healthz'), {
      BROWSER: {},
      CONTROL_TOKEN: 'control-test-token',
      NEXORA_AGENT_SHARED_SECRET: 'tenant-test-secret',
      SENTRY_DSN: 'https://publickey@o4512361266937856.ingest.us.sentry.io/4512361789128705',
      AI: { run: async () => ({ choices: [{ message: { content: 'test' } }] }) },
      AI_MODEL: '@cf/openai/gpt-oss-20b',
    });
    const health = await response.json();
    expect(health.browserRenderingConfigured).toBe(true);
    expect(health.controlConfigured).toBe(true);
    expect(health.aiConfigured).toBe(true);
    expect(health.aiModel).toBe('@cf/openai/gpt-oss-20b');
    expect(health.sentryConfigured).toBe(true);
    expect(JSON.stringify(health)).not.toContain('publickey');
    expect(JSON.stringify(health)).not.toContain('control-test-token');
    expect(JSON.stringify(health)).not.toContain('tenant-test-secret');
  });
  it('serves authenticated OpenAI-compatible text completions through the Preview AI binding', async () => {
    let receivedModel = '';
    let receivedInput;
    const aiEnv = {
      ...env,
      AI_MODEL: '@cf/openai/gpt-oss-20b',
      AI: { run: async (model, input) => {
        receivedModel = model;
        receivedInput = input;
        return { id: 'test-completion', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'NEXORA AI ONLINE', reasoning_content: 'must-not-leak' } }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, neurons: 2.5 } };
      } },
    };
    const response = await worker.fetch(new Request('https://agent.test/api/ai/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', 'x-nexora-tenant-token': tenantToken(), 'x-operator-id': 'test-profile', 'x-request-id': 'ai-unit-1' },
      body: JSON.stringify({ messages: [{ role: 'system', content: 'Be concise.' }, { role: 'user', content: 'Say hello.' }], max_tokens: 128, temperature: 0.1 }),
    }), aiEnv);
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(receivedModel).toBe('@cf/openai/gpt-oss-20b');
    expect(receivedInput.max_tokens).toBe(128);
    expect(payload.choices[0].message.content).toBe('NEXORA AI ONLINE');
    expect(payload.usage.neurons).toBe(2.5);
    expect(JSON.stringify(payload)).not.toContain('must-not-leak');
  });

  it('rejects AI requests when the Preview AI binding is missing', async () => {
    const response = await worker.fetch(new Request('https://agent.test/api/ai/v1/chat/completions', {
      method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', 'x-nexora-tenant-token': tenantToken() },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] }),
    }), env);
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe('ai_binding_missing');
  });

  it('rejects AI tool/function calling and unsupported message roles', async () => {
    const aiEnv = { ...env, AI: { run: async () => { throw new Error('must not run'); } } };
    const base = { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', 'x-nexora-tenant-token': tenantToken() } };
    const toolResponse = await worker.fetch(new Request('https://agent.test/api/ai/v1/chat/completions', { ...base, body: JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }], tools: [] }) }), aiEnv);
    expect(toolResponse.status).toBe(400);
    expect((await toolResponse.json()).code).toBe('tool_calls_not_supported');
    const roleResponse = await worker.fetch(new Request('https://agent.test/api/ai/v1/chat/completions', { ...base, body: JSON.stringify({ messages: [{ role: 'tool', content: 'run something' }] }) }), aiEnv);
    expect(roleResponse.status).toBe(400);
    expect((await roleResponse.json()).code).toBe('invalid_message');
  });

  it('caps AI output tokens and rejects oversized prompts before inference', async () => {
    let calls = 0;
    const aiEnv = { ...env, AI: { run: async () => { calls += 1; return { choices: [{ message: { content: 'ok' } }] }; } } };
    const headers = { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', 'x-nexora-tenant-token': tenantToken() };
    const tokenResponse = await worker.fetch(new Request('https://agent.test/api/ai/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }], max_tokens: 4096 }) }), aiEnv);
    expect(tokenResponse.status).toBe(400);
    const promptResponse = await worker.fetch(new Request('https://agent.test/api/ai/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(12_001) }] }) }), aiEnv);
    expect(promptResponse.status).toBe(413);
    expect(calls).toBe(0);
  });

  it('rejects an invalid control bearer token', async () => {
    const response = await worker.fetch(toolRequest('agent.health_check', {}, { bearer: 'wrong' }), env);
    expect(response.status).toBe(401);
  });
  it('rejects a tenant token with an invalid signature', async () => {
    const token = `${tenantToken().split('.').slice(0, 2).join('.')}.invalid`;
    const response = await worker.fetch(toolRequest('agent.health_check', {}, { token }), env);
    expect(response.status).toBe(401);
  });
  it('rejects an operator header that does not match the signed token', async () => {
    const response = await worker.fetch(toolRequest('agent.health_check', {}, { operator: 'other-profile' }), env);
    expect(response.status).toBe(403);
  });
  it('returns the read-only tool list for a valid signed tenant', async () => {
    const response = await worker.fetch(toolRequest('agent.health_check'), { ...env, BROWSER: {} });
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.result.writeActionsEnabled).toBe(false);
    expect(payload.result.supportedTools).toContain('browser.extract');
  });
  it('blocks private network destinations before browser acquisition', async () => {
    const response = await worker.fetch(toolRequest('browser.navigate', { url: 'http://127.0.0.1:8080' }), env);
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('unsafe_url');
  });

  it('reports sanitized 5xx control failures to Sentry without attaching credentials or request data', async () => {
    const originalFetch = globalThis.fetch;
    let capturedUrl = '';
    let capturedInit;
    globalThis.fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(null, { status: 200 });
    };
    try {
      const request = new Request('https://agent.test/api/control/v1/tools/agent.health_check?private=must-not-leak', {
        method: 'POST',
        headers: { authorization: 'Bearer do-not-report-this-token', 'content-type': 'application/json' },
        body: JSON.stringify({ customerEmail: 'private@example.com' }),
      });
      const response = await worker.fetch(request, {
        SENTRY_DSN: 'https://publickey@o4512361266937856.ingest.us.sentry.io/4512361789128705',
        SENTRY_ENVIRONMENT: 'preview',
      });
      expect(response.status).toBe(503);
      expect(capturedUrl).toBe('https://o4512361266937856.ingest.us.sentry.io/api/4512361789128705/envelope/');
      const lines = String(capturedInit.body).split('\n');
      const event = JSON.parse(lines[2]);
      expect(event.environment).toBe('preview');
      expect(event.tags.code).toBe('control_not_configured');
      expect(event.tags.route).toBe('/api/control/v1/tools/agent.health_check');
      expect(JSON.stringify(event)).not.toContain('do-not-report-this-token');
      expect(JSON.stringify(event)).not.toContain('private@example.com');
      expect(JSON.stringify(event)).not.toContain('must-not-leak');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not call Sentry when no DSN is configured', async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = async () => { called = true; return new Response(null, { status: 200 }); };
    try {
      const response = await worker.fetch(toolRequest('agent.health_check'), {});
      expect(response.status).toBe(503);
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('requires a configured Browser Rendering binding for public navigation', async () => {
    const response = await worker.fetch(toolRequest('browser.navigate', { url: 'https://example.com' }), env);
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe('browser_binding_missing');
  });
});
