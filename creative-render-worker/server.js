import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { renderLocal3D } from '../creative-engine/local.js';

const port = Number(process.env.RENDER_WORKER_PORT || 8090);
const token = String(process.env.RENDER_WORKER_TOKEN || '').trim();

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function authorized(req) {
  if (!token) return false;
  const expected = Buffer.from('Bearer ' + token);
  const received = Buffer.from(String(req.headers.authorization || ''));
  return received.length === expected.length && timingSafeEqual(received, expected);
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 2000000) throw new Error('request body too large');
  }
  return raw ? JSON.parse(raw) : {};
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/healthz') {
      return json(res, 200, { ok: true, provider: 'self-hosted-blender', worker: 'creative-render-worker' });
    }
    if (req.method !== 'POST' || req.url !== '/render/3d') {
      return json(res, 404, { error: 'not found' });
    }
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });

    const payload = await readBody(req);
    const result = await renderLocal3D({
      project: payload.project || {},
      outputDir: process.env.RENDER_OUTPUT_DIR || '/data/renders',
      filename: payload.filename,
      binary: process.env.BLENDER_BIN
    });
    return json(res, 200, { ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message === 'request body too large' ? 413 : error instanceof SyntaxError ? 400 : 500;
    return json(res, status, { ok: false, error: message });
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log('creative-render-worker listening on ' + port);
});
