# Control Layer (Phase 5B)

Authorized operators (for example Grok) call a versioned HTTP API. This package owns
authentication, deny-by-default policy, audit, idempotency, and repair orchestration.

Grok is **not** connected yet. This layer must work on its own first.

## Base path

`/api/control/v1`

- `GET  /api/control/v1/health`
- `POST /api/control/v1/tools/:toolName`

## Authentication

`Authorization: Bearer $CONTROL_TOKEN`

Dashboard basic auth (`DASHBOARD_USER` / `DASHBOARD_PASS`) is never accepted.

If `CONTROL_TOKEN` is missing in production (`NODE_ENV=production`), the Control API is fail-closed (health returns 503).

## Example

```bash
curl -sS -X POST "$ORIGIN/api/control/v1/tools/agent.create_task" \
  -H "Authorization: Bearer $CONTROL_TOKEN" \
  -H "Idempotency-Key: create-task-001" \
  -H "Content-Type: application/json" \
  -d '{"name":"Probe","goal":"Open example.com and report the title","timezone":"Africa/Dar_es_Salaam"}'
```

## Registered tools

Agent: `create_task`, `run_task`, `get_task`, `get_run`, `get_logs`, `retry_run`, `health_check`  
Browser: `open`, `inspect`, `screenshot`, `extract`, `click`, `type` (click/type require `approved=true`)  
GitHub: `inspect_repository`, `read_file`, `run_tests`, `get_test_results`, `modify_file` (`repair/*` + approval only)  
Render: `get_status`, `get_logs`, `get_deployments`, `deploy` (staging + approval only)  
Repair: `start`, `get`, `advance`

## Intentionally NOT implemented

- outreach / email / DM send
- application or tender submission
- payment / purchase / spend
- production data or volume delete
- approval bypass
- direct `master` writes
- production Render deploy

Phase 4 sample/proposal behavior and Phase 5A draft-only outreach are unchanged.

## Production autoDeploy conflict (follow-up)

`deploy/render.yaml` currently has `autoDeploy: true`. That is a production-safety conflict
with the repair loop. This phase **does not** change that infrastructure flag.
The Control Layer itself blocks `render.deploy` to production. A later infra change should
disable production autoDeploy and add a dedicated staging service.

## Required environment variables

| Variable | Required for |
|---|---|
| `CONTROL_TOKEN` | All Control API calls (required in production) |
| `GITHUB_TOKEN` | GitHub tools |
| `GITHUB_OWNER` / `GITHUB_REPO` | Defaults to `michaelleon937-sudo/ai-browser-agent` |
| `RENDER_API_KEY` | Render tools |
| `RENDER_STAGING_SERVICE_ID` | Staging deploy / status |
| `RENDER_PRODUCTION_SERVICE_ID` | Read-only production status (deploy still blocked) |
| `MAX_REPAIR_ATTEMPTS` | Default `3` |
| `CONTROL_BROWSER_ALLOWLIST` | Comma-separated hosts for `browser.open` |
