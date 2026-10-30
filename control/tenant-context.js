// Share the exact AsyncLocalStorage context used by the tenant-partitioned database.
export { getTenantContext, getTenantId, runWithTenantContext } from '../database/tenant-context.js';
