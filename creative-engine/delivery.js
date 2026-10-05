import { statSync } from 'node:fs';
import { validateVideoDesign } from './video.js';
import { validateGraphicDesign } from './graphic.js';
import { validate3DDesign } from './three-d.js';
import { validateBrandIdentity } from './brand.js';
export const CREATIVE_DELIVERY_VERSION='1.0.0';
export const DELIVERY_FORMATS=Object.freeze({video:['mp4','mov','webm'],graphic:['png','jpg','webp','svg','pdf'],threeD:['png','jpg','webp','glb','gltf','obj'],brand:['svg','png','pdf','webp','json']});
export const DELIVERY_PROFILES=Object.freeze({social:Object.freeze({name:'social',formats:['mp4','png','jpg','webp'],quality:'high'}),digital:Object.freeze({name:'digital',formats:['mp4','png','jpg','webp','svg','webm'],quality:'high'}),print:Object.freeze({name:'print',formats:['pdf','png','jpg','svg'],quality:'press'}),web3d:Object.freeze({name:'web3d',formats:['glb','gltf','webp','png','jpg'],quality:'high'}),brandKit:Object.freeze({name:'brandKit',formats:['svg','png','pdf','webp','json'],quality:'master'})});
const slug=v=>String(v||'creative-project').toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,80)||'creative-project';
export function resolveDeliveryProfile(input={}){const requested=String(input.profile||input.deliveryProfile||'digital').toLowerCase();return DELIVERY_PROFILES[requested]||DELIVERY_PROFILES.digital;}
export function createDeliveryManifest(project={},input={}){const channel=String(project.channel||project.type||input.channel||input.type||'graphic').toLowerCase();const profile=resolveDeliveryProfile(input);const requested=Array.isArray(input.formats)?input.formats.map(x=>String(x).toLowerCase()):profile.formats;const allowed=DELIVERY_FORMATS[channel]||DELIVERY_FORMATS.graphic;const formats=[...new Set(requested.filter(x=>allowed.includes(x)))];const name=slug(input.name||project.name||project.creativeBrief?.name||project.spec?.title||'creative-project');const provenance=project.spec?.assetPolicy||project.spec?.assets||{};return{version:CREATIVE_DELIVERY_VERSION,channel,profile:profile.name,quality:profile.quality,naming:{project:name,filenamePattern:name+'-{variant}.{ext}'},formats:formats.length?formats:allowed.slice(0,1),assets:{provenanceRequired:provenance.provenanceRequired!==false,sourceFilesRequired:true,licensesAttached:Boolean(input.licensesAttached)},metadata:{altTextRequired:channel!=='video',captionSafe:channel==='video',colorProfile:profile.name==='print'?'CMYK':'sRGB'},package:{manifest:true,preview:true,source:false,checksum:true},deliveryGate:{qaPassed:false,clientApproved:false,exportVerified:false}}}
export function validateDeliveryManifest(manifest={}){const failures=[];if(!manifest.version)failures.push('version is required');if(!manifest.channel)failures.push('channel is required');if(!Array.isArray(manifest.formats)||!manifest.formats.length)failures.push('at least one export format is required');if(!manifest.naming?.filenamePattern)failures.push('filename pattern is required');if(manifest.assets?.provenanceRequired&&!manifest.assets?.licensesAttached)failures.push('license/provenance evidence is not attached');return{passed:failures.length===0,failures};}
export function validateCreativeForDelivery(project={}){if(project.type==='video')return validateVideoDesign(project.spec);if(project.type==='graphic')return validateGraphicDesign(project.spec);if(project.type==='3d')return validate3DDesign(project.spec);if(project.type==='brand')return validateBrandIdentity(project.spec);return{passed:true,failures:[]};}
export function verifyRenderedOutputs(renderResult = {}, manifest = {}) {
  const candidates=Array.isArray(renderResult.files)&&renderResult.files.length?renderResult.files:renderResult.path?[renderResult.path]:[];
  const failures=[];
  if(!candidates.length) failures.push("rendered-output-is-required-for-export-verification");
  for(const file of candidates){try{const info=statSync(file);if(!info.isFile()||info.size<=0) failures.push("invalid-rendered-file:"+file)}catch{failures.push("missing-rendered-file:"+file)}}
  const expected=new Set(manifest.formats||[]);
  if(renderResult.format&&expected.size&&!expected.has(String(renderResult.format).toLowerCase())) failures.push("render-format-not-requested:"+renderResult.format);
  return {passed:failures.length===0,failures,files:candidates};
}

export function buildDeliveryPackage(project={},input={}) {
  const creativeQA=validateCreativeForDelivery(project);
  const manifest=createDeliveryManifest(project,input);
  manifest.deliveryGate.qaPassed=creativeQA.passed;
  const gate=validateDeliveryManifest(manifest);
  const exportVerification=input.renderResult?verifyRenderedOutputs(input.renderResult,manifest):{passed:false,failures:["render-result-not-supplied"],files:[]};
  manifest.deliveryGate.exportVerified=exportVerification.passed;
  return {engine:"professional-creative-delivery-engine",version:CREATIVE_DELIVERY_VERSION,status:creativeQA.passed&&gate.passed&&exportVerification.passed?"READY_FOR_EXPORT":"BLOCKED",creativeQA,exportVerification,manifest,checklist:{technicalQA:creativeQA.passed,provenancePolicy:manifest.assets.provenanceRequired,exportFormatsResolved:gate.passed,renderedOutputVerified:exportVerification.passed,clientApprovalRequired:true,checksumRequired:true}};
}
