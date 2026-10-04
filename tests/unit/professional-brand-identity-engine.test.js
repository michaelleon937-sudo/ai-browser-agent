
import { buildBrandProject, createBrandIdentitySpec, validateBrandIdentity } from '../../creative-engine/brand.js';

describe('Professional Brand Identity Engine', () => {
  it('builds a production-ready brand identity system', () => {
    const p = buildBrandProject({
      type: 'full-identity',
      brandName: 'Atlas Luxury',
      industry: 'luxury',
      audience: 'premium buyers',
      positioning: 'refined contemporary luxury',
      personality: ['refined', 'confident'],
      colors: ['#FFFFFF', '#D9A7B0'],
      fonts: ['Cormorant Garamond', 'Inter']
    });
    expect(p.status).toBe('READY_FOR_REVIEW');
    expect(p.qa.passed).toBe(true);
    expect(p.spec.logo.variants).toContain('mark-only');
    expect(p.spec.color.contrastRequired).toBe(true);
    expect(p.spec.typography.roles).toContain('body');
    expect(p.spec.assets.provenanceRequired).toBe(true);
  });

  it('enforces core brand governance and accessibility rules', () => {
    const s = createBrandIdentitySpec({ brandName: 'Test Brand' });
    expect(validateBrandIdentity(s).passed).toBe(true);
    expect(s.qa.noInventedClaims).toBe(true);
    expect(s.qa.noUnlicensedAssets).toBe(true);
    expect(s.motion.reducedMotionFallback).toBe(true);
  });
});
