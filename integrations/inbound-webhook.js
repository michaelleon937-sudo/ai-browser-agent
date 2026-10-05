// integrations/inbound-webhook.js
// Phase A2 — authenticated CloudMailin inbound email webhook.
import { ingestA2InboundMessage } from './a2-safe-ingestion.js';
import { normalizeCloudMailinInbound, verifyCloudMailinAuthorization } from './inbound-cloudmailin.js';

// The deployed CloudMailin configuration uses this existing callback path.
// Keep the URL stable while removing all Resend/Svix provider logic.
const ROUTE = '/api/inbound/email/resend.json';
const MAX_BODY_BYTES = 1024 * 1024;
const installedServers = new WeakSet();

async function readBody(req, maxBytes) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > maxBytes) throw Object.assign(new Error('request body too large'), { status: 413 });
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw Object.assign(new Error('request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

export function installInboundEmailWebhook(server, { route = ROUTE } = {}) {
  if (!server || typeof server.listeners !== 'function') throw new Error('HTTP server is required');
  if (installedServers.has(server)) return server;

  const listeners = server.listeners('request');
  const original = listeners[0];
  if (typeof original !== 'function') throw new Error('HTTP server request listener not found');

  server.removeAllListeners('request');
  server.on('request', async (req, res) => {
    const pathname = String(req.url || '').split('?')[0];
    if (req.method !== 'POST' || pathname !== route) return original(req, res);

    try {
      const verification = verifyCloudMailinAuthorization({
        authorization: req.headers.authorization,
        secret: process.env.CLOUDMAILIN_WEBHOOK_AUTH_SECRET || '',
      });
      if (!verification.ok) {
        return json(res, verification.status || 401, {
          ok: false,
          error: verification.status === 503 ? 'CloudMailin provider is not configured' : 'unauthorized CloudMailin webhook',
        });
      }

      const rawBody = await readBody(req, MAX_BODY_BYTES);
      let payload;
      try { payload = JSON.parse(rawBody); }
      catch { return json(res, 400, { ok: false, error: 'invalid JSON payload' }); }

      const normalized = normalizeCloudMailinInbound(payload);
      const result = ingestA2InboundMessage({ normalized });

      return json(res, 200, {
        ok: true,
        duplicate: Boolean(result.duplicate),
        messageId: result.message?.id || null,
        conversationId: result.conversation?.id || null,
        classification: result.classification || null,
        intent: result.intent || null,
        unresolved: !result.contact && !result.company && !result.prospect,
        externalSideEffect: false,
      });
    } catch (err) {
      const status = Number(err?.status) || 500;
      return json(res, status, {
        ok: false,
        error: status >= 500 ? 'inbound processing failed' : err.message,
      });
    }
  });

  installedServers.add(server);
  return server;
}

export { ROUTE as INBOUND_EMAIL_ROUTE, MAX_BODY_BYTES as INBOUND_EMAIL_MAX_BODY_BYTES };
