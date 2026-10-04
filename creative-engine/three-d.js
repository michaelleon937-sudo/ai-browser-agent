import { createCreativeIntelligence, validateCreativeIntelligence } from './intelligence.js';

export const THREE_D_TYPES=Object.freeze(['product-visual','architectural-exterior','architectural-interior','real-estate-render','interior-design','packaging-visual','automotive-visual','luxury-object','environment-design']);
export const THREE_D_RENDER_MODES=Object.freeze(['photoreal','stylized','editorial','clay','technical']);
export const THREE_D_CAMERAS=Object.freeze(['hero-front','three-quarter','eye-level','low-angle','high-angle','top-down','wide-interior','perspective-architectural']);

export function create3DDesignSpec(input={}) {
  const type=THREE_D_TYPES.includes(input.type)?input.type:'product-visual';
  const renderMode=THREE_D_RENDER_MODES.includes(input.renderMode)?input.renderMode:'photoreal';
  const camera=THREE_D_CAMERAS.includes(input.camera)?input.camera:'three-quarter';
  const intelligence=createCreativeIntelligence(input);
  return {
    version:'1.0.0',brief:{type,renderMode,camera,description:String(input.description||'').trim()},
    intelligence,
    scene:{scale:'real-world',materials:'physically-based',lighting:'art-directed',environment:'contextual',composition:'single-hero-focal'},
    camera:{type:camera,fov:camera.includes('architectural')?68:50,depthOfField:true},
    materials:{workflow:'PBR',textureResolution:'production',surfaceAccuracy:'preserve-client-materials'},
    lighting:{key:'directional-softbox',fill:'controlled',rim:'purposeful',environment:'image-or-procedural'},
    realism:{shadows:true,reflections:true,contactOcclusion:true,proportionValidation:true},
    accessibility:{reducedMotionFallback:true},
    assetPolicy:{provenanceRequired:true,noUnlicensedAssets:true,noInventedClientFacts:true}
  };
}
export function validate3DDesign(spec={}) {
  const failures=[],b=spec.brief||{};
  if(!THREE_D_TYPES.includes(b.type)) failures.push('unsupported-type');
  if(!THREE_D_RENDER_MODES.includes(b.renderMode)) failures.push('render-mode');
  if(!THREE_D_CAMERAS.includes(b.camera)) failures.push('camera');
  if(spec.scene?.scale!=='real-world') failures.push('scale');
  if(spec.materials?.workflow!=='PBR') failures.push('materials');
  if(spec.realism?.proportionValidation!==true) failures.push('proportion-validation');
  if(spec.assetPolicy?.provenanceRequired!==true) failures.push('asset-provenance');
  const intelligenceQa=validateCreativeIntelligence(spec.intelligence);
  if(!intelligenceQa.passed) failures.push(...intelligenceQa.failures.map(x=>`intelligence:${x}`));
  return {passed:failures.length===0,failures};
}
export function build3DProject(input={}) {
  const spec=create3DDesignSpec(input),qa=validate3DDesign(spec);
  return {type:'3d',engine:'professional-creative-engine',spec,qa,status:qa.passed?'READY_FOR_RENDER':'BLOCKED'};
}
