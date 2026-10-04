import { buildVideoProject, VIDEO_FORMATS, VIDEO_GENRES, validateVideoDesign } from './video.js';
import { buildGraphicProject, GRAPHIC_FORMATS, GRAPHIC_TYPES, validateGraphicDesign } from './graphic.js';

export const CREATIVE_ENGINE_VERSION = '1.0.0';
export const CREATIVE_CHANNELS = Object.freeze(['website', 'video', 'graphic', '3d', 'brand']);
export const CREATIVE_LIFECYCLE = Object.freeze(['BRIEF','ANALYSIS','ART_DIRECTION','STORYBOARD','DESIGN','RENDER_READY','QA','CLIENT_REVIEW','APPROVED','DELIVERY']);

export function createCreativeBrief(input = {}) {
  const b = typeof input === 'string' ? { description: input } : { ...input };
  return { name: String(b.name || b.businessName || '').trim(), description: String(b.description || '').trim(), industry: String(b.industry || '').trim(), audience: String(b.audience || '').trim(), brandGuidelines: b.brandGuidelines || null, channels: Array.isArray(b.channels) ? b.channels : ['website'], language: String(b.language || 'en').trim() };
}

export function createCreativeProject(input = {}) {
  const brief = createCreativeBrief(input);
  const type = String(input.type || input.channel || 'graphic').toLowerCase();
  if (type === 'video') return { ...buildVideoProject({ ...brief, ...input }), creativeBrief: brief };
  if (type === 'graphic' || type === 'image') return { ...buildGraphicProject({ ...brief, ...input }), creativeBrief: brief };
  return { type, engine: 'professional-creative-engine', engineVersion: CREATIVE_ENGINE_VERSION, creativeBrief: brief, status: 'READY_FOR_ART_DIRECTION', contracts: { website: 'website-engine', video: 'video-engine', graphic: 'graphic-engine', threeD: '3d-runtime', brand: 'brand-system' } };
}

export function validateCreativeProject(project = {}) {
  if (project.type === 'video') return validateVideoDesign(project.spec);
  if (project.type === 'graphic') return validateGraphicDesign(project.spec);
  return { passed: true, failures: [], contractOnly: true };
}

export const creativeEngineCapabilities = {
  channels: CREATIVE_CHANNELS, lifecycle: CREATIVE_LIFECYCLE,
  video: { genres: VIDEO_GENRES, formats: Object.keys(VIDEO_FORMATS), features: ['storyboard','scenes','transitions','captions','music','voiceover','motion-graphics','kinetic-typography','3d','effects'] },
  graphic: { types: GRAPHIC_TYPES, formats: Object.keys(GRAPHIC_FORMATS), features: ['art-direction','hierarchy','typography','composition','social','print','3d-product'] },
  sharedIntelligence: ['industry-analysis','audience','brand-system','design-direction','accessibility','asset-policy','qa','revision-workflow']
};
