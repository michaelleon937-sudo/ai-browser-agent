# Cloudflare customer email automation

## Runtime

The Cloudflare Worker email extension is installed around the existing `ai-browser-agent` Worker and its existing `ReplayGuard` Durable Object namespace. The legacy CloudMailin path `/api/inbound/email/resend.json` remains accepted as a compatibility route; the new canonical path is `/api/inbound/email/cloudmailin`.

## Request flow

1. CloudMailin posts normalized JSON with an Authorization bearer header.
2. The Worker verifies the webhook secret, validates the message, and uses the existing Durable Object namespace for idempotent ingestion and a 25-message per-sender history.
3. The Worker calls Nexora's authenticated `/api/agent/email-assistant` endpoint. Nexora uses the configured Gemini model and its canonical service catalogue.
4. Deterministic policy rules block automatic replies for pricing, quotations, payments, contracts, deadlines, project status, revisions, complaints, urgent requests, low confidence, or unsupported claims.
5. Safe FAQ/intake replies remain drafts unless `EMAIL_AUTOREPLY_ENABLED=true`. Preview keeps auto-reply and notification delivery disabled; outbound test mode defaults to true, and no outbound message is sent unless all delivery credentials and explicit enablement are configured.
6. CloudMailin delivery events are authenticated and deduplicated at `/api/outbound/email/cloudmailin/events`.

## Required Worker environment

- Protected control-plane secret bindings: `CONTROL_TOKEN` and `NEXORA_AGENT_SHARED_SECRET`. Both are required for the Worker control API; the latter verifies signed tenant tokens and the former authenticates the control bearer. Keep both as Cloudflare Worker secrets, not plain-text `[vars]` and never commit them. The current Preview health route reports both missing and `controlConfigured=false`; protected control actions therefore fail closed with `503 control_not_configured`.
- Required secret bindings for live outbound delivery (not configured in the current Preview Worker): `CLOUDMAILIN_WEBHOOK_AUTH_SECRET`, `CLOUDMAILIN_OUTBOUND_ACCOUNT_ID`, `CLOUDMAILIN_OUTBOUND_API_TOKEN`, `CLOUDMAILIN_OUTBOUND_EVENTS_AUTH_SECRET`, `CLOUDMAILIN_OUTBOUND_FROM`, `NEXORA_AGENT_SHARED_SECRET`. `CLOUDMAILIN_OUTBOUND_TEST_MODE` is a safety flag and remains true in Preview.
- Plain-text binding: `NEXORA_EMAIL_ASSISTANT_URL` (the Nexora Preview endpoint URL).
- Optional plain-text binding: `EMAIL_AUTOREPLY_ENABLED`. Defaults to false; enable only after sender-domain verification and explicit owner approval.
- Optional monitoring secret: `SENTRY_DSN`. The current Preview reports Sentry as not configured.
- Existing `REPLAY_GUARD` Durable Object namespace is required.

## Preview verification

The Cloudflare branch Preview for commit `bed5b4f` deployed successfully. GET `/healthz` and GET `/api/control/v1/health` returned HTTP 200. The runtime reported browser rendering and AI bindings configured, but the control token and tenant signing secret were absent, so the control API remained disabled. These health checks do not prove an end-to-end research task, customer email delivery or live browser interaction.

## Safety and activation

- This change does not deploy the Worker version to live customer traffic, enable automatic customer replies, or send real customer email.
- CloudMailin Test mode validates outbound requests without delivering them.
- Customer-specific project status, prices, payment state, deadlines, contracts, revisions and complaints require human review.
- The service catalogue is treated as specifications; preview-only/not-started/blocked services are never described as operational.
- No Production deployment, secret change, customer communication, invoice or payment was performed during this verification.
