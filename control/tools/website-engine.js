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
export async function createDesignSpec(a={}){if(!a.brief&&!a.industry&&!a.name)throw Object.assign(new Error("brief required"),{status:400});return createDesignSpecProject(a.brief||a)}
export async function preview(a={}){return{ok:true,status:"PREVIEW_READY",projectId:a.project?.projectId||a.project?.id||null,previewUrl:a.previewUrl||null}}
export async function revise(a={}){return applyTargetedRevision(a.project,a.request||{})}
export async function visualQa(a={}){return runFullVisualQa(a.project)}
export async function prepareDeployment(a={}){return prepareProduction(a.project)}
export async function deploy(a={}){return deployWebsite(a.project,a)}
export async function rollback(a={}){return rollbackWebsite(a)}
export async function status(a={}){return websiteStatus(a)}
export async function delivery(a={}){return buildDeliveryManifest(a.project)}
export async function openReview(a={}){return openClientReview(a.project,a.origin)}
export async function reviewComment(a={}){return addClientReviewComment(a.project,a.comment)}
export async function reviewDecision(a={}){return decideClientReview(a.project,a.decision,a.actor)}
export async function compareVersions(a={}){return compareVersions(a.project,a.fromVersion,a.toVersion)}
export async function capabilities(){return{ok:true,...summarizeEngine(),lifecycle:["DRAFT","INTERNAL_REVIEW","CLIENT_REVIEW","REVISION_REQUESTED","READY_FOR_APPROVAL","APPROVED","DEPLOYMENT_PENDING","DEPLOYED","DELIVERED"],productionFeatures:["structured-brief","seo-metadata","versioned-revisions","approval-gate","production-qa","bounded-self-repair","delivery-manifest"]}}
export const websiteEngineTools={"website.create_design_spec":createDesignSpec,"website.preview":preview,"website.revise":revise,"website.visual_qa":visualQa,"website.prepare_deployment":prepareDeployment,"website.deploy":deploy,"website.rollback":rollback,"website.status":status,"website.delivery":delivery,"website.open_review":openReview,"website.review_comment":reviewComment,"website.review_decision":reviewDecision,"website.compare_versions":compareVersions,"website.generate":generate,"website.variations":variations,"website.prepare_delivery":prepare,"website.create_project":createProject,"website.request_revision":requestProjectRevision,"website.apply_revision":applyProjectRevision,"website.qa":qa,"website.self_repair":repair,"website.approve":approve,"website.prepare_production":prepareProductionDelivery,"website.delivery_manifest":deliveryManifest,"website.capabilities":capabilities};
