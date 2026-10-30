import { AsyncLocalStorage } from 'node:async_hooks';
const storage = new AsyncLocalStorage();
export function getTenantContext() { return storage.getStore() || null; }
export function getTenantId() { return getTenantContext()?.tenantId || null; }
export function runWithTenantContext(identity, callback) {
  const tenantId = typeof identity === 'string' ? identity : identity?.tenantId;
  const operatorId = typeof identity === 'string' ? '' : String(identity?.operatorId || '');
  if (typeof tenantId !== 'string' || !tenantId.trim()) throw new Error('Verified tenant identity is required');
  return storage.run({ tenantId, operatorId }, callback);
}
