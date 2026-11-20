import { afterEach, describe, expect, it, vi } from "vitest";
import { installEmailRuntime } from "../../cloudflare/email-runtime.js";

function createMemoryStore() {
  const deliveries = new Map();
  const stub = {
    async fetch(input, init) {
      const request = input instanceof Request ? input : new Request(input, init);
      const body = await request.json();
      if (body.operation === "reserveDelivery") {
        const key = body.delivery.idempotencyKey;
        const existing = deliveries.get(key);
        if (existing) return Response.json({ replay: true, delivery: existing });
        deliveries.set(key, body.delivery);
        return Response.json({ replay: false, delivery: body.delivery });
      }
      if (body.operation === "updateDelivery") {
        const current = deliveries.get(body.idempotencyKey);
        if (!current) return Response.json({ ok: false, missing: true });
        const updated = { ...current, ...body.patch, idempotencyKey: body.idempotencyKey };
        deliveries.set(body.idempotencyKey, updated);
        return Response.json({ ok: true, delivery: updated });
      }
      return Response.json({ error: "unknown_operation" }, { status: 400 });
    },
  };
  return { idFromName: () => "email-store", get: () => stub, deliveries };
}

function createRuntime(overrides = {}) {
  class ReplayGuard {
    async fetch() { return new Response("not found", { status: 404 }); }
  }
  const worker = { async fetch() { return new Response("not found", { status: 404 }); } };
  installEmailRuntime(ReplayGuard, worker);
  const env = {
    NEXORA_EMAIL_AGENT_SHARED_SECRET: "preview-notification-secret",
    EMAIL_NOTIFICATIONS_ENABLED: "true",
    CLOUDMAILIN_OUTBOUND_ACCOUNT_ID: "test-account",
    CLOUDMAILIN_OUTBOUND_API_TOKEN: "test-token",
    CLOUDMAILIN_OUTBOUND_FROM: "noreply@example.invalid",
    CLOUDMAILIN_OUTBOUND_TEST_MODE: "true",
    REPLAY_GUARD: createMemoryStore(),
    ...overrides,
  };
  return { worker, env };
}

function notification(overrides = {}) {
  return {
    eventId: "project-42:status:in-progress:v1",
    eventType: "project_update",
    sourceRecordId: "project-42",
    recipient: "customer@example.invalid",
    subject: "Nexora project update",
    body: "Your project status is now In Progress. This is a synthetic Preview notification.",
    verified: true,
    ...overrides,
  };
}

function request(body, authorization = "Bearer preview-notification-secret") {
  return new Request("https://worker.example/api/email/v1/notifications", {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ctx = { waitUntil() {} };

afterEach(() => vi.unstubAllGlobals());

describe("Nexora-triggered CloudMailin notifications", () => {
  it("rejects unauthenticated notification requests", async () => {
    const { worker, env } = createRuntime();
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const response = await worker.fetch(request(notification(), "Bearer wrong"), env, ctx);
    expect(response.status).toBe(401);
    expect(outbound).not.toHaveBeenCalled();
  });

  it("requires a verified Nexora source record", async () => {
    const { worker, env } = createRuntime();
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const response = await worker.fetch(request(notification({ verified: false })), env, ctx);
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("unverified_source_record");
    expect(outbound).not.toHaveBeenCalled();
  });

  it("requires human approval for quotation and proposal drafts", async () => {
    const { worker, env } = createRuntime();
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const response = await worker.fetch(request(notification({ eventType: "quotation_draft" })), env, ctx);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("human_approval_required");
    expect(outbound).not.toHaveBeenCalled();
  });

  it("accepts a verified project update in CloudMailin Test mode without delivering email", async () => {
    const { worker, env } = createRuntime();
    const outbound = vi.fn(async (_url, options) => new Response(JSON.stringify({ id: "cloudmailin-test-1" }), { status: 202, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", outbound);
    const response = await worker.fetch(request(notification()), env, ctx);
    const result = await response.json();
    expect(response.status).toBe(202);
    expect(result.deliveryStatus).toBe("TEST_ACCEPTED");
    expect(result.testMode).toBe(true);
    expect(result.externalSideEffect).toBe(false);
    expect(outbound).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(outbound.mock.calls[0][1].body);
    expect(sent.test_mode).toBe(true);
    expect(sent.to).toEqual(["customer@example.invalid"]);
  });

  it("deduplicates the same Nexora event and never sends it twice", async () => {
    const { worker, env } = createRuntime();
    const outbound = vi.fn(async () => new Response(JSON.stringify({ id: "cloudmailin-test-2" }), { status: 202 }));
    vi.stubGlobal("fetch", outbound);
    const body = notification();
    const first = await worker.fetch(request(body), env, ctx);
    const replay = await worker.fetch(request(body), env, ctx);
    expect(first.status).toBe(202);
    expect(replay.status).toBe(200);
    expect((await replay.json()).duplicate).toBe(true);
    expect(outbound).toHaveBeenCalledTimes(1);
  });


  it("blocks live customer notifications even when an approval claim is supplied", async () => {
    const { worker, env } = createRuntime({ CLOUDMAILIN_OUTBOUND_TEST_MODE: "false" });
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const response = await worker.fetch(request(notification({ humanApproved: true, approvalId: "synthetic-approval-1" })), env, ctx);
    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe("live_customer_notifications_disabled_by_policy");
    expect(outbound).not.toHaveBeenCalled();
  });

  it("keeps the notification route disabled unless explicitly enabled", async () => {
    const { worker, env } = createRuntime({ EMAIL_NOTIFICATIONS_ENABLED: "false" });
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const response = await worker.fetch(request(notification()), env, ctx);
    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe("notifications_disabled");
    expect(outbound).not.toHaveBeenCalled();
  });
});
