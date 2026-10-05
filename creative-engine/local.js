import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const clean = v => String(v ?? '').trim();
const safe = (v, fallback = 'creative') => clean(v).replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || fallback;
const palettes = { luxury: ['#f7f2ea','#171717','#b89b5e'], fashion: ['#f5f0eb','#161616','#d6bfa8'], corporate: ['#f5f7fa','#0f172a','#2563eb'], church: ['#eef5ff','#16325c','#38a75b'], default: ['#f5f5f5','#171717','#9b7b4f'] };

export const FREE_RENDER_VERSION = '1.1.0';
export const FREE_RENDER_MODES = Object.freeze(['browser-compositor','ffmpeg','comfyui','blender']);

export function resolveLocalRenderConfig(env = process.env) {
  return Object.freeze({
    outputDir: clean(env.CREATIVE_OUTPUT_DIR || env.DATA_DIR || '/data') || '/data',
    comfyuiBaseUrl: clean(env.COMFYUI_BASE_URL),
    ffmpegBin: clean(env.FFMPEG_BIN) || 'ffmpeg',
    defaultFps: Number(env.CREATIVE_FPS || 24)
  });
}

export function localCreativeCapabilities(env = process.env) {
  const c = resolveLocalRenderConfig(env);
  return {
    version: FREE_RENDER_VERSION,
    freeLocal: { enabled: true, mode: 'browser-compositor', image: true, video: true },
    selfHosted: { comfyui: Boolean(c.comfyuiBaseUrl), blender: Boolean(clean(env.BLENDER_BIN)), image: true, video: true, threeD: Boolean(clean(env.BLENDER_BIN)) },
    optionalPaid: { runway: Boolean(clean(env.RUNWAY_API_KEY)), meshy: Boolean(clean(env.MESHY_API_KEY)), shotstack: Boolean(clean(env.SHOTSTACK_API_KEY)) }
  };
}

function esc(v) { return clean(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function html(o) {
  const p=o.palette, vertical=o.ratio==='9:16';
  return '<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}body{background:linear-gradient(135deg,'+p[0]+','+p[0]+');font-family:Inter,Arial,sans-serif;color:'+p[1]+'}.frame{position:relative;width:100vw;height:100vh;padding:'+(vertical?'8vh 8vw':'7vw')+';display:flex;flex-direction:column;justify-content:center}.orb{position:absolute;width:42vw;height:42vw;border-radius:50%;right:-13vw;top:-12vw;background:'+p[2]+';opacity:.12}.eyebrow{font-size:'+(vertical?'2.1vw':'1.25vw')+';letter-spacing:.24em;text-transform:uppercase;color:'+p[2]+';font-weight:700;margin-bottom:2.4vh}.title{font-size:'+(vertical?'8vw':'6vw')+';line-height:.94;max-width:86vw;font-weight:800;letter-spacing:-.045em}.subtitle{font-size:'+(vertical?'2.7vw':'1.65vw')+';line-height:1.35;max-width:80vw;margin-top:3vh;opacity:.78}.rule{width:12vw;height:4px;background:'+p[2]+';margin-top:4vh}.meta{position:absolute;bottom:5vh;left:7vw;right:7vw;display:flex;justify-content:space-between;font-size:1vw;letter-spacing:.12em;text-transform:uppercase;opacity:.55}</style></head><body><main class="frame"><div class="orb"></div><div class="eyebrow">'+esc(o.eyebrow)+'</div><div class="title">'+esc(o.title)+'</div><div class="subtitle">'+esc(o.subtitle)+'</div><div class="rule"></div><div class="meta"><span>Creative Engine</span><span>'+esc(o.scene)+' / '+esc(o.total)+'</span></div></main></body></html>';
}
function pick(project) {
  const i=clean(project?.intelligence?.industry || project?.brief?.industry).toLowerCase();
  return palettes[Object.keys(palettes).find(k=>i.includes(k)) || 'default'];
}
function exec(cmd,args) {
  return new Promise((resolve,reject)=>{
    const p=spawn(cmd,args,{stdio:['ignore','pipe','pipe']}); let out='',err='';
    p.stdout.on('data',d=>out+=d); p.stderr.on('data',d=>err+=d); p.on('error',reject);
    p.on('close',code=>code===0?resolve({out,err}):reject(Object.assign(new Error(cmd+' failed: '+code),{out,err,code})));
  });
}

export async function renderLocalImage({project={},outputDir=resolveLocalRenderConfig().outputDir,filename}={}) {
  const dir=path.resolve(outputDir); await mkdir(dir,{recursive:true});
  const spec=project.spec||project.brief||{}; const file=path.join(dir,filename||safe(project.name||project.type)+'-image.png');
  const {chromium}=await import('playwright'); const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage({viewport:{width:Number(spec.width||1920),height:Number(spec.height||1080)}});
    await page.setContent(html({title:spec.title||project.brief?.name||'Professional Creative',subtitle:spec.description||project.brief?.description||'Premium visual communication',eyebrow:spec.industry||project.brief?.industry||'Creative Studio',ratio:spec.ratio||'16:9',palette:pick(project),scene:1,total:1}),{waitUntil:'load'});
    await page.screenshot({path:file,type:'png'});
  } finally { await browser.close(); }
  return {provider:'free-local-browser',mode:'browser-compositor',format:'png',path:file};
}

export async function renderLocalVideo({project={},outputDir=resolveLocalRenderConfig().outputDir,filename,fps=resolveLocalRenderConfig().defaultFps,scenes=6}={}) {
  const dir=path.resolve(outputDir), work=path.join(dir,'creative-'+Date.now()+'-'+safe(project.name||project.type));
  await mkdir(work,{recursive:true}); const spec=project.spec||project.brief||{}, ratio=spec.ratio||'16:9', vertical=ratio==='9:16';
  const width=vertical?1080:1920,height=vertical?1920:1080, {chromium}=await import('playwright'), browser=await chromium.launch({headless:true});
  const copy=['Build desire.','Make it memorable.','Turn attention into action.','Designed for your brand.','Built for every screen.','Made to perform.'];
  try {
    const page=await browser.newPage({viewport:{width,height}});
    for(let i=0;i<scenes;i++){ await page.setContent(html({title:i===0?(spec.title||project.brief?.name||'Premium Creative'):copy[i-1],subtitle:spec.description||project.brief?.description||'Professional visual storytelling.',eyebrow:spec.industry||project.brief?.industry||'Creative Studio',ratio,palette:pick(project),scene:i+1,total:scenes}),{waitUntil:'load'}); await page.screenshot({path:path.join(work,'frame-'+String(i+1).padStart(4,'0')+'.png'),type:'png'}); }
  } finally { await browser.close(); }
  const file=path.join(dir,filename||safe(project.name||project.type)+'-video.mp4');
  await exec(resolveLocalRenderConfig().ffmpegBin,['-y','-framerate',String(fps),'-i',path.join(work,'frame-%04d.png'),'-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart',file]);
  return {provider:'free-local-browser+ffmpeg',mode:'browser-compositor',format:'mp4',path:file,scenes,fps};
}

function safeOutputName(filename) {
  const base=path.basename(clean(filename));
  if(!base || base==='.' || base==='..') throw new Error('invalid ComfyUI output filename');
  return base;
}
function collectComfyOutputs(history) {
  const outputs=[];
  for(const node of Object.values(history?.outputs||{})) for(const value of Object.values(node||{})) {
    if(!Array.isArray(value)) continue;
    for(const item of value) if(item?.filename) outputs.push({filename:item.filename,subfolder:item.subfolder||'',type:item.type||'output'});
  }
  return outputs;
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

export async function renderComfyUI({prompt,workflow,baseUrl=resolveLocalRenderConfig().comfyuiBaseUrl,outputDir=resolveLocalRenderConfig().outputDir,timeoutMs=10*60*1000,pollMs=1000,fetchImpl=globalThis.fetch}={}) {
  if(!baseUrl) throw new Error('COMFYUI_BASE_URL is required for self-hosted AI rendering');
  if(typeof fetchImpl!=='function') throw new Error('fetch implementation is required');
  if(!prompt&&!workflow) throw new Error('prompt or workflow is required');
  const base=String(baseUrl).replace(/\/$/,'');
  const queued=await fetchImpl(base+'/prompt',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(workflow||prompt)});
  if(!queued.ok) throw new Error('ComfyUI queue failed: '+queued.status);
  const queuedBody=await queued.json(), promptId=queuedBody.prompt_id;
  if(!promptId) throw new Error('ComfyUI queue response did not include prompt_id');
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline) {
    const res=await fetchImpl(base+'/history/'+encodeURIComponent(promptId));
    if(!res.ok) throw new Error('ComfyUI history failed: '+res.status);
    const body=await res.json(), history=body?.[promptId];
    if(history) {
      const status=history.status?.status_str;
      if(status==='error'||status==='failed') throw new Error('ComfyUI render failed: '+status);
      const outputs=collectComfyOutputs(history);
      if(outputs.length||history.status?.completed===true) {
        if(!outputs.length) throw new Error('ComfyUI completed without output files');
        const dir=path.resolve(outputDir,'comfyui',safe(promptId)); await mkdir(dir,{recursive:true}); const files=[];
        for(const item of outputs) {
          const url=base+'/view?filename='+encodeURIComponent(safeOutputName(item.filename))+'&subfolder='+encodeURIComponent(item.subfolder)+'&type='+encodeURIComponent(item.type);
          const media=await fetchImpl(url); if(!media.ok) throw new Error('ComfyUI output download failed: '+media.status);
          const target=path.join(dir,safeOutputName(item.filename)); await writeFile(target,Buffer.from(await media.arrayBuffer())); files.push(target);
        }
        return {provider:'self-hosted-comfyui',mode:'comfyui',promptId,files,path:files[0],outputs};
      }
    }
    await sleep(pollMs);
  }
  throw new Error('ComfyUI render timed out after '+timeoutMs+'ms');
}

export async function renderFreeFirst({project={},options={}}={}) {
  const type=String(project.type||'graphic').toLowerCase();
  if(type==='video') return renderLocalVideo({project,outputDir:options.outputDir,filename:options.filename,fps:options.fps,scenes:options.scenes||6});
  if(type==='graphic'||type==='image') return renderLocalImage({project,outputDir:options.outputDir,filename:options.filename});
  if(type==='3d'||type==='three-d') return renderLocal3D({project,outputDir:options.outputDir,filename:options.filename,binary:options.blenderBinary||process.env.BLENDER_BIN});
  throw new Error('Unsupported free render type: '+type);
}
