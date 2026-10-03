import {buildWebsite,prepareDelivery,summarizeEngine} from "../../website-engine/index.js";
function req(a){if(!a||(!a.brief&&!a.industry&&!a.name)){const e=Error("brief or basic project fields are required");e.status=400;throw e}}
export async function generate(a={}){req(a);const p=buildWebsite(a,{variationIndex:Number(a.variationIndex||0)});return{ok:true,projectId:p.id,designSpecification:p.spec,qa:p.qa,files:p.files,audit:p.audit}}
export async function variations(a={}){req(a);const p=buildWebsite(a,{variationIndex:0});return{ok:true,projectId:p.id,available:["Luxury Editorial","Modern Minimal","Futuristic 3D"],selected:p.spec.name}}
export async function prepare(a={}){req(a);return prepareDelivery(buildWebsite(a,{variationIndex:Number(a.variationIndex||0)}))}
export async function capabilities(){return{ok:true,...summarizeEngine()}}
export const websiteEngineTools={"website.generate":generate,"website.variations":variations,"website.prepare_delivery":prepare,"website.capabilities":capabilities};
