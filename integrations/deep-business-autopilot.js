// integrations/deep-business-autopilot.js
// Phase 9 — Deep CRM ecosystem + durable long-running autonomous business loops.
// Provider-neutral: external credentials/actions remain behind adapters.
// No external send, charge, purchase, or deployment is performed here.
import { nanoid } from 'nanoid';
import { getDb, tasks, companies, contacts, conversations, inboundMessages, clientMemory, relationshipStates, clientTimelineEvents, clientRevenueSnapshots, followUpRecommendations, opportunities, invoices, payments, projects } from '../database/index.js';
const SYSTEMS=Object.freeze(['crm','accounting','sales_engagement','calendar','payments','support']);
const STATUSES=Object.freeze(['PLANNED','CONNECTED','PAUSED','ERROR']);
const LOOP_MODES=Object.freeze(['COPILOT','AUTOPILOT','BOUNDED_AUTONOMOUS']);
const MAX_DAYS=365;
const now=()=>new Date().toISOString();
const clean=(v,fallback='')=>String(v??'').trim()||fallback;
const arr=v=>Array.isArray(v)?v:(v==null?[]:[v]);
const obj=(v,fallback={})=>v&&typeof v==='object'?v:fallback;
const json=(v,fallback)=>{try{return v==null?fallback:JSON.parse(v);}catch{return fallback;}};
const clamp=(n,min,max)=>Math.max(min,Math.min(max,Number(n)||0));
export function registerDeepCRMIntegration({system,provider,status='PLANNED',capabilities=[],config={}}={}){
 system=clean(system).toLowerCase();provider=clean(provider);
 if(!SYSTEMS.includes(system))throw new Error('Unsupported integration system: '+system);
 if(!provider)throw new Error('Integration provider is required');
 if(!STATUSES.includes(status))throw new Error('Unsupported integration status: '+status);
 const timestamp=now(),id=nanoid(12),existing=getDb().prepare('SELECT * FROM external_integrations WHERE system=? AND provider=?').get(system,provider);
 if(existing){getDb().prepare('UPDATE external_integrations SET status=?,capabilities_json=?,config_json=?,updated_at=? WHERE id=?').run(status,JSON.stringify(arr(capabilities)),JSON.stringify(obj(config)),timestamp,existing.id);return getDb().prepare('SELECT * FROM external_integrations WHERE id=?').get(existing.id);}
 getDb().prepare('INSERT INTO external_integrations(id,system,provider,status,capabilities_json,config_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id,system,provider,status,JSON.stringify(arr(capabilities)),JSON.stringify(obj(config)),timestamp,timestamp);
 return getDb().prepare('SELECT * FROM external_integrations WHERE id=?').get(id);
}
export function listDeepCRMIntegrations({system,status}={}){
 const where=[],params=[];if(system){where.push('system=?');params.push(String(system).toLowerCase());}if(status){where.push('status=?');params.push(status);}
 return getDb().prepare('SELECT * FROM external_integrations '+(where.length?'WHERE '+where.join(' AND '):'')+' ORDER BY system,provider').all(...params).map(r=>({...r,capabilities:json(r.capabilities_json,[]),config:json(r.config_json,{})}));
}
export function queueCRMSync({integrationId,entityType,entityId,direction='OUTBOUND',action='UPSERT',externalId=null,payload={}}={}){
 if(!integrationId)throw new Error('integrationId is required');if(!clean(entityType))throw new Error('entityType is required');
 const id=nanoid(14),timestamp=now();getDb().prepare('INSERT INTO crm_sync_events(id,integration_id,entity_type,entity_id,direction,action,status,external_id,payload_json,occurred_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,integrationId,entityType,entityId||null,direction,action,'QUEUED',externalId,payload?JSON.stringify(payload):null,timestamp,timestamp);return getDb().prepare('SELECT * FROM crm_sync_events WHERE id=?').get(id);
}
export function getCustomer360({companyId,contactId,prospectId}={}){
 if(!companyId&&!contactId&&!prospectId)throw new Error('companyId, contactId, or prospectId is required');
 const company=companyId?companies.get(companyId):null,contact=contactId?contacts.get(contactId):null,conversationRows=conversations.list({limit:100,companyId,contactId,prospectId}),messages=[];
 for(const c of conversationRows)messages.push(...inboundMessages.list({conversationId:c.id,limit:100}));
 const memory=clientMemory.list({limit:200,companyId,contactId,prospectId}),relationship=relationshipStates.getCurrent({companyId,contactId,prospectId}),timeline=clientTimelineEvents.list({companyId,contactId,prospectId,limit:200}),followUps=followUpRecommendations.list({companyId,contactId,prospectId,status:'OPEN',limit:100}),revenue=clientRevenueSnapshots.getLatest({companyId,contactId,prospectId}),opps=prospectId?opportunities.getOpportunitiesForProspect(prospectId,{limit:50}):[],invoiceRows=companyId?invoices.list({limit:100,companyId}):[],paymentRows=invoiceRows.flatMap(i=>payments.list({limit:100,invoiceId:i.id})),projectRows=projects.list({limit:100,companyId});
 return {ok:true,company,contact,conversations:conversationRows,messages:messages.sort((a,b)=>String(a.received_at).localeCompare(String(b.received_at))),memory,relationship,timeline,followUps,revenue,opportunities:opps,invoices:invoiceRows,payments:paymentRows,projects:projectRows,systems:SYSTEMS,externalSideEffect:false};
}
function defaultStrategy(successMetrics,allowedActions){return {priority:'learn_and_improve',focus:successMetrics[0]||'qualified revenue',actions:allowedActions.length?allowedActions:['research','qualify','prepare_follow_up'],experiments:[],avoid:[],rationale:'Start from evidence; change strategy only when measured outcomes justify it.'};}
export function createAutonomousBusinessLoop({name,goal,mode='BOUNDED_AUTONOMOUS',durationDays=30,cadence='0 9 * * *',timezone='Africa/Dar_es_Salaam',successMetrics=[],allowedActions=[],exceptionPolicy={maxUnresolved:5,escalateOn:['payment','legal','security','negative_sentiment','approval_required']}}={}){
 if(!clean(name)||!clean(goal))throw new Error('Loop name and goal are required');if(!LOOP_MODES.includes(mode))throw new Error('Unsupported loop mode: '+mode);
 const days=clamp(durationDays,1,MAX_DAYS),started=now(),ends=new Date(Date.now()+days*86400000).toISOString(),strategy=defaultStrategy(arr(successMetrics).filter(Boolean),arr(allowedActions).filter(Boolean)),loopId='loop_'+nanoid(12);
 const task=tasks.create({name:'Autonomous Loop — '+clean(name).slice(0,60),goal:['Long-running business loop '+loopId+'.','Goal: '+clean(goal)+'.','Run a durable checkpoint, inspect CRM/customer intelligence, evaluate outcomes, adapt the strategy, and return only material exceptions to the owner.','Never bypass approval, security, payment, external-send, or production-deploy controls.'].join(' '),cronExpression:cadence,timezone,metadata:{feature:'DEEP_CRM_AUTONOMOUS_LOOP',version:1,loopId,mode,endsAt:ends}});
 getDb().prepare('INSERT INTO autonomous_loops(id,name,goal,mode,status,started_at,ends_at,cadence,timezone,success_metrics_json,allowed_actions_json,exception_policy_json,strategy_json,task_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(loopId,clean(name),clean(goal),mode,'ACTIVE',started,ends,cadence,timezone,JSON.stringify(arr(successMetrics)),JSON.stringify(arr(allowedActions)),JSON.stringify(exceptionPolicy),JSON.stringify(strategy),task.id,started,started);
 return getAutonomousLoop(loopId);
}
export function getAutonomousLoop(loopId){const row=getDb().prepare('SELECT * FROM autonomous_loops WHERE id=?').get(loopId);if(!row)return null;return {...row,successMetrics:json(row.success_metrics_json,[]),allowedActions:json(row.allowed_actions_json,[]),exceptionPolicy:json(row.exception_policy_json,{}),strategy:json(row.strategy_json,{}),lastOutcome:json(row.last_outcome_json,null)};}
export function listAutonomousLoops({status,limit=50}={}){const n=clamp(limit,1,200),rows=status?getDb().prepare('SELECT * FROM autonomous_loops WHERE status=? ORDER BY created_at DESC LIMIT ?').all(status,n):getDb().prepare('SELECT * FROM autonomous_loops ORDER BY created_at DESC LIMIT ?').all(n);return rows.map(r=>getAutonomousLoop(r.id));}
function adaptStrategy(strategy,outcome,exceptions){const next={...obj(strategy),experiments:Array.isArray(strategy?.experiments)?[...strategy.experiments]:[],avoid:Array.isArray(strategy?.avoid)?[...strategy.avoid]:[]},signal=String(outcome?.signal||'').toLowerCase();if(signal==='positive'){next.priority='scale_what_works';next.experiments.push({at:now(),change:'Increase emphasis on the best-performing action',evidence:outcome?.evidence||null});}else if(signal==='negative'){next.priority='change_approach';next.avoid.push({at:now(),change:'Reduce the lowest-performing action',evidence:outcome?.evidence||null});}if(exceptions.length)next.priority='exception_first';next.rationale=exceptions.length?'Resolve/escalate exceptions before further autonomous expansion.':(outcome?.evidence||'Adapt only from observed business outcomes.');return next;}
export function recordAutonomousLoopOutcome({loopId,signal='neutral',evidence=null,metrics={},exceptions=[]}={}){const loop=getAutonomousLoop(loopId);if(!loop)throw new Error('Autonomous loop not found');const strategy=adaptStrategy(loop.strategy,{signal,evidence},arr(exceptions)),version=Number(loop.strategy_version||1)+1,outcome={signal,evidence,metrics,exceptions:arr(exceptions),recordedAt:now()};getDb().prepare('UPDATE autonomous_loops SET strategy_json=?,strategy_version=?,last_outcome_json=?,updated_at=? WHERE id=?').run(JSON.stringify(strategy),version,JSON.stringify(outcome),now(),loopId);return getAutonomousLoop(loopId);}
export function checkpointAutonomousLoop({loopId,outcome={signal:'neutral'},exceptions=[]}={}){
 const loop=getAutonomousLoop(loopId);if(!loop)throw new Error('Autonomous loop not found');if(loop.status!=='ACTIVE')return {ok:false,reason:'Loop is '+loop.status,loop};
 if(loop.ends_at&&new Date(loop.ends_at).getTime()<=Date.now()){getDb().prepare('UPDATE autonomous_loops SET status=?,updated_at=? WHERE id=?').run('COMPLETED',now(),loopId);return {ok:true,status:'completed',loop:getAutonomousLoop(loopId)};}
 const checkpointNo=Number(loop.checkpoint_count||0)+1,started=now(),snapshot={integrations:listDeepCRMIntegrations(),relationships:[],openFollowUps:[],revenueSignals:[],opportunitySignals:[],timelineSignals:[]};
 for(const c of companies.list({limit:200}).slice(0,50)){snapshot.relationships.push({companyId:c.id,name:c.name,state:relationshipStates.getCurrent({companyId:c.id})});snapshot.openFollowUps.push(...followUpRecommendations.list({companyId:c.id,status:'OPEN',limit:20}));const rev=clientRevenueSnapshots.getLatest({companyId:c.id});if(rev)snapshot.revenueSignals.push(rev);snapshot.timelineSignals.push(...clientTimelineEvents.list({companyId:c.id,limit:20}));}
 snapshot.opportunitySignals=opportunities.listOpportunities({limit:100});const materialExceptions=arr(exceptions).slice(0,20),strategyBefore=loop.strategy,strategyAfter=adaptStrategy(strategyBefore,obj(outcome,{signal:'neutral'}),materialExceptions),checkpointId='checkpoint_'+nanoid(12),finished=now();
 getDb().prepare('INSERT INTO autonomous_loop_checkpoints(id,loop_id,checkpoint_no,status,snapshot_json,outcome_json,strategy_before_json,strategy_after_json,exceptions_json,actions_json,started_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(checkpointId,loopId,checkpointNo,'COMPLETED',JSON.stringify(snapshot),JSON.stringify(outcome),JSON.stringify(strategyBefore),JSON.stringify(strategyAfter),JSON.stringify(materialExceptions),JSON.stringify(arr(loop.allowedActions)),started,finished);
 getDb().prepare('UPDATE autonomous_loops SET checkpoint_count=?,last_checkpoint_at=?,last_outcome_json=?,strategy_json=?,strategy_version=?,updated_at=? WHERE id=?').run(checkpointNo,finished,JSON.stringify(outcome),JSON.stringify(strategyAfter),Number(loop.strategy_version||1)+1,finished,loopId);
 return {ok:true,loop:getAutonomousLoop(loopId),checkpoint:{id:checkpointId,number:checkpointNo,status:'COMPLETED',snapshot,exceptions:materialExceptions,actions:arr(loop.allowedActions),strategyBefore,strategyAfter},externalSideEffect:false};
}
export function getAutonomousLoopCheckpoints(loopId,{limit=20}={}){const n=clamp(limit,1,100);return getDb().prepare('SELECT * FROM autonomous_loop_checkpoints WHERE loop_id=? ORDER BY checkpoint_no DESC LIMIT ?').all(loopId,n).map(r=>({...r,snapshot:json(r.snapshot_json,{}),outcome:json(r.outcome_json,{}),strategyBefore:json(r.strategy_before_json,{}),strategyAfter:json(r.strategy_after_json,{}),exceptions:json(r.exceptions_json,[]),actions:json(r.actions_json,[])}));}
export const deepBusinessAutopilotTools={'crm.integration_register':registerDeepCRMIntegration,'crm.integration_list':listDeepCRMIntegrations,'crm.sync_queue':queueCRMSync,'crm.customer_360':getCustomer360,'autopilot.loop_create':createAutonomousBusinessLoop,'autopilot.loop_get':getAutonomousLoop,'autopilot.loop_list':listAutonomousLoops,'autopilot.loop_checkpoint':checkpointAutonomousLoop,'autopilot.loop_record_outcome':recordAutonomousLoopOutcome,'autopilot.loop_checkpoints':getAutonomousLoopCheckpoints};
export { SYSTEMS as DEEP_CRM_SYSTEMS, LOOP_MODES as AUTONOMOUS_LOOP_MODES };
