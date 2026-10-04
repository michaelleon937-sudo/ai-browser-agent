import { createCreativeIntelligence, validateCreativeIntelligence } from './intelligence.js';

export const VIDEO_FORMATS=Object.freeze({
  vertical:{width:1080,height:1920,ratio:'9:16',platforms:['reels','tiktok','shorts','stories']},
  square:{width:1080,height:1080,ratio:'1:1',platforms:['feed','social']},
  landscape:{width:1920,height:1080,ratio:'16:9',platforms:['youtube','web','presentation']},
  cinematic:{width:3840,height:2160,ratio:'16:9',platforms:['cinema','hero-film']}
});
export const VIDEO_GENRES=Object.freeze(['luxury-commercial','social-short','cinematic-brand-film','product-ad','fashion-campaign','hotel-travel','real-estate-walkthrough','church-promo','podcast-social','ai-ugc']);
export const VIDEO_SHOT_TYPES=Object.freeze(['hero','wide','medium','close-up','macro','overhead','tracking','orbit','drone','screen-capture','talking-head','b-roll']);
export const VIDEO_PLATFORM_PRESETS=Object.freeze({
  reels:{format:'vertical',captionSafeArea:'9:16-safe',hookWindowSec:2},
  tiktok:{format:'vertical',captionSafeArea:'9:16-safe',hookWindowSec:2},
  shorts:{format:'vertical',captionSafeArea:'9:16-safe',hookWindowSec:2},
  youtube:{format:'landscape',captionSafeArea:'16:9-safe',hookWindowSec:5},
  web:{format:'landscape',captionSafeArea:'16:9-safe',hookWindowSec:5},
  stories:{format:'vertical',captionSafeArea:'9:16-safe',hookWindowSec:2}
});
const clean=v=>String(v??'').trim();

export function resolveVideoFormat(x='vertical'){
  const q=clean(x).toLowerCase();
  return VIDEO_FORMATS[q]||Object.values(VIDEO_FORMATS).find(v=>v.ratio===q)||VIDEO_FORMATS.vertical;
}
function sceneCount(duration){return duration<=15?4:duration<=30?6:duration<=60?8:10;}
export function createStoryboard(b={}) {
  const d=Math.max(1,Number(b.duration||30)),n=sceneCount(d),beats=['hook','context','proof','product','emotion','cta','brand','end-card'];
  return Array.from({length:n},(_,i)=>({
    scene:i+1,beat:beats[i]||'detail',durationSec:Number((d/n).toFixed(3)),
    shot:VIDEO_SHOT_TYPES[i%VIDEO_SHOT_TYPES.length],
    transition:i===0?'cut':i===n-1?'fade':'match-cut',
    motion:i===0?'kinetic-entry':i%3===0?'camera-orbit':i%2?'camera-push':'parallax',
    text:i===0?'HOOK':i===n-1?(b.cta||'CALL TO ACTION'):'',
    voiceover:i===0?b.description:i===n-1?b.cta:'',
    captionSafe:true
  }));
}
export function createVideoDesignSpec(input={}) {
  const b={genre:clean(input.genre||'social-short'),description:clean(input.description),duration:Math.max(1,Number(input.duration||30)),format:clean(input.format||'vertical'),cta:clean(input.cta),platform:clean(input.platform),captions:input.captions!==false,voiceover:input.voiceover!==false,music:input.music!==false};
  const format=resolveVideoFormat(b.format), intelligence=createCreativeIntelligence(input);
  const platform=VIDEO_PLATFORM_PRESETS[b.platform]||null;
  return {
    version:'1.1.0',brief:b,intelligence,format,platformPreset:platform,storyboard:createStoryboard(b),
    artDirection:{primary:intelligence.primaryDirection,alternatives:intelligence.artDirectionMatrix},
    motion:{camera:'purposeful',typography:'kinetic',transitions:'editorial',threeD:'progressive',reducedMotionFallback:'static-or-crossfade'},
    audio:{music:b.music,voiceover:b.voiceover,ducking:true,captionSync:true},
    captions:{enabled:b.captions,style:'safe-area-branded',maxLines:2},
    effects:['motion-blur','speed-ramp','depth-parallax','kinetic-type','film-grain','3d-depth'],
    assets:{provenanceRequired:true,licenseRequired:true,clientAssetsPreserved:true},
    safety:{noInventedClaims:true,noUnlicensedAssets:true}
  };
}
export function validateVideoDesign(s={}) {
  const f=[],b=s.brief||{},sb=s.storyboard||[];
  if(!VIDEO_GENRES.includes(b.genre)) f.push('unsupported-genre');
  if(!s.format?.width) f.push('format');
  if(!sb.length) f.push('storyboard');
  if(Math.abs(sb.reduce((n,x)=>n+x.durationSec,0)-b.duration)>.2) f.push('duration-mismatch');
  if(sb.some(x=>x.durationSec<=0||!VIDEO_SHOT_TYPES.includes(x.shot))) f.push('scene-contract');
  if(s.captions?.enabled&&sb.some(x=>x.captionSafe!==true)) f.push('caption-safe-area');
  if(s.assets?.provenanceRequired!==true||s.assets?.licenseRequired!==true) f.push('asset-provenance');
  if(s.safety?.noInventedClaims!==true) f.push('claims-policy');
  if(s.safety?.noUnlicensedAssets!==true) f.push('asset-license-policy');
  const intelligenceQa=validateCreativeIntelligence(s.intelligence);
  if(!intelligenceQa.passed) f.push(...intelligenceQa.failures.map(x=>`intelligence:${x}`));
  return {passed:!f.length,failures:f};
}
export function buildVideoProject(input={}) {
  const spec=createVideoDesignSpec(input),qa=validateVideoDesign(spec);
  return {type:'video',engine:'professional-creative-engine',spec,qa,status:qa.passed?'READY_FOR_RENDER':'BLOCKED'};
}
