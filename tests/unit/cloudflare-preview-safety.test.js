import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const previewConfig = readFileSync(new URL("../../wrangler.preview.toml", import.meta.url), "utf8");

describe("Cloudflare Preview email safety configuration", () => {
  it("keeps auto-reply and notification delivery disabled in both preview environments", () => {
    expect((previewConfig.match(/EMAIL_AUTOREPLY_ENABLED = \"false\"/g) || []).length).toBe(2);
    expect((previewConfig.match(/EMAIL_NOTIFICATIONS_ENABLED = \"false\"/g) || []).length).toBe(2);
  });

  it("keeps outbound test mode enabled and the Worker in the Preview environment", () => {
    expect((previewConfig.match(/CLOUDMAILIN_OUTBOUND_TEST_MODE = \"true\"/g) || []).length).toBe(2);
    expect((previewConfig.match(/SENTRY_ENVIRONMENT = \"preview\"/g) || []).length).toBe(2);
  });

  it("does not configure live CloudMailin outbound credentials", () => {
    expect(previewConfig).not.toMatch(/CLOUDMAILIN_OUTBOUND_(ACCOUNT_ID|API_TOKEN|FROM)\s*=/);
  });
});
