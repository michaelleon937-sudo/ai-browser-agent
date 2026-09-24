// control/index.js
// Versioned Control HTTP API: /api/control/v1

import express from 'express';
import { nanoid } from 'nanoid';
import { controlAuthMiddleware, ControlAuthError, getControlToken, isProductionEnv } from './auth.js';
import { evaluatePolicy, isMutatingTool, isForbiddenTool, ALLOWED_TOOLS, FORBIDDEN_TOOLS } from './policy.js';
import { recordAudit } from './audit.js';
import { hashRequest, lookupIdempotency, beginIdempotency, completeIdempotency, parseStoredResult } from './idempotency.js';
import { agentTools } from './tools/agent.js';
import { browserTools } from './tools/browser.js';
import { githubTools } from './tools/github.js';
import { renderTools } from './tools/render.js';
import { repairTools } from './repair.js';
import { invokeControlTool } from './invoke.js';

const TOOLS = {
  ...agentTools,
  ...browserTools,
  ...githubTools,
  ...renderTools,
  ...repairTools,
};

export function listRegisteredTools() {
  return Object.keys(TOOLS);
}

export async function executeTool(toolName, args, ctx = {}) {
  if (isForbiddenTool(toolName) || !TOOLS[toolName]) {
    const err = new Error(`Tool "${toolName}" is not registered`);
    err.status = 403;
    throw err;
  }
  const policy = evaluatePolicy({ toolName, args });
  if (!policy.allow) {
    const err = new Error(policy.reason);
    err.status = policy.status || 403;
    throw err;
  }
  return TOOLS[toolName](args, ctx);
}

export { invokeControlTool };

export function createControlRouter() {
  const router = express.Router();

  router.get('/health', (req, res) => {
    const tokenConfigured = Boolean(getControlToken());
    if (!tokenConfigured && isProductionEnv()) {
      return res.status(503).json({
        ok: false,
        error: 'CONTROL_TOKEN is required in production; Control API is fail-closed',
      });
    }
    res.json({
      ok: true,
      service: 'control',
      version: 'v1',
      tools: listRegisteredTools(),
      forbiddenNeverRegistered: FORBIDDEN_TOOLS,
      tokenConfigured,
    });
  });

  router.post('/tools/:toolName', controlAuthMiddleware, async (req, res) => {
    const toolName = req.params.toolName;
    const requestId = req.headers['x-request-id'] || nanoid(12);
    const operatorId = req.controlAuth?.operatorId || 'control-operator';
    const idempotencyKey = req.headers['idempotency-key'] || req.body?.idempotencyKey || null;
    const args = req.body || {};
    const outcome = await invokeControlTool({
      toolName,
      args,
      operatorId,
      idempotencyKey,
      requestId,
      source: 'http',
    });
    return res.status(outcome.status).json(outcome.body);
  });

  return router;
}

export { ALLOWED_TOOLS, FORBIDDEN_TOOLS };
