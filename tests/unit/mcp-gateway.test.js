import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';

const invokeControlTool = vi.fn(async ({ toolName, args, idempotencyKey, source }) => ({
  ok: true,
  status: 200,
  body: { ok: true, toolName, args, idempotencyKey, source },
}));

const registeredTools = [];

vi.mock('../../control/invoke.js', () => ({
  invokeControlTool,
}));

vi.mock('@modelcontextprotocol/server', () => ({
  McpServer: class {
    constructor() {}

    registerTool(name, definition, handler) {
      registeredTools.push({ name, definition, handler });
    }

    async connect() {}

    async close() {}
  },
}));

vi.mock('@modelcontextprotocol/node', () => ({
  NodeStreamableHTTPServerTransport: class {
    constructor() {}

    async handleRequest(_req, res) {
      res.status(200).json({ ok: true });
    }
  },
}));

vi.mock('@modelcontextprotocol/express', () => ({
  hostHeaderValidation: (allowedHosts) => (req, res, next) => {
    if (allowedHosts.includes(req.hostname) || allowedHosts.includes(req.get('host'))) {
      return next();
    }
    return res.status(403).json({ error: 'invalid host' });
  },
}));

vi.mock('../../config/index.js', () => ({
  config: {
    dashboard: {
      host: '0.0.0.0',
      port: 0,
    },
  },
}));

const EXPECTED_MAPPINGS = [
  ['agent_health_check', 'agent.health_check'],
  ['agent_create_task', 'agent.create_task'],
  ['agent_run_task', 'agent.run_task'],
  ['agent_get_task', 'agent.get_task'],
  ['agent_get_run', 'agent.get_run'],
  ['agent_get_logs', 'agent.get_logs'],
  ['agent_retry_run', 'agent.retry_run'],
  ['browser_open', 'browser.open'],
  ['browser_inspect', 'browser.inspect'],
  ['browser_screenshot', 'browser.screenshot'],
  ['browser_extract', 'browser.extract'],
  ['browser_click', 'browser.click'],
  ['browser_type', 'browser.type'],
  ['github_inspect_repository', 'github.inspect_repository'],
  ['github_read_file', 'github.read_file'],
  ['github_run_tests', 'github.run_tests'],
  ['github_get_test_results', 'github.get_test_results'],
  ['render_get_status', 'render.get_status'],
  ['render_get_logs', 'render.get_logs'],
  ['render_get_deployments', 'render.get_deployments'],
  ['repair_get', 'repair.get'],
  ['repair_start', 'repair.start'],
  ['repair_advance', 'repair.advance'],
  ['outreach_list', 'outreach.list'],
  ['outreach_get', 'outreach.get'],
  ['outreach_list_pending', 'outreach.list_pending'],
  ['outreach_approve', 'outreach.approve'],
  ['outreach_deny', 'outreach.deny'],
  ['outreach_send_approved', 'outreach.send_approved'],
  ['crm_find_company', 'crm.find_company'],
  ['crm_find_contact', 'crm.find_contact'],
  ['crm_find_conversation', 'crm.find_conversation'],
  ['crm_get_conversation', 'crm.get_conversation'],
  ['crm_list_messages', 'crm.list_messages'],
  ['crm_ingest_message', 'crm.ingest_message'],
  ['crm_list_companies', 'crm.list_companies'],
  ['crm_get_company', 'crm.get_company'],
  ['crm_get_client_memory', 'crm.get_client_memory'],
  ['crm_update_client_memory', 'crm.update_client_memory'],
  ['crm_get_next_action', 'crm.get_next_action'],
  ['crm_link_prospect_to_client', 'crm.link_prospect_to_client'],
  ['crm_mark_customer', 'crm.mark_customer'],
  ['crm_draft_reply', 'crm.draft_reply'],
];

const FORBIDDEN = [
  'outreach.send',
  'outreach.send_email',
  'email.send',
  'dm.send',
  'application.submit',
  'tender.submit',
  'payment.charge',
  'purchase.create',
  'money.spend',
  'production.delete',
  'production.database.delete',
  'production.volume.delete',
  'approval.bypass',
  'github.modify_master',
  'render.deploy_production',
  'github.modify_file',
  'render.deploy',
];

describe('Remote MCP Gateway', () => {
  let MCP_TOOL_DEFINITIONS;
  let createMcpServerInstance;
  let mountMcp;

  beforeEach(async () => {
    registeredTools.length = 0;
    invokeControlTool.mockClear();
    process.env.CONTROL_TOKEN = 'mcp-test-token';

    ({ MCP_TOOL_DEFINITIONS, createMcpServerInstance, mountMcp } = await import('../../mcp/server.js'));
  });

  it('exposes exactly 64 MCP definitions', () => {
    expect(MCP_TOOL_DEFINITIONS).toHaveLength(64);
  });

  it('uses the exact MCP to Control mapping', () => {
    const actual = MCP_TOOL_DEFINITIONS.map(({ mcpName, controlName }) => [mcpName, controlName]);
    for (const pair of EXPECTED_MAPPINGS) {
      expect(actual).toContainEqual(pair);
    }
    expect(actual).toHaveLength(MCP_TOOL_DEFINITIONS.length);
  });

  it('has unique MCP and Control names', () => {
    const mcpNames = MCP_TOOL_DEFINITIONS.map((d) => d.mcpName);
    const controlNames = MCP_TOOL_DEFINITIONS.map((d) => d.controlName);

    expect(new Set(mcpNames).size).toBe(mcpNames.length);
    expect(new Set(controlNames).size).toBe(controlNames.length);
  });

  it('uses closed object schemas and never exposes idempotencyKey as business input', () => {
    for (const definition of MCP_TOOL_DEFINITIONS) {
      const schema = definition.inputSchema;
      expect(schema.type).toBe('object');
      expect(schema.additionalProperties).toBe(false);
      expect(schema.properties).not.toHaveProperty('idempotencyKey');
      expect(schema.required || []).not.toContain('idempotencyKey');
    }
  });

  it('requires explicit approval for browser click and type', () => {
    const click = MCP_TOOL_DEFINITIONS.find((d) => d.mcpName === 'browser_click');
    const type = MCP_TOOL_DEFINITIONS.find((d) => d.mcpName === 'browser_type');

    expect(click.inputSchema.required).toContain('approved');
    expect(type.inputSchema.required).toContain('approved');
    expect(click.inputSchema.properties.approved.type).toBe('boolean');
    expect(type.inputSchema.properties.approved.type).toBe('boolean');
  });

  it('does not expose forbidden or direct-write tools', () => {
    const controls = new Set(MCP_TOOL_DEFINITIONS.map((d) => d.controlName));

    for (const forbidden of FORBIDDEN) {
      expect(controls.has(forbidden), forbidden).toBe(false);
    }
  });

  it('registers all 35 definitions with the MCP server', () => {
    createMcpServerInstance();

    expect(registeredTools).toHaveLength(64);
    expect(registeredTools.map((tool) => tool.name))
      .toEqual(MCP_TOOL_DEFINITIONS.map((definition) => definition.mcpName));
  });

  it('routes registered MCP calls through invokeControlTool and preserves Idempotency-Key', async () => {
    createMcpServerInstance();

    const createTask = registeredTools.find((tool) => tool.name === 'agent_create_task');

    await createTask.handler(
      { name: 'MCP task', goal: 'test' },
      { requestInfo: { headers: { 'idempotency-key': 'mcp-idem-1' } } },
    );

    expect(invokeControlTool).toHaveBeenCalledWith({
      toolName: 'agent.create_task',
      args: { name: 'MCP task', goal: 'test' },
      operatorId: 'mcp-operator',
      idempotencyKey: 'mcp-idem-1',
      source: 'mcp',
    });
  });

  it('uses CONTROL_TOKEN bearer authentication for /mcp while leaving /mcp/health unauthenticated', async () => {
    const app = express();
    app.use(express.json());
    mountMcp(app);

    const server = await new Promise((resolve) => {
      const instance = app.listen(0, () => resolve(instance));
    });
    const { port } = server.address();

    try {
      const health = await fetch(`http://127.0.0.1:${port}/mcp/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({
        ok: true,
        service: 'mcp-gateway',
        transport: 'streamable-http',
        path: '/mcp',
        toolCount: 64,
      });

      const unauthorized = await fetch(`http://127.0.0.1:${port}/mcp`, {
        headers: { Host: '127.0.0.1' },
      });
      expect(unauthorized.status).toBe(401);

      const authorized = await fetch(`http://127.0.0.1:${port}/mcp`, {
        headers: {
          Host: '127.0.0.1',
          Authorization: 'Bearer mcp-test-token',
        },
      });
      expect(authorized.status).toBe(200);
    } finally {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it('applies host validation to the protected /mcp endpoint', async () => {
    const app = express();
    app.use(express.json());
    mountMcp(app);

    const server = await new Promise((resolve) => {
      const instance = app.listen(0, () => resolve(instance));
    });
    const { port } = server.address();

    try {
      const response = await new Promise((resolve, reject) => {
        const request = http.request({
          hostname: '127.0.0.1',
          port,
          path: '/mcp',
          method: 'GET',
          headers: {
            Host: 'evil.example',
            Authorization: 'Bearer mcp-test-token',
          },
        }, resolve);
        request.on('error', reject);
        request.end();
      });
      expect(response.statusCode).toBe(403);
    } finally {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
