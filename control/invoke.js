// control/invoke.js
// Shared Control tool invocation used by HTTP router and MCP gateway.
// Enforces policy, audit, and idempotency — never bypass.

import { nanoid } from 'nanoid';
import { evaluatePolicy } from './policy.js';
import { appendAudit } from './audit.js';
import { beginIdempotent, completeIdempotent, failIdempotent } from './idempotency.js';
import { agentTools } from './tools/agent.js';
import { browserTools } from './tools/browser.js';
import { githubTools } from './tools/github.js';
import { renderTools } from './tools/render.js';
import { repairTools } from './repair.js';
import { outreachTools } from './tools/outreach.js';

const TOOL_HANDLERS = {
  ...agentTools,
  ...browserTools,
  ...githubTools,
  ...renderTools,
  ...repairTools,
  ...outreachTools,
};

/**
 * @param {object} opts
 * @param {string} opts.toolName
 * @param {object} [opts.args]
 * @param {string|null} [opts.idempotencyKey]
 * @param {string} [opts.actor]
 * @param {string|null} [opts.taskId]
 * @param {string|null} [opts.runId]
 * @param {string} [opts.source] - 'http' | 'mcp'
 */
export async function invokeControlTool({
  toolName,
  args = {},
  idempotencyKey = null,
  actor = 'operator',
  taskId = null,
  runId = null,
  source = 'http',
} = {}) {
  const startedAt = Date.now();
  const requestId = nanoid(12);

  const policy = evaluatePolicy(toolName, args);
  if (!policy.allowed) {
    appendAudit({
      requestId,
      actor,
      toolName,
      decision: 'deny',
      reason: policy.reason,
      taskId,
      runId,
      args,
      source,
    });
    const err = new Error(policy.reason || 'forbidden');
    err.status = policy.status || 403;
    err.code = policy.code || 'FORBIDDEN';
    throw err;
  }

  if (policy.requiresIdempotency && !idempotencyKey) {
    appendAudit({
      requestId,
      actor,
      toolName,
      decision: 'deny',
      reason: 'Idempotency-Key required',
      taskId,
      runId,
      args,
      source,
    });
    const err = new Error('Idempotency-Key header is required for this operation');
    err.status = 400;
    err.code = 'IDEMPOTENCY_REQUIRED';
    throw err;
  }

  let idemRecord = null;
  if (idempotencyKey) {
    const begun = beginIdempotent({
      key: idempotencyKey,
      toolName,
      requestId,
      actor,
    });
    if (begun.replay) {
      appendAudit({
        requestId,
        actor,
        toolName,
        decision: 'replay',
        reason: 'idempotent replay',
        taskId,
        runId,
        args,
        source,
        durationMs: Date.now() - startedAt,
      });
      return {
        ok: true,
        replay: true,
        requestId,
        result: begun.response,
      };
    }
    idemRecord = begun.record;
  }

  const handler = TOOL_HANDLERS[toolName];
  if (!handler) {
    appendAudit({
      requestId,
      actor,
      toolName,
      decision: 'deny',
      reason: 'tool not registered',
      taskId,
      runId,
      args,
      source,
    });
    const err = new Error(`Tool not registered: ${toolName}`);
    err.status = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }

  try {
    const result = await handler({ ...args, idempotencyKey, requestId, actor });
    if (idemRecord) {
      completeIdempotent(idemRecord.id, result);
    }
    appendAudit({
      requestId,
      actor,
      toolName,
      decision: 'allow',
      reason: 'ok',
      taskId,
      runId,
      args,
      source,
      durationMs: Date.now() - startedAt,
    });
    return {
      ok: true,
      replay: false,
      requestId,
      result,
    };
  } catch (err) {
    if (idemRecord) {
      try {
        failIdempotent(idemRecord.id, err.message || String(err));
      } catch {}
    }
    appendAudit({
      requestId,
      actor,
      toolName,
      decision: 'error',
      reason: err.message || String(err),
      taskId,
      runId,
      args,
      source,
      durationMs: Date.now() - startedAt,
    });
    throw err;
  }
}

export function listRegisteredTools() {
  return Object.keys(TOOL_HANDLERS).sort();
}
