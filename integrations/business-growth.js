// integrations/business-growth.js
// Business growth orchestration built on the existing CRM, opportunity, memory,
// scheduler, website, creative and approval primitives.
import { nanoid } from 'nanoid';
import { tasks, prospects, opportunities, conversations, clientMemory, conversationInsights, inboundMessages } from '../database/index.js';
import { analyzeOpportunity } from './opportunity-intelligence.js';
import { recommendNextAction } from './next-action.js';
import { generateA2ReplyDraft } from './a2-reply-draft.js';

const MAX_SCAN = 200;
const AUTOPILOT_MODES = Object.freeze({ COPILOT:'COPILOT', AUTOPILOT:'AUTOPILOT', AUTONOMOUS:'AUTONOMOUS' });
const CHANNELS = new Set(['whatsapp','email','website','telegram','browser','social','video','crm']);
const clean = (v, fallback='') => String(v ?? '').trim() || fallback;
const clamp = (n,min,max) => Math.max(min,Math.min(max,Number(n)||0));
const sinceDays = (v) => { if(!v)return null; const ms=Date.now()-new Date(v).getTime(); return Number.isFinite(ms)?Math.max(0,Math.floor(ms/86400000)):null; };
const parse = (v,fallback) => { if(v==null)return fallback; if(typeof v==='object')return v; try{return JSON.parse(v);}catch{return fallback;} };
const channels = (v) => [...new Set((Array.isArray(v)?v:String(v||'').split(',')).map(x=>String(x).trim().toLowerCase()).filter(x=>CHANNELS.has(x)))];

export function createRevenueHunter({name='AI Revenue Hunter',targetMarket,idealCustomer,offer,geography='global',maxProspects=20,channels:requested=['browser'],cronExpression,timezone}={}){
  if(!targetMarket&&!idealCustomer&&!offer)throw new Error('Revenue Hunter requires targetMarket, idealCustomer, or offer');
  const selected=channels(requested);
  const goal=[
    'AI Revenue Hunter: research and qualify new business opportunities.',
    'Target market: '+clean(targetMarket,'businesses with a commercial growth need')+'.',
    'Ideal customer: '+clean(idealCustomer,'qualified businesses')+'.',
    'Geography: '+clean(geography,'global')+'.',
    'Offer: '+clean(offer,'website, creative, automation, marketing, or AI services')+'.',
    'Maximum prospects per run: '+clamp(maxProspects,1,100)+'.',
    'Verify public evidence, never invent contact details, score fit, and prepare a personalized next action.',
    'Do not send unsolicited outreach, spend money, purchase anything, or deploy production changes without existing approval gates.'
  ].join(' ');
  const task=tasks.create({name,goal,cronExpression:cronExpression||null,timezone:timezone||null,metadata:{feature:'AI_REVENUE_HUNTER',version:1,targetMarket:clean(targetMarket),idealCustomer:clean(idealCustomer),offer:clean(offer),geography, maxProspects:clamp(maxProspects,1,100),channels:selected,autonomy:'research_and_prepare_only'}});
  return {ok:true,feature:'AI_REVENUE_HUNTER',task,goal,externalSideEffect:false};
}

export function buildAutopilot({goal,mode=AUTOPILOT_MODES.AUTOPILOT,successMetrics=[],allowedActions=[],approvalThresholds={},cronExpression,timezone}={}){
  if(!clean(goal))throw new Error('Business Autopilot requires a goal');
  if(!Object.values(AUTOPILOT_MODES).includes(mode))throw new Error('Unsupported autopilot mode: '+mode);
  const task=tasks.create({
    name:'AI Business Autopilot — '+clean(goal).slice(0,70),
    goal:[
      'Business Autopilot mode='+mode+'. Goal: '+clean(goal)+'.',
      'Success metrics: '+(Array.isArray(successMetrics)?successMetrics:[successMetrics]).filter(Boolean).join('; '),
      'Allowed actions: '+(Array.isArray(allowedActions)?allowedActions:[allowedActions]).filter(Boolean).join(', '),
      'Approval thresholds: '+JSON.stringify(approvalThresholds||{})+'.',
      'Use existing CRM, memory, opportunity, creative, website and communication capabilities.',
      'Never bypass existing approval, security, payment, external-send, or production-deploy controls.'
    ].join(' '),
    cronExpression:cronExpression||null,timezone:timezone||null,
    metadata:{feature:'AI_BUSINESS_AUTOPILOT',version:1,mode,successMetrics,allowedActions,approvalThresholds,autonomy:mode===AUTOPILOT_MODES.AUTONOMOUS?'bounded_autonomous':mode.toLowerCase()}
  });
  return {ok:true,feature:'AI_BUSINESS_AUTOPILOT',mode,task,externalSideEffect:false};
}

export function runOpportunityRadar({limit=MAX_SCAN,minScore=0,notify=false}={}){
  const rows=prospects.list({limit:clamp(limit,1,MAX_SCAN)}), results=[];
  for(const prospect of rows){
    const analysis=analyzeOpportunity(prospect); if(analysis.score<Number(minScore||0))continue;
    const existing=opportunities.getOpportunitiesForProspect(prospect.id,{limit:1})[0];
    const opportunity=existing||opportunities.createOpportunity({
      prospectId:prospect.id,score:analysis.score,priority:analysis.priority,opportunityType:analysis.opportunityType,summary:analysis.summary,
      identifiedProblems:analysis.identifiedProblems,recommendedServices:analysis.recommendedServices,
      recommendedActions:[analysis.recommendedSampleReason,'qualify lead','prepare personalized follow-up'].filter(Boolean),
      recommendedSampleType:analysis.recommendedSampleType,recommendedSampleReason:analysis.recommendedSampleReason,
      estimatedValue:analysis.estimatedValue,confidence:analysis.confidence,status:'NEW'
    });
    results.push({prospect,analysis,opportunity,isNew:!existing});
  }
  results.sort((a,b)=>b.analysis.score-a.analysis.score);
  return {ok:true,feature:'OPPORTUNITY_RADAR',scanned:rows.length,opportunities:results,
    alerts:notify?results.filter(x=>['HIGH','MEDIUM'].includes(x.analysis.priority)).map(x=>({priority:x.analysis.priority,prospectId:x.prospect.id,businessName:x.prospect.business_name,score:x.analysis.score,summary:x.analysis.summary})):[],
    externalSideEffect:false};
}

function memoryFor(conversation){
  const insight=conversationInsights.get(conversation.id);
  const rows=clientMemory.list({companyId:conversation.company_id,contactId:conversation.contact_id,prospectId:conversation.prospect_id,limit:100});
  return {summary:conversation.summary||insight?.summary||null,intent:insight?.current_intent||null,classification:insight?.current_classification||null,requestedService:insight?.requested_service||null,requestedDeliverables:insight?.requested_deliverables||null,deadline:insight?.deadline||null,budget:insight?.budget||null,unresolved:parse(insight?.unresolved_questions_json,[]),facts:Object.fromEntries(rows.map(r=>[r.key,{value:r.value,confidence:r.confidence,source:r.source}]))};
}

export async function getFollowUps({limit=MAX_SCAN,minDays=3,includeDrafts=true}={}){
  const rows=conversations.list({limit:clamp(limit,1,MAX_SCAN),status:'OPEN'}), due=[];
  for(const conversation of rows){
    const staleDays=sinceDays(conversation.last_message_at||conversation.updated_at); if(staleDays==null||staleDays<Number(minDays||3))continue;
    const latest=inboundMessages.list({conversationId:conversation.id,limit:1})[0]||null, memory=memoryFor(conversation);
    const nextAction=recommendNextAction({classification:memory.classification||latest?.classification,intent:memory.intent||latest?.intent,requestedService:memory.requestedService,unresolvedQuestions:memory.unresolved,messageCount:Number(conversation.message_count||0)});
    let draft=null;
    if(includeDrafts&&latest?.body){try{const generated=await generateA2ReplyDraft({conversationId:conversation.id,messageText:latest.body,context:{...memory,nextAction}});if(generated?.ok&&generated.draft)draft=generated.draft;}catch{}}
    due.push({conversation,staleDays,memory,nextAction,draft,requiresApproval:Boolean(draft)});
  }
  due.sort((a,b)=>b.staleDays-a.staleDays);
  return {ok:true,feature:'FOLLOW_UP_CUSTOMER_MEMORY',count:due.length,followUps:due,externalSideEffect:false};
}

export function getCustomerMemory({companyId,contactId,prospectId,limit=100}={}){
  const rows=clientMemory.list({companyId,contactId,prospectId,limit:clamp(limit,1,200)}),rank={CONFIRMED_BY_CLIENT:3,CONFIRMED_BY_SYSTEM:2,INFERRED:1,UNKNOWN:0},best={};
  for(const row of rows){const prev=best[row.key];if(!prev||(rank[row.confidence]||0)>(rank[prev.confidence]||0))best[row.key]=row;}
  return {ok:true,feature:'FOLLOW_UP_CUSTOMER_MEMORY',facts:rows,authoritative:Object.fromEntries(Object.entries(best).map(([k,v])=>[k,{value:v.value,confidence:v.confidence,source:v.source,updatedAt:v.updated_at}])),externalSideEffect:false};
}

export function buildMarketingCampaign({brief,objective,audience,offer,channels:requested,launchWindow,budget}={}){
  if(!clean(brief))throw new Error('Marketing campaign brief is required');
  const allowed=['website','whatsapp','email','social','video','crm'],selected=(Array.isArray(requested)?requested:allowed).map(x=>String(x).toLowerCase()).filter(x=>allowed.includes(x)),finalChannels=[...new Set(selected.length?selected:allowed)];
  return {ok:true,feature:'ONE_BRIEF_FULL_MARKETING_CAMPAIGN',campaignId:'campaign_'+nanoid(10),brief:clean(brief),objective:clean(objective,'generate qualified demand and measurable revenue'),audience:clean(audience,'defined from the brief and validated through research'),offer:clean(offer,'derived from the brief; pricing remains human-controlled'),channels:finalChannels,launchWindow:clean(launchWindow,'not specified'),budget:budget??null,
    stages:[
      {stage:1,name:'Strategy',deliverables:['audience definition','offer positioning','message hierarchy','success metrics']},
      {stage:2,name:'Conversion Surface',deliverables:['landing page or website section','lead form','CRM capture','tracking plan']},
      {stage:3,name:'Creative System',deliverables:['hero creative','social variants','short-form video concept','brand-safe copy']},
      {stage:4,name:'Conversation',deliverables:['WhatsApp response flows','email sequence drafts','FAQ/objection handling','follow-up rules']},
      {stage:5,name:'Measurement',deliverables:['lead funnel metrics','opportunity radar signals','follow-up queue','owner briefing']}
    ],automation:{website:finalChannels.includes('website'),whatsapp:finalChannels.includes('whatsapp'),email:finalChannels.includes('email'),social:finalChannels.includes('social'),video:finalChannels.includes('video'),crm:true,opportunityRadar:true,followUpMemory:true},
    approvals:['external outreach/send','paid media spend','payment/charge','production deployment','material customer-facing claims/pricing'],externalSideEffect:false};
}

export function createCampaignTask(args={}){
  const blueprint=buildMarketingCampaign(args);
  const task=tasks.create({name:'Marketing Campaign — '+blueprint.campaignId,goal:'Execute the approved campaign blueprint through existing website, creative, CRM, WhatsApp/email drafting, opportunity radar, and follow-up capabilities. Campaign: '+blueprint.brief+'. Objective: '+blueprint.objective+'. Channels: '+blueprint.channels.join(', ')+'. All irreversible external actions remain subject to existing approval gates.',cronExpression:args.cronExpression||null,timezone:args.timezone||null,metadata:{feature:'ONE_BRIEF_FULL_MARKETING_CAMPAIGN',version:1,blueprint}});
  return {...blueprint,task,externalSideEffect:false};
}

export const businessGrowthTools={
  'growth.revenue_hunter':createRevenueHunter,
  'growth.autopilot':buildAutopilot,
  'growth.opportunity_radar':runOpportunityRadar,
  'growth.follow_ups':getFollowUps,
  'growth.customer_memory':getCustomerMemory,
  'growth.campaign_blueprint':buildMarketingCampaign,
  'growth.campaign_task':createCampaignTask,
};
export { AUTOPILOT_MODES };
