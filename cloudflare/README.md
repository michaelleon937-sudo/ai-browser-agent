# Cloudflare Browser Execution Runtime

This Worker is the Cloudflare execution plane for Nexora's read-only browser tools. It deliberately does not send email, submit web forms, click purchase/booking controls, create CRM records, issue invoices, or perform other external write actions.

## Runtime contract

- `GET /healthz` reports runtime and binding readiness without exposing credentials.
- `POST /api/control/v1/tools/agent.health_check` validates the static control bearer token and a signed Nexora tenant token.
- `POST /api/control/v1/tools/browser.navigate`
- `POST /api/control/v1/tools/browser.extract`
- `POST /api/control/v1/tools/browser.screenshot`

The browser tools accept a JSON object containing a public `http` or `https` `url`. They block local/private IPs, localhost-style domains, non-GET/HEAD browser requests, unsafe URL schemes, embedded credentials and non-standard ports. Browser execution is one session per request with a bounded navigation timeout and bounded text/screenshot output.

## Preview safety

The Cloudflare Workers Builds Preview trigger uses `npx wrangler versions upload`, not `wrangler deploy`, so branch builds create an uploaded version without promoting it to the live Worker. The existing production trigger remains restricted to `master` and is not changed by this repository configuration. Do not merge or promote a version until the owner has approved Production release.

## Required runtime configuration

Set these only through Cloudflare's secret store after owner authorization:

- `CONTROL_TOKEN`: high-entropy bearer token shared with Nexora's `AI_BROWSER_AGENT_CONTROL_TOKEN`.
- `NEXORA_AGENT_SHARED_SECRET`: HMAC secret shared with Nexora's signed tenant-token issuer.

No secret values are committed to Git. Until both values are set, `/healthz` remains available but control routes return `503 control_not_configured`.

## Zero-budget policy

Use ordinary HTTP fetch and static HTML parsing first. Use Browser Rendering only for JavaScript-heavy pages or visual evidence. Cloudflare's Free Browser Rendering allowance is limited (currently documented as 10 browser minutes per day); the runtime serializes work per request and returns a quota/capacity error rather than attempting a paid upgrade. Do not change the Cloudflare plan or enable paid usage without owner approval.

## Node/Render compatibility

The Node service's Dockerfile uses the Playwright base image, which already contains Chromium and its system dependencies. The root package no longer runs `playwright install --with-deps` as a postinstall script; that privileged OS package installation is not appropriate in Cloudflare's build environment.
