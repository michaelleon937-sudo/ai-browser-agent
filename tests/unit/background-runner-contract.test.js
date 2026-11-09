import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { isAllowedGithubOidcClaims } from "../../cloudflare/night-worker-ai.js";

const config = JSON.parse(readFileSync(new URL("../../wrangler.background.jsonc", import.meta.url), "utf8"));
const worker = readFileSync(new URL("../../cloudflare/background-worker.js", import.meta.url), "utf8");
const aiModule = readFileSync(new URL("../../cloudflare/night-worker-ai.js", import.meta.url), "utf8");

const claims = (overrides = {}) => ({
  iss: "https://token.actions.githubusercontent.com",
  aud: "nexora-night-worker",
  repository: "michaelleon937-sudo/nexora-intelligence",
  ref: "refs/heads/feature/nexora-autonomous-night-worker",
  event_name: "push",
  workflow_ref: "michaelleon937-sudo/nexora-intelligence/.github/workflows/ci.yml@refs/heads/feature/nexora-autonomous-night-worker",
  sub: "repo:michaelleon937-sudo/nexora-intelligence:ref:refs/heads/feature/nexora-autonomous-night-worker",
  exp: 2_000_000_000,
  ...overrides,
});

describe("Nexora background runner Preview contract", () => {
  it("uses a dedicated Preview Worker, AI binding, and durable Workflow binding", () => {
    expect(config.name).toBe("nexora-background-runner-preview");
    expect(config.main).toBe("cloudflare/background-worker.js");
    expect(config.ai).toEqual({ binding: "AI" });
    expect(config.workflows).toContainEqual({
      name: "nexora-background-task-preview",
      binding: "TASK_WORKFLOW",
      class_name: "NexoraBackgroundWorkflow",
    });
  });

  it("exposes AI plan/patch only behind GitHub Actions OIDC verification", () => {
    expect(worker).toContain('url.pathname.startsWith("/v1/agent/")');
    expect(worker).toContain("handleNightWorkerAI(request, env)");
    expect(aiModule).toContain("verifyGithubActionsOidc");
    expect(aiModule).toContain("token.actions.githubusercontent.com/.well-known/jwks");
    expect(aiModule).toContain('claims?.repository === REPOSITORY');
    expect(aiModule).toContain('AGENT_REF_PATTERN.test(claims?.ref || "")');
    expect(aiModule).toContain('["push", "workflow_dispatch"].includes(claims?.event_name)');
    expect(aiModule).toContain('claims?.workflow_ref === `${REPOSITORY}/.github/workflows/ci.yml@${claims?.ref}`');
  });

  it("accepts only the authorized Preview workflow identity", () => {
    expect(isAllowedGithubOidcClaims(claims(), 1_900_000_000)).toBe(true);
    expect(isAllowedGithubOidcClaims(claims({ event_name: "workflow_dispatch" }), 1_900_000_000)).toBe(true);
    const resumedRef = "refs/heads/agent/nexora-night-worker-proof-20261109";
    expect(isAllowedGithubOidcClaims(claims({
      ref: resumedRef,
      event_name: "workflow_dispatch",
      workflow_ref: `michaelleon937-sudo/nexora-intelligence/.github/workflows/ci.yml@${resumedRef}`,
      sub: `repo:michaelleon937-sudo/nexora-intelligence:ref:${resumedRef}`,
    }), 1_900_000_000)).toBe(true);
    expect(isAllowedGithubOidcClaims(claims({
      ref: resumedRef,
      event_name: "workflow_dispatch",
      workflow_ref: `michaelleon937-sudo/nexora-intelligence/.github/workflows/untrusted.yml@${resumedRef}`,
      sub: `repo:michaelleon937-sudo/nexora-intelligence:ref:${resumedRef}`,
    }), 1_900_000_000)).toBe(false);
    expect(isAllowedGithubOidcClaims(claims({ ref: "refs/heads/main" }), 1_900_000_000)).toBe(false);
    expect(isAllowedGithubOidcClaims(claims({ repository: "attacker/repo" }), 1_900_000_000)).toBe(false);
    expect(isAllowedGithubOidcClaims(claims({ event_name: "pull_request" }), 1_900_000_000)).toBe(false);
    expect(isAllowedGithubOidcClaims(claims({ aud: "other-audience" }), 1_900_000_000)).toBe(false);
    expect(isAllowedGithubOidcClaims(claims({ exp: 1_899_999_999 }), 1_900_000_000)).toBe(false);
  });

  it("persists Night Worker checkpoints with bounded retries and Preview-only execution", () => {
    expect(worker).toContain('kind === "night-worker"');
    expect(worker).toContain('step.waitForEvent(`night-worker-checkpoint-${sequence}`');
    expect(worker).toContain('persist-night-worker-checkpoint-${sequence}');
    expect(worker).toContain('timeout: "7 days"');
    expect(worker).toContain("Math.min(60, Math.max(1, Number(body.maxCheckpoints) || 60))");
    expect(worker).toContain("checkpoint.sequence > 60");
    expect(worker).toContain("const checkpointEventType = `night-worker-checkpoint-${sequence}`;");
    expect(worker).toContain("type: `night-worker-checkpoint-${body.sequence}`");
    expect(worker).toContain("body.sequence > 60");
    expect(worker).toContain("sequence <= maxCheckpoints");
    expect(worker).toContain('limit: 3');
    expect(worker).toContain('match[2] === "checkpoint"');
    expect(worker).toContain("clientSequence: checkpoint.sequence");
    expect(worker).toContain('await githubOidcAuth(request)');
  });

  it("retains authenticated task operations and fails closed on Production", () => {
    expect(worker).toContain("BACKGROUND_AGENT_TOKEN");
    expect(worker).toContain('url.pathname === "/healthz"');
    expect(worker).toContain("production_locked");
    expect(worker).toContain('environment !== "preview"');
    expect(worker).toContain("productionWrites: false");
  });

  it("keeps the existing sleep checkpoint and approval-gated workflow intact", () => {
    expect(worker).toContain('step.sleep("phone-offline-window", "90 seconds")');
    expect(worker).toContain('type: "approval"');
    expect(worker).toContain('timeout: "24 hours"');
    expect(worker).toContain("step.do(");
  });
});
