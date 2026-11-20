// agent/approval-notifications.js
// External approval notifications are disabled unless explicitly enabled by an operator.
export function isApprovalNotificationEnabled(env = process.env) {
  const value = String(env?.NEXORA_APPROVAL_NOTIFICATIONS_ENABLED || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(value);
}
