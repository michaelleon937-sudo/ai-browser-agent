// control/auth.js
// Mandatory bearer-token auth for the Control API. Independent of dashboard basic auth.

import crypto from 'node:crypto';
import { config } from '../config/index.js';

export class ControlAuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.name = 'ControlAuthError';
    this.status = status;
  }
}

export function getControlToken() {
  return String(config.control?.token || process.env.CONTROL_TOKEN || '');
}

export function isProductionEnv() {
  return (process.env.NODE_ENV || config.env || 'production') === 'production';
}

export function assertControlConfigured() {
  const token = getControlToken();
  if (!token && isProductionEnv()) {
    throw new ControlAuthError('CONTROL_TOKEN is required in production; Control API is fail-closed', 503);
  }
  return token;
}

export function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) {
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

export function extractBearerToken(req) {
  const header = req.headers?.authorization || req.headers?.Authorization || '';
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || typeof value !== 'string') return '';
  const m = value.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

export function authenticateControlRequest(req) {
  const expected = assertControlConfigured();
  if (!expected) {
    throw new ControlAuthError('CONTROL_TOKEN is not configured', 503);
  }
  const provided = extractBearerToken(req);
  if (!provided || !timingSafeEqualString(provided, expected)) {
    throw new ControlAuthError('Unauthorized', 401);
  }
  return {
    operatorId: req.headers['x-operator-id'] || 'control-operator',
    authenticated: true,
  };
}

export function controlAuthMiddleware(req, res, next) {
  try {
    req.controlAuth = authenticateControlRequest(req);
    next();
  } catch (err) {
    const status = err.status || 401;
    res.status(status).json({ ok: false, error: err.message || 'Unauthorized' });
  }
}
