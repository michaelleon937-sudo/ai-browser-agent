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

export function buildProceduralBlenderScript(project = {}, outputDir = "/data", filename = "creative-3d") {
  const safeFile = safe(filename).replace(/\.png$/i, "").replace(/\.glb$/i, "");
  const description = clean(project?.spec?.brief?.description || project?.brief?.description || project?.description || "professional 3D hero object");
  return [
    "import bpy","import os","OUTPUT_DIR = " + JSON.stringify(outputDir),"NAME = " + JSON.stringify(safeFile),"DESCRIPTION = " + JSON.stringify(description),
    "os.makedirs(OUTPUT_DIR, exist_ok=True)","bpy.ops.wm.read_factory_settings(use_empty=True)",
    "bpy.ops.mesh.primitive_uv_sphere_add(segments=96, ring_count=64, location=(0, 0, 1.25))","hero = bpy.context.object","hero.name = 'HeroObject'","hero.scale = (1.15,1.15,1.15)","bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)",
    "mat = bpy.data.materials.new('HeroMaterial')","mat.use_nodes = True","bsdf = mat.node_tree.nodes.get('Principled BSDF')","bsdf.inputs['Base Color'].default_value = (0.72,0.55,0.20,1.0)","bsdf.inputs['Metallic'].default_value = 0.72","bsdf.inputs['Roughness'].default_value = 0.2","hero.data.materials.append(mat)",
    "bpy.ops.mesh.primitive_cylinder_add(vertices=96, radius=2.25, depth=0.18, location=(0,0,0.08))","base = bpy.context.object","base.name = 'HeroBase'","bpy.ops.mesh.primitive_plane_add(size=20, location=(0,0,-0.02))","floor = bpy.context.object","floor.name = 'Floor'",
    "def area(name, location, energy, size):","    bpy.ops.object.light_add(type='AREA', location=location)","    lamp = bpy.context.object","    lamp.name = name","    lamp.data.energy = energy","    lamp.data.shape = 'DISK'","    lamp.data.size = size","    return lamp",
    "def point_at(obj, target):","    direction = target - obj.location","    obj.rotation_euler = direction.to_track_quat('-Z','Y').to_euler()","target = hero.location",
    "for lamp in (area('Key',(4,-4,6),1100,4), area('Fill',(-4,-1,3.5),650,5), area('Rim',(2,4,5),900,3)):","    point_at(lamp,target)",
    "bpy.ops.object.camera_add(location=(5.8,-5.8,3.8))","camera = bpy.context.object","point_at(camera,target)","camera.data.lens = 58","bpy.context.scene.camera = camera",
    "scene = bpy.context.scene","try: scene.render.engine = 'BLENDER_EEVEE_NEXT'","except: scene.render.engine = 'BLENDER_EEVEE'","scene.render.resolution_x = 1024","scene.render.resolution_y = 1024","scene.render.resolution_percentage = 100","scene.render.image_settings.file_format = 'PNG'","scene.render.filepath = os.path.join(OUTPUT_DIR,NAME+'.png')","scene.render.film_transparent = False",
    "world = scene.world or bpy.data.worlds.new('World')","scene.world = world","world.use_nodes = True","world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.015,0.015,0.02,1.0)","world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.18",
    "scene['creative_description'] = DESCRIPTION","bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUTPUT_DIR,NAME+'.blend'))","bpy.ops.render.render(write_still=True)","try: bpy.ops.preferences.addon_enable(module='io_scene_gltf2')","except Exception: pass","bpy.ops.export_scene.gltf(filepath=os.path.join(OUTPUT_DIR,NAME+'.glb'),export_format='GLB',use_selection=False)"
  ].join("\n");
}
export async function renderLocal3D({ project = {}, outputDir = resolveLocalRenderConfig().outputDir, filename, binary = process.env.BLENDER_BIN } = {}) {
  if (!clean(binary)) throw new Error("BLENDER_BIN is required for local 3D rendering");
  const dir=path.resolve(outputDir); const base=safe(filename||project.name||project.type||"creative-3d");
  await mkdir(dir,{recursive:true}); const scriptPath=path.join(dir,base+"-scene.py");
  await writeFile(scriptPath,buildProceduralBlenderScript(project,dir,base),"utf8");
  const result=await exec(binary,["--background","--python",scriptPath]);
  const files=[path.join(dir,base+".png"),path.join(dir,base+".glb"),path.join(dir,base+".blend")];
  const missing=[];
  for(const file of files){try{const info=await (await import("node:fs/promises")).stat(file);if(!info.isFile()||info.size<=0) missing.push(file)}catch{missing.push(file)}}
  if(missing.length) throw Object.assign(new Error("Blender render completed without required outputs: "+missing.join(", ")),{out:result.out,err:result.err,missing});
  return {provider:"free-local-blender",mode:"blender",format:"png+glb",path:files[0],files,scriptPath,stdout:result.out.slice(-1000),stderr:result.err.slice(-1000)};
}

export async function renderFreeFirst({project={},options={}}={}) {
  const type=String(project.type||'graphic').toLowerCase();
  if(type==='video') return renderLocalVideo({project,outputDir:options.outputDir,filename:options.filename,fps:options.fps,scenes:options.scenes||6});
  if(type==='graphic'||type==='image') return renderLocalImage({project,outputDir:options.outputDir,filename:options.filename});
  if(type==='3d'||type==='three-d') return renderLocal3D({project,outputDir:options.outputDir,filename:options.filename,binary:options.blenderBinary||process.env.BLENDER_BIN});
  throw new Error('Unsupported free render type: '+type);
}
