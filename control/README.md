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

## Remote MCP gateway (Grok)

Grok connects to the AI Browser Agent through a **Streamable HTTP** MCP endpoint that fronts the Control Layer.

### Endpoint

| Item | Value |
|------|--------|
| Path | `/mcp` |
| Health | `GET /mcp/health` (no auth) |
| Production URL | `https://ai-browser-agent-8qig.onrender.com/mcp` |
| Transport | Streamable HTTP (`@modelcontextprotocol/server` + `@modelcontextprotocol/node`) |

### Authentication

- Same secret as Control API: **`CONTROL_TOKEN`**
- Send `Authorization: Bearer <CONTROL_TOKEN>` on every MCP request
- Missing or invalid token → **401**
- Token is never returned in MCP responses or logs

### Security model

```
Grok → Remote MCP (/mcp) → Control invokeControlTool → policy / audit / idempotency → tools
```

- MCP **does not** call browser/agent modules directly.
- Forbidden tools are not registered on MCP or Control.
- Mutating tools still require **`Idempotency-Key`** (HTTP header on the MCP request).
- Approval-gated tools still require Control policy (`approved=true` where applicable).
- Host header validation includes `ai-browser-agent-8qig.onrender.com` and localhost; extend via `MCP_ALLOWED_HOSTS` (comma-separated).

### Exposed MCP tools (underscore names)

agent_health_check, agent_create_task, agent_run_task, agent_get_task, agent_get_run, agent_get_logs, agent_retry_run,
browser_open, browser_inspect, browser_screenshot, browser_extract, browser_click, browser_type,
github_inspect_repository, github_read_file, github_run_tests, github_get_test_results,
render_get_status, render_get_logs, render_get_deployments,
repair_get, repair_start, repair_advance

Not exposed via MCP: `github.modify_file`, `render.deploy`, and all forbidden tools (email/DM/send, payments, tender submit, approval bypass, etc.).

### Grok connection procedure

1. Deploy a build that includes the MCP gateway.
2. Ensure `CONTROL_TOKEN` is set on the Render service.
3. In Grok / xAI MCP client config, add a remote server:
   - URL: `https://ai-browser-agent-8qig.onrender.com/mcp`
   - Header: `Authorization: Bearer <CONTROL_TOKEN>`
4. Confirm `tools/list` returns the catalog above.
5. Call `agent_health_check` as a smoke test.

### Local testing

```bash
export CONTROL_TOKEN=dev-token
export NODE_ENV=development
export AI_PROVIDER=stub
export SEARCH_PROVIDER=none
npm test          # includes tests/unit/mcp-gateway.test.js
```

### Environment variables

| Variable | Purpose |
|----------|---------|
| `CONTROL_TOKEN` | Required for MCP and Control API |
| `MCP_ALLOWED_HOSTS` | Optional extra Host header allowlist (comma-separated) |

Do not commit real tokens.
