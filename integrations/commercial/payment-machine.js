// integrations/commercial/payment-machine.js
// Phase 8 commercial payment states. COMPLETED is never inferred from a request.

export const COMMERCIAL_PAYMENT_STATES = Object.freeze([
  'CREATED',
  'PENDING',
  'AUTHORIZED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'REFUNDED',
  'RECONCILIATION_REQUIRED',
]);

export function toCommercialState(storeStatus) {
  const s = String(storeStatus || '').toUpperCase();
  if (s === 'SUCCEEDED' || s === 'COMPLETED') return 'COMPLETED';
  if (s === 'PROCESSING') return 'PENDING';
  if (s === 'UNKNOWN') return 'RECONCILIATION_REQUIRED';
  if (COMMERCIAL_PAYMENT_STATES.includes(s)) return s;
  return 'CREATED';
}

export function toStoreStatus(commercialState) {
  const s = String(commercialState || '').toUpperCase();
  if (s === 'COMPLETED') return 'SUCCEEDED';
  if (s === 'AUTHORIZED') return 'PROCESSING';
  if (s === 'RECONCILIATION_REQUIRED') return 'UNKNOWN';
  return s;
}

const TRANSITIONS = {
  CREATED: new Set(['CREATED', 'PENDING', 'AUTHORIZED', 'FAILED', 'CANCELLED', 'RECONCILIATION_REQUIRED']),
  PENDING: new Set(['PENDING', 'AUTHORIZED', 'COMPLETED', 'FAILED', 'CANCELLED', 'RECONCILIATION_REQUIRED']),
  AUTHORIZED: new Set(['AUTHORIZED', 'COMPLETED', 'FAILED', 'CANCELLED', 'RECONCILIATION_REQUIRED']),
  COMPLETED: new Set(['COMPLETED', 'REFUNDED', 'RECONCILIATION_REQUIRED']),
  FAILED: new Set(['FAILED', 'PENDING', 'RECONCILIATION_REQUIRED']),
  CANCELLED: new Set(['CANCELLED']),
  REFUNDED: new Set(['REFUNDED']),
  RECONCILIATION_REQUIRED: new Set(['RECONCILIATION_REQUIRED', 'COMPLETED', 'FAILED', 'CANCELLED', 'PENDING']),
};

export function assertCommercialPaymentTransition(from, to) {
  if (from === to) return;
  const allowed = TRANSITIONS[from];
  if (!allowed || !allowed.has(to)) {
    throw new Error(`Invalid commercial payment transition: ${from} → ${to}`);
  }
}

export function canMarkCompleted({ providerVerified, providerTransactionId, amountMatch, currencyMatch } = {}) {
  return Boolean(
    providerVerified === true
    && providerTransactionId
    && String(providerTransactionId).trim() !== ''
    && amountMatch === true
    && currencyMatch === true,
  );
}

export function transitionCommercialPayment(currentStoreStatus, nextCommercial, evidence = {}) {
  const from = toCommercialState(currentStoreStatus);
  const to = String(nextCommercial || '').toUpperCase();
  if (!COMMERCIAL_PAYMENT_STATES.includes(to)) {
    throw new Error(`Unknown commercial payment state: ${to}`);
  }
  assertCommercialPaymentTransition(from, to);
  if (to === 'COMPLETED' && !canMarkCompleted(evidence)) {
    const err = new Error('COMPLETED requires verified provider confirmation (transaction id, amount, currency)');
    err.code = 'COMPLETION_NOT_VERIFIED';
    throw err;
  }
  return { from, to, storeStatus: toStoreStatus(to) };
}
