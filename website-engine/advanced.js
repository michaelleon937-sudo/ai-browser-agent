import crypto from 'node:crypto';

const clean = (value) => String(value ?? '').trim();

export const RESPONSIVE_BREAKPOINTS = Object.freeze({ xs: 0, sm: 480, md: 768, lg: 1024, xl: 1440, xxl: 1920 });
export const VIEWPORT_MATRIX = Object.freeze([
  { name: 'mobile', width: 390, height: 844, orientation: 'portrait' },
  { name: 'mobile-landscape', width: 844, height: 390, orientation: 'landscape' },
  { name: 'tablet', width: 768, height: 1024, orientation: 'portrait' },
  { name: 'desktop', width: 1440, height: 900, orientation: 'landscape' },
  { name: 'wide', width: 1920, height: 1080, orientation: 'landscape' },
]);

export function createResponsiveSystem(spec = {}) {
  return { version:'1.0.0', breakpoints:RESPONSIVE_BREAKPOINTS, container:{minGutter:'20px',maxWidth:'1200px',fluidWidth:'90vw'}, layout:{mobile:'single-column',tablet:'adaptive-grid',desktop:'multi-column',wide:'max-width-constrained'}, typeScale:{min:'clamp(.9rem,.82rem + .35vw,1.15rem)',display:'clamp(3rem,8vw,8rem)'}, spacing:[8,16,24,32,48,64,96,128], touchTarget:44, overflowPolicy:'no-horizontal-scroll', mediaPolicy:'responsive-images-and-video', motionPolicy:'reduced-motion-aware', direction:clean(spec.designDirection?.name||spec.designDirection||'') };
}

export function createVisualRuntimeManifest(spec = {}, media = {}) {
  const required3D=Boolean(spec.threeD?.required);
  return { version:'1.0.0', renderer:required3D?'progressive-webgl':'dom-first', threeD:{enabled:required3D,strategy:required3D?'capability-detected progressive runtime':'disabled',fallback:spec.threeD?.mobileFallback||'static-image',reducedMotion:'disable-or-freeze-animation',assetContract:'GLTF-ready'}, motion:{language:clean(spec.motionLanguage||'subtle transitions'),reducedMotion:true,pointerInteraction:required3D}, media:{images:Array.isArray(media.images)?media.images.length:0,videos:Array.isArray(media.videos)?media.videos.length:0,lazy:true,posterRequired:true,mobileFallback:true}, security:{noInlineSecrets:true,noDynamicCodeExecution:true} };
}

export function createInformationArchitecture(brief = {}, spec = {}, content = {}) {
  const pages=Array.isArray(spec.pages)?spec.pages:[];
  const labels=pages.map(page=>({id:clean(page),label:clean(page).replace(/-/g,' ').replace(/\b\w/g,m=>m.toUpperCase()),path:page==='home'?'/':'/'+page,intent:page==='contact'?'conversion':page==='about'?'trust':'information'}));
  return {version:'1.0.0',primaryNavigation:labels,hierarchy:{maxPrimaryItems:7,breadcrumbs:pages.length>4,footerNavigation:true},contentModel:{separateContentFromComponents:true,structuredPerPage:true,placeholderPolicy:'never-invent-client-facts'},conversion:{primary:clean(brief.conversionGoal||brief.goal||spec.primaryObjective),contactRoute:'/api/website/leads'},generatedPages:Object.keys(content.pages||{})};
}

export function createCrmManifest(brief = {}, spec = {}) {
  const destination=clean(brief.crmDestination);
  return {version:'1.0.0',enabled:true,endpoint:'/api/website/leads',method:'POST',fields:[{name:'name',type:'text',required:true},{name:'email',type:'email',required:true},{name:'phone',type:'tel',required:false},{name:'message',type:'textarea',required:true},{name:'consent',type:'checkbox',required:true}],destination:destination||'application-lead-route',handoff:destination?'configured-destination-deferred-to-server-adapter':'server-route',industry:clean(spec.industry)};
}

export function validateResponsiveOutput(site = {}) {
  const css=site.files?.['styles.css']||'',html=site.files?.['index.html']||'',failures=[];
  if(!css.includes('@media'))failures.push('responsive-media-queries');
  if(!/@media\s*\(max-width:\s*800px\)/.test(css))failures.push('mobile-breakpoint');
  if(!html.includes('name="viewport"'))failures.push('viewport-meta');
  if(!css.includes('grid-template-columns:1fr'))failures.push('mobile-single-column');
  if(css.includes('overflow-x:hidden'))failures.push('forced-overflow-hiding');
  return {passed:failures.length===0,failures,breakpoints:Object.keys(RESPONSIVE_BREAKPOINTS).length};
}

export function validateVisualRuntime(site = {}) {
  const css=site.files?.['styles.css']||'',js=site.files?.['app.js']||'',failures=[];
  if(site.spec?.threeD?.required&&!js.includes('canWebGL'))failures.push('webgl-capability-detection');
  if(site.spec?.threeD?.required&&!js.includes('scene-fallback'))failures.push('3d-fallback');
  if(!css.includes('prefers-reduced-motion'))failures.push('reduced-motion-css');
  if(site.spec?.threeD?.required&&!js.includes('pointerdown'))failures.push('pointer-interaction');
  return {passed:failures.length===0,failures};
}

export function validateContentArchitecture(site = {}) {
  const failures=[],pages=site.content?.pages||{};
  if(!Object.keys(pages).length)failures.push('content-pages');
  if(!site.designSystem)failures.push('design-system');
  return {passed:failures.length===0,failures,pageCount:Object.keys(pages).length};
}

export function validateSeoAccessibilityPerformance(site = {}) {
  const html=site.files?.['index.html']||'',css=site.files?.['styles.css']||'',js=site.files?.['app.js']||'',failures=[];
  if(!/<html[^>]+lang="[^"]+"/i.test(html))failures.push('html-lang');
  if(!/<title>[^<]+<\/title>/i.test(html))failures.push('title');
  if(!html.includes('name="description"'))failures.push('meta-description');
  if(!html.includes('rel="canonical"'))failures.push('canonical');
  if(!html.includes('application/ld+json'))failures.push('structured-data');
  if(!site.files?.['sitemap.xml'])failures.push('sitemap');
  if(!site.files?.['robots.txt'])failures.push('robots');
  if(/<img\b/i.test(html)&&!/loading="lazy"/i.test(html))failures.push('lazy-images');
  if(/<img\b/i.test(html)&&!/alt="/i.test(html))failures.push('image-alt');
  if(!css.includes(':focus-visible'))failures.push('focus-visible');
  if(!css.includes('prefers-reduced-motion'))failures.push('reduced-motion');
  if(js.includes('eval(')||js.includes('new Function('))failures.push('dynamic-code-execution');
  return {passed:failures.length===0,failures,seo:true,accessibility:true,performance:true};
}

export function createRevisionPatch(request = {}) {
  const type=clean(request.type||'general').toLowerCase(),target=clean(request.target||'site'),instruction=clean(request.instruction);
  if(!instruction)throw new Error('revision instruction is required');
  const allowed=new Set(['content','copy','style','visual','layout','media','seo','general','qa']);
  return {revisionId:'patch_'+crypto.createHash('sha256').update(type+':'+target+':'+instruction).digest('hex').slice(0,16),type:allowed.has(type)?type:'general',target,instruction,value:request.value==null?null:clean(request.value),deterministic:true};
}

export function summarizeRevisionImpact(before = {}, after = {}) {
  const a=before.files||{},b=after.files||{},files=[...new Set([...Object.keys(a),...Object.keys(b)])],changed=files.filter(f=>(a[f]||'')!==(b[f]||''));
  return {changedFiles:changed,changedCount:changed.length};
}

export function selfCritiqueWebsite(site = {}) {
  const checks={responsive:validateResponsiveOutput(site),visualRuntime:validateVisualRuntime(site),content:validateContentArchitecture(site),seoAccessibilityPerformance:validateSeoAccessibilityPerformance(site)};
  const failures=[...new Set(Object.values(checks).flatMap(r=>r.failures||[]))];
  return {passed:failures.length===0,score:Math.max(0,100-failures.length*5),checks,failures,repairable:failures.filter(x=>x!=='dynamic-code-execution')};
}

export function buildRepairPlan(critique = {}) {
  const map={'responsive-media-queries':'Add responsive media-query coverage without changing content.','mobile-breakpoint':'Restore mobile breakpoint behavior.','viewport-meta':'Restore the responsive viewport meta tag.','webgl-capability-detection':'Restore WebGL capability detection and fallback.','3d-fallback':'Restore accessible 3D fallback behavior.','reduced-motion-css':'Restore reduced-motion CSS.','pointer-interaction':'Restore pointer interaction only when supported.','content-pages':'Restore structured page content.','html-lang':'Restore semantic document language metadata.','title':'Restore a meaningful page title.','meta-description':'Restore the page description metadata.','canonical':'Restore canonical metadata.','structured-data':'Restore valid structured data.','sitemap':'Restore sitemap output.','robots':'Restore robots policy output.','lazy-images':'Restore lazy-loading for images.','image-alt':'Restore meaningful image alt text.','focus-visible':'Restore visible keyboard focus styling.'};
  const repairs=(critique.failures||[]).map(failure=>({failure,instruction:map[failure]||('Repair '+failure+'.'),automatic:Boolean(map[failure])}));
  return {repairCount:repairs.length,repairs};
}

export function certifyWebsite(site = {}, project = null) {
  const critique=selfCritiqueWebsite(site),qa=site.qa||{},gates={generated:Boolean(site.files?.['index.html']&&site.files?.['styles.css']&&site.files?.['app.js']),responsive:critique.checks.responsive.passed,visualRuntime:critique.checks.visualRuntime.passed,content:critique.checks.content.passed,seoAccessibilityPerformance:critique.checks.seoAccessibilityPerformance.passed,quality:(qa.quality?.failures||[]).length===0,security:(qa.security?.failures||[]).length===0,visualQa:(qa.visual?.failures||[]).length===0,approvalGated:project?['APPROVED','DEPLOYMENT_PENDING','DEPLOYED','DELIVERED'].includes(project.state):true};
  const failedGates=Object.entries(gates).filter(([,passed])=>!passed).map(([name])=>name);
  return {certified:failedGates.length===0,status:failedGates.length===0?'CERTIFIED':'BLOCKED',gates,failedGates,score:critique.score,engine:'commercial-production',secretsIncluded:false};
}

export function buildCommercialManifest(site = {}, project = null) {
  return {certification:certifyWebsite(site,project),projectId:project?.projectId||null,state:project?.state||'DRAFT',version:project?.versions?.at(-1)?.version||1,artifacts:Object.keys(site.files||{}),channels:['web'],deployment:'approval-gated',generatedAt:new Date().toISOString()};
}
