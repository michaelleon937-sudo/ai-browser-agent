import puppeteer from '@cloudflare/puppeteer';

const encoder = new TextEncoder();
const TOOL_PREFIX = '/api/control/v1/tools/';
const AI_PREFIX = '/api/ai/v1/chat/completions';
const MAX_AI_BODY_BYTES = 24 * 1024;
const MAX_AI_PROMPT_CHARS = 12_000;
const MAX_AI_MESSAGES = 20;
const MAX_AI_OUTPUT_TOKENS = 1024;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_NAVIGATION_MS = 20_000;
const MAX_TEXT_CHARS = 12_000;
const MAX_SCREENSHOT_BYTES = 512 * 1024;
const ALLOWED_TOOLS = new Set([
  'agent.health_check',
  'browser.navigate',
  'browser.extract',
  'browser.screenshot',
]);

class ControlError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
      'x-content-type-options': 'nosniff',
    },
  });
}

function base64UrlToBytes(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function decodeBase64UrlJson(value) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(value)));
}

function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

async function verifyTenantToken(token, secret) {
  if (!token || !secret) throw new ControlError(401, 'tenant_token_missing', 'A signed Nexora tenant token is required');
  const parts = token.split('.');
  if (parts.length !== 3) throw new ControlError(401, 'tenant_token_invalid', 'The tenant token is malformed');

  if (parts[0] !== 'v1') {
    throw new ControlError(401, 'tenant_token_invalid', 'The tenant token version is not accepted');
  }
  let claims;
  try {
    claims = decodeBase64UrlJson(parts[1]);
  } catch {
    throw new ControlError(401, 'tenant_token_invalid', 'The tenant token is malformed');
  }

  // Match Nexora/Agent's shared v1 HMAC contract: sign the base64url payload only.
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  let signatureValid = false;
  try {
    signatureValid = await crypto.subtle.verify(
      'HMAC',
      key,
      base64UrlToBytes(parts[2]),
      encoder.encode(parts[1]),
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) throw new ControlError(401, 'tenant_token_invalid', 'The tenant token signature is invalid');

  const now = Math.floor(Date.now() / 1000);
  if (
    claims?.iss !== 'nexora-intelligence' ||
    claims?.aud !== 'ai-browser-agent-control' ||
    claims?.typ !== 'tenant' ||
    typeof claims?.tenantId !== 'string' || !claims.tenantId ||
    typeof claims?.sub !== 'string' || !claims.sub ||
    typeof claims?.jti !== 'string' || !claims.jti ||
    !Number.isInteger(claims?.iat) || !Number.isInteger(claims?.exp) ||
    claims.iat > now + 30 || claims.exp <= now || claims.exp - claims.iat > 600
  ) {
    throw new ControlError(401, 'tenant_token_expired_or_invalid', 'The tenant token claims are invalid or expired');
  }
  return claims;
}

function isPrivateIpv4(hostname) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return false;
  const octets = hostname.split('.').map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) return true;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 192 && b === 0) ||
    (a === 198 && b === 51) ||
    (a === 203 && b === 0);
}

function assertPublicHttpUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) {
    throw new ControlError(400, 'invalid_url', 'A valid public HTTP or HTTPS URL is required');
  }
  let url;
  try { url = new URL(value); } catch { throw new ControlError(400, 'invalid_url', 'The URL is invalid'); }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username || url.password ||
    (url.port && !['80', '443'].includes(url.port)) ||
    !hostname || hostname === 'localhost' || hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') || hostname.endsWith('.internal') ||
    hostname.endsWith('.test') || hostname.endsWith('.invalid') ||
    hostname.endsWith('.onion') || hostname.includes(':') ||
    isPrivateIpv4(hostname) || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)
  ) {
    throw new ControlError(400, 'unsafe_url', 'The requested URL is not an allowed public web address');
  }
  return url;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function executeBrowserTask(toolName, args, env, requestId) {
  const target = assertPublicHttpUrl(args?.url);
  if (!env.BROWSER) throw new ControlError(503, 'browser_binding_missing', 'Cloudflare Browser Rendering is not configured for this Worker');
  const requestedTimeout = Number.isFinite(args?.timeoutMs) ? args.timeoutMs : 12_000;
  const timeoutMs = Math.max(3_000, Math.min(requestedTimeout, MAX_NAVIGATION_MS));
  let browser;
  try {
    // Browser Run guardrails constrain the entire session, including redirects and subresources,
    // to the public hostname explicitly requested by the owner-approved task.
    const alternateHost = target.hostname.startsWith('www.') ? target.hostname.slice(4) : `www.${target.hostname}`;
    const allowedDomains = Array.from(new Set([target.hostname, alternateHost]));
    browser = await puppeteer.launch(env.BROWSER, {
      guardrails: { allowedDomains, allowedDomainSets: ['common-cdns'] },
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    page.setDefaultNavigationTimeout(timeoutMs);
    const response = await page.goto(target.toString(), { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const snapshotText = await page.evaluate(() => JSON.stringify({
      title: document.title || '',
      description: document.querySelector('meta[name="description"]')?.getAttribute('content') || '',
      text: (document.body?.innerText || '').slice(0, 12000),
      links: Array.from(document.querySelectorAll('a[href]')).slice(0, 30).map((anchor) => ({
        text: (anchor.innerText || anchor.textContent || '').trim().slice(0, 160),
        href: anchor.href,
      })),
    }));
    const snapshot = JSON.parse(snapshotText || '{}');
    const pageText = typeof snapshot.text === 'string' ? snapshot.text.slice(0, MAX_TEXT_CHARS) : '';
    const result = {
      requestedUrl: target.toString(),
      finalUrl: page.url(),
      title: snapshot.title || '',
      description: snapshot.description || '',
      text: pageText,
      links: Array.isArray(snapshot.links) ? snapshot.links : [],
      statusCode: response?.status?.() ?? null,
      capturedAt: new Date().toISOString(),
      contentSha256: await sha256Hex(pageText),
      requestId,
    };

    if (toolName === 'browser.screenshot') {
      const screenshot = await page.screenshot({ type: 'jpeg', quality: 55, fullPage: false });
      if (screenshot.byteLength <= MAX_SCREENSHOT_BYTES) {
        result.screenshotMimeType = 'image/jpeg';
        result.screenshotBase64 = bytesToBase64(screenshot);
      } else {
        result.screenshotOmitted = true;
        result.screenshotOmittedReason = 'screenshot_exceeds_512kb_limit';
      }
    }
    return result;
  } catch (error) {
    const message = String(error?.message || 'Browser execution failed');
    if (/timeout|timed out/i.test(message)) throw new ControlError(504, 'browser_navigation_timeout', 'The browser navigation timed out');
    if (/limit|quota|concurrent|capacity/i.test(message)) throw new ControlError(429, 'browser_capacity_or_quota', 'The Browser Rendering capacity or free allowance is currently unavailable');
    console.error(JSON.stringify({ event: 'agent_browser_error', requestId, errorName: error?.name || 'Error', message: message.slice(0, 240) }));
    throw new ControlError(502, 'browser_execution_failed', 'The browser task could not be completed');
  } finally {
    if (browser) {
      try { await browser.close(); } catch (error) {
        console.error(JSON.stringify({ event: 'agent_browser_close_error', requestId, errorName: error?.name || 'Error' }));
      }
    }
  }
}

async function authenticateControlRequest(request, env) {
  if (!env.CONTROL_TOKEN || !env.NEXORA_AGENT_SHARED_SECRET) {
    throw new ControlError(503, 'control_not_configured', 'The signed Nexora control credentials have not been configured');
  }
  const authorization = request.headers.get('authorization') || '';
  if (!constantTimeEqual(authorization, `Bearer ${env.CONTROL_TOKEN}`)) {
    throw new ControlError(401, 'control_token_invalid', 'The control bearer token is invalid');
  }
  const tenantClaims = await verifyTenantToken(request.headers.get('x-nexora-tenant-token'), env.NEXORA_AGENT_SHARED_SECRET);
  const operatorHeader = request.headers.get('x-operator-id');
  if (operatorHeader && operatorHeader !== tenantClaims.sub) {
    throw new ControlError(403, 'operator_context_mismatch', 'The operator header does not match the signed tenant token');
  }
  return tenantClaims;
}

function requestIdFor(request) {
  const value = request.headers.get('x-request-id') || '';
  return /^[A-Za-z0-9._-]{1,100}$/.test(value) ? value : crypto.randomUUID();
}

async function handleControlRequest(request, env) {
  const requestId = requestIdFor(request);
  await authenticateControlRequest(request, env);

  const pathname = new URL(request.url).pathname;
  if (!pathname.startsWith(TOOL_PREFIX)) throw new ControlError(404, 'tool_not_found', 'The requested control tool was not found');
  const toolName = decodeURIComponent(pathname.slice(TOOL_PREFIX.length));
  if (!ALLOWED_TOOLS.has(toolName)) throw new ControlError(403, 'tool_not_enabled', 'This tool is not enabled in the Cloudflare browser execution runtime');

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) throw new ControlError(413, 'request_too_large', 'The browser task request is too large');
  let args = {};
  if (rawBody) {
    try { args = JSON.parse(rawBody); } catch { throw new ControlError(400, 'invalid_json', 'The request body must be valid JSON'); }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ControlError(400, 'invalid_arguments', 'The request arguments must be a JSON object');

  if (toolName === 'agent.health_check') {
    return json({
      ok: true,
      tool: toolName,
      requestId,
      result: {
        runtime: 'cloudflare-workers',
        browserRenderingConfigured: Boolean(env.BROWSER),
        aiConfigured: Boolean(env.AI && typeof env.AI.run === 'function'),
        aiModel: env.AI_MODEL || null,
        supportedTools: Array.from(ALLOWED_TOOLS),
        writeActionsEnabled: false,
      },
    });
  }

  const result = await executeBrowserTask(toolName, args, env, requestId);
  return json({ ok: true, tool: toolName, requestId, result });
}

async function handleAiRequest(request, env) {
  const requestId = requestIdFor(request);
  await authenticateControlRequest(request, env);
  if (!env.AI || typeof env.AI.run !== 'function') {
    throw new ControlError(503, 'ai_binding_missing', 'Workers AI is not configured for this Preview');
  }

  const rawBody = await request.text();
  if (encoder.encode(rawBody).byteLength > MAX_AI_BODY_BYTES) {
    throw new ControlError(413, 'ai_request_too_large', 'The AI request exceeds the allowed size');
  }
  let body;
  try { body = JSON.parse(rawBody); } catch {
    throw new ControlError(400, 'invalid_json', 'The AI request body must be valid JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ControlError(400, 'invalid_ai_request', 'The AI request must be a JSON object');
  }
  if (body.tools || body.functions || body.tool_choice || body.function_call) {
    throw new ControlError(400, 'tool_calls_not_supported', 'This endpoint supports text generation only; tool execution is disabled');
  }
  if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > MAX_AI_MESSAGES) {
    throw new ControlError(400, 'invalid_messages', 'Between 1 and 20 chat messages are required');
  }
  let totalChars = 0;
  const messages = body.messages.map((message) => {
    if (!message || typeof message !== 'object' || !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string') {
      throw new ControlError(400, 'invalid_message', 'Each message must have a system, user or assistant role and plain-text content');
    }
    totalChars += message.content.length;
    if (message.content.length > 8_000 || totalChars > MAX_AI_PROMPT_CHARS) {
      throw new ControlError(413, 'ai_prompt_too_large', 'The combined AI prompt exceeds the allowed character limit');
    }
    return { role: message.role, content: message.content };
  });
  if (!messages.some((message) => message.role === 'user')) {
    throw new ControlError(400, 'user_message_required', 'At least one user message is required');
  }

  const maxTokens = body.max_tokens === undefined ? 512 : body.max_tokens;
  if (!Number.isInteger(maxTokens) || maxTokens < 64 || maxTokens > MAX_AI_OUTPUT_TOKENS) {
    throw new ControlError(400, 'invalid_max_tokens', `max_tokens must be an integer between 64 and ${MAX_AI_OUTPUT_TOKENS}`);
  }
  const temperature = body.temperature === undefined ? 0.2 : body.temperature;
  if (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 1) {
    throw new ControlError(400, 'invalid_temperature', 'temperature must be a number between 0 and 1');
  }

  const model = typeof env.AI_MODEL === 'string' && env.AI_MODEL.startsWith('@cf/')
    ? env.AI_MODEL
    : '@cf/openai/gpt-oss-20b';
  let result;
  try {
    result = await env.AI.run(model, { messages, max_tokens: maxTokens, temperature, stream: false });
  } catch (error) {
    console.error(JSON.stringify({ event: 'agent_ai_inference_error', requestId, errorName: error?.name || 'Error' }));
    throw new ControlError(502, 'ai_inference_failed', 'Workers AI could not complete the request');
  }
  const choice = result?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new ControlError(502, 'ai_empty_response', 'Workers AI returned no usable text response');
  }
  const usage = result?.usage || {};
  const safeUsage = {};
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'neurons']) {
    if (typeof usage[key] === 'number' && Number.isFinite(usage[key])) safeUsage[key] = usage[key];
  }
  return json({
    id: typeof result?.id === 'string' ? result.id : `chatcmpl-${requestId}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    requestId,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: choice.finish_reason || 'stop' }],
    usage: safeUsage,
  });
}

function safeSentryText(value, max = 400) {
  return String(value || 'Unhandled Worker error')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[url]')
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/((?:token|secret|password|api[_-]?key)=)[^\s&]+/gi, '$1[redacted]')
    .slice(0, max);
}

async function captureSentry(env, error, request, code, requestId) {
  const dsnValue = env.SENTRY_DSN;
  if (!dsnValue) return false;
  try {
    const dsn = new URL(dsnValue);
    const projectId = dsn.pathname.split('/').filter(Boolean).at(-1);
    const publicKey = dsn.username;
    if (dsn.protocol !== 'https:' || !dsn.hostname.endsWith('.ingest.us.sentry.io') || !projectId || !publicKey) return false;
    const eventId = crypto.randomUUID().replace(/-/g, '');
    const timestamp = Date.now() / 1000;
    const route = (() => { try { return new URL(request.url).pathname; } catch { return 'unknown'; } })();
    const message = safeSentryText(error?.message || error?.name || code || 'Unhandled Worker error');
    const event = {
      event_id: eventId,
      timestamp,
      platform: 'javascript',
      level: 'error',
      logger: 'ai-browser-agent',
      environment: safeSentryText(env.SENTRY_ENVIRONMENT || 'preview', 40),
      message,
      tags: {
        runtime: 'cloudflare-workers',
        route: safeSentryText(route, 200),
        method: safeSentryText(request.method || 'unknown', 16),
        code: safeSentryText(code || 'internal_error', 100),
        request_id: safeSentryText(requestId || 'unknown', 100),
      },
      fingerprint: ['ai-browser-agent', safeSentryText(code || 'worker-error', 100)],
      exception: { values: [{ type: safeSentryText(error?.name || 'Error', 80), value: message }] },
    };
    const envelope = [
      JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString(), dsn: dsnValue }),
      JSON.stringify({ type: 'event', content_type: 'application/json' }),
      JSON.stringify(event),
      '',
    ].join('\n');
    const response = await fetch(`https://${dsn.hostname}/api/${projectId}/envelope/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-sentry-envelope',
        'x-sentry-auth': `Sentry sentry_version=7,sentry_client=ai-browser-agent/1.0,sentry_key=${publicKey}`,
      },
      body: envelope,
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/healthz') {
      return json({
        ok: true,
        service: 'ai-browser-agent',
        runtime: 'cloudflare-workers',
        browserRenderingConfigured: Boolean(env.BROWSER),
        controlConfigured: Boolean(env.CONTROL_TOKEN && env.NEXORA_AGENT_SHARED_SECRET),
        aiConfigured: Boolean(env.AI && typeof env.AI.run === 'function'),
        aiModel: env.AI_MODEL || null,
        sentryConfigured: Boolean(env.SENTRY_DSN),
        version: env.BUILD_SHA || 'preview',
        timestamp: new Date().toISOString(),
      });
    }
    const isControlRoute = url.pathname.startsWith(TOOL_PREFIX);
    const isAiRoute = url.pathname === AI_PREFIX;
    if (request.method !== 'POST' || (!isControlRoute && !isAiRoute)) {
      return json({ ok: false, error: 'Not found', code: 'not_found' }, 404);
    }
    try {
      return isAiRoute ? await handleAiRequest(request, env) : await handleControlRequest(request, env);
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      const code = typeof error?.code === 'string' ? error.code : 'internal_error';
      const requestId = request.headers.get('x-request-id') || crypto.randomUUID();
      if (status >= 500) {
        console.error(JSON.stringify({ event: 'agent_control_error', requestId, code, errorName: error?.name || 'Error' }));
        const report = captureSentry(env, error, request, code, requestId);
        if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(report);
        else await report;
      }
      return json({ ok: false, error: error?.message || 'The control request failed', code, requestId }, status);
    }
  },
};
