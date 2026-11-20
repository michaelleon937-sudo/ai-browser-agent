# Nexora AI Browser Agent: Research, Draft and Approval Workflow

## Default operating mode

`NEXORA_AGENT_MODE=draft` is the default. `research` is read-only. Invalid mode values fail closed to `research`.

- **Research:** public HTTP(S) web search, navigation, snapshots, screenshots, text extraction and analysis. Private IPs, localhost, login/account/admin, checkout/payment and credential-bearing URLs are blocked.
- **Draft:** all research capabilities plus internal prospect, opportunity, sample, proposal, website concept and outreach-draft creation. Drafts are not sent, published or delivered.
- **Human approval:** browser interactions pause in the existing approval queue. The approval record includes the current page URL/title and visible target label. Missing/stale targets, password/payment fields, arbitrary page JavaScript, Enter/Return form submission and obvious send/publish/pay/delete controls are blocked.
- **Per-action binding:** each approval is bound to the run ID, tool and canonical SHA-256 hash of the exact action payload; it expires after 30 minutes. Changed, missing, expired or mismatched payloads are denied. This is a consistency hash, not a signed approval token.

## Customer communications and money movement

- Inbound email replies are always drafts and always require human review. `EMAIL_AUTOREPLY_ENABLED` cannot bypass this policy.
- Live customer notifications are hard-disabled by policy in this phase, even if an approval claim is supplied. Quote/proposal/revision notifications require human approval even in provider test mode. A future live-send release needs a separately reviewed approval integration.
- Cloudflare Preview keeps `EMAIL_AUTOREPLY_ENABLED=false`, `EMAIL_NOTIFICATIONS_ENABLED=false` and `CLOUDMAILIN_OUTBOUND_TEST_MODE=true`.
- Agent approval email/webhook notifications are disabled unless `NEXORA_APPROVAL_NOTIFICATIONS_ENABLED=true`; approval records remain in the dashboard.
- No payment, invoice sending, customer messaging, public publishing, Production database writes or Production deployment is enabled by this workflow.

## Control-plane credentials and Preview status

- Protected Worker control routes require the Cloudflare Worker secrets `CONTROL_TOKEN` and `NEXORA_AGENT_SHARED_SECRET`. Store them as Worker secrets, never in `wrangler.toml`, source code or committed environment files.
- The control API verifies the bearer token, verifies a signed tenant token, checks an optional operator ID against the tenant-token subject, and consumes the tenant-token JTI through `REPLAY_GUARD` to prevent replay.
- The current branch Preview reports `browserRenderingConfigured=true` and `aiConfigured=true`, but `controlTokenConfigured=false`, `tenantSigningSecretConfigured=false` and `controlConfigured=false`. Therefore protected control actions fail closed with `503 control_not_configured` until the two secrets are configured.
- The Preview GET `/healthz` and `/api/control/v1/health` both returned HTTP 200. This verifies the Worker health route and configuration flags, not an end-to-end research or browser task. Sentry is not configured in this Preview.
- Signed tenant authentication at the control API is separate from the per-action human approval record. Both controls must pass before any future controlled action.

## Configuration

```env
NEXORA_AGENT_MODE=draft
NEXORA_APPROVAL_NOTIFICATIONS_ENABLED=false
EMAIL_AUTOREPLY_ENABLED=false
EMAIL_NOTIFICATIONS_ENABLED=false
CLOUDMAILIN_OUTBOUND_TEST_MODE=true
```

Changing the mode, configuring control-plane secrets or enabling notifications is an operator configuration change and must be reviewed separately. This code change alone does not change deployed secrets or enable customer-facing side effects.

## Verification

- A2 Certification passed on commit `bed5b4f738370d3abf97a137ef8095096f35d310`: inbound unit 5/5, full unit 666/666, integration 49/49 and full regression 715/715 across 81 test files.
- Four approval-payload tests cover canonical hashing, exact payload matching, run/tool mismatch, payload mutation and expiry.
- Cloudflare branch Preview build and deployment succeeded; the two read-only health routes returned HTTP 200.
- Live research/draft task acceptance, configured control secrets, Sentry, and a separate authenticated Vercel Preview health check remain outstanding. No Production deployment, customer communication, invoice or payment was performed.
