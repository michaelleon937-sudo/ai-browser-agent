// integrations/payments/mode.js
// Payment mode: mock (default) | sandbox | live (blocked in Phase 8A)

const VALID = new Set(['mock', 'sandbox', 'live']);

export function getPaymentMode() {
  const raw = String(process.env.PAYMENT_MODE || 'mock').trim().toLowerCase();
  if (!VALID.has(raw)) return 'mock';
  return raw;
}

export function isLivePaymentsEnabled() {
  return String(process.env.LIVE_PAYMENTS_ENABLED || 'false').toLowerCase() === 'true';
}

export function assertPaymentExecutionAllowed() {
  const mode = getPaymentMode();
  if (mode === 'live') {
    if (!isLivePaymentsEnabled()) {
      const err = new Error('PAYMENT_MODE=live is disabled. Set LIVE_PAYMENTS_ENABLED=true only after explicit authorization (Phase 8A blocks live).');
      err.code = 'LIVE_PAYMENTS_BLOCKED';
      err.status = 403;
      throw err;
    }
    const err = new Error('Live payment providers are not implemented in Phase 8A. Use PAYMENT_MODE=mock or PAYMENT_MODE=sandbox.');
    err.code = 'LIVE_NOT_IMPLEMENTED';
    err.status = 503;
    throw err;
  }
  return mode;
}

export function redactSecrets(value) {
  if (value == null) return value;
  const s = String(value);
  if (s.length <= 8) return '***';
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}
