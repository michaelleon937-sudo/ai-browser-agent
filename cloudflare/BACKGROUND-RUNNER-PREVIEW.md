# Nexora Background Runner — Preview only

This isolated Worker/Workflow is intentionally separate from the existing `ai-browser-agent` service.

## Safety boundary

- Dedicated Worker: `nexora-background-runner-preview`
- Dedicated Workflow: `nexora-background-task-preview`
- Only `preview-validation` and `phone-sleep-proof` task kinds are accepted.
- All task creation, status, and approval routes require `BACKGROUND_AGENT_TOKEN`.
- Public route is health-only.
- Any non-Preview execution request is rejected.
- This branch does not deploy to, change, or bind the existing Production Worker.
- Neon access in CI is a read-only transaction against the Phase 8 Preview branch.

## API

- `GET /healthz` — public health metadata; does not expose secrets.
- `POST /v1/tasks` — authenticated; JSON: `{"taskId":"unique-id","kind":"phone-sleep-proof","environment":"preview"}`
- `GET /v1/tasks/:taskId` — authenticated status.
- `POST /v1/tasks/:taskId/approval` — authenticated JSON: `{"approved":true}` or `{"approved":false}`.

A phone-sleep proof waits 90 seconds in Cloudflare Workflows, records a durable checkpoint, then waits up to 24 hours for explicit approval. The client is not required to remain connected.

## Deployment

Use only `wrangler.background.jsonc`. Do not use the existing `wrangler.jsonc` for this runner. Bind the Workflow after its resource is registered, and set `BACKGROUND_AGENT_TOKEN` as a Worker secret. Never copy existing production secrets into this Worker.

## CI

The dedicated GitHub Actions workflow runs contract/unit tests and a read-only Neon Preview connectivity check. It does not run migrations or write to the database.
