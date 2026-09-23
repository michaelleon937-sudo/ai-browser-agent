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
    const auditBase = { operatorId, toolName, requestId, idempotencyKey, action: `tool:${toolName}` };
    try {
      if (isForbiddenTool(toolName) || !ALLOWED_TOOLS.includes(toolName) || !TOOLS[toolName]) {
        recordAudit({ ...auditBase, status: 'forbidden', details: { reason: 'not registered' } });
        return res.status(403).json({ ok: false, error: `Tool "${toolName}" is not registered` });
      }
      const policy = evaluatePolicy({ toolName, args });
      if (!policy.allow) {
        recordAudit({ ...auditBase, status: 'forbidden', details: { reason: policy.reason } });
        return res.status(policy.status || 403).json({ ok: false, error: policy.reason });
      }
      if (isMutatingTool(toolName)) {
        if (!idempotencyKey) {
          recordAudit({ ...auditBase, status: 'rejected', details: { reason: 'idempotency key required' } });
          return res.status(400).json({ ok: false, error: 'Idempotency-Key header is required for mutating tools' });
        }
        const existing = lookupIdempotency(idempotencyKey);
        if (existing) {
          const parsed = parseStoredResult(existing);
          recordAudit({ ...auditBase, status: 'replayed', details: { idempotencyId: existing.id } });
          return res.status(200).json({ ok: true, replayed: true, tool: toolName, requestId, result: parsed.result });
        }
        beginIdempotency({ idempotencyKey, operatorId, toolName, requestHash: hashRequest(toolName, args) });
      }
      const result = await executeTool(toolName, args, { operatorId, requestId });
      if (isMutatingTool(toolName) && idempotencyKey) {
        completeIdempotency(idempotencyKey, { status: 'completed', result });
      }
      recordAudit({ ...auditBase, status: 'ok', target: args.taskId || args.runId || args.path || args.url || args.branch || null, details: { ok: true } });
      return res.json({ ok: true, tool: toolName, requestId, result });
    } catch (err) {
      if (isMutatingTool(toolName) && idempotencyKey && lookupIdempotency(idempotencyKey)) {
        completeIdempotency(idempotencyKey, { status: 'failed', result: { error: err.message } });
      }
      const status = err.status || (err instanceof ControlAuthError ? err.status : 500);
      recordAudit({ ...auditBase, status: 'error', details: { error: err.message, code: err.code || null } });
      return res.status(status).json({ ok: false, error: err.message, code: err.code || undefined });
    }
  });

  return router;
}

export { ALLOWED_TOOLS, FORBIDDEN_TOOLS };
