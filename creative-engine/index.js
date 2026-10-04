import { buildVideoProject, VIDEO_FORMATS, VIDEO_GENRES, validateVideoDesign } from './video.js';
import { buildGraphicProject, GRAPHIC_FORMATS, GRAPHIC_TYPES, validateGraphicDesign } from './graphic.js';
import { build3DProject, THREE_D_TYPES, THREE_D_RENDER_MODES, validate3DDesign } from './three-d.js';
import { createCreativeIntelligence, validateCreativeIntelligence } from './intelligence.js';
import { buildBrandProject, BRAND_IDENTITY_TYPES, BRAND_COLOR_MODES, validateBrandIdentity } from './brand.js';

export const CREATIVE_ENGINE_VERSION='1.3.0';
export const CREATIVE_CHANNELS=Object.freeze(['website','video','graphic','3d','brand']);
export const CREATIVE_LIFECYCLE=Object.freeze(['BRIEF','ANALYSIS','ART_DIRECTION','STORYBOARD','DESIGN','RENDER_READY','QA','CLIENT_REVIEW','APPROVED','DELIVERY']);

export function createCreativeBrief(input={}) {
  const b=typeof input==='string'?{description:input}:{...input};
  return {name:String(b.name||b.businessName||'').trim(),description:String(b.description||'').trim(),industry:String(b.industry||'').trim(),subIndustry:String(b.subIndustry||'').trim(),audience:String(b.audience||'').trim(),goal:String(b.goal||b.objective||'').trim(),platform:String(b.platform||'').trim(),brandGuidelines:b.brandGuidelines||null,channels:Array.isArray(b.channels)?b.channels:['website'],language:String(b.language||'en').trim()};
}

export function createCreativeProject(input={}) {
  const brief=createCreativeBrief(input), intelligence=createCreativeIntelligence({...brief,...input});
  const type=String(input.type||input.channel||'graphic').toLowerCase();
  if(type==='video') return {...buildVideoProject({...brief,...input}),creativeBrief:brief};
  if(type==='graphic'||type==='image') return {...buildGraphicProject({...brief,...input}),creativeBrief:brief};
  if(['3d','three-d','3d-design'].includes(type)) return {...build3DProject({...brief,...input}),creativeBrief:brief};
  if(['brand','brand-identity','branding'].includes(type)) return {...buildBrandProject({...brief,...input}),creativeBrief:brief,intelligence};
  return {type,engine:'professional-creative-engine',engineVersion:CREATIVE_ENGINE_VERSION,creativeBrief:brief,intelligence,status:'READY_FOR_ART_DIRECTION',contracts:{website:'website-engine',video:'video-engine',graphic:'graphic-engine',threeD:'three-d-engine',brand:'brand-identity-engine'}};
}

export function validateCreativeProject(project={}) {
  if(project.type==='video') return validateVideoDesign(project.spec);
  if(project.type==='graphic') return validateGraphicDesign(project.spec);
  if(project.type==='3d') return validate3DDesign(project.spec);
  if(project.type==='brand') return validateBrandIdentity(project.spec);
  if(project.intelligence) return validateCreativeIntelligence(project.intelligence);
  return {passed:true,failures:[],contractOnly:true};
}

export const creativeEngineCapabilities={
  channels:CREATIVE_CHANNELS,
  lifecycle:CREATIVE_LIFECYCLE,
  video:{genres:VIDEO_GENRES,formats:Object.keys(VIDEO_FORMATS),features:['storyboard','scene-contracts','shot-types','transitions','captions','safe-areas','music','voiceover','motion-graphics','kinetic-typography','3d','effects','asset-provenance']},
  graphic:{types:GRAPHIC_TYPES,formats:Object.keys(GRAPHIC_FORMATS),features:['art-direction','hierarchy','typography','composition','social-presets','print-specs','bleed','accessibility','asset-provenance','3d-product']},
  threeD:{types:THREE_D_TYPES,renderModes:THREE_D_RENDER_MODES,features:['PBR','real-world-scale','art-directed-lighting','camera-presets','photorealism','architectural-visualization','product-visualization']},
  brand:{types:BRAND_IDENTITY_TYPES,colorModes:BRAND_COLOR_MODES,features:['logo-system','color-system','typography-system','grid-and-spacing','iconography','imagery-direction','motion-language','brand-voice','asset-governance','digital-print-kits','accessibility','consistency-qa']},
  sharedIntelligence:['industry-analysis','audience','goal','brand-system','design-direction','accessibility','asset-policy','qa','revision-workflow']
};
