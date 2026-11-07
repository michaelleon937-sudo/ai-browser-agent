import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync(new URL("../../wrangler.background.jsonc", import.meta.url), "utf8"));
const worker = readFileSync(new URL("../../cloudflare/background-worker.js", import.meta.url), "utf8");

describe("Nexora background runner Preview contract", () => {
  it("uses a dedicated Preview Worker and Workflow binding", () => {
    expect(config.name).toBe("nexora-background-runner-preview");
    expect(config.main).toBe("cloudflare/background-worker.js");
    expect(config.workflows).toContainEqual({
      name: "nexora-background-task-preview",
      binding: "TASK_WORKFLOW",
      class_name: "NexoraBackgroundWorkflow",
    });
    expect(JSON.stringify(config)).not.toContain("ai-browser-agent");
  });

  it("requires authenticated task operations and exposes only health publicly", () => {
    expect(worker).toContain("BACKGROUND_AGENT_TOKEN");
    expect(worker).toContain('url.pathname === "/healthz"');
    expect(worker).toContain("const denied = await auth(request, env)");
    expect(worker).toContain("production_locked");
  });

  it("normalizes Cloudflare Workflow event payload shapes", () => {
    expect(worker).toContain("event?.payload ?? event?.params ?? event");
    expect(worker).toContain('typeof rawPayload === "string" ? JSON.parse(rawPayload) : rawPayload');
  });

  it("persists a sleep checkpoint and waits for an explicit approval event", () => {
    expect(worker).toContain('step.sleep("phone-offline-window", "90 seconds")');
    expect(worker).toContain('type: "approval"');
    expect(worker).toContain('timeout: "24 hours"');
    expect(worker).toContain("step.do(");
  });

  it("rejects unapproved task kinds and production execution", () => {
    expect(worker).toContain('"phone-sleep-proof", "preview-validation"');
    expect(worker).toContain('environment !== "preview"');
    expect(worker).toContain("productionWrites: false");
  });
});
