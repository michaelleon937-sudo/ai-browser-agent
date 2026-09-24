// integrations/client-memory.js
import { clientMemory, MEMORY_CONFIDENCE } from '../database/index.js';

export function extractAndStoreMemory({ companyId, contactId, prospectId, extracted = {}, sourceMessageId } = {}) {
  const results = [];
  const scope = { companyId, contactId, prospectId };
  const map = [
    ['brand_name', extracted.brandOrBusinessName],
    ['requested_service', extracted.requestedService],
    ['requested_deliverables', extracted.requestedDeliverables],
    ['deadline', extracted.deadline],
    ['budget', extracted.budget],
  ];
  for (const [key, value] of map) {
    if (value === undefined || value === null || value === '') continue;
    const normalized = Array.isArray(value) ? value.join(', ') : String(value);
    results.push({ key, ...clientMemory.upsertFact({ ...scope, key, value: normalized, confidence: MEMORY_CONFIDENCE.CONFIRMED_BY_CLIENT, source: 'client_message', sourceMessageId }) });
  }
  return results;
}

export function updateClientMemory({ companyId, contactId, prospectId, key, value, confidence, source, notes } = {}) {
  if (!key) throw new Error('key is required');
  if (value === undefined || value === null) throw new Error('value is required');
  const conf = confidence && MEMORY_CONFIDENCE[confidence] ? confidence : MEMORY_CONFIDENCE.CONFIRMED_BY_SYSTEM;
  return clientMemory.upsertFact({ companyId, contactId, prospectId, key, value: String(value), confidence: conf, source: source || 'operator', notes });
}

export function getClientMemory({ companyId, contactId, prospectId, key, limit = 50 } = {}) {
  return clientMemory.list({ companyId, contactId, prospectId, key, limit });
}

export function getAuthoritativeFacts({ companyId, contactId, prospectId } = {}) {
  const rows = clientMemory.list({ companyId, contactId, prospectId, limit: 200 });
  const rank = { CONFIRMED_BY_CLIENT: 3, CONFIRMED_BY_SYSTEM: 2, INFERRED: 1, UNKNOWN: 0 };
  const byKey = new Map();
  for (const row of rows) {
    const prev = byKey.get(row.key);
    const r = rank[row.confidence] || 0;
    const pr = prev ? (rank[prev.confidence] || 0) : -1;
    if (!prev || r > pr || (r === pr && String(row.updated_at) >= String(prev.updated_at))) byKey.set(row.key, row);
  }
  return Object.fromEntries([...byKey.entries()].map(([k, v]) => [k, { value: v.value, confidence: v.confidence, source: v.source, id: v.id, updatedAt: v.updated_at }]));
}
