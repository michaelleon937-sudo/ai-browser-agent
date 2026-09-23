// mcp/auth.js
// Bearer auth for the MCP gateway using the existing CONTROL_TOKEN.
// Never logs or returns the token value.

import { assertControlConfigured, timingSafeEqualString, ControlAuthError, getControlToken } from '../control/auth.js';

/**
 * Express middleware: require Authorization: Bearer <CONTROL_TOKEN>.
 * Attaches req.mcpAuth = { operatorId: 'mcp-operator' } on success.
 */
export function mcpBearerAuth(req, res, next) {
  try {
    const expected = assertControlConfigured();
    if (!expected) {
      return res.status(503).json({
        error: 'CONTROL_TOKEN is not configured; MCP gateway is fail-closed',
      });
    }
    const header = String(req.headers.authorization || '');
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (!m) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ error: 'Unauthorized', message: 'Bearer token required' });
    }
    const provided = m[1].trim();
    if (!timingSafeEqualString(provided, expected)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ error: 'Unauthorized', message: 'Invalid token' });
    }
    req.mcpAuth = { operatorId: 'mcp-operator', authenticated: true };
    return next();
  } catch (err) {
    if (err instanceof ControlAuthError) {
      return res.status(err.status || 503).json({ error: err.message });
    }
    return res.status(500).json({ error: 'auth failure' });
  }
}

export function isMcpTokenConfigured() {
  return Boolean(getControlToken());
}
