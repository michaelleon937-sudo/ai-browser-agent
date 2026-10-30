import { AsyncLocalStorage } from 'node:async_hooks';
const storage = new AsyncLocalStorage();
export function getTenantId() { return storage.getStore()?.tenantId || null; }
export function runWithTenantContext(tenantId, callback) {
  if (typeof tenantId !== 'string' || !tenantId.trim()) throw new Error('Verified tenant identity is required');
  return storage.run({ tenantId }, callback);
}
