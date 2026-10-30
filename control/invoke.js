// control/invoke.js
// Shared Control tool invocation used by HTTP router and MCP gateway.
// Enforces policy, audit, and idempotency â never bypass.

import { nanoid } from 'nanoid';
import { evaluatePolicy, isMutatingTool, isForbiddenTool, requiresApproval } from './policy.js';
import { recordAudit } from './audit.js';
import {
  hashRequest,
  lookupIdempotency,
  beginIdempotency,
  completeIdempotency,
  parseStoredResult,
} from './idempotency.js';
import { verifyAndConsumeApprovalContract } from './approval-contract.js';
import { getTenantId } from './tenant-context.js';
import { agentTools } from './tools/agent.js';
import { browserTools } from './tools/browser.js';
import { githubTools } from './tools/github.js';
import { renderTools } from './tools/render.js';
import { repairTools } from './repair.js';
import { outreachTools } from './tools/outreach.js';
import { crmTools } from './tools/crm.js';
import { composioTools } from './tools/composio.js';
import { billingTools } from './tools/billing.js';
import { biTools } from './tools/bi.js';
import { commercialTools } from './tools/commercial.js';
import { clientDeliveryTools } from './tools/client-delivery.js';
import { websiteEngineTools } from './tools/website-engine.js';
import { creativeEngineTools } from './tools/creative-engine.js';
import { supervisorTools } from './tools/supervisor.js';
import { businessGrowthTools } from '../integrations/business-growth.js';
import { deepBusinessAutopilotTools } from '../integrations/deep-business-autopilot.js';
import { clientRevenueIntelligenceTools } from '../integrations/client-revenue-intelligence.js';

const TOOLS = {
  ...agentTools,
  ...browserTools,
  ...githubTools,
  ...renderTools,
  ...repairTools,
  ...outreachTools,
  ...crmTools,
  ...composioTools,
  ...billingTools,
  ...biTools,
  ...commercialTools,
  ...clientDeliveryTools,
  ...websiteEngineTools,
  ...creativeEngineTools,
  ...supervisorTools,
  ...businessGrowthTools,
  ...deepBusinessAutopilotTools,
  ...clientRevenueIntelligenceTools,
};

async function runTool(toolName, args, ctx, approvalVerified = false) {
  if (isForbiddenTool(toolName) || !TOOLS[toolName]) {
    const err = new Error(`Tool "${toolName}" is not registered`);
    err.status = 403;
    throw err;
  }
  const policy = evaluatePolicy({ toolName, args, approvalVerified });
  if (!policy.allow) {
    const err = new Error(policy.reason);
    err.status = policy.status || 403;
    throw err;
  }
  return TOOLS[toolName](args, ctx);
}

export async function invokeControlTool(opts = {}) {
  const toolName = String(opts.toolName || '');
  const args = opts.args && typeof opts.args === 'object' ? opts.args : {};
  const tenantContext = opts.tenantId || getTenantId();
  const operatorId = opts.operatorId || 'control-operator';
  const idempotencyScope = tenantContext ? `${tenantContext}:${operatorId}` : operatorId;
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
    let approvalVerified = false;
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
      const requestHash = hashRequest(toolName, args);
      const existing = lookupIdempotency(idempotencyKey, idempotencyScope);
      if (existing) {
        if (existing.request_hash !== requestHash || existing.tool_name !== toolName) {
          recordAudit({ ...auditBase, status: 'rejected', details: { ...auditBase.details, reason: 'idempotency_payload_mismatch', idempotencyId: existing.id } });
          return { ok: false, status: 409, body: { ok: false, error: 'Idempotency key was already used for a different request', code: 'idempotency_payload_mismatch', requestId } };
        }
        if (existing.status === 'started') {
          return { ok: false, status: 409, body: { ok: false, error: 'A request with this idempotency key is still in progress', code: 'idempotency_in_progress', requestId } };
        }
        const parsed = parseStoredResult(existing);
        recordAudit({ ...auditBase, status: 'replayed', details: { ...auditBase.details, idempotencyId: existing.id } });
        return { ok: true, status: 200, body: { ok: true, replayed: true, tool: toolName, requestId, result: parsed.result } };
      }
      if (requiresApproval(toolName)) {
        verifyAndConsumeApprovalContract(opts.approvalContract, { tenantId: tenantContext, operatorId, toolName, args });
        approvalVerified = true;
      }
      beginIdempotency({ idempotencyKey, operatorId: idempotencyScope, toolName, requestHash });
    }

    const result = await runTool(toolName, args, { operatorId, tenantId: tenantContext, requestId, source, approvalVerified }, approvalVerified);
    if (isMutatingTool(toolName) && idempotencyKey) {
      completeIdempotency(idempotencyKey, idempotencyScope, { status: 'completed', result });
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
    if (isMutatingTool(toolName) && idempotencyKey && lookupIdempotency(idempotencyKey, idempotencyScope)) {
      completeIdempotency(idempotencyKey, idempotencyScope, { status: 'failed', result: { error: err.message } });
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
