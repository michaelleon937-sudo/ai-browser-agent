import crypto from 'node:crypto';
import { buildWebsite, createDesignSpecification, runQualityChecks, runSecurityChecks, runVisualQa, runRenderedVisualQa, prepareDelivery } from './index.js';\nimport { createReviewSession, addReviewComment, recordReviewDecision, compareWebsiteVersions } from './review.js';\nimport { triggerRenderDeploy, listRenderDeploys, waitForRenderDeploy, rollbackRenderDeploy, deploymentCapabilities } from './deployment.js';

export const WEBSITE_ENGINE_VERSION = '2.0.0';
export const APPROVAL_STATES = Object.freeze(['DRAFT','INTERNAL_REVIEW','CLIENT_REVIEW','REVISION_REQUESTED','READY_FOR_APPROVAL','APPROVED','DEPLOYMENT_PENDING','DEPLOYED','DELIVERED']);
const now = () => new Date().toISOString();
const id = (prefix, value = '') => `${prefix}_${crypto.createHash('sha256').update(`${value}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 16)}`;
const clean = (value) => String(value ?? '').trim();

export function normalizeClientBrief(input = {}) {
  const source = typeof input === 'string' ? { description: input } : { ...input };
  return {
    name: clean(source.name || source.businessName), industry: clean(source.industry || source.businessType), description: clean(source.description),
    audience: clean(source.audience), location: clean(source.location),
    services: Array.isArray(source.services) ? source.services.map(clean).filter(Boolean) : [],
    products: Array.isArray(source.products) ? source.products.map(clean).filter(Boolean) : [],
    brandColors: source.brandColors || source.colors || null, logo: source.logo || null, fonts: source.fonts || null, brandGuidelines: source.brandGuidelines || null,
    referenceWebsites: Array.isArray(source.referenceWebsites) ? source.referenceWebsites.map(clean).filter(Boolean) : [],
    referenceImages: Array.isArray(source.referenceImages) ? source.referenceImages.map(clean).filter(Boolean) : [],
    visualDirection: clean(source.visualDirection || source.style), desiredPages: Array.isArray(source.desiredPages) ? source.desiredPages.map(clean).filter(Boolean) : [],
    conversionGoal: clean(source.conversionGoal || source.goal), contact: source.contact || {}, socialLinks: source.socialLinks || {},
    crmDestination: clean(source.crmDestination), deploymentDestination: clean(source.deploymentDestination),
    seoKeywords: Array.isArray(source.seoKeywords) ? source.seoKeywords.map(clean).filter(Boolean) : [],
    content: source.content && typeof source.content === 'object' ? source.content : {},
  };
}

export function generateSeo(brief = {}, spec = {}, origin = '') {
  const b = normalizeClientBrief(brief); const title = clean(b.name || spec.brand || 'Professional Website').slice(0, 60);
  const description = clean(b.description || spec.primaryObjective || 'Professional digital experience').slice(0, 160);
  const canonical = clean(origin) ? `${clean(origin).replace(/\/$/, '')}/` : null;
  const type = b.industry === 'restaurant' ? 'Restaurant' : b.industry === 'hotel' ? 'Hotel' : b.industry === 'ecommerce' ? 'Organization' : 'Organization';
  return { title, description, canonical, keywords: b.seoKeywords, openGraph: { title, description, type, url: canonical }, twitter: { card: 'summary_large_image', title, description }, robots: 'index,follow', structuredData: { '@context': 'https://schema.org', '@type': type, name: b.name || spec.brand || 'Brand', description } };
}

export function createWebsiteProject(brief = {}, options = {}) {
  const normalized = normalizeClientBrief(brief); const spec = createDesignSpecification(normalized);
  const site = buildWebsite(normalized, { variationIndex: Number(options.variationIndex || 0) });
  const createdAt = now();
  return { projectId: id('wp', normalized.name || spec.industry), engineVersion: WEBSITE_ENGINE_VERSION, createdAt, updatedAt: createdAt, state: 'DRAFT', clientBrief: normalized, designSpecification: spec, site, seo: generateSeo(normalized, spec, options.origin), versions: [{ version: 1, createdAt, reason: 'initial-generation', site }], revisions: [], approvals: [], audit: [{ event: 'project.created', status: 'ok', at: createdAt }] };
}

export function requestRevision(project, request = {}) {
  if (!project?.projectId) throw new Error('website project is required');
  const instruction = clean(request.instruction); if (!instruction) throw new Error('revision instruction is required');
  const revision = { revisionId: id('rev', project.projectId), createdAt: now(), type: clean(request.type || 'general'), instruction, target: clean(request.target || 'targeted'), status: 'REQUESTED' };
  return { ...project, updatedAt: now(), state: 'REVISION_REQUESTED', revisions: [...project.revisions, revision], audit: [...project.audit, { event: 'revision.requested', revisionId: revision.revisionId, at: revision.createdAt }] };
}

export function applyTargetedRevision(project, request = {}) {
  if (!project?.projectId) throw new Error('website project is required');
  const latest = project.revisions.at(-1); if (!latest) throw new Error('no revision request exists');
  const nextBrief = normalizeClientBrief(project.clientBrief); const instruction = clean(request.instruction || latest.instruction); const content = { ...nextBrief.content };
  if (/hero|headline|title/i.test(instruction) && request.value) content.heroTitle = clean(request.value);
  if (/cta/i.test(instruction) && request.value) content.cta = clean(request.value);
  nextBrief.content = content;
  const nextSite = buildWebsite(nextBrief, { variationIndex: Number(request.variationIndex ?? 0) }); const version = (project.versions.at(-1)?.version || 0) + 1; const appliedAt = now();
  return { ...project, updatedAt: appliedAt, state: 'INTERNAL_REVIEW', clientBrief: nextBrief, site: nextSite, versions: [...project.versions, { version, createdAt: appliedAt, reason: 'targeted-revision', revisionId: latest.revisionId, site: nextSite }], revisions: [...project.revisions.slice(0, -1), { ...latest, status: 'APPLIED', appliedAt }], audit: [...project.audit, { event: 'revision.applied', revisionId: latest.revisionId, version, at: appliedAt }] };
}

export function runProductionQa(project) {
  if (!project?.site) throw new Error('website project is required');
  const quality = runQualityChecks(project.site, project.designSpecification); const security = runSecurityChecks(project.site); const visual = runVisualQa(project.site);
  const seo = Boolean(project.seo?.title && project.seo?.description && Array.isArray(project.seo?.keywords));
  return { quality, security, visual, seo: { passed: seo, total: 1, failures: seo ? [] : ['seo-metadata'] }, passed: quality.failures.length === 0 && security.failures.length === 0 && visual.failures.length === 0 && seo };
}

export function selfRepair(project, maxRepairs = 2) {
  if (!project?.site) throw new Error('website project is required'); const limit = Math.max(0, Math.min(5, Number(maxRepairs) || 0)); let current = project; const repairs = [];
  for (let attempt = 0; attempt < limit; attempt += 1) { const qa = runProductionQa(current); if (qa.passed) break; const failures = [...qa.quality.failures, ...qa.security.failures, ...qa.visual.failures, ...qa.seo.failures]; if (failures.some(f => ['no secrets','no eval','no Function'].includes(f))) break; const next = requestRevision(current, { type: 'qa', instruction: `QA repair: ${failures.join(', ')}`, target: 'automated' }); current = applyTargetedRevision(next, { instruction: next.revisions.at(-1).instruction, value: current.clientBrief.content?.heroTitle || 'Refined digital experience' }); repairs.push({ attempt: attempt + 1, failures, at: now() }); }
  return { project: current, repairs, qa: runProductionQa(current), repairLimit: limit };
}

export function gateForApproval(project) { const qa = runProductionQa(project); return qa.passed ? { ok: true, status: 'READY_FOR_APPROVAL', qa } : { ok: false, status: 'BLOCKED', qa }; }
export function approveWebsite(project, actor = 'client') { const gate = gateForApproval(project); if (!gate.ok) return { ...project, gate }; const approval = { approvalId: id('approval', project.projectId), actor: clean(actor) || 'client', at: now(), status: 'APPROVED' }; return { ...project, state: 'APPROVED', updatedAt: approval.at, approvals: [...project.approvals, approval], audit: [...project.audit, { event: 'approval.granted', approvalId: approval.approvalId, at: approval.at }] }; }
export function prepareProduction(project) { const gate = gateForApproval(project); if (!gate.ok) return { ok: false, status: 'BLOCKED', projectId: project?.projectId || null, gate }; if (project.state !== 'APPROVED') return { ok: false, status: 'APPROVAL_REQUIRED', projectId: project.projectId, gate }; const delivery = prepareDelivery(project.site); if (!delivery.ok) return { ok: false, status: 'BLOCKED', projectId: project.projectId, delivery }; return { ok: true, status: 'DEPLOYMENT_PENDING', projectId: project.projectId, version: project.versions.at(-1)?.version || 1, files: Object.keys(project.site.files), seo: project.seo, delivery }; }

export function createDesignSpecProject(brief = {}) {
  const normalized = normalizeClientBrief(brief);
  const spec = createDesignSpecification(normalized);
  return { ok: true, designSpecification: spec, contentArchitecture: { pages: spec.pages, industryModules: spec.industryModules } };
}
export async function runFullVisualQa(project) {
  const base = runProductionQa(project);
  const rendered = await runRenderedVisualQa(project.site);
  return { ...base, renderedVisual: rendered, passed: base.passed && rendered.passed };
}
export function openClientReview(project, origin = '') { return createReviewSession(project, origin); }
export function addClientReviewComment(project, comment) { return addReviewComment(project, comment); }
export function decideClientReview(project, decision, actor) { return recordReviewDecision(project, decision, actor); }
export function compareVersions(project, fromVersion, toVersion) { return compareWebsiteVersions(project, fromVersion, toVersion); }
export async function deployWebsite(project, options = {}) {
  if (project?.state !== 'APPROVED') throw Object.assign(new Error('website must be APPROVED before deployment'), { status: 403 });
  const deploy = await triggerRenderDeploy(options);
  const verified = options.wait === false ? deploy : await waitForRenderDeploy({ serviceId: options.serviceId, deployId: deploy.id });
  return { ok: verified.status === 'live', status: verified.status, deploy: verified, project: { ...project, state: verified.status === 'live' ? 'DEPLOYED' : 'DEPLOYMENT_PENDING' } };
}
export async function websiteStatus(options = {}) { return { ok: true, deploys: await listRenderDeploys(options), capabilities: deploymentCapabilities() }; }
export async function rollbackWebsite(options = {}) { return { ok: true, deploy: await rollbackRenderDeploy(options) }; }
\nexport function buildDeliveryManifest(project) { if (!project?.projectId) throw new Error('website project is required'); return { projectId: project.projectId, engineVersion: project.engineVersion, version: project.versions.at(-1)?.version || 1, state: project.state, source: ['index.html','styles.css','app.js'], artifacts: Object.keys(project.site.files), seo: project.seo, approvalCount: project.approvals.length, revisionCount: project.revisions.length, generatedAt: now(), secretsIncluded: false }; }
