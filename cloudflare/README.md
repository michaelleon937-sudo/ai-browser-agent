# Cloudflare Worker replay protection

This folder maintains the `ReplayGuard` Durable Object source used by the Cloudflare-hosted `ai-browser-agent` Worker. The deployed Worker is dashboard-managed; this repository does not yet contain its complete Worker entrypoint. Do not deploy this class alone as a replacement for the full agent Worker.

## Integration

Derive the Durable Object name from both tenant and token ID:

```js
const namespace = env.REPLAY_GUARD || ctx?.exports?.ReplayGuard;
if (!namespace) throw new ControlError(503, 'replay_guard_unavailable', 'Replay protection is not configured');
const id = namespace.idFromName(`${claims.tenantId}:${claims.jti}`);
const response = await namespace.get(id).fetch('https://replay-guard/consume', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jti: claims.jti, exp: claims.exp }),
});
if (response.status === 409) throw new ControlError(409, 'tenant_token_replayed', 'Tenant token has already been used');
if (!response.ok) throw new ControlError(503, 'replay_guard_unavailable', 'Replay protection is unavailable');
```

Call this only after HMAC/signature, issuer, audience, `iat`, and `exp` validation, and before any browser/provider/control side effect. Fail closed if the Durable Object is unavailable.

## Wrangler migration fragment

Merge into the existing Worker configuration; do not replace its main entrypoint:

```toml
[[durable_objects.bindings]]
name = "REPLAY_GUARD"
class_name = "ReplayGuard"

[[migrations]]
tag = "v1-replay-guard"
new_sqlite_classes = ["ReplayGuard"]
```

For a Worker already deployed with this class migration, retain its existing migration history and namespace ID. Do not reapply migration tags or delete the namespace.

## Tests

Run with Node 20+:

```bash
node --test tests/replay-guard.test.js
```

Tests cover first-use acceptance (201), repeat use (409), concurrent same-jti requests (one 201 and one 409), expired claims (400), and alarm cleanup. Local tests do not replace Cloudflare live tests.

## Preview deployment evidence

- Worker: `ai-browser-agent`; `SENTRY_ENVIRONMENT=preview`.
- Active version: `34`.
- Deployment ID: `8d7d013e-6348-48dc-b06b-609fb5dc9d6d`.
- Durable Object: `ReplayGuard`; binding: `REPLAY_GUARD`.
- Live `/healthz` and `/api/control/v1/health`: HTTP 200.
- Invalid control bearer: HTTP 401.
- Durable Object: first use 201, replay 409, concurrent duplicate 201 + 409, expired claim 400.
- No Production deployment or database migration was performed.

The Worker bundle remains dashboard-managed. Before future source-controlled deployments, move the complete Worker entrypoint into this repository and configure CI/deployment from that canonical source. Never deploy only `replay-guard.js` as the full agent Worker.
