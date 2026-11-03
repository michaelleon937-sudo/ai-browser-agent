# Cloudflare Worker source of truth

This directory contains the complete Worker module recovered from the deployed Cloudflare script, plus the standalone ReplayGuard class used for focused unit tests. `cloudflare/worker.js` is the deployable bundled entrypoint; do not deploy `replay-guard.js` by itself.

## Recovered deployment snapshot

- Worker: `ai-browser-agent`
- Source version: `b1506706-b08b-4df0-9bd9-bf7dfc886879` (version 34)
- Source captured from Cloudflare: 2026-11-03T21:00:46Z
- Latest deployment record at capture: `8d7d013e-6348-48dc-b06b-609fb5dc9d6d`, 100% traffic to version 34
- Version annotation says “Preview”, and `SENTRY_ENVIRONMENT` is `preview`; however, Cloudflare version metadata reports `has_preview: false` and the deployment record assigns 100% of Worker traffic to this version. These labels do **not** prove traffic isolation. Verify routing and production status before any future deployment.
- workers.dev enabled; preview URLs enabled; no custom Worker domains were returned by the account API.

## Runtime routes recovered from the module

- `GET /healthz`
- `GET /api/control/v1/health`
- `/api/control/v1/tools/` (control tool dispatch)
- `/api/ai/v1/chat/completions` (AI-compatible chat endpoint)

The full module is bundled/minified. `node --check cloudflare/worker.js` passed at recovery time.

## Runtime bindings

| Binding | Cloudflare type | Notes |
|---|---|---|
| `AI` | Workers AI | AI binding |
| `AI_MODEL` | Plain text variable | Preserved from dashboard with `keep_vars` |
| `BROWSER` | Browser | Browser Rendering binding (version 2 in live metadata) |
| `BUILD_SHA` | Plain text variable | Preserved from dashboard with `keep_vars` |
| `CONTROL_TOKEN` | Secret text | Existing encrypted secret; value is never stored in Git |
| `NEXORA_AGENT_SHARED_SECRET` | Secret text | Existing encrypted secret; value is never stored in Git |
| `REPLAY_GUARD` | Durable Object namespace | Class `ReplayGuard`; namespace `071ea369563e49fc90fa074281b58e49` |
| `SENTRY_DSN` | Plain text variable | Preserved from dashboard with `keep_vars` |
| `SENTRY_ENVIRONMENT` | Plain text variable | Preserved from dashboard with `keep_vars` |

The Wrangler config declares the AI, Browser and Durable Object bindings; declares the two required secret names for validation; and uses `keep_vars: true` so dashboard-managed variables are not overwritten. Secret values are not committed. Cloudflare documents that secrets are preserved unless explicitly deleted.

## Durable Object export and binding

The recovered version metadata reports `ReplayGuard` as a SQLite-backed Durable Object export and binds it as `REPLAY_GUARD`. `wrangler.jsonc` uses the declarative `exports` configuration (not a second legacy migration), matching the deployed version metadata. Keep the existing namespace and class identity; do not create a new namespace or reapply an old migration tag.

The class consumes `jti` atomically inside a storage transaction, returns `201` for the first use and `409` for a replay, rejects expired/invalid claims with `400`, and schedules cleanup using an alarm. The API caller must validate HMAC/signature, issuer, audience, `iat`, and `exp` before calling the Durable Object. Fail closed if the namespace is unavailable.

## Preview CI behavior

Cloudflare Workers Builds has separate triggers: Preview includes non-`master` branches and runs `npx wrangler@4.156.1 versions upload`; Production includes `master` and runs `npx wrangler deploy`. This feature branch is not `master`, so its configured trigger is Preview. `versions upload` uploads a version; it is not the same command as `wrangler deploy`. Still inspect deployment history after CI to verify that no traffic deployment occurred.

## Validation

```bash
node --check cloudflare/worker.js
npx vitest run tests/replay-guard.test.js
npx wrangler@4.156.1 versions upload
```

Do not run `wrangler deploy`, `wrangler versions deploy`, or change deployment percentages as part of Preview verification. Production changes require a separate explicit approval.
