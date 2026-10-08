import { describe, expect, it } from 'vitest';
import { evaluatePolicy, isMutatingTool, requiresApproval } from '../../control/policy.js';

describe('Composio Control policy', () => {
  it('registers Composio read tools without mutation', () => {
    expect(evaluatePolicy({ toolName: 'composio.hubspot.search_contacts', args: {} }).allow).toBe(true);
    expect(isMutatingTool('composio.hubspot.search_contacts')).toBe(false);
  });

  it('requires approval and idempotency for external mutations', () => {
    const denied = evaluatePolicy({ toolName: 'composio.hubspot.create_contact', args: {} });
    expect(denied).toMatchObject({ allow: false, status: 403 });
    expect(requiresApproval('composio.hubspot.create_contact')).toBe(true);
    expect(isMutatingTool('composio.hubspot.create_contact')).toBe(true);
  });

  it('requires approval for calendar and Xero draft writes', () => {
    expect(evaluatePolicy({ toolName: 'composio.calendar.create_event', args: {} }).allow).toBe(false);
    expect(evaluatePolicy({ toolName: 'composio.xero.create_draft_invoice', args: {} }).allow).toBe(false);
    expect(evaluatePolicy({ toolName: 'composio.xero.create_draft_invoice', args: { approved: true } }).allow).toBe(true);
  });

  it('denies arbitrary toolkit or unregistered operation names', () => {
    expect(evaluatePolicy({ toolName: 'composio.slack.send_message', args: { approved: true } }))
      .toMatchObject({ allow: false, status: 403 });
  });
});
