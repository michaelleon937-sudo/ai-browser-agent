import {buildWebsite,prepareDelivery,summarizeEngine} from "../../website-engine/index.js";
import {createWebsiteProject,requestRevision,applyTargetedRevision,runProductionQa,selfRepair,approveWebsite,prepareProduction,buildDeliveryManifest} from "../../website-engine/production.js";
function req(a){if(!a||(!a.brief&&!a.industry&&!a.name)){const e=Error("brief or basic project fields are required");e.status=400;throw e}}
export async function generate(a={}){req(a);const p=buildWebsite(a,{variationIndex:Number(a.variationIndex||0)});return{ok:true,projectId:p.id,designSpecification:p.spec,qa:p.qa,files:p.files,audit:p.audit}}
export async function variations(a={}){req(a);const p=buildWebsite(a,{variationIndex:0});return{ok:true,projectId:p.id,available:["Luxury Editorial","Modern Minimal","Futuristic 3D"],selected:p.spec.name}}
export async function prepare(a={}){req(a);return prepareDelivery(buildWebsite(a,{variationIndex:Number(a.variationIndex||0)}))}
export async function createProject(a={}){req(a);return createWebsiteProject(a,{variationIndex:Number(a.variationIndex||0),origin:a.origin})}
export async function requestProjectRevision(a={}){if(!a.project||!a.request)throw Object.assign(new Error("project and request are required"),{status:400});return requestRevision(a.project,a.request)}
export async function applyProjectRevision(a={}){if(!a.project)throw Object.assign(new Error("project is required"),{status:400});return applyTargetedRevision(a.project,a.request||{})}
export async function qa(a={}){if(!a.project)throw Object.assign(new Error("project is required"),{status:400});return runProductionQa(a.project)}
export async function repair(a={}){if(!a.project)throw Object.assign(new Error("project is required"),{status:400});return selfRepair(a.project,a.maxRepairs)}
export async function approve(a={}){if(!a.project)throw Object.assign(new Error("project is required"),{status:400});return approveWebsite(a.project,a.actor)}
export async function prepareProductionDelivery(a={}){if(!a.project)throw Object.assign(new Error("project is required"),{status:400});return prepareProduction(a.project)}
export async function deliveryManifest(a={}){if(!a.project)throw Object.assign(new Error("project is required"),{status:400});return buildDeliveryManifest(a.project)}
export async function capabilities(){return{ok:true,...summarizeEngine(),lifecycle:["DRAFT","INTERNAL_REVIEW","CLIENT_REVIEW","REVISION_REQUESTED","READY_FOR_APPROVAL","APPROVED","DEPLOYMENT_PENDING","DEPLOYED","DELIVERED"],productionFeatures:["structured-brief","seo-metadata","versioned-revisions","approval-gate","production-qa","bounded-self-repair","delivery-manifest"]}}
export const websiteEngineTools={"website.generate":generate,"website.variations":variations,"website.prepare_delivery":prepare,"website.create_project":createProject,"website.request_revision":requestProjectRevision,"website.apply_revision":applyProjectRevision,"website.qa":qa,"website.self_repair":repair,"website.approve":approve,"website.prepare_production":prepareProductionDelivery,"website.delivery_manifest":deliveryManifest,"website.capabilities":capabilities};
