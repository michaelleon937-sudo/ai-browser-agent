import { RunwayProvider, MeshyProvider, ShotstackProvider, runBlenderRender } from './providers.js';

export async function renderCreativeProject(project={},options={}){
  const type=String(project.type||'').toLowerCase();
  const spec=project.spec||{};
  if(!project.qa?.passed)throw new Error('creative project is not render-ready');
  if(type==='video'){
    const provider=options.videoProvider||new RunwayProvider(options.runway);
    const result=await provider.generateVideo({prompt:spec.brief?.description||'professional brand video',promptImage:options.promptImage,ratio:spec.format?.ratio==='9:16'?'768:1280':'1280:768',duration:Math.min(15,Math.max(1,Number(spec.brief?.duration||5))),model:options.videoModel||'gen4.5'});
    if(options.shotstackTimeline){const compositor=options.compositor||new ShotstackProvider(options.shotstack);return {generation:result,render:await compositor.render({timeline:options.shotstackTimeline,output:options.shotstackOutput})};}
    return {generation:result};
  }
  if(type==='graphic'){
    const provider=options.imageProvider||new RunwayProvider(options.runway);
    return {generation:await provider.generateImage({prompt:spec.brief?.description||'professional graphic design',ratio:spec.format?.ratio==='9:16'?'768:1280':spec.format?.ratio==='1:1'?'1024:1024':'1360:768',model:options.imageModel||'gen4_image',referenceImages:options.referenceImages||[]})};
  }
  if(type==='3d'){
    const provider=options.threeDProvider||new MeshyProvider(options.meshy);
    const generation=await provider.generateTextTo3D({prompt:spec.brief?.description||'production-ready 3D asset',model:options.threeDModel||'latest',texture:options.texture!==false,enablePbr:options.enablePbr!==false,targetFormats:['glb'],autoSize:true});
    if(options.blenderSceneFile)return {generation,render:await runBlenderRender({sceneFile:options.blenderSceneFile,outputDir:options.blenderOutputDir,binary:options.blenderBinary})};
    return {generation};
  }
  throw new Error(`unsupported creative render type: ${type||'unknown'}`);
}

export function renderCapabilityMatrix(env=process.env){return {image:{provider:'runway',configured:Boolean(env.RUNWAY_API_KEY)},video:{generationProvider:'runway',compositor:'shotstack',configured:Boolean(env.RUNWAY_API_KEY&&env.SHOTSTACK_API_KEY)},threeD:{assetProvider:'meshy',optionalRenderFarm:'blender',configured:Boolean(env.MESHY_API_KEY),blenderConfigured:Boolean(env.BLENDER_BIN)}};}
