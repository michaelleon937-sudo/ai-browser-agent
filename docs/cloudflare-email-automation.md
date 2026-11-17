# Cloudflare customer email automation

## Runtime

The Cloudflare Worker email extension is installed around the existing `ai-browser-agent` Worker and its existing `ReplayGuard` Durable Object namespace. The legacy CloudMailin path `/api/inbound/email/resend.json` remains accepted as a compatibility route; the new canonical path is `/api/inbound/email/cloudmailin`.

## Request flow

1. CloudMailin posts normalized JSON with an Authorization bearer header.
2. The Worker verifies the webhook secret, validates the message, and uses the existing Durable Object namespace for idempotent ingestion and a 25-message per-sender history.
3. The Worker calls Nexora's authenticated `/api/agent/email-assistant` endpoint. Nexora uses the configured Gemini model and its canonical service catalogue.
4. Deterministic policy rules block automatic replies for pricing, quotations, payments, contracts, deadlines, project status, revisions, complaints, urgent requests, low confidence, or unsupported claims.
5. Safe FAQ/intake replies remain drafts unless `EMAIL_AUTOREPLY_ENABLED=true`. Outbound calls use CloudMailin's test-mode flag by default and retry transient failures up to three times.
6. CloudMailin delivery events are authenticated and deduplicated at `/api/outbound/email/cloudmailin/events`.

## Required Worker environment

- Existing secret bindings: `CLOUDMAILIN_WEBHOOK_AUTH_SECRET`, `CLOUDMAILIN_OUTBOUND_ACCOUNT_ID`, `CLOUDMAILIN_OUTBOUND_API_TOKEN`, `CLOUDMAILIN_OUTBOUND_EVENTS_AUTH_SECRET`, `CLOUDMAILIN_OUTBOUND_FROM`, `CLOUDMAILIN_OUTBOUND_TEST_MODE`, `NEXORA_AGENT_SHARED_SECRET`.
- Plain-text binding: `NEXORA_EMAIL_ASSISTANT_URL` (the Nexora Preview endpoint URL).
- Optional plain-text binding: `EMAIL_AUTOREPLY_ENABLED`. Defaults to false; enable only after sender-domain verification and explicit owner approval.
- Existing `REPLAY_GUARD` Durable Object namespace is required.

## Safety and activation

- This change does not alter CloudMailin inbound routing, deploy the Worker version to live traffic, enable automatic customer replies, or send real customer email.
- CloudMailin Test mode validates outbound requests without delivering them.
- Customer-specific project status, prices, payment state, deadlines, contracts, revisions and complaints require human review.
- The service catalogue is treated as specifications; preview-only/not-started/blocked services are never described as operational.
