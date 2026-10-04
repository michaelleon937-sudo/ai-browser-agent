import { createCreativeIntelligence, validateCreativeIntelligence } from './intelligence.js';

export const GRAPHIC_FORMATS=Object.freeze({
  poster:{width:1080,height:1350,ratio:'4:5',medium:'digital'},
  square:{width:1080,height:1080,ratio:'1:1',medium:'digital'},
  story:{width:1080,height:1920,ratio:'9:16',medium:'digital'},
  landscape:{width:1920,height:1080,ratio:'16:9',medium:'digital'},
  printA4:{width:2480,height:3508,ratio:'A4',medium:'print',dpi:300,bleedMm:3},
  thumbnail:{width:1280,height:720,ratio:'16:9',medium:'digital'},
  presentation:{width:1920,height:1080,ratio:'16:9',medium:'digital'}
});
export const GRAPHIC_TYPES=Object.freeze(['poster','flyer','social-graphic','product-ad','luxury-campaign','fashion-editorial','restaurant-menu','real-estate-ad','church-graphic','event-graphic','youtube-thumbnail','logo','brand-asset','packaging','presentation','infographic','product-mockup','3d-product']);
export const GRAPHIC_PLATFORM_PRESETS=Object.freeze({
  instagram:{format:'square',safeArea:'10%',textDensity:'medium'},
  instagramStory:{format:'story',safeArea:'8%',textDensity:'low'},
  youtube:{format:'thumbnail',safeArea:'8%',textDensity:'low'},
  presentation:{format:'presentation',safeArea:'5%',textDensity:'medium'}
});
const clean=v=>String(v??'').trim();
export function resolveGraphicFormat(x='square'){
  const q=clean(x).toLowerCase(),key=Object.keys(GRAPHIC_FORMATS).find(k=>k.toLowerCase()===q);
  return GRAPHIC_FORMATS[key]||Object.values(GRAPHIC_FORMATS).find(v=>String(v.ratio).toLowerCase()===q)||GRAPHIC_FORMATS.square;
}
export function createGraphicDesignSpec(input={}) {
  const requestedType=clean(input.graphicType||input.designType||input.type);
  const type=GRAPHIC_TYPES.includes(requestedType)?requestedType:'social-graphic';
  const b={type,description:clean(input.description),format:clean(input.format||'square'),platform:clean(input.platform)};
  const format=resolveGraphicFormat(b.format),intelligence=createCreativeIntelligence(input);
  const platformPreset=GRAPHIC_PLATFORM_PRESETS[b.platform]||null;
  const print=format.medium==='print';
  return {
    version:'1.1.0',brief:b,format,platformPreset,intelligence,
    artDirection:{primary:intelligence.primaryDirection,alternatives:intelligence.artDirectionMatrix},
    hierarchy:{headline:'dominant',subheadline:'supporting',cta:'action',brand:'recognizable-not-dominant'},
    composition:{grid:'modular',focalPoint:'single-clear-focal',safeArea:platformPreset?.safeArea||'10%',whitespace:'intentional',alignment:'deliberate'},
    typography:{display:intelligence.primaryDirection?.typography?.display||'Inter',body:intelligence.primaryDirection?.typography?.body||'Inter',maxFamilies:2,minimumBodyContrast:'WCAG-aware'},
    production:{medium:format.medium,dpi:format.dpi||72,bleedMm:format.bleedMm||0,export:'render-adapter-ready'},
    effects:{depth:type==='3d-product'?'3d':'flat'},
    assetPolicy:{noInventedClientFacts:true,noUnlicensedAssets:true,logoPreserved:true,provenanceRequired:true}
  };
}
export function validateGraphicDesign(s={}) {
  const f=[],b=s.brief||{};
  if(!GRAPHIC_TYPES.includes(b.type)) f.push('unsupported-type');
  if(!s.format?.width) f.push('format');
  if(!s.hierarchy?.headline) f.push('hierarchy');
  if(s.production?.medium==='print'&&s.production.dpi!==300) f.push('print-dpi');
  if(s.assetPolicy?.provenanceRequired!==true) f.push('asset-provenance');
  if(s.assetPolicy?.noInventedClientFacts!==true) f.push('claims-policy');
  if(s.assetPolicy?.noUnlicensedAssets!==true) f.push('asset-license-policy');
  if(s.assetPolicy?.logoPreserved!==true) f.push('logo-policy');
  const intelligenceQa=validateCreativeIntelligence(s.intelligence);
  if(!intelligenceQa.passed) f.push(...intelligenceQa.failures.map(x=>`intelligence:${x}`));
  return {passed:!f.length,failures:f};
}
export function buildGraphicProject(input={}) {
  const spec=createGraphicDesignSpec(input),qa=validateGraphicDesign(spec);
  return {type:'graphic',engine:'professional-creative-engine',spec,qa,status:qa.passed?'READY_FOR_RENDER':'BLOCKED'};
}
