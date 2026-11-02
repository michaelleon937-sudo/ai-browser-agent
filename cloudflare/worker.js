import puppeteer from '@cloudflare/puppeteer';

const encoder = new TextEncoder();
const TOOL_PREFIX = '/api/control/v1/tools/';
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

  let header;
  let claims;
  try {
    header = decodeBase64UrlJson(parts[0]);
    claims = decodeBase64UrlJson(parts[1]);
  } catch {
    throw new ControlError(401, 'tenant_token_invalid', 'The tenant token is malformed');
  }
  if (header?.alg !== 'HS256' || header?.typ !== 'JWT') {
    throw new ControlError(401, 'tenant_token_invalid', 'The tenant token algorithm is not accepted');
  }

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
      encoder.encode(`${parts[0]}.${parts[1]}`),
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
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    page.setDefaultNavigationTimeout(timeoutMs);
    await page.setRequestInterception(true);
    page.on('request', (outgoing) => {
      let allowed = false;
      try {
        assertPublicHttpUrl(outgoing.url());
        allowed = ['GET', 'HEAD'].includes(outgoing.method().toUpperCase());
      } catch { allowed = false; }
      const action = allowed ? outgoing.continue() : outgoing.abort('blockedbyclient');
      action.catch(() => {});
    });

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

async function handleControlRequest(request, env) {
  const requestIdHeader = request.headers.get('x-request-id') || '';
  const requestId = /^[A-Za-z0-9._-]{1,100}$/.test(requestIdHeader) ? requestIdHeader : crypto.randomUUID();
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
        supportedTools: Array.from(ALLOWED_TOOLS),
        writeActionsEnabled: false,
      },
    });
  }

  const result = await executeBrowserTask(toolName, args, env, requestId);
  return json({ ok: true, tool: toolName, requestId, result });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/healthz') {
      return json({
        ok: true,
        service: 'ai-browser-agent',
        runtime: 'cloudflare-workers',
        browserRenderingConfigured: Boolean(env.BROWSER),
        controlConfigured: Boolean(env.CONTROL_TOKEN && env.NEXORA_AGENT_SHARED_SECRET),
        version: env.BUILD_SHA || 'preview',
        timestamp: new Date().toISOString(),
      });
    }
    if (request.method !== 'POST' || !url.pathname.startsWith(TOOL_PREFIX)) {
      return json({ ok: false, error: 'Not found', code: 'not_found' }, 404);
    }
    try {
      return await handleControlRequest(request, env);
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      const code = typeof error?.code === 'string' ? error.code : 'internal_error';
      const requestId = request.headers.get('x-request-id') || crypto.randomUUID();
      if (status >= 500) console.error(JSON.stringify({ event: 'agent_control_error', requestId, code, errorName: error?.name || 'Error' }));
      return json({ ok: false, error: error?.message || 'The control request failed', code, requestId }, status);
    }
  },
};
