// agent/operating-modes.js
// Fail-closed operating policy for Nexora's research -> draft -> human approval workflow.
// No customer communication, publishing, payment, invoice issuance or deletion is enabled here.
const MODES = new Set(['research', 'draft']);
const RESEARCH_TOOLS = new Set(['browser_navigate','browser_snapshot','browser_hover','browser_get_text','browser_get_page_info','browser_screenshot','browser_tabs','browser_new_tab','browser_close_tab','browser_wait_for','browser_wait_for_text','browser_wait_ms','web_search','analyze_prospect_page','analyze_opportunity']);
const DRAFT_TOOLS = new Set(['generate_website','save_prospect','save_opportunity','create_sample','save_sample','generate_proposal','save_proposal','prepare_outreach']);
const APPROVAL_TOOLS = new Set(['browser_click','browser_type','browser_fill','browser_select_option','browser_press','browser_upload_file','browser_drag','request_human_approval']);
const BLOCKED_URL_SEGMENTS = new Set(['login','signin','sign-in','logout','admin','checkout','payment','payments','billing','account','oauth','authorize']);
const BLOCKED_PAYMENT_HOSTS = ['stripe.com','paypal.com','squareup.com','adyen.com','paystack.com','flutterwave.com'];
const EXTERNAL_ACTION_HINTS = /\b(send|submit|publish|pay|purchase|delete|charge|refund|invoice|email|whatsapp|sms|message|checkout|billing|place\s+order|confirm\s+order)\b/i;
const SENSITIVE_FIELD_HINTS = /\b(password|passcode|card|cvv|cvc|security code|secret|token|api key|private key)\b/i;
function deny(mode, reason) { return { allow:false, requiresApproval:false, mode, reason }; }
function allow(mode, reason, requiresApproval=false, approvalContext=null) { return { allow:true, requiresApproval, mode, reason, approvalContext }; }
function isPrivateIpv4(host) {
  const match=String(host).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if(!match)return false;
  const octets=match.slice(1).map(Number); if(octets.some(n=>n<0||n>255))return true;
  const [a,b]=octets;
  return a===0||a===10||a===127||a>=224||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===100&&b>=64&&b<=127)||(a===198&&(b===18||b===19));
}
export function resolveAgentMode(value=process.env.NEXORA_AGENT_MODE) {
  const mode=String(value||'draft').trim().toLowerCase();
  return MODES.has(mode)?mode:'research';
}
export function isSafeResearchUrl(value) {
  if(typeof value!=='string'||!value.trim())return false;
  try {
    const url=new URL(value); if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return false;
    const host=url.hostname.toLowerCase().replace(/^\[|\]$/g,'');
    if(!host||host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host.endsWith('.internal')||host==='metadata.google.internal')return false;
    if(isPrivateIpv4(host)||host==='::1'||host.startsWith('fc')||host.startsWith('fd')||host.startsWith('fe80'))return false;
    if(BLOCKED_PAYMENT_HOSTS.some(domain=>host===domain||host.endsWith(`.${domain}`)))return false;
    const segments=url.pathname.split('/').filter(Boolean).map(part=>decodeURIComponent(part).toLowerCase());
    if(segments.some(part=>BLOCKED_URL_SEGMENTS.has(part)))return false;
    if([...url.searchParams.keys()].some(key=>['token','password','secret','session','authorization','code'].includes(key.toLowerCase())))return false;
    return true;
  } catch { return false; }
}
function findTargetElement(observation,target) {
  const elements=Array.isArray(observation?.elements)?observation.elements:[];
  return elements.find(element=>String(element?.ref||element?.id||'')===String(target||''))||null;
}
function describeTarget(element) {
  if(!element)return null;
  const label=[element.text,element.ariaLabel,element.label,element.title,element.name].filter(value=>typeof value==='string'&&value.trim()).join(' ').trim().slice(0,180);
  return {ref:element.ref||element.id||null,tag:element.tag||element.tagName||null,role:element.role||null,type:element.type||null,label:label||null,href:element.href||null};
}
export function evaluateAgentAction({mode,tool,args={},observation=null}={}) {
  const activeMode=resolveAgentMode(mode); const name=String(tool||'').trim();
  if(!name)return deny(activeMode,'Tool name is required.');
  if(name==='task_complete'||name==='task_fail')return allow(activeMode,'Task lifecycle action.');
  if(name==='browser_evaluate')return deny(activeMode,'Arbitrary page JavaScript is disabled in Nexora operating modes.');
  if(name==='browser_navigate'||name==='browser_new_tab') {
    if(args.url&&!isSafeResearchUrl(args.url))return deny(activeMode,'Only public HTTP(S) research URLs are allowed; private, login/account/admin, checkout and payment destinations are blocked.');
    if(name==='browser_navigate'&&!args.url)return deny(activeMode,'A public URL is required for navigation.');
    return allow(activeMode,'Public read-only browsing.');
  }
  if(RESEARCH_TOOLS.has(name))return allow(activeMode,'Read-only research action.');
  if(DRAFT_TOOLS.has(name))return activeMode==='draft'?allow(activeMode,'Internal draft or sample creation; no external delivery.'):deny(activeMode,'Draft creation is disabled in research-only mode.');
  if(APPROVAL_TOOLS.has(name)) {
    if(activeMode!=='draft')return deny(activeMode,'Browser interaction requires draft mode and a human approval checkpoint.');
    if(name==='browser_press'&&/^(enter|return)$/i.test(String(args.key||'')))return deny(activeMode,'Enter/Return can submit a form; form submission is blocked.');
    if(['browser_click','browser_type','browser_fill','browser_select_option','browser_upload_file'].includes(name)) {
      const element=findTargetElement(observation,args.target); if(!element)return deny(activeMode,'Target must match a visible element in the current browser snapshot.');
      const context=describeTarget(element); const labelAndHref=`${context?.label||''} ${context?.href||''}`;
      if(EXTERNAL_ACTION_HINTS.test(labelAndHref))return deny(activeMode,'Customer communication, publishing, payment, invoice and destructive controls are blocked.');
      if(SENSITIVE_FIELD_HINTS.test(`${context?.label||''} ${context?.type||''}`))return deny(activeMode,'Credential and payment fields are blocked from agent interaction.');
      if(context?.href&&!isSafeResearchUrl(context.href))return deny(activeMode,'The selected element points to a restricted destination.');
      return allow(activeMode,'Visible browser target requires human approval before interaction.',true,{pageUrl:observation?.url||null,pageTitle:observation?.title||null,target:context});
    }
    if(name==='browser_drag') {
      const start=findTargetElement(observation,args.startTarget),end=findTargetElement(observation,args.endTarget);
      if(!start||!end)return deny(activeMode,'Drag targets must match visible elements in the current browser snapshot.');
      return allow(activeMode,'Browser drag requires human approval.',true,{pageUrl:observation?.url||null,pageTitle:observation?.title||null,startTarget:describeTarget(start),endTarget:describeTarget(end)});
    }
    return allow(activeMode,'Browser interaction requires human approval.',true,{pageUrl:observation?.url||null,pageTitle:observation?.title||null});
  }
  return deny(activeMode,`Tool ${name} is not included in the research/draft allowlist.`);
}
