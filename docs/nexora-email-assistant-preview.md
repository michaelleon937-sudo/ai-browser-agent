# Nexora Customer Email Assistant — Preview Runbook

## Architecture

CloudMailin inbound email → Cloudflare AI Browser Agent Worker Preview → isolated ReplayGuard Durable Object (conversation history, idempotency, delivery state) → authenticated Nexora email-assistant Preview API → Gemini.

Outbound replies use the CloudMailin outbound account. Delivery events are accepted through the authenticated Worker event endpoint and recorded against the message/conversation. The Worker keeps the customer-facing send gate separate from the assistant draft.

## Preview endpoints

- Worker Preview: https://feature-cloudflare-customer-email-automation-ai-browser-agent.michaelleon937.workers.dev
- Health: `GET /api/email/v1/health`
- Inbound webhook: `POST /api/inbound/email/cloudmailin`
- Outbound events: `POST /api/outbound/email/cloudmailin/events`
- Nexora assistant: `POST /api/agent/email-assistant`
- CloudMailin test inbound address: `d1a33da79de9e55552f6@cloudmailin.net`

The test address forwards only to the Cloudflare Preview Worker. It is not the live customer address.

## Current verified Preview state — 2026-11-17

- Cloudflare Worker Preview health returns `ok: true`.
- Inbound authentication, outbound configuration, outbound Test Mode, notifications, and Durable Object storage are configured.
- Automatic replies remain disabled.
- The Nexora Gemini bridge is configured and reachable from the Worker Preview; the health probe reports HTTP 200, provider `gemini`, and `modelConfigured: true`.
- `GEMINI_API_KEY` is configured in the Vercel Preview environment. Its value is never read or exposed.
- The CloudMailin Preview inbound address is confirmed to forward to the Worker Preview route above.
- CloudMailin currently has no inbound messages recorded for the Preview test address.
- CloudMailin sending domain `mlcreativedesign.com` has been created but remains unverified. A CloudMailin outbound request was accepted in Test Mode and recorded as `Test`; no email was delivered.
- A Cloudflare zone for `mlcreativedesign.com` has been recreated in pending state on the Free plan. The required CloudMailin CNAME and DKIM TXT records plus recommended root SPF and monitoring-only DMARC TXT records are staged in that zone. No MX, A, AAAA, or website records were changed.
- Cloudflare assigned nameservers `joaquin.ns.cloudflare.com` and `melinda.ns.cloudflare.com`. Verisign .com RDAP returned HTTP 404 for `mlcreativedesign.com` while a known registered control domain returned HTTP 200, so the domain currently has no active .com registration record. The zone cannot become authoritative until the domain is registered and those nameservers are set at its registrar.
- CloudMailin `verifyDomain` confirms that its required CNAME and DKIM records are still unverified because public DNS delegation is not active.
- The separate Vercel MCP connection can see the team but does not list the Nexora project. The native Vercel connector can access the project and its Preview deployments; this does not block the current Preview health check.

A successful health probe proves configuration and bridge reachability only. It does not prove that a real Gemini inference request, inbound message processing, or outbound provider delivery has completed end to end.

## Required bindings and variables

Cloudflare Preview secrets (names only; values remain in secret bindings):
- `CLOUDMAILIN_WEBHOOK_AUTH_SECRET`
- `CLOUDMAILIN_OUTBOUND_API_TOKEN`
- `CLOUDMAILIN_OUTBOUND_EVENTS_AUTH_SECRET`
- `CLOUDMAILIN_OUTBOUND_ACCOUNT_ID`
- `CLOUDMAILIN_OUTBOUND_FROM`
- `NEXORA_EMAIL_AGENT_SHARED_SECRET`
- `NEXORA_VERCEL_PROTECTION_BYPASS`
- CloudMailin SMTP/account settings.

Nexora Vercel Preview:
- `NEXORA_EMAIL_AGENT_SHARED_SECRET` is configured for the Cloudflare-to-Nexora machine connection.
- `GEMINI_API_KEY` is configured in Preview. Do not copy it to Production or expose its value.

## Safety gates

Current Preview values:
- `EMAIL_AUTOREPLY_ENABLED=false`
- `CLOUDMAILIN_OUTBOUND_TEST_MODE=true`
- `EMAIL_NOTIFICATIONS_ENABLED=true`

These gates prevent customer-facing auto-replies and prevent outbound test messages from being delivered. The Vercel Preview protection remains enabled for human access; Cloudflare uses a separate machine-only bypass token plus the Bearer shared secret.

Quotes, proposals, invoices, payments, project status, delivery claims, revisions, complaints and urgent requests require human review. The assistant must not invent prices, deadlines, payment status, project progress, completion or delivery links.

## Verified code and deployment checks

- The email Worker Preview deployment is deployed on the isolated branch `feature/cloudflare-customer-email-automation`.
- The latest email-specific Worker tests previously passed: 16 tests across inbound, outbound, idempotency and Nexora bridge suites.
- The Worker health endpoint returns HTTP 200 and confirms the Gemini bridge is reachable.
- The Nexora Preview API is protected by Vercel Preview authentication; the Worker health probe confirms its machine-to-machine health check succeeds.
- A synthetic inbound payload and replay-deduplication check were previously exercised in the isolated test path; CloudMailin's current message list is empty, so no provider-delivered inbound message is claimed here.
- CloudMailin outbound Test Mode was previously accepted as a validation request; no email was delivered.

## Go-live blockers and order

1. Run an authenticated synthetic POST through the actual Worker → Nexora assistant route and verify a real Gemini response, bilingual output, policy handling and conversation persistence.
2. Register `mlcreativedesign.com` or provide another active registered sender domain. The Cloudflare zone and CloudMailin records are already staged; set the registrar nameservers to `joaquin.ns.cloudflare.com` and `melinda.ns.cloudflare.com`.
3. After public delegation is active, run CloudMailin `verifyDomain` until the required CNAME and DKIM records pass. Root SPF and monitoring-only DMARC records are already staged.
4. Run an isolated inbound message through the CloudMailin Preview address, verify the Worker response, replay deduplication, draft/escalation, and notification state.
5. Run CloudMailin outbound Test Mode and authenticated delivery-event/idempotency checks after a sender domain is verified.
6. Obtain separate explicit go-live approval before deploying the Worker to Production or changing live CloudMailin routing.
7. Enable automatic replies only after bilingual, service-routing, pricing-safety, escalation, and delivery tests pass.

## Live routing status

The existing customer inbound address is intentionally unchanged and still points to the legacy Render URL. Render has not been reintroduced into the new Preview architecture. Do not switch live traffic to the Preview Worker. The separate CloudMailin Preview test address is available for safe validation.

DNS records were written only into the pending Cloudflare zone. No public DNS delegation, MX change, Production Worker deployment, Production database write, real customer email, or paid service action occurred during this Preview work.
