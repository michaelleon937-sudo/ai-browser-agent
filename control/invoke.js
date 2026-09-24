// control/invoke.js
// Shared Control tool invocation used by HTTP router and MCP gateway.
// Enforces policy, audit, and idempotency — never bypass.

import { nanoid } from 'nanoid';
import { evaluatePolicy, isMutatingTool, isForbiddenTool } from './policy.js';
import { recordAudit } from './audit.js';
import {
  hashRequest,
  lookupIdempotency,
  beginIdempotency,
  completeIdempotency,
  parseStoredResult,
} from './idempotency.js';
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

async function runTool(toolName, args, ctx) {
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

/**
 * Invoke a Control tool with full policy/audit/idempotency.
 * @returns {Promise<{ ok: boolean, status: number, body: object }>
 */
export async function invokeControlTool(opts = {}) {
  const toolName = String(opts.toolName || '');
  const args = opts.args && typeof opts.args === 'object' ? opts.args : {};
  const operatorId = opts.operatorId || 'control-operator';
  const requestId = opts.requestId || nanoid(12);
  const idempotencyKey = opts.idempotencyKey || null;
  const source = opts.source || 'control';
  const auditBase = {
    operatorId,
    toolName,
    requestId,
    idempotencyKey,
    action: `tool:${toolName}`,
    details: { source },
  };

  if (!toolName) {
    recordAudit({ ...auditBase, status: 'rejected', details: { ...auditBase.details, reason: 'tool name required' } });
    return { ok: false, status: 400, body: { ok: false, error: 'tool name required', requestId } };
  }

  if (isForbiddenTool(toolName)) {
    recordAudit({ ...auditBase, status: 'rejected', details: { ...auditBase.details, reason: 'forbidden' } });
    return {
      ok: false,
      status: 403,
      body: { ok: false, error: `Tool "${toolName}" is forbidden and is not registered`, requestId },
    };
  }

  try {
    if (isMutatingTool(toolName)) {
      if (!idempotencyKey) {
        recordAudit({
          ...auditBase,
          status: 'rejected',
          details: { ...auditBase.details, reason: 'idempotency key required' },
        });
        return {
          ok: false,
          status: 400,
          body: { ok: false, error: 'Idempotency-Key header is required for mutating tools', requestId },
        };
      }
      const existing = lookupIdempotency(idempotencyKey);
      if (existing) {
        const parsed = parseStoredResult(existing);
        recordAudit({
          ...auditBase,
          status: 'replayed',
          details: { ...auditBase.details, idempotencyId: existing.id },
        });
        return {
          ok: true,
          status: 200,
          body: { ok: true, replayed: true, tool: toolName, requestId, result: parsed.result },
        };
      }
      beginIdempotency({
        idempotencyKey,
        operatorId,
        toolName,
        requestHash: hashRequest(toolName, args),
      });
    }

    const result = await runTool(toolName, args, { operatorId, requestId, source });
    if (isMutatingTool(toolName) && idempotencyKey) {
      completeIdempotency(idempotencyKey, { status: 'completed', result });
    }
    recordAudit({
      ...auditBase,
      status: 'ok',
      target: args.taskId || args.runId || args.path || args.url || args.branch || null,
      details: { ...auditBase.details, ok: true },
    });
    return {
      ok: true,
      status: 200,
      body: { ok: true, tool: toolName, requestId, result },
    };
  } catch (err) {
    if (isMutatingTool(toolName) && idempotencyKey && lookupIdempotency(idempotencyKey)) {
      completeIdempotency(idempotencyKey, { status: 'failed', result: { error: err.message } });
    }
    const status = err.status || 500;
    recordAudit({
      ...auditBase,
      status: 'error',
      details: { ...auditBase.details, error: err.message, code: err.code || null },
    });
    return {
      ok: false,
      status,
      body: { ok: false, error: err.message, code: err.code || undefined, requestId },
    };
  }
}
