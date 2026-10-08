// control/tools/composio.js
// Agent-facing Composio tools. Every mutation is invoked through Control.

import { executeComposioOperation, composioRuntimeStatus } from '../../integrations/composio-runtime.js';

export const composioTools = {
  'composio.status': status,
  'composio.hubspot.search_contacts': hubspotSearchContacts,
  'composio.hubspot.create_contact': hubspotCreateContact,
  'composio.hubspot.update_contact': hubspotUpdateContact,
  'composio.hubspot.read_contact': hubspotReadContact,
  'composio.calendar.create_event': calendarCreateEvent,
  'composio.calendar.get_event': calendarGetEvent,
  'composio.calendar.patch_event': calendarPatchEvent,
  'composio.calendar.delete_event': calendarDeleteEvent,
  'composio.xero.create_draft_invoice': xeroCreateDraftInvoice,
  'composio.xero.get_invoice': xeroGetInvoice,
};

async function status() {
  return { ok: true, runtime: composioRuntimeStatus() };
}

async function execute(provider, operation, args, ctx) {
  return executeComposioOperation({
    provider,
    operation,
    args,
    requestId: ctx?.requestId || null,
  });
}

async function hubspotSearchContacts(args = {}, ctx) {
  return execute('hubspot', 'search_contacts', args, ctx);
}

async function hubspotCreateContact(args = {}, ctx) {
  return execute('hubspot', 'create_contact', args, ctx);
}

async function hubspotUpdateContact(args = {}, ctx) {
  return execute('hubspot', 'update_contact', args, ctx);
}

async function hubspotReadContact(args = {}, ctx) {
  return execute('hubspot', 'read_contact', args, ctx);
}

async function calendarCreateEvent(args = {}, ctx) {
  return execute('googlecalendar', 'create_event', args, ctx);
}

async function calendarGetEvent(args = {}, ctx) {
  return execute('googlecalendar', 'get_event', args, ctx);
}

async function calendarPatchEvent(args = {}, ctx) {
  return execute('googlecalendar', 'patch_event', args, ctx);
}

async function calendarDeleteEvent(args = {}, ctx) {
  return execute('googlecalendar', 'delete_event', args, ctx);
}

export async function xeroCreateDraftInvoice(args = {}, ctx) {
  if (String(args.Status || 'DRAFT').toUpperCase() !== 'DRAFT') {
    const err = new Error('Xero runtime only permits DRAFT invoice creation');
    err.status = 403;
    err.code = 'XERO_DRAFT_ONLY';
    throw err;
  }
  return execute('xero', 'create_draft_invoice', { ...args, Status: 'DRAFT' }, ctx);
}

async function xeroGetInvoice(args = {}, ctx) {
  return execute('xero', 'get_invoice', args, ctx);
}
