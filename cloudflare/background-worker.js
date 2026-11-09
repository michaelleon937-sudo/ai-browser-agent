import { WorkflowEntrypoint } from "cloudflare:workers";
import { handleNightWorkerAI, verifyGithubActionsOidc } from "./night-worker-ai.js";

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

async function githubOidcAuth(request) {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token || !(await verifyGithubActionsOidc(token))) return json({ error: "github_oidc_rejected" }, 401);
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
        if (!["phone-sleep-proof", "preview-validation", "night-worker"].includes(kind)) {
          return { taskId, status: "rejected", reason: "task_kind_not_allowlisted", productionWrites: false };
        }
        return { taskId, kind, environment, acceptedAt: new Date().toISOString() };
      },
    );

    if (accepted.status === "rejected") return accepted;

    if (kind === "night-worker") {
      const maxCheckpoints = Math.min(20, Math.max(1, Number(payload.maxCheckpoints) || 20));
      await step.do(
        "night-worker-durable-start",
        { retries: { limit: 2, delay: "2 seconds", backoff: "exponential" }, timeout: "30 seconds" },
        async () => ({ taskId, status: "running", environment: "preview", productionWrites: false, startedAt: new Date().toISOString() }),
      );
      let lastCheckpoint = null;
      for (let sequence = 1; sequence <= maxCheckpoints; sequence += 1) {
        const event = await step.waitForEvent(`night-worker-checkpoint-${sequence}`, {
          type: "checkpoint",
          timeout: "7 days",
        });
        const checkpoint = event?.payload || {};
        lastCheckpoint = await step.do(
          `persist-night-worker-checkpoint-${sequence}`,
          { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "30 seconds" },
          async () => {
            const stages = ["started", "planned", "researched", "patched", "verified", "complete", "blocked", "failed"];
            const statuses = ["running", "complete", "blocked", "failed"];
            if (checkpoint.taskId !== taskId || !Number.isInteger(checkpoint.sequence)
              || checkpoint.sequence < 1 || checkpoint.sequence > 20
              || !stages.includes(checkpoint.stage) || !statuses.includes(checkpoint.status)) {
              throw new Error("invalid_night_worker_checkpoint");
            }
            return {
              taskId, sequence, clientSequence: checkpoint.sequence, stage: checkpoint.stage, status: checkpoint.status,
              summary: String(checkpoint.summary || "").slice(0, 500),
              timestamp: checkpoint.timestamp || new Date().toISOString(),
              productionWrites: false,
            };
          },
        );
        if (["complete", "blocked", "failed"].includes(lastCheckpoint.status)) {
          return { taskId, status: lastCheckpoint.status, checkpoints: sequence, lastCheckpoint, productionWrites: false };
        }
      }
      return { taskId, status: "checkpoint_limit_reached", checkpoints: maxCheckpoints, lastCheckpoint, productionWrites: false };
    }

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

    return step.do(
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
        aiConfigured: Boolean(env.AI && typeof env.AI.run === "function"),
        aiModel: env.AI_MODEL || null,
        productionWrites: false,
      });
    }

    if (request.method === "POST" && url.pathname.startsWith("/v1/agent/")) {
      return handleNightWorkerAI(request, env);
    }

    if (request.method === "POST" && url.pathname === "/v1/tasks") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
      const { taskId, kind } = body || {};
      const denied = kind === "night-worker" ? await githubOidcAuth(request) : await auth(request, env);
      if (denied) return denied;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(taskId || "")) return json({ error: "invalid_task_id" }, 400);
      if (!["phone-sleep-proof", "preview-validation", "night-worker"].includes(kind)) return json({ error: "task_kind_not_allowlisted" }, 400);
      if ((body.environment || "preview") !== "preview") return json({ error: "production_locked" }, 403);
      const maxCheckpoints = Math.min(20, Math.max(1, Number(body.maxCheckpoints) || 20));
      let instance;
      let created = true;
      try {
        instance = await env.TASK_WORKFLOW.create({
          id: taskId,
          params: { taskId, kind, environment: "preview", maxCheckpoints },
        });
      } catch {
        try { instance = await env.TASK_WORKFLOW.get(taskId); created = false; }
        catch { return json({ error: "workflow_create_failed" }, 503); }
      }
      return json({ taskId, instanceId: instance.id, created, status: await instance.status() }, created ? 202 : 200);
    }

    const match = url.pathname.match(/^\/v1\/tasks\/([A-Za-z0-9_-]{1,64})(?:\/(approval|checkpoint))?$/);
    if (!match) return json({ error: "not_found" }, 404);
    const denied = match[2] === "approval"
      ? await auth(request, env)
      : await githubOidcAuth(request);
    if (denied) return denied;
    let instance;
    try { instance = await env.TASK_WORKFLOW.get(match[1]); }
    catch { return json({ error: "task_not_found" }, 404); }
    if (request.method === "GET" && !match[2]) {
      return json({ taskId: match[1], status: await instance.status(), productionWrites: false });
    }
    if (request.method === "POST" && match[2] === "checkpoint") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
      if (!Number.isInteger(body?.sequence) || body.sequence < 1 || body.sequence > 20
        || typeof body.stage !== "string" || typeof body.status !== "string"
        || typeof body.summary !== "string" || body.summary.length > 500) {
        return json({ error: "invalid_checkpoint_payload" }, 400);
      }
      await instance.sendEvent({
        type: "checkpoint",
        payload: { taskId: match[1], sequence: body.sequence, stage: body.stage, status: body.status, summary: body.summary, timestamp: new Date().toISOString() },
      });
      return json({ taskId: match[1], checkpointAccepted: true, sequence: body.sequence });
    }
    if (request.method === "POST" && match[2] === "approval") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "invalid_json" }, 400); }
      if (typeof body?.approved !== "boolean") return json({ error: "approved_boolean_required" }, 400);
      await instance.sendEvent({
        type: "approval",
        payload: { approved: body.approved, approvedAt: new Date().toISOString() },
      });
      return json({ taskId: match[1], approvalRecorded: true, approved: body.approved });
    }
    return json({ error: "method_not_allowed" }, 405);
  },
};
