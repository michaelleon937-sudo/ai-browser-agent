import { WorkflowEntrypoint } from "cloudflare:workers";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const encoder = new TextEncoder();

async function equalSecret(a, b) {
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const x = new Uint8Array(left);
  const y = new Uint8Array(right);
  let mismatch = 0;
  for (let i = 0; i < x.length; i += 1) mismatch |= x[i] ^ y[i];
  return mismatch === 0;
}

async function requireAuth(request, env) {
  const configured = env.BACKGROUND_AGENT_TOKEN;
  if (!configured) return json({ error: "preview_runner_not_configured" }, 503);
  const supplied = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!supplied || !(await equalSecret(supplied, configured))) {
    return json({ error: "unauthorized" }, 401);
  }
  return null;
}

export class NexoraBackgroundWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { taskId, kind, environment } = event.payload || {};

    const accepted = await step.do("validate-preview-task", async () => {
      if (environment !== "preview") throw new Error("production_execution_blocked");
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(taskId || "")) throw new Error("invalid_task_id");
      if (!["phone-sleep-proof", "preview-validation"].includes(kind)) throw new Error("task_kind_not_allowlisted");
      return { taskId, kind, environment: "preview", acceptedAt: new Date().toISOString() };
    });

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

    const result = await step.do(
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
      }),
    );

    return result;
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
        productionWrites: false,
      });
    }

    const authError = await requireAuth(request, env);
    if (authError) return authError;

    if (request.method === "POST" && url.pathname === "/v1/tasks") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
      const taskId = body?.taskId;
      const kind = body?.kind;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(taskId || "")) return json({ error: "invalid_task_id" }, 400);
      if (!["phone-sleep-proof", "preview-validation"].includes(kind)) return json({ error: "task_kind_not_allowlisted" }, 400);
      if ((body?.environment || "preview") !== "preview") return json({ error: "production_locked" }, 403);

      let instance;
      let created = true;
      try {
        instance = await env.TASK_WORKFLOW.create({
          id: taskId,
          params: { taskId, kind, environment: "preview" },
        });
      } catch (error) {
        try {
          instance = await env.TASK_WORKFLOW.get(taskId);
          created = false;
        } catch {
          throw error;
        }
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
      await instance.sendEvent({
        type: "approval",
        payload: { approved: body.approved, approvedAt: new Date().toISOString() },
      });
      return json({ taskId, approvalRecorded: true, approved: body.approved });
    }

    return json({ error: "method_not_allowed" }, 405);
  },
};
