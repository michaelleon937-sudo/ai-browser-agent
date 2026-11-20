import { describe, expect, it } from "vitest";
import {
  classifyEmailIntent,
  normalizeCloudMailinMessage,
  resolveWorkerEmailPolicy,
} from "../../cloudflare/email-runtime.js";

describe("CloudMailin email runtime", () => {
  it("normalizes CloudMailin JSON normalized payloads", () => {
    const result = normalizeCloudMailinMessage({
      envelope: { from: "customer@example.com", to: "hello@nexora.example" },
      headers: { message_id: "<m-1@example.com>", subject: "Website design", date: "2026-11-17T12:00:00Z" },
      plain: "I need a website for my hotel.",
    });
    expect(result.sender).toBe("customer@example.com");
    expect(result.externalMessageId).toBe("<m-1@example.com>");
    expect(result.body).toContain("hotel");
  });

  it("rejects inbound payloads without a stable message id", () => {
    expect(() => normalizeCloudMailinMessage({
      envelope: { from: "customer@example.com", to: "hello@nexora.example" },
      headers: { subject: "Hello" },
      plain: "Hello",
    })).toThrow("message_id is required");
  });

  it("routes pricing and urgent complaints to a human", () => {
    expect(classifyEmailIntent("How much does a website cost?")).toBe("quote_request");
    expect(classifyEmailIntent("I have an urgent complaint")).toBe("urgent_escalation");
  });

  it("keeps even high-confidence low-risk FAQ replies as drafts requiring human approval", () => {
    const result = resolveWorkerEmailPolicy({
      intent: "service_faq",
      confidence: 0.93,
      requiresHumanReview: false,
      message: "What does your logo design service include?",
      reply: "We can explain the brief and the deliverables.",
    });
    expect(result.requiresHumanReview).toBe(true);
    expect(result.autoSendEligible).toBe(false);
    expect(result.draftEligible).toBe(true);
    expect(result.approvalRequired).toBe(true);
    expect(result.reason).toBe("nexora_draft_only_requires_human_approval");
  });

  it("blocks automatic sends for money and unverified completion claims", () => {
    const result = resolveWorkerEmailPolicy({
      intent: "service_faq",
      confidence: 0.99,
      requiresHumanReview: false,
      message: "Tell me about branding",
      reply: "The package costs TZS 300,000 and is fully delivered.",
    });
    expect(result.requiresHumanReview).toBe(true);
  });
});
