// mcp/server.js
// Remote MCP gateway (Streamable HTTP) → Control Layer.
// Grok connects here; all tools run through invokeControlTool (policy/audit/idempotency).

import { McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { hostHeaderValidation } from '@modelcontextprotocol/express';
import { MCP_TOOL_DEFINITIONS } from './tools.js';
import { mcpBearerAuth, isMcpTokenConfigured } from './auth.js';
import { invokeControlTool } from '../control/invoke.js';
import { config } from '../config/index.js';

function buildAllowedHosts() {
  const hosts = new Set([
    'localhost',
    '127.0.0.1',
    '[::1]',
    'ai-browser-agent-8qig.onrender.com',
  ]);
  const extra = (process.env.MCP_ALLOWED_HOSTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const h of extra) hosts.add(h);
  // Dashboard host if it looks like a hostname
  if (config.dashboard?.host && config.dashboard.host !== '0.0.0.0') {
    hosts.add(config.dashboard.host);
  }
  return [...hosts];
}

function createMcpServerInstance() {
  const server = new McpServer(
    {
      name: 'ai-browser-agent',
      version: '1.0.0',
    },
    {
      instructions: [
        'You are connected to the AI Browser Agent via a secure MCP gateway.',
        'You are the reasoning/planning operator brain. The agent is the execution runtime.',
        'All tools pass through the Control Layer (policy, audit, idempotency, approval gates).',
        'Business workflow: TASK → DISCOVERY → PROSPECT QUALIFICATION → OPPORTUNITY ANALYSIS → SAMPLE GENERATION → PROPOSAL GENERATION → OUTREACH DRAFT → HUMAN APPROVAL → REPORT.',
        'Never attempt email/DM send, payments, tender submission, production deletion, or approval bypass — those tools are not registered.',
        'Mutating tools require an Idempotency-Key HTTP header on the MCP request.',
        'Approval-gated tools still require approved=true when Control policy demands it.',
      ].join(' '),
    },
  );

  for (const def of MCP_TOOL_DEFINITIONS) {
    server.registerTool(
      def.mcpName,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.inputSchema,
      },
      async (args, extra) => {
        const headers = extra?.requestInfo?.headers || extra?.headers || {};
        const idempotencyKey =
          headers['idempotency-key'] ||
          headers['Idempotency-Key'] ||
          (args && args.idempotencyKey) ||
          null;
        // Strip client-supplied idempotencyKey from tool args so it is not treated as tool input noise
        const toolArgs = { ...(args || {}) };
        delete toolArgs.idempotencyKey;

        const outcome = await invokeControlTool({
          toolName: def.controlName,
          args: toolArgs,
          operatorId: 'mcp-operator',
          idempotencyKey: idempotencyKey ? String(idempotencyKey) : null,
          source: 'mcp',
        });

        if (!outcome.ok) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ok: false,
                  status: outcome.status,
                  error: outcome.body?.error || 'tool failed',
                  requestId: outcome.body?.requestId,
                }),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(outcome.body, null, 2),
            },
          ],
        };
      },
    );
  }

  return server;
}

/**
 * Mount Streamable HTTP MCP at /mcp on an existing Express app.
 * Auth: CONTROL_TOKEN bearer. Host validation for public Render hostname.
 */
export function mountMcp(app) {
  const allowedHosts = buildAllowedHosts();
  const hostMw = hostHeaderValidation(allowedHosts);

  // Lightweight readiness (no secrets)
  app.get('/mcp/health', (req, res) => {
    res.json({
      ok: true,
      service: 'mcp-gateway',
      transport: 'streamable-http',
      path: '/mcp',
      tokenConfigured: isMcpTokenConfigured(),
      toolCount: MCP_TOOL_DEFINITIONS.length,
    });
  });

  const handler = async (req, res) => {
    // Stateless transport per request (safe behind public HTTPS + bearer auth)
    const server = createMcpServerInstance();
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ error: 'MCP transport error', message: err.message });
      }
    } finally {
      try {
        await server.close?.();
      } catch {
        /* ignore */
      }
    }
  };

  // Authenticated MCP endpoint (POST/GET/DELETE for Streamable HTTP)
  app.post('/mcp', hostMw, mcpBearerAuth, handler);
  app.get('/mcp', hostMw, mcpBearerAuth, handler);
  app.delete('/mcp', hostMw, mcpBearerAuth, handler);
}

export { MCP_TOOL_DEFINITIONS, createMcpServerInstance };
