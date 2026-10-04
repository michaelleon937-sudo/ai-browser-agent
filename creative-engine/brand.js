export const BRAND_IDENTITY_TYPES = Object.freeze([
  'full-identity',
  'logo-system',
  'visual-identity',
  'brand-guidelines',
  'campaign-identity',
  'digital-brand-kit',
  'print-brand-kit'
]);

export const BRAND_COLOR_MODES = Object.freeze([
  'light',
  'dark',
  'adaptive',
  'monochrome',
  'duotone'
]);

export const BRAND_ASSET_CLASSES = Object.freeze([
  'primary-logo',
  'secondary-logo',
  'wordmark',
  'mark',
  'favicon',
  'social-avatar',
  'pattern',
  'icon-set',
  'photography',
  'illustration',
  '3d-assets',
  'templates'
]);

const clean = value => String(value ?? '').trim();

export function createBrandIdentitySpec(input = {}) {
  const type = clean(input.type || 'full-identity').toLowerCase();
  const industry = clean(input.industry || 'corporate').toLowerCase();
  const brandName = clean(input.brandName || input.businessName || '');
  const audience = clean(input.audience);
  const positioning = clean(input.positioning || input.goal || input.objective);
  const personality = Array.isArray(input.personality) ? input.personality.filter(Boolean) : [];
  const colors = Array.isArray(input.colors) ? input.colors : [];
  const fonts = Array.isArray(input.fonts) ? input.fonts : [];

  return {
    type,
    brandName,
    industry,
    audience,
    positioning,
    personality,
    strategy: {
      audienceFirst: true,
      positioningDriven: true,
      differentiationRequired: true,
      preserveApprovedAssets: true,
      noInventedClaims: true
    },
    logo: {
      primary: 'approved-primary-logo',
      variants: ['horizontal', 'stacked', 'mark-only', 'monochrome'],
      clearSpace: 'defined-by-logo-height',
      minimumSize: { digitalPx: 24, printMm: 8 },
      misuseRules: ['no-stretch', 'no-unapproved-colors', 'no-effects', 'no-redraw']
    },
    color: {
      mode: clean(input.colorMode || 'light').toLowerCase(),
      primary: colors[0] || null,
      secondary: colors.slice(1),
      semantic: {
        success: null,
        warning: null,
        error: null,
        info: null
      },
      contrastRequired: true,
      tokens: ['brand-primary', 'brand-secondary', 'surface', 'text', 'muted', 'accent']
    },
    typography: {
      primary: fonts[0] || null,
      secondary: fonts[1] || null,
      roles: ['display', 'heading', 'body', 'caption', 'label'],
      hierarchyRequired: true,
      fallbackRequired: true
    },
    layout: {
      grid: 'responsive-12-column',
      spacingScale: [4, 8, 12, 16, 24, 32, 48, 64, 96],
      alignment: 'consistent',
      whitespace: 'intentional'
    },
    imagery: {
      direction: clean(input.imageryDirection || 'brand-consistent'),
      photography: 'approved-or-licensed',
      illustration: 'approved-or-original',
      assetProvenanceRequired: true,
      subjectConsistency: true
    },
    iconography: {
      style: clean(input.iconStyle || 'consistent'),
      strokeConsistency: true,
      opticalAlignment: true,
      customAssetsPreferred: false
    },
    motion: {
      language: clean(input.motionLanguage || 'restrained-brand-motion'),
      durationRangeMs: [160, 700],
      easing: 'brand-consistent',
      reducedMotionFallback: true
    },
    voice: {
      tone: clean(input.voiceTone || 'clear'),
      language: clean(input.language || 'en'),
      traits: personality.length ? personality : ['clear', 'confident', 'consistent'],
      forbidden: ['invented-claims', 'unsupported-promises']
    },
    assets: {
      provenanceRequired: true,
      licenseRequired: true,
      classes: BRAND_ASSET_CLASSES,
      preserveClientAssets: true
    },
    deliverables: {
      digital: ['svg', 'png', 'webp', 'pdf'],
      print: ['pdf', 'svg'],
      package: ['brand-guidelines', 'logo-kit', 'color-tokens', 'typography-spec']
    },
    accessibility: {
      contrastValidation: true,
      legibleTypography: true,
      reducedMotionFallback: true
    },
    qa: {
      consistencyChecks: ['logo', 'color', 'typography', 'spacing', 'imagery', 'motion', 'voice'],
      noInventedClaims: true,
      noUnlicensedAssets: true
    }
  };
}

export function validateBrandIdentity(spec = {}) {
  const failures = [];
  if (!spec.type) failures.push('missing-type');
  if (!spec.brandName) failures.push('missing-brand-name');
  if (!spec.logo?.variants?.length) failures.push('missing-logo-system');
  if (!spec.color?.tokens?.length) failures.push('missing-color-system');
  if (!spec.typography?.roles?.length) failures.push('missing-typography-system');
  if (!spec.layout?.spacingScale?.length) failures.push('missing-spacing-system');
  if (spec.assets?.provenanceRequired !== true) failures.push('asset-provenance-required');
  if (spec.qa?.noInventedClaims !== true) failures.push('no-invented-claims-required');
  if (spec.qa?.noUnlicensedAssets !== true) failures.push('no-unlicensed-assets-required');
  if (spec.accessibility?.contrastValidation !== true) failures.push('contrast-validation-required');
  if (spec.motion?.reducedMotionFallback !== true) failures.push('reduced-motion-fallback-required');
  return { passed: failures.length === 0, failures };
}

export function buildBrandProject(input = {}) {
  const spec = createBrandIdentitySpec(input);
  const qa = validateBrandIdentity(spec);
  return {
    type: 'brand',
    engine: 'brand-identity-engine',
    engineVersion: '1.0.0',
    status: qa.passed ? 'READY_FOR_REVIEW' : 'BLOCKED',
    spec,
    qa
  };
}
