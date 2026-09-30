// integrations/payments/mode.js
// Payment mode: mock (default) | sandbox | live
// Live requires LIVE_PAYMENTS_ENABLED=true (explicit owner authorization).

const VALID = new Set(['mock', 'sandbox', 'live']);

export function getPaymentMode() {
  const raw = String(process.env.PAYMENT_MODE || 'mock').trim().toLowerCase();
  if (!VALID.has(raw)) return 'mock';
  return raw;
}

export function isLivePaymentsEnabled() {
  return String(process.env.LIVE_PAYMENTS_ENABLED || 'false').toLowerCase() === 'true';
}

/**
 * Gate outbound payment execution.
 * - mock / sandbox: always allowed
 * - live: only when LIVE_PAYMENTS_ENABLED=true
 * Live *providers* are selected by getPaymentProvider(); this only blocks execution
 * when live is requested without explicit authorization.
 */
export function assertPaymentExecutionAllowed() {
  const mode = getPaymentMode();
  if (mode === 'live') {
    if (!isLivePaymentsEnabled()) {
      const err = new Error(
        'PAYMENT_MODE=live is disabled. Set LIVE_PAYMENTS_ENABLED=true only after explicit authorization.'
      );
      err.code = 'LIVE_PAYMENTS_BLOCKED';
      err.status = 403;
      throw err;
    }
    // Live providers (Stakaba, Daraja) are implemented; gate is env only.
    return mode;
  }
  return mode;
}

export function redactSecrets(value) {
  if (value == null) return value;
  const s = String(value);
  if (s.length <= 8) return '***';
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}
