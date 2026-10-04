import { describe,it,expect,vi } from 'vitest';
import { getCreativeProviderConfig,preflightCreativeProviders,RunwayProvider,MeshyProvider,ShotstackProvider,renderCapabilityMatrix } from '../../creative-engine/providers.js';
import { createCreativeProject,renderCreativeProject } from '../../creative-engine/index.js';

const response=(body,status=200)=>({ok:status<400,status,text:async()=>JSON.stringify(body)});

describe('production creative providers',()=>{
  it('fails closed when provider credentials are absent',()=>{
    const c=getCreativeProviderConfig({});
    expect(c.runway.enabled).toBe(false);expect(c.meshy.enabled).toBe(false);expect(c.shotstack.enabled).toBe(false);
    expect(preflightCreativeProviders({}).passed).toBe(false);
  });
  it('tracks configured image/video/3d/compositor providers without exposing secrets',()=>{
    const m=renderCapabilityMatrix({RUNWAY_API_KEY:'secret',MESHY_API_KEY:'secret',SHOTSTACK_API_KEY:'secret'});
    expect(m.image.configured).toBe(true);expect(m.video.configured).toBe(true);expect(m.threeD.configured).toBe(true);expect(m.threeD.blenderConfigured).toBe(false);
  });
  it('runs a real Runway image task contract through injected transport',async()=>{
    const fetch=vi.fn().mockResolvedValueOnce(response({id:'img-task'})).mockResolvedValueOnce(response({id:'img-task',status:'SUCCEEDED',output:['https://cdn.example/image.png']}));
    const p=new RunwayProvider({apiKey:'key_test',fetchImpl:fetch,pollMs:0,maxPolls:2});
    const out=await p.generateImage({prompt:'luxury hotel hero'});
    expect(out.output[0]).toContain('image.png');expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('runs Meshy preview then refine contract',async()=>{
    const fetch=vi.fn()
      .mockResolvedValueOnce(response({result:'preview-1'}))
      .mockResolvedValueOnce(response({id:'preview-1',status:'SUCCEEDED'}))
      .mockResolvedValueOnce(response({result:'refine-1'}))
      .mockResolvedValueOnce(response({id:'refine-1',status:'SUCCEEDED',model_urls:{glb:'https://cdn.example/model.glb'}}));
    const p=new MeshyProvider({apiKey:'key_test',fetchImpl:fetch,pollMs:0,maxPolls:2});
    const out=await p.generateTextTo3D({prompt:'premium product bottle'});
    expect(out.model_urls.glb).toContain('.glb');expect(fetch).toHaveBeenCalledTimes(4);
  });
  it('runs Shotstack render polling contract',async()=>{
    const fetch=vi.fn().mockResolvedValueOnce(response({response:{id:'render-1'}})).mockResolvedValueOnce(response({response:{id:'render-1',status:'done',url:'https://cdn.example/video.mp4'}}));
    const p=new ShotstackProvider({apiKey:'key_test',fetchImpl:fetch,pollMs:0,maxPolls:2});
    const out=await p.render({timeline:{tracks:[]}});
    expect(out.response.status).toBe('done');expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('blocks rendering when the project is not QA-ready',async()=>{
    await expect(renderCreativeProject({type:'video',qa:{passed:false},spec:{}})).rejects.toThrow('not render-ready');
    const project=createCreativeProject({type:'video',genre:'social-short',description:'premium product launch',duration:5});
    expect(project.qa.passed).toBe(true);
  });
});
