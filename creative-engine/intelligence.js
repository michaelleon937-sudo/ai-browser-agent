import { buildArtDirectionMatrix, rankDesignDirections, resolveDesignDirection } from '../website-engine/design-library.js';

const clean = value => String(value ?? '').trim();

export const CREATIVE_INDUSTRY_PROFILES = Object.freeze({
  luxury:{categories:['luxury','fashion'],visualPriority:'refinement',motion:'restrained-cinematic'},
  fashion:{categories:['fashion','creative'],visualPriority:'art-direction',motion:'editorial'},
  hospitality:{categories:['hospitality','luxury'],visualPriority:'experience',motion:'slow-cinematic'},
  realestate:{categories:['realestate','architecture'],visualPriority:'space-and-trust',motion:'cinematic-walkthrough'},
  architecture:{categories:['architecture','realestate'],visualPriority:'form-and-material',motion:'architectural'},
  automotive:{categories:['automotive','luxury'],visualPriority:'precision',motion:'camera-kinetic'},
  community:{categories:['community','creative'],visualPriority:'human-connection',motion:'warm-cinematic'},
  corporate:{categories:['corporate','saas'],visualPriority:'clarity-and-trust',motion:'precision'},
  saas:{categories:['saas','futuristic'],visualPriority:'product-clarity',motion:'interface-motion'},
  commerce:{categories:['commerce','fashion','luxury'],visualPriority:'product-and-conversion',motion:'product-reveal'}
});

export function createCreativeIntelligence(input={}) {
  const brief=typeof input==='string'?{description:input}:input;
  const industry=clean(brief.industry).toLowerCase();
  const profile=CREATIVE_INDUSTRY_PROFILES[industry]||null;
  const ranked=rankDesignDirections(brief);
  const preferred=profile?ranked.filter(d=>profile.categories.includes(d.category)):ranked;
  const directions=(preferred.length?preferred:ranked).slice(0,5);
  return {
    industry,
    audience:clean(brief.audience),
    goal:clean(brief.goal||brief.objective||brief.conversionGoal),
    platform:clean(brief.platform),
    premium:Boolean(brief.premium||brief.luxury||/luxury|premium|high-end/i.test(JSON.stringify(brief))),
    profile,
    primaryDirection:resolveDesignDirection(directions[0]?.name||''),
    artDirectionMatrix:buildArtDirectionMatrix(brief,5),
    rankedDirections:directions,
    rules:{audienceFirst:true,goalDriven:true,platformAware:true,preserveBrandAssets:true,noInventedClaims:true,noUnlicensedAssets:true,accessibilityAware:true,reducedMotionFallback:true}
  };
}

export function validateCreativeIntelligence(intelligence={}) {
  const failures=[];
  if(!intelligence.primaryDirection?.name) failures.push('missing-primary-direction');
  if(!Array.isArray(intelligence.artDirectionMatrix)||!intelligence.artDirectionMatrix.length) failures.push('missing-art-direction-matrix');
  for(const key of ['noInventedClaims','noUnlicensedAssets','accessibilityAware']) if(intelligence.rules?.[key]!==true) failures.push(key);
  return {passed:failures.length===0,failures};
}
