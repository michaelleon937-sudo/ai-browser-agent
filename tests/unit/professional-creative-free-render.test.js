import { describe, it, expect } from 'vitest';
import {
  FREE_RENDER_VERSION, FREE_RENDER_MODES, localCreativeCapabilities,
  resolveLocalRenderConfig, renderComfyUI, buildProceduralBlenderScript
} from '../../creative-engine/local.js';
import { renderCapabilityMatrix, renderSelfHosted3DWorker } from '../../creative-engine/render.js';

describe('professional creative free/local renderer', () => {
  it('supports free local image and video generation without paid credentials', () => {
    const c = localCreativeCapabilities({});
    expect(FREE_RENDER_VERSION).toBe('1.1.0');
    expect(FREE_RENDER_MODES).toEqual(expect.arrayContaining(['browser-compositor', 'ffmpeg', 'comfyui']));
    expect(c.freeLocal.image).toBe(true);
    expect(c.freeLocal.video).toBe(true);
  });

  it('detects self-hosted ComfyUI', () => {
    expect(localCreativeCapabilities({ COMFYUI_BASE_URL: 'http://comfy:8188' }).selfHosted.comfyui).toBe(true);
  });

  it('keeps paid providers optional', () => {
    const c = renderCapabilityMatrix({});
    expect(c.paidFallback.strategy).toBe('explicit-opt-in');
    expect(c.paidFallback.image).toBe(false);
    expect(c.freeLocal.enabled).toBe(true);
  });

  it('defaults output to /data', () => {
    expect(resolveLocalRenderConfig({}).outputDir).toBe('/data');
  });

  it('queues, polls, and downloads a ComfyUI result', async () => {
    const calls = [];
    let poll = 0;
    const fetchImpl = async (url, init = {}) => {
      calls.push(String(url));
      if (String(url).endsWith('/prompt')) {
        expect(JSON.parse(init.body).prompt).toBe('luxury product');
        return new Response(JSON.stringify({ prompt_id: 'abc123' }), { status: 200 });
      }
      if (String(url).includes('/history/abc123')) {
        poll += 1;
        if (poll === 1) return new Response(JSON.stringify({}), { status: 200 });
        return new Response(JSON.stringify({
          abc123: {
            status: { status_str: 'success', completed: true },
            outputs: { '9': { images: [{ filename: 'hero.png', subfolder: '', type: 'output' }] } }
          }
        }), { status: 200 });
      }
      if (String(url).includes('/view?')) {
        return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200 });
      }
      throw new Error('unexpected url: ' + url);
    };
    const result = await renderComfyUI({
      prompt: 'luxury product',
      workflow: { prompt: 'luxury product' },
      baseUrl: 'http://comfy:8188',
      outputDir: '/tmp/creative-test-comfy',
      pollMs: 1,
      timeoutMs: 1000,
      fetchImpl
    });
    expect(result.provider).toBe('self-hosted-comfyui');
    expect(result.promptId).toBe('abc123');
    expect(result.files).toHaveLength(1);
    expect(result.path.endsWith('hero.png')).toBe(true);
    expect(calls.some(x => x.endsWith('/prompt'))).toBe(true);
    expect(calls.some(x => x.includes('/history/abc123'))).toBe(true);
    expect(calls.some(x => x.includes('/view?'))).toBe(true);
  });

  it('fails clearly when ComfyUI does not return a prompt id', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({}), { status: 200 });
    await expect(renderComfyUI({
      prompt: 'test',
      baseUrl: 'http://comfy:8188',
      fetchImpl,
      timeoutMs: 100
    })).rejects.toThrow('prompt_id');
  });
  it('routes 3D rendering through the authenticated self-hosted worker', async () => {
    const fetchImpl = async (url, init) => {
      expect(url).toBe('http://blender-worker:8090/render/3d');
      expect(init.headers.authorization).toBe('Bearer test-token');
      return new Response(JSON.stringify({ ok: true, path: '/data/renders/hero.png', glb: '/data/renders/hero.glb' }), { status: 200 });
    };
    const result = await renderSelfHosted3DWorker({ project: { type: '3d' }, workerUrl: 'http://blender-worker:8090/', workerToken: 'test-token', fetchImpl });
    expect(result.provider).toBe('self-hosted-blender-worker');
    expect(result.path).toContain('hero.png');
  });
});
