// integrations/payments/project-service.js
import { projects, payments, invoices, assertProjectStatusTransition } from '../../database/index.js';

export function createProject(input = {}) {
  return projects.create({ ...input, status: input.status || 'NOT_STARTED', scope: input.scope || null, deliverables: input.deliverables || null });
}

export function startProject(projectId, { allowUnpaid = false } = {}) {
  const project = projects.get(projectId);
  if (!project) throw new Error('project not found');
  if (!allowUnpaid) {
    if (!project.payment_id) throw new Error('project requires verified payment before start');
    const payment = payments.get(project.payment_id);
    if (!payment || payment.status !== 'SUCCEEDED') throw new Error('project requires SUCCEEDED payment before start');
    if (project.invoice_id) {
      const inv = invoices.get(project.invoice_id);
      if (inv && inv.status !== 'PAID' && inv.status !== 'PARTIALLY_PAID') throw new Error('invoice must be PAID before project start');
    }
  }
  if (project.status === 'NOT_STARTED') projects.updateStatus(projectId, 'READY_TO_START');
  return projects.updateStatus(projectId, 'IN_PROGRESS');
}

export function advanceProject(projectId, toStatus) {
  const project = projects.get(projectId);
  if (!project) throw new Error('project not found');
  assertProjectStatusTransition(project.status, toStatus);
  return projects.updateStatus(projectId, toStatus);
}

export function completeProject(projectId) {
  const project = projects.get(projectId);
  if (!project) throw new Error('project not found');
  if (project.status === 'IN_PROGRESS') { projects.updateStatus(projectId, 'IN_REVIEW'); projects.updateStatus(projectId, 'APPROVED'); projects.updateStatus(projectId, 'DELIVERED'); }
  else if (project.status === 'IN_REVIEW') { projects.updateStatus(projectId, 'APPROVED'); projects.updateStatus(projectId, 'DELIVERED'); }
  else if (project.status === 'APPROVED') { projects.updateStatus(projectId, 'DELIVERED'); }
  return projects.updateStatus(projectId, 'COMPLETED');
}
