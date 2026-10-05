import { createCreativeProject, validateCreativeProject, preflightCreativeProviders, renderCapabilityMatrix, renderCreativeProject } from '../../creative-engine/index.js';

function requireBrief(a={}){if(!a||(!a.description&&!a.brief&&a.type===undefined))throw Object.assign(new Error('creative brief is required'),{status:400});}
export function capabilities(){return{ok:true,providers:renderCapabilityMatrix()};}
export function preflight(){return preflightCreativeProviders();}
export function plan(a={}){requireBrief(a);const input=a.brief&&typeof a.brief==='object'?{...a.brief,...a}:a;const project=createCreativeProject(input);return{ok:true,project,validation:validateCreativeProject(project)};}
export async function render(a={}){requireBrief(a);if(!a.approved)throw Object.assign(new Error('creative.render requires explicit approval (approved=true)'),{status:403});const input=a.brief&&typeof a.brief==='object'?{...a.brief,...a}:a;const project=a.project||createCreativeProject(input);const validation=validateCreativeProject(project);if(!validation.passed)throw Object.assign(new Error(`creative project is not render-ready: ${validation.failures.join(',')}`),{status:422});return{ok:true,projectId:project.id||null,result:await renderCreativeProject(project,a.options||{})};}
export const creativeEngineTools={'creative.capabilities':capabilities,'creative.preflight':preflight,'creative.plan':plan,'creative.render':render};
