import { WorkflowEntrypoint } from "cloudflare:workers";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

async function equalSecret(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const left = new Uint8Array(x);
  const right = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

async function auth(request, env) {
  if (!env.BACKGROUND_AGENT_TOKEN) return json({ error: "preview_runner_not_configured" }, 503);
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token || !(await equalSecret(token, env.BACKGROUND_AGENT_TOKEN))) {
    return json({ error: "unauthorized" }, 401);
  }
  return null;
}

export class NexoraBackgroundWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const rawPayload = event?.payload ?? event?.params ?? event;
    const payload = typeof rawPayload === "string" ? JSON.parse(rawPayload) : rawPayload;
    const { taskId, kind, environment } = payload || {};

    const accepted = await step.do(
      "validate-preview-task",
      { retries: { limit: 1, delay: "1 second" }, timeout: "30 seconds" },
      async () => {
        if (environment !== "preview") {
          return { taskId, status: "rejected", reason: "production_execution_blocked", productionWrites: false };
        }
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(taskId || "")) {
          return { taskId: null, status: "rejected", reason: "invalid_task_id", productionWrites: false };
        }
        if (!["phone-sleep-proof", "preview-validation"].includes(kind)) {
          return { taskId, status: "rejected", reason: "task_kind_not_allowlisted", productionWrites: false };
        }
        return { taskId, kind, environment, acceptedAt: new Date().toISOString() };
      },
    );

    if (accepted.status === "rejected") return accepted;

    const validation = await step.do(
      "verify-preview-runner-readiness",
      { retries: { limit: 1, delay: "1 second" }, timeout: "30 seconds" },
      async () => ({
        tokenConfigured: Boolean(this.env.BACKGROUND_AGENT_TOKEN),
        workflowConfigured: Boolean(this.env.TASK_WORKFLOW),
        environment: "preview",
        productionWrites: false,
      }),
    );
    if (!validation.tokenConfigured || !validation.workflowConfigured) {
      return { taskId, status: "rejected", reason: "preview_runner_not_configured", validation, productionWrites: false };
    }

    if (kind === "phone-sleep-proof") {
      await step.sleep("phone-offline-window", "90 seconds");
      await step.do("offline-window-checkpoint", async () => ({
        taskId,
        phoneConnectionRequired: false,
        checkpointAt: new Date().toISOString(),
        executionRuntime: "cloudflare-workflows",
      }));
    }

    const approval = await step.waitForEvent("human-approval", {
      type: "approval",
      timeout: "24 hours",
    });

    if (approval?.payload?.approved !== true) {
      return { taskId, status: "rejected", productionWrites: false };
    }

    return await step.do(
      "execute-approved-preview-task",
      { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "1 minute" },
      async () => ({
        taskId,
        kind,
        status: "complete",
        approvedAt: approval.payload.approvedAt || null,
        completedAt: new Date().toISOString(),
        productionWrites: false,
        acceptedTask: accepted,
        validation,
      }),
    );
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return json({
        ok: true,
        service: "nexora-background-runner-preview",
        runtime: "cloudflare-workflows",
        environment: "preview",
        tokenConfigured: Boolean(env.BACKGROUND_AGENT_TOKEN),
        workflowConfigured: Boolean(env.TASK_WORKFLOW),
        productionWrites: false,
      });
    }
    const denied = await auth(request, env);
    if (denied) return denied;

    if (request.method === "POST" && url.pathname === "/v1/tasks") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
      const { taskId, kind } = body || {};
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(taskId || "")) return json({ error: "invalid_task_id" }, 400);
      if (!["phone-sleep-proof", "preview-validation"].includes(kind)) return json({ error: "task_kind_not_allowlisted" }, 400);
      if ((body.environment || "preview") !== "preview") return json({ error: "production_locked" }, 403);
      let instance;
      let created = true;
      try {
        instance = await env.TASK_WORKFLOW.create({ id: taskId, params: { taskId, kind, environment: "preview" } });
      } catch (error) {
        try { instance = await env.TASK_WORKFLOW.get(taskId); created = false; }
        catch { throw error; }
      }
      return json({ taskId, instanceId: instance.id, created, status: await instance.status() }, created ? 202 : 200);
    }

    const match = url.pathname.match(/^\/v1\/tasks\/([A-Za-z0-9_-]{1,64})(?:\/(approval))?$/);
    if (!match) return json({ error: "not_found" }, 404);
    const [, taskId, approvalRoute] = match;
    let instance;
    try { instance = await env.TASK_WORKFLOW.get(taskId); }
    catch { return json({ error: "task_not_found" }, 404); }
    if (request.method === "GET" && !approvalRoute) {
      return json({ taskId, status: await instance.status(), productionWrites: false });
    }
    if (request.method === "POST" && approvalRoute === "approval") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
      if (typeof body?.approved !== "boolean") return json({ error: "approved_boolean_required" }, 400);
      await instance.sendEvent({ type: "approval", payload: { approved: body.approved, approvedAt: new Date().toISOString() } });
      return json({ taskId, approvalRecorded: true, approved: body.approved });
    }
    return json({ error: "method_not_allowed" }, 405);
  },
};
