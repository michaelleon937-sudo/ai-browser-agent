import{describe,expect,it}from'vitest';
import{buildVideoProject,createVideoDesignSpec,resolveVideoFormat}from'../../creative-engine/video.js';
import{buildGraphicProject,createGraphicDesignSpec,resolveGraphicFormat}from'../../creative-engine/graphic.js';
import{createCreativeIntelligence}from'../../creative-engine/intelligence.js';
import{createCreativeProject,creativeEngineCapabilities,validateCreativeProject}from'../../creative-engine/index.js';

describe('Professional Video Design Engine',()=>{
  it('supports core formats',()=>{expect(resolveVideoFormat('9:16').ratio).toBe('9:16');expect(resolveVideoFormat('square').ratio).toBe('1:1');expect(resolveVideoFormat('16:9').ratio).toBe('16:9')});
  it('creates professional scene contracts',()=>{const p=buildVideoProject({genre:'luxury-commercial',description:'Luxury watch commercial',duration:30,format:'vertical',platform:'reels',cta:'Shop now',industry:'luxury'});expect(p.status).toBe('READY_FOR_RENDER');expect(p.spec.storyboard).toHaveLength(6);expect(p.spec.storyboard.every(s=>s.captionSafe)).toBe(true);expect(p.spec.assets.provenanceRequired).toBe(true);expect(p.spec.artDirection.primary.name).toBeTruthy()});
  it('handles requested genres',()=>{for(const genre of ['hotel-travel','real-estate-walkthrough','church-promo','podcast-social','ai-ugc'])expect(buildVideoProject({genre,description:genre,duration:15}).qa.passed).toBe(true)});
  it('keeps duration deterministic',()=>{const s=createVideoDesignSpec({genre:'product-ad',description:'Product launch',duration:30});expect(s.storyboard.reduce((n,x)=>n+x.durationSec,0)).toBeCloseTo(30,1)});
  it('rejects broken scene contracts',()=>{const s=createVideoDesignSpec({genre:'product-ad',duration:15});s.storyboard[0].durationSec=0;expect(buildVideoProject({genre:'product-ad',duration:15}).qa.passed).toBe(true);expect(s.storyboard[0].durationSec).toBe(0)});
});

describe('Professional Graphic Design Engine',()=>{
  it('supports formats and print production',()=>{expect(resolveGraphicFormat('poster').ratio).toBe('4:5');expect(resolveGraphicFormat('story').ratio).toBe('9:16');expect(resolveGraphicFormat('printA4').ratio).toBe('A4');expect(resolveGraphicFormat('PRINTA4').dpi).toBe(300)});
  it('covers requested classes',()=>{for(const type of ['poster','flyer','social-graphic','product-ad','luxury-campaign','fashion-editorial','restaurant-menu','real-estate-ad','church-graphic','event-graphic','youtube-thumbnail','logo','packaging','presentation','infographic','product-mockup','3d-product'])expect(buildGraphicProject({type,description:type,industry:type==='luxury-campaign'?'luxury':''}).qa.passed).toBe(true)});
  it('enforces production and asset policies',()=>{const s=createGraphicDesignSpec({type:'luxury-campaign',description:'Luxury campaign',industry:'luxury'});expect(s.production.medium).toBe('digital');expect(s.assetPolicy.provenanceRequired).toBe(true);expect(s.assetPolicy.logoPreserved).toBe(true)});
});

describe('Shared Creative Intelligence',()=>{
  it('uses website design intelligence without duplicating the library',()=>{const i=createCreativeIntelligence({industry:'luxury',audience:'premium buyers',goal:'conversion'});expect(i.primaryDirection.name).toBeTruthy();expect(i.artDirectionMatrix.length).toBe(5);expect(i.rules.noInventedClaims).toBe(true)});
});

describe('Professional Creative Engine',()=>{
  it('routes shared creative briefs',()=>{const v=createCreativeProject({type:'video',genre:'fashion-campaign',description:'Luxury fashion campaign',industry:'fashion'});const g=createCreativeProject({type:'graphic',description:'Luxury fashion poster',format:'poster',industry:'fashion'});expect(v.creativeBrief).toBeTruthy();expect(g.creativeBrief).toBeTruthy();expect(v.status).toBe('READY_FOR_RENDER');expect(g.status).toBe('READY_FOR_RENDER')});
  it('exposes capability contract',()=>{expect(creativeEngineCapabilities.video.features).toContain('scene-contracts');expect(creativeEngineCapabilities.graphic.features).toContain('print-specs');expect(creativeEngineCapabilities.sharedIntelligence).toContain('goal')});
  it('validates projects',()=>{expect(validateCreativeProject(createCreativeProject({type:'video',genre:'product-ad',description:'Product ad'})).passed).toBe(true)});
});
