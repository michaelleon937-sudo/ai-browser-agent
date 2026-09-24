// control/tools/billing.js
import { invoices, payments, projects } from '../../database/index.js';
import { createInvoice, approveInvoice, sendInvoice } from '../../integrations/payments/invoice-service.js';
import { getPaymentProvider } from '../../integrations/payments/provider.js';
import { verifyPayment, handlePaymentWebhook } from '../../integrations/payments/verification.js';
import { createProject, startProject, advanceProject, completeProject } from '../../integrations/payments/project-service.js';

export const billingTools = {
  'crm.create_invoice': async (args = {}) => ({ ok: true, invoice: createInvoice({ clientId: args.clientId, companyId: args.companyId, contactId: args.contactId, prospectId: args.prospectId, opportunityId: args.opportunityId, proposalId: args.proposalId, taskId: args.taskId, runId: args.runId, currency: args.currency, subtotal: args.subtotal, tax: args.tax, total: args.total, description: args.description, lineItems: args.lineItems, status: args.status || 'DRAFT' }) }),
  'crm.get_invoice': async (args = {}) => { const id = args.id || args.invoiceId; if (!id) throw new Error('id is required'); const inv = invoices.get(id); return { ok: Boolean(inv), invoice: inv || null }; },
  'crm.list_invoices': async (args = {}) => ({ ok: true, invoices: invoices.list({ limit: Number(args.limit) || 50, status: args.status, companyId: args.companyId, prospectId: args.prospectId, opportunityId: args.opportunityId }) }),
  'crm.approve_invoice': async (args = {}) => { const id = args.id || args.invoiceId; if (!id) throw new Error('id is required'); return { ok: true, invoice: approveInvoice(id) }; },
  'crm.send_invoice': async (args = {}) => { const id = args.id || args.invoiceId; if (!id) throw new Error('id is required'); return { ok: true, invoice: sendInvoice(id), externalSend: false }; },
  'payment.create': async (args = {}) => {
    const invoiceId = args.invoiceId; if (!invoiceId) throw new Error('invoiceId is required');
    const inv = invoices.get(invoiceId); if (!inv) throw new Error('invoice not found');
    const providerName = args.provider || 'stripe'; const provider = getPaymentProvider(providerName);
    const amount = args.amount !== undefined ? Number(args.amount) : Number(inv.total); const currency = args.currency || inv.currency;
    const idempotencyKey = args.idempotencyKey || `pay_${invoiceId}_${providerName}`;
    const existing = payments.getByIdempotencyKey(idempotencyKey); if (existing) return { ok: true, payment: existing, duplicate: true };
    const req = await provider.createPaymentRequest({ amount, currency, invoiceId, idempotencyKey }); if (!req.ok) return { ok: false, error: req.error || 'provider request failed' };
    const payment = payments.create({ invoiceId, clientId: inv.client_id, companyId: inv.company_id, provider: providerName, providerPaymentId: req.providerPaymentId, amount, currency, status: 'PENDING', paymentMethod: args.paymentMethod || providerName, idempotencyKey, metadata: { checkoutUrl: req.checkoutUrl } });
    return { ok: true, payment, checkoutUrl: req.checkoutUrl || null, duplicate: false };
  },
  'payment.get': async (args = {}) => { const id = args.id || args.paymentId; if (!id) throw new Error('id is required'); const payment = payments.get(id); return { ok: Boolean(payment), payment: payment || null }; },
  'payment.list': async (args = {}) => ({ ok: true, payments: payments.list({ limit: Number(args.limit) || 50, status: args.status, invoiceId: args.invoiceId, provider: args.provider }) }),
  'payment.verify': async (args = {}) => { const id = args.id || args.paymentId; if (!id) throw new Error('id is required'); return verifyPayment(id); },
  'payment.handle_webhook': async (args = {}) => { if (!args.provider) throw new Error('provider is required'); return handlePaymentWebhook({ provider: args.provider, headers: args.headers || {}, body: args.body || {}, rawBody: args.rawBody }); },
  'project.create': async (args = {}) => ({ ok: true, project: createProject({ clientId: args.clientId, companyId: args.companyId, contactId: args.contactId, prospectId: args.prospectId, opportunityId: args.opportunityId, proposalId: args.proposalId, invoiceId: args.invoiceId, paymentId: args.paymentId, projectType: args.projectType, scope: args.scope, deliverables: args.deliverables, deadline: args.deadline, assignedTask: args.assignedTask }) }),
  'project.get': async (args = {}) => { const id = args.id || args.projectId; if (!id) throw new Error('id is required'); const project = projects.get(id); return { ok: Boolean(project), project: project || null }; },
  'project.start': async (args = {}) => { const id = args.id || args.projectId; if (!id) throw new Error('id is required'); return { ok: true, project: startProject(id, { allowUnpaid: Boolean(args.allowUnpaid) }) }; },
  'project.update': async (args = {}) => { const id = args.id || args.projectId; if (!id) throw new Error('id is required'); if (!args.status) throw new Error('status is required'); return { ok: true, project: advanceProject(id, args.status) }; },
  'project.complete': async (args = {}) => { const id = args.id || args.projectId; if (!id) throw new Error('id is required'); return { ok: true, project: completeProject(id) }; },
  'project.deliver': async (args = {}) => { const id = args.id || args.projectId; if (!id) throw new Error('id is required'); const project = projects.get(id); if (!project) throw new Error('project not found'); if (project.status === 'IN_PROGRESS') { advanceProject(id, 'IN_REVIEW'); advanceProject(id, 'APPROVED'); } else if (project.status === 'IN_REVIEW') { advanceProject(id, 'APPROVED'); } return { ok: true, project: advanceProject(id, 'DELIVERED') }; },
};
