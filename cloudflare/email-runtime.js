const EMAIL_MAX_BODY_BYTES = 1024 * 1024;
const EMAIL_STORE_ID = "nexora-email-store-v1";
const INBOUND_ROUTES = new Set([
  "/api/inbound/email/cloudmailin",
  "/api/inbound/email/resend.json",
]);
const EVENTS_ROUTE = "/api/outbound/email/cloudmailin/events";

function emailJson(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function constantTimeEqual(left, right) {
  const a = new TextEncoder().encode(String(left || ""));
  const b = new TextEncoder().encode(String(right || ""));
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

function bool(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return null;
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  const value = key ? headers[key] : null;
  return Array.isArray(value) ? value[0] || null : value || null;
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t\r\n]+/g, " ")
    .trim()
    .slice(0, 12000);
}

export function normalizeCloudMailinMessage(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw Object.assign(new Error("invalid CloudMailin payload"), { status: 400 });
  }
  const envelope = payload.envelope && typeof payload.envelope === "object" ? payload.envelope : {};
  const headers = payload.headers && typeof payload.headers === "object" ? payload.headers : {};
  const senderRaw = String(headerValue(headers, "from") || envelope.from || "").trim();
  const senderMatch = senderRaw.match(/^(.*?)\s*<([^<>]+)>$/);
  const sender = (senderMatch ? senderMatch[2] : senderRaw).trim();
  const senderName = senderMatch ? senderMatch[1].replace(/^["']|["']$/g, "").trim().slice(0, 160) : "";
  const recipient = String(envelope.to || (Array.isArray(envelope.recipients) ? envelope.recipients[0] : envelope.recipients) || headerValue(headers, "to") || "").trim();
  const externalMessageId = String(headerValue(headers, "message_id") || headerValue(headers, "message-id") || "").trim();
  const subject = String(headerValue(headers, "subject") || "").trim().slice(0, 500);
  const plain = typeof payload.plain === "string" ? payload.plain : "";
  const html = typeof payload.html === "string" ? payload.html : "";
  const body = (plain || payload.reply_plain || stripHtml(html)).trim().slice(0, 12000);
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(sender)) throw Object.assign(new Error("sender email address is invalid"), { status: 400 });
  if (!recipient) throw Object.assign(new Error("recipient is required"), { status: 400 });
  if (!externalMessageId) throw Object.assign(new Error("message_id is required"), { status: 400 });
  if (!body && !subject) throw Object.assign(new Error("message content is required"), { status: 400 });
  return {
    provider: "cloudmailin",
    externalMessageId,
    sender: sender.slice(0, 320),
    senderName,
    recipient: recipient.slice(0, 320),
    subject,
    body,
    receivedAt: String(headerValue(headers, "date") || new Date().toISOString()).slice(0, 80),
    threadId: String(headerValue(headers, "in_reply_to") || "").slice(0, 320) || null,
  };
}

export function classifyEmailIntent(message) {
  const value = String(message || "").toLowerCase();
  if (/\b(urgent|emergency|lawyer|legal action|fraud|security breach|angry|complaint|refund|cancel)\b|\b(haraka|malalamiko|rudisha pesa|ghadhabu)\b/.test(value)) return "urgent_escalation";
  if (/\b(price|pricing|cost|how much|quote|quotation|proposal|invoice|payment|paid|discount|contract)\b|\b(bei|gharama|nukuu|ankara|malipo|mkataba)\b/.test(value)) return "quote_request";
  if (/\b(project status|progress|when will|delivery date|completed|revision|edit|change request)\b|\b(mradi|maendeleo|umekamilika|marekebisho|mabadiliko)\b/.test(value)) return "project_update";
  if (/\b(start|need|looking for|interested|business|website|logo|branding|video|automation|design)\b|\b(nahitaji|natafuta|biashara|tovuti|nembo|muundo|video|otomatiki)\b/.test(value)) return "lead_intake";
  return "service_faq";
}

export function resolveWorkerEmailPolicy({ intent, confidence, requiresHumanReview, message, reply }) {
  const sensitive = /\b(price|pricing|cost|how much|quote|quotation|proposal|invoice|payment|paid|refund|discount|contract|deadline|delivery date|project status|progress|revision|complaint|urgent|cancel|charge|bei|gharama|nukuu|ankara|malipo|lini|muda|marekebisho|malalamiko|haraka)\b/i.test(String(message || ""));
  const unsupported = /(?:TZS|KES|USD|\$)\s?[\d,.]+|\b(?:completed|fully delivered|payment received|paid in full|will deliver by|work has started)\b/i.test(String(reply || ""));
  const allowed = ["service_faq", "lead_intake", "onboarding", "general_support"].includes(intent);
  const score = Number.isFinite(Number(confidence)) ? Math.max(0, Math.min(1, Number(confidence))) : 0;
  const human = Boolean(requiresHumanReview) || sensitive || unsupported || !allowed || score < 0.75;
  return {
    requiresHumanReview: human,
    autoSendEligible: !human,
    reason: human ? (sensitive ? "commercial_or_customer_specific_claim_requires_review" : unsupported ? "unsupported_claim_requires_review" : !allowed ? "intent_requires_human_review" : "low_confidence_requires_review") : "safe_faq_or_intake",
  };
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((part) => part.toString(16).padStart(2, "0")).join("");
}

async function readJson(request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > EMAIL_MAX_BODY_BYTES) throw Object.assign(new Error("body too large"), { status: 413 });
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > EMAIL_MAX_BODY_BYTES) throw Object.assign(new Error("body too large"), { status: 413 });
  try { return JSON.parse(text); } catch { throw Object.assign(new Error("invalid JSON"), { status: 400 }); }
}

async function storeCall(env, operation, data = {}) {
  if (!env.REPLAY_GUARD) throw new Error("Durable Object storage binding is unavailable");
  const id = env.REPLAY_GUARD.idFromName(EMAIL_STORE_ID);
  const stub = env.REPLAY_GUARD.get(id);
  const response = await stub.fetch("https://replay-guard/email-store", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation, ...data }),
  });
  if (!response.ok) throw new Error("email storage unavailable");
  return response.json();
}

async function callNexoraAssistant(message, history, env) {
  const endpoint = String(env.NEXORA_EMAIL_ASSISTANT_URL || "").trim();
  const secret = String(env.NEXORA_AGENT_SHARED_SECRET || "").trim();
  if (!endpoint || !secret) throw new Error("Nexora Gemini assistant is not configured for this Worker environment");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + secret,
    },
    body: JSON.stringify({
      messageId: message.externalMessageId,
      conversationId: message.conversationId,
      customerEmail: message.sender,
      customerName: message.senderName || "",
      subject: message.subject,
      message: message.body,
      conversationHistory: history.filter((item) => item.id !== message.externalMessageId).slice(-20).map((item) => ({
        direction: item.direction,
        subject: item.subject,
        body: item.body,
        receivedAt: item.receivedAt,
      })),
    }),
    signal: AbortSignal.timeout(35000),
    cache: "no-store",
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok !== true || typeof result.reply !== "string") {
    throw new Error("Nexora Gemini assistant request failed");
  }
  return result;
}

async function sendCloudMailin(delivery, env) {
  const accountId = String(env.CLOUDMAILIN_OUTBOUND_ACCOUNT_ID || "").trim();
  const token = String(env.CLOUDMAILIN_OUTBOUND_API_TOKEN || "").trim();
  const from = String(env.CLOUDMAILIN_OUTBOUND_FROM || "").trim();
  const base = String(env.CLOUDMAILIN_API_BASE_URL || "https://api.cloudmailin.com/api/v0.1").replace(/\/$/, "");
  if (!accountId || !token || !from) throw new Error("CloudMailin outbound is not configured");
  const testMode = bool(env.CLOUDMAILIN_OUTBOUND_TEST_MODE, true);
  let lastError = "CloudMailin outbound failed";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(base + "/" + encodeURIComponent(accountId) + "/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          accept: "application/json",
          "idempotency-key": delivery.idempotencyKey,
        },
        body: JSON.stringify({
          from,
          to: [delivery.recipient],
          subject: delivery.subject,
          plain: delivery.body,
          test_mode: testMode,
          headers: delivery.clientMessageId ? { "Message-ID": delivery.clientMessageId } : undefined,
          tags: ["nexora", "ai-browser-agent", delivery.intent || "customer-email"],
        }),
        signal: AbortSignal.timeout(15000),
      });
      const text = await response.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch {}
      if (response.ok) {
        return {
          ok: true,
          testMode,
          providerMessageId: data.id || data.message_id || response.headers.get("x-message-id") || null,
        };
      }
      lastError = "CloudMailin HTTP " + response.status;
      if (response.status !== 429 && response.status < 500) break;
    } catch (error) {
      lastError = error && error.name === "AbortError" ? "CloudMailin request timed out" : "CloudMailin network error";
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 300 * (2 ** attempt)));
  }
  throw new Error(lastError);
}

async function handleInbound(request, env, ctx) {
  const secret = String(env.CLOUDMAILIN_WEBHOOK_AUTH_SECRET || "");
  if (!secret) return emailJson({ ok: false, error: "inbound_not_configured" }, 503);
  if (!constantTimeEqual(request.headers.get("authorization") || "", "Bearer " + secret)) {
    return emailJson({ ok: false, error: "unauthorized" }, 401);
  }
  let payload;
  try { payload = await readJson(request); } catch (error) {
    return emailJson({ ok: false, error: error.message || "invalid_payload" }, error.status || 400);
  }
  let normalized;
  try { normalized = normalizeCloudMailinMessage(payload); } catch (error) {
    return emailJson({ ok: false, error: error.message || "invalid_email" }, error.status || 400);
  }
  const conversationId = await sha256(normalized.sender.toLowerCase());
  const message = {
    ...normalized,
    id: normalized.externalMessageId,
    conversationId,
    direction: "inbound",
    status: "RECEIVED",
  };
  let stored;
  try {
    stored = await storeCall(env, "ingest", { message });
  } catch {
    return emailJson({ ok: false, error: "email_storage_unavailable" }, 503);
  }
  if (stored.duplicate) {
    return emailJson({
      ok: true, duplicate: true, messageId: normalized.externalMessageId,
      conversationId, status: stored.message?.status || "RECEIVED",
    });
  }

  let assistant;
  try {
    assistant = await callNexoraAssistant(message, stored.history || [], env);
  } catch {
    assistant = {
      ok: false,
      intent: classifyEmailIntent(normalized.subject + " " + normalized.body),
      reply: "",
      confidence: 0,
      requiresHumanReview: true,
      autoSendEligible: false,
      escalationReason: "Gemini/Nexora context is unavailable; human response required.",
      extractedRequirements: {},
      missingFields: [],
    };
  }

  const policy = resolveWorkerEmailPolicy({
    intent: assistant.intent || classifyEmailIntent(normalized.subject + " " + normalized.body),
    confidence: assistant.confidence,
    requiresHumanReview: assistant.requiresHumanReview,
    message: normalized.subject + " " + normalized.body,
    reply: assistant.reply,
  });
  const delivery = {
    idempotencyKey: "nexora-email:" + await sha256(normalized.externalMessageId + "|" + normalized.sender.toLowerCase()),
    recipient: normalized.sender,
    subject: /^re:\s/i.test(normalized.subject) ? normalized.subject : "Re: " + (normalized.subject || "Your message to Nexora"),
    body: assistant.reply || "",
    intent: assistant.intent || "other",
    serviceSlug: assistant.serviceSlug || null,
    conversationId,
    messageId: normalized.externalMessageId,
    status: policy.requiresHumanReview ? "NEEDS_HUMAN_REVIEW" : "DRAFT_READY",
    createdAt: new Date().toISOString(),
    clientMessageId: "<" + await sha256("nexora-email:" + normalized.externalMessageId + "|" + normalized.sender.toLowerCase()) + "@mail.nexora.local>",
    extractedRequirements: assistant.extractedRequirements || {},
    missingFields: assistant.missingFields || [],
    summary: assistant.summary || "",
    language: assistant.language || "en",
    escalationReason: assistant.escalationReason || null,
    requiresHumanReview: policy.requiresHumanReview,
    attempts: [],
  };
  try {
    const reserved = await storeCall(env, "reserveDelivery", { delivery });
    if (reserved.replay) {
      return emailJson({ ok: true, duplicate: true, messageId: normalized.externalMessageId, conversationId, intent: delivery.intent, deliveryStatus: reserved.delivery?.status || "PENDING", externalSideEffect: false }, 200);
    }
    if (policy.autoSendEligible && bool(env.EMAIL_AUTOREPLY_ENABLED, false)) {
      try {
        const sent = await sendCloudMailin(delivery, env);
        delivery.status = sent.testMode ? "TEST_ACCEPTED" : "SENT";
        delivery.providerMessageId = sent.providerMessageId;
        delivery.testMode = sent.testMode;
        delivery.sentAt = new Date().toISOString();
        delivery.attempts.push({ status: "SUCCESS", at: delivery.sentAt, testMode: sent.testMode });
      } catch (error) {
        delivery.status = "FAILED";
        delivery.error = error.message || "outbound_failed";
        delivery.attempts.push({ status: "FAILED", at: new Date().toISOString(), error: delivery.error });
      }
      await storeCall(env, "updateDelivery", { idempotencyKey: delivery.idempotencyKey, patch: delivery });
    } else {
      await storeCall(env, "updateDelivery", { idempotencyKey: delivery.idempotencyKey, patch: delivery });
    }
  } catch {
    return emailJson({ ok: false, error: "delivery_state_unavailable" }, 503);
  }

  if (policy.requiresHumanReview) {
    ctx.waitUntil(storeCall(env, "escalate", {
      escalation: {
        id: normalized.externalMessageId,
        conversationId,
        customerEmail: normalized.sender,
        subject: normalized.subject,
        intent: delivery.intent,
        reason: assistant.escalationReason || policy.reason,
        summary: assistant.summary || normalized.body.slice(0, 600),
        requirements: assistant.extractedRequirements || {},
        missingFields: assistant.missingFields || [],
        createdAt: new Date().toISOString(),
        status: "OPEN",
      },
    }).catch(() => null));
  }

  return emailJson({
    ok: true,
    duplicate: false,
    messageId: normalized.externalMessageId,
    conversationId,
    intent: delivery.intent,
    serviceSlug: delivery.serviceSlug,
    language: assistant.language || "en",
    requiresHumanReview: policy.requiresHumanReview,
    autoSendEligible: policy.autoSendEligible,
    deliveryStatus: delivery.status,
    testMode: delivery.testMode === true,
    historyMessages: (stored.history || []).length,
    externalSideEffect: delivery.status === "SENT",
  }, 202);
}

async function handleDeliveryEvents(request, env) {
  const secret = String(env.CLOUDMAILIN_OUTBOUND_EVENTS_AUTH_SECRET || "");
  if (!secret) return emailJson({ ok: false, error: "events_not_configured" }, 503);
  if (!constantTimeEqual(request.headers.get("authorization") || "", "Bearer " + secret)) {
    return emailJson({ ok: false, error: "unauthorized" }, 401);
  }
  let payload;
  try { payload = await readJson(request); } catch (error) {
    return emailJson({ ok: false, error: error.message || "invalid_payload" }, error.status || 400);
  }
  const events = Array.isArray(payload.events) ? payload.events.slice(0, 100) : [];
  if (!events.length) return emailJson({ ok: false, error: "events_array_required" }, 400);
  const results = [];
  for (const event of events) {
    const eventKey = await sha256(JSON.stringify(event || {}));
    const kind = String(event?.kind || "unknown").slice(0, 80);
    const status = kind === "delivery" ? "DELIVERED"
      : ["bounce", "retries_exhausted", "suppressed", "error"].includes(kind) ? "FAILED"
      : ["soft_bounce", "dispatch_soft_bounce", "rate_limit"].includes(kind) ? "RETRYING"
      : ["open", "click"].includes(kind) ? "ENGAGED" : "EVENT_RECORDED";
    const saved = await storeCall(env, "trackEvent", {
      eventKey,
      event: {
        kind,
        status,
        providerMessageId: String(event?.message_id || "").slice(0, 200),
        originalMessageId: String(event?.original_message_id || "").slice(0, 320),
        recipient: String(event?.recipient || "").slice(0, 320),
        timestamp: String(event?.timestamp || new Date().toISOString()).slice(0, 80),
      },
    });
    results.push({ eventKey, duplicate: saved.duplicate === true, matched: saved.matched === true, status });
  }
  return emailJson({ ok: true, processed: results.length, results });
}

function installDurableObjectEmailStore(ReplayGuard) {
  if (!ReplayGuard || ReplayGuard.prototype.__nexoraEmailStoreInstalled) return;
  const originalFetch = ReplayGuard.prototype.fetch;
  ReplayGuard.prototype.fetch = async function(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/email-store") return originalFetch.call(this, request);
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    let body;
    try { body = await request.json(); } catch { return emailJson({ error: "invalid_json" }, 400); }
    try {
      const result = await this.storage.transaction(async (tx) => {
        if (body.operation === "ingest") {
          const message = body.message;
          const messageKey = "email:inbound:" + message.externalMessageId;
          const conversationKey = "email:conversation:" + message.conversationId;
          const existing = await tx.get(messageKey);
          const history = (await tx.get(conversationKey)) || [];
          if (existing) return { duplicate: true, message: existing, history };
          await tx.put(messageKey, message);
          const next = [...history, message].slice(-25);
          await tx.put(conversationKey, next);
          return { duplicate: false, message, history: next };
        }
        if (body.operation === "reserveDelivery") {
          const delivery = body.delivery;
          const key = "email:delivery:" + delivery.idempotencyKey;
          const existing = await tx.get(key);
          if (existing) return { replay: true, delivery: existing };
          const saved = { ...delivery, createdAt: delivery.createdAt || new Date().toISOString() };
          await tx.put(key, saved);
          await tx.put("email:delivery-id:" + saved.id, saved);
          return { replay: false, delivery: saved };
        }
        if (body.operation === "updateDelivery") {
          const key = "email:delivery:" + body.idempotencyKey;
          const current = await tx.get(key);
          if (!current) return { ok: false, missing: true };
          const updated = { ...current, ...body.patch, idempotencyKey: body.idempotencyKey, updatedAt: new Date().toISOString() };
          await tx.put(key, updated);
          await tx.put("email:delivery-id:" + updated.id, updated);
          if (updated.providerMessageId) await tx.put("email:provider:" + updated.providerMessageId, body.idempotencyKey);
          if (updated.clientMessageId) await tx.put("email:client:" + updated.clientMessageId, body.idempotencyKey);
          return { ok: true, delivery: updated };
        }
        if (body.operation === "escalate") {
          const item = body.escalation;
          const key = "email:escalation:" + item.id;
          const existing = await tx.get(key);
          if (existing) return { duplicate: true, escalation: existing };
          await tx.put(key, item);
          return { duplicate: false, escalation: item };
        }
        if (body.operation === "trackEvent") {
          const eventKey = "email:event:" + body.eventKey;
          const existing = await tx.get(eventKey);
          if (existing) return { duplicate: true, matched: false };
          await tx.put(eventKey, body.event);
          const byProvider = body.event.providerMessageId ? await tx.get("email:provider:" + body.event.providerMessageId) : null;
          const byClient = body.event.originalMessageId ? await tx.get("email:client:" + body.event.originalMessageId) : null;
          const idempotencyKey = byProvider || byClient;
          if (!idempotencyKey) return { duplicate: false, matched: false };
          const deliveryKey = "email:delivery:" + idempotencyKey;
          const current = await tx.get(deliveryKey);
          if (!current) return { duplicate: false, matched: false };
          const updated = { ...current, status: body.event.status, lastDeliveryEvent: body.event, updatedAt: new Date().toISOString() };
          await tx.put(deliveryKey, updated);
          await tx.put("email:delivery-id:" + updated.id, updated);
          return { duplicate: false, matched: true, deliveryId: updated.id, status: updated.status };
        }
        return { error: "unknown_operation" };
      });
      return emailJson(result);
    } catch {
      return emailJson({ error: "email_store_transaction_failed" }, 500);
    }
  };
  ReplayGuard.prototype.__nexoraEmailStoreInstalled = true;
}

export function installEmailRuntime(ReplayGuard, worker) {
  installDurableObjectEmailStore(ReplayGuard);
  if (!worker || typeof worker.fetch !== "function" || worker.__nexoraEmailRuntimeInstalled) return worker;
  const originalFetch = worker.fetch.bind(worker);
  worker.fetch = async (request, env, ctx) => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/api/email/v1/health") {
      return emailJson({
        ok: true,
        service: "ai-browser-agent-email",
        runtime: "cloudflare-workers",
        inboundAuthConfigured: Boolean(env.CLOUDMAILIN_WEBHOOK_AUTH_SECRET),
        outboundConfigured: Boolean(env.CLOUDMAILIN_OUTBOUND_ACCOUNT_ID && env.CLOUDMAILIN_OUTBOUND_API_TOKEN && env.CLOUDMAILIN_OUTBOUND_FROM),
        outboundTestMode: bool(env.CLOUDMAILIN_OUTBOUND_TEST_MODE, true),
        autoReplyEnabled: bool(env.EMAIL_AUTOREPLY_ENABLED, false),
        nexoraGeminiBridgeConfigured: Boolean(env.NEXORA_EMAIL_ASSISTANT_URL && env.NEXORA_AGENT_SHARED_SECRET),
        durableStoreConfigured: Boolean(env.REPLAY_GUARD),
        productionSafe: !bool(env.EMAIL_AUTOREPLY_ENABLED, false) || bool(env.CLOUDMAILIN_OUTBOUND_TEST_MODE, true),
      });
    }
    if (request.method === "POST" && INBOUND_ROUTES.has(url.pathname)) {
      return handleInbound(request, env, ctx);
    }
    if (request.method === "POST" && url.pathname === EVENTS_ROUTE) {
      return handleDeliveryEvents(request, env);
    }
    return originalFetch(request, env, ctx);
  };
  worker.__nexoraEmailRuntimeInstalled = true;
  return worker;
}
