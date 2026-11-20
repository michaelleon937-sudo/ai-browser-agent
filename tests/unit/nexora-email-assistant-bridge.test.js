import { afterEach, describe, expect, it, vi } from "vitest";
import { callNexoraAssistant } from "../../cloudflare/email-runtime.js";

afterEach(() => vi.unstubAllGlobals());

describe("Nexora Gemini email-assistant bridge", () => {
  it("uses the dedicated Preview shared secret and Vercel protection bypass", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, reply: "Please share your project brief.", intent: "lead_intake" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await callNexoraAssistant(
      { externalMessageId: "msg-1", conversationId: "conv-1", sender: "client@example.com", senderName: "Client", subject: "Website", body: "I need a website" },
      [{ id: "older", direction: "inbound", subject: "Hello", body: "Previous context", receivedAt: "2026-11-17T10:00:00.000Z" }],
      { NEXORA_EMAIL_ASSISTANT_URL: "https://nexora-preview.example/api/agent/email-assistant", NEXORA_EMAIL_AGENT_SHARED_SECRET: "preview-shared-secret", NEXORA_AGENT_SHARED_SECRET: "legacy-secret", NEXORA_VERCEL_PROTECTION_BYPASS: "preview-bypass-token" },
    );
    expect(result.reply).toBe("Please share your project brief.");
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://nexora-preview.example/api/agent/email-assistant");
    expect(options.headers.authorization).toBe("Bearer preview-shared-secret");
    expect(options.headers["x-vercel-protection-bypass"]).toBe("preview-bypass-token");
    expect(JSON.parse(options.body).messageId).toBe("msg-1");
  });

  it("supports the existing shared-secret binding when the Preview alias is absent", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, reply: "Thanks for the details." }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await callNexoraAssistant(
      { externalMessageId: "msg-2", conversationId: "conv-2", sender: "client@example.com", subject: "Branding", body: "I need branding" },
      [],
      { NEXORA_EMAIL_ASSISTANT_URL: "https://nexora-preview.example/api/agent/email-assistant", NEXORA_AGENT_SHARED_SECRET: "legacy-secret" },
    );
    const options = fetchMock.mock.calls[0][1];
    expect(options.headers.authorization).toBe("Bearer legacy-secret");
    expect(options.headers["x-vercel-protection-bypass"]).toBeUndefined();
  });

  it("fails closed when no shared secret is configured", async () => {
    await expect(callNexoraAssistant(
      { externalMessageId: "msg-3", conversationId: "conv-3", sender: "client@example.com", subject: "Help", body: "Help" },
      [],
      { NEXORA_EMAIL_ASSISTANT_URL: "https://nexora-preview.example/api/agent/email-assistant" },
    )).rejects.toThrow("Nexora Gemini assistant is not configured");
  });
});
