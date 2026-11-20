import { describe, expect, it } from 'vitest';
import { isApprovalNotificationEnabled } from '../../agent/approval-notifications.js';

describe('approval notification delivery gate', () => {
  it('does not send external approval notifications by default', () => {
    expect(isApprovalNotificationEnabled({})).toBe(false);
    expect(isApprovalNotificationEnabled({ NEXORA_APPROVAL_NOTIFICATIONS_ENABLED:'false' })).toBe(false);
  });
  it('requires explicit operator opt-in to send approval notifications', () => {
    expect(isApprovalNotificationEnabled({ NEXORA_APPROVAL_NOTIFICATIONS_ENABLED:'true' })).toBe(true);
    expect(isApprovalNotificationEnabled({ NEXORA_APPROVAL_NOTIFICATIONS_ENABLED:'1' })).toBe(true);
  });
});
