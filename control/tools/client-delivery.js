// control/tools/client-delivery.js — Phase A1
import {
  prepareClientDelivery,
  approveClientDelivery,
  denyClientDelivery,
  sendApprovedClientDelivery,
  getClientDelivery,
  listClientDeliveries,
  artifactDelivery,
} from '../../integrations/comms/client-delivery.js';

function requireId(args) {
  const id = args.deliveryId || args.id;
  if (!id) {
    const err = new Error('deliveryId is required');
    err.status = 400;
    throw err;
  }
  return id;
}

export async function prepare(args = {}) {
  return { ok: true, ...prepareClientDelivery(args) };
}
export async function get(args = {}) {
  const row = getClientDelivery(requireId(args));
  if (!row) {
    const err = new Error('not found');
    err.status = 404;
    throw err;
  }
  return { ok: true, ...row };
}
export async function list(args = {}) {
  return {
    ok: true,
    items: listClientDeliveries({
      limit: Number(args.limit) || 50,
      status: args.status,
      conversationId: args.conversationId,
      invoiceId: args.invoiceId,
      companyId: args.companyId,
    }),
  };
}
export async function approve(args = {}) {
  if (!args.approved) {
    const err = new Error('client_delivery.approve requires approved=true');
    err.status = 403;
    throw err;
  }
  const result = approveClientDelivery(requireId(args), { decidedBy: args.decidedBy || 'control' });
  return { ok: true, status: result.delivery.status, deliveryId: result.delivery.id, sent: false };
}
export async function deny(args = {}) {
  const result = denyClientDelivery(requireId(args), { decidedBy: args.decidedBy || 'control' });
  return { ok: true, status: result.delivery.status, deliveryId: result.delivery.id, sent: false };
}
export async function sendApproved(args = {}) {
  if (!args.approved) {
    const err = new Error('client_delivery.send_approved requires approved=true');
    err.status = 403;
    throw err;
  }
  if (!args.idempotencyKey) {
    const err = new Error('idempotencyKey is required');
    err.status = 400;
    throw err;
  }
  const result = await sendApprovedClientDelivery(requireId(args), {
    idempotencyKey: args.idempotencyKey,
    decidedBy: args.decidedBy || 'control',
  });
  return {
    ok: result.ok,
    replay: Boolean(result.replay),
    status: result.delivery?.status,
    deliveryId: result.delivery?.id,
    attemptId: result.attempt?.id,
    sent: result.sent,
    externalSideEffect: result.externalSideEffect,
    error: result.error || null,
    historyWarning: result.historyWarning || null,
  };
}
export async function artifactStatus() {
  return {
    ok: true,
    configured: artifactDelivery.isConfigured(),
    signedUrl: artifactDelivery.createSignedUrl(),
  };
}

export const clientDeliveryTools = {
  'client_delivery.prepare': prepare,
  'client_delivery.get': get,
  'client_delivery.list': list,
  'client_delivery.approve': approve,
  'client_delivery.deny': deny,
  'client_delivery.send_approved': sendApproved,
  'client_delivery.artifact_status': artifactStatus,
};
