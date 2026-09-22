// control/tools/render.js
import { config } from '../../config/index.js';

function renderCfg() {
  return config.control.render;
}

function missing(msg) {
  const err = new Error(msg);
  err.status = 503;
  err.code = 'RENDER_NOT_CONFIGURED';
  throw err;
}

async function renderFetch(path, { method = 'GET', body } = {}) {
  const { apiKey } = renderCfg();
  if (!apiKey) missing('RENDER_API_KEY is not set');
  const url = path.startsWith('http') ? path : `https://api.render.com/v1${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(data?.message || `Render API ${res.status}`);
    err.status = res.status;
    err.details = data;
    throw err;
  }
  return data;
}

function resolveServiceId({ target, serviceId }) {
  const cfg = renderCfg();
  const t = String(target || 'staging').toLowerCase();
  if (t === 'production' || t === 'prod') {
    return { serviceId: serviceId || cfg.productionServiceId, target: 'production' };
  }
  return { serviceId: serviceId || cfg.stagingServiceId, target: 'staging' };
}

export async function getStatus(args = {}) {
  const { serviceId, target } = resolveServiceId(args);
  if (!serviceId) missing(`Render ${target} service id missing. Set RENDER_STAGING_SERVICE_ID or RENDER_PRODUCTION_SERVICE_ID`);
  const data = await renderFetch(`/services/${serviceId}`);
  return { ok: true, target, service: data };
}

export async function getLogs(args = {}) {
  const { serviceId, target } = resolveServiceId(args);
  if (!serviceId) missing(`Render ${target} service id missing`);
  const data = await renderFetch(`/services/${serviceId}/logs?limit=${Number(args.limit) || 50}`);
  return { ok: true, target, logs: data };
}

export async function getDeployments(args = {}) {
  const { serviceId, target } = resolveServiceId(args);
  if (!serviceId) missing(`Render ${target} service id missing`);
  const data = await renderFetch(`/services/${serviceId}/deploys?limit=${Number(args.limit) || 10}`);
  return { ok: true, target, deployments: data };
}

export async function deploy(args = {}) {
  const target = String(args.target || args.environment || 'staging').toLowerCase();
  if (target === 'production' || target === 'prod') {
    const err = new Error('production Render deploy is blocked by default');
    err.status = 403;
    throw err;
  }
  if (!args.approved) {
    const err = new Error('render.deploy requires approved=true');
    err.status = 403;
    throw err;
  }
  const { serviceId } = resolveServiceId({ target: 'staging', serviceId: args.serviceId });
  if (!serviceId) missing('RENDER_STAGING_SERVICE_ID is not set; refusing to pretend deploy succeeded');
  if (!renderCfg().apiKey) missing('RENDER_API_KEY is not set');
  const data = await renderFetch(`/services/${serviceId}/deploys`, {
    method: 'POST',
    body: { clearCache: args.clearCache ? 'clear' : 'do_not_clear' },
  });
  return { ok: true, target: 'staging', deploy: data };
}

export const renderTools = {
  'render.get_status': getStatus,
  'render.get_logs': getLogs,
  'render.get_deployments': getDeployments,
  'render.deploy': deploy,
};
