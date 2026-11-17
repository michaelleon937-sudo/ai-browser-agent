# Nexora Customer Email Assistant — Preview Runbook

## Architecture

CloudMailin inbound email → Cloudflare AI Browser Agent Worker → isolated ReplayGuard Durable Object (conversation history, idempotency, delivery state) → authenticated Nexora email-assistant API → Gemini.

Outbound replies use the CloudMailin outbound account. Delivery events are accepted through the authenticated Worker event endpoint and recorded against the message/conversation. The Worker keeps the customer-facing send gate separate from the assistant draft.

## Preview endpoints

- Worker Preview: https://feature-cloudflare-customer-email-automation-ai-browser-agent.michaelleon937.workers.dev
- Health: `GET /api/email/v1/health`
- Inbound webhook: `POST /api/inbound/email/cloudmailin`
- Outbound events: `POST /api/outbound/email/cloudmailin/events`
- Nexora assistant: `POST /api/agent/email-assistant`
- CloudMailin test inbound address: `d1a33da79de9e55552f6@cloudmailin.net`

The test address forwards only to the Cloudflare Preview Worker. It is not the live customer address.

## Required bindings and variables

Cloudflare Preview secrets (names only; values are stored as secret bindings):
- `CLOUDMAILIN_WEBHOOK_AUTH_SECRET`
- `CLOUDMAILIN_OUTBOUND_API_TOKEN`
- `CLOUDMAILIN_OUTBOUND_EVENTS_AUTH_SECRET`
- `NEXORA_EMAIL_AGENT_SHARED_SECRET`
- `NEXORA_VERCEL_PROTECTION_BYPASS`
- CloudMailin SMTP/account settings.

Nexora Vercel Preview:
- `NEXORA_EMAIL_AGENT_SHARED_SECRET` is configured for the Cloudflare-to-Nexora machine connection.
- `GEMINI_API_KEY` is not configured in Preview yet. The assistant health route therefore reports `modelConfigured: false`. Do not copy the Production key into Preview without explicit approval; use a dedicated Preview key.

## Safety gates

Current Preview values:
- `EMAIL_AUTOREPLY_ENABLED=false`
- `CLOUDMAILIN_OUTBOUND_TEST_MODE=true`

These gates prevent customer-facing auto-replies and prevent outbound test messages from being delivered. The Vercel Preview protection remains enabled for human access; Cloudflare uses a separate machine-only bypass token plus the Bearer shared secret.

## Verified Preview checks

- Cloudflare Workers Build runs the dedicated email unit suites before deployment.
- Latest completed email test gate: 16 tests passed across inbound, outbound, idempotency and Nexora bridge suites.
- Worker health returned HTTP 200; the isolated Durable Object store, inbound auth and outbound test configuration were ready.
- Nexora Preview authenticated health returned HTTP 200 and exposed the live service/package context (50 services, 5 packages). Gemini inference remains blocked only by the missing Preview `GEMINI_API_KEY`.
- A synthetic inbound payload was accepted once and a replay of the same message ID was deduplicated.
- CloudMailin outbound Test mode accepted a synthetic validation request and recorded it as `Test`; no email was delivered.

## Go-live blockers and order

1. Add a dedicated `GEMINI_API_KEY` to the Nexora Vercel Preview environment and redeploy Preview.
2. Configure and verify a sending domain in CloudMailin; publish the provider's DNS records at the domain's DNS host.
3. Re-run authenticated Gemini inference, bilingual draft checks, customer-data authorization checks and outbound Test mode checks.
4. Obtain explicit go-live approval, deploy the Worker to Production with auto-reply still disabled, then move the existing CloudMailin inbound address from Render to the Production Worker.
5. Enable auto-replies only after live sender-domain verification, human escalation checks and end-to-end delivery tracking pass.

## Live routing status

The existing customer inbound address is intentionally unchanged and still points to the legacy Render URL. Render has not been reintroduced into the new Preview architecture. Do not switch live traffic to the Preview Worker. The separate CloudMailin Preview test address is available for safe validation.

No Production Worker deployment, Production database write, real customer email or paid service action was performed during this Preview work.
