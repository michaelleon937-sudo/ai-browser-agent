// Request-scoped tenant identity for tenant-partitioned runtime storage.
import { AsyncLocalStorage } from 'node:async_hooks';
const storage = new AsyncLocalStorage();
export function getTenantContext() { return storage.getStore() || null; }
export function getTenantId() { return getTenantContext()?.tenantId || null; }
export function runWithTenantContext(context, callback) {
  const tenantId = String(context?.tenantId || '').trim();
  if (!tenantId) throw new Error('Verified tenant identity is required');
  return storage.run({ tenantId, operatorId: String(context.operatorId || '') }, callback);
}
