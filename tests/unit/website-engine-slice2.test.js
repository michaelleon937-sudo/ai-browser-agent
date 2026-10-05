import { describe, expect, it } from 'vitest';
import {
  WEBSITE_ENGINE_SLICE2_VERSION, THREE_VERSION, WEBSITE_SLICE2_DELIVERY_PATHS,
  createWebsiteSlice2Spec, validateWebsiteSlice2Spec, createWebsiteDeliveryManifest,
  buildWebsiteRepairPlan, evaluateWebsiteRuntimeQa, renderWebsiteSlice2Html,
} from '../../website-engine/slice2.js';

describe('Website Engine Slice 2', () => {
  it('creates a production-grade runtime contract', () => {
    const spec = createWebsiteSlice2Spec({ title: 'Luxury Residence', description: 'Architectural portfolio' });
    expect(spec.version).toBe(WEBSITE_ENGINE_SLICE2_VERSION);
    expect(spec.threeD.engine).toBe('Three.js');
    expect(spec.threeD.loader).toBe('GLTFLoader');
    expect(spec.threeD.version).toBe(THREE_VERSION);
    expect(spec.motion.reveal).toBe('intersection-observer');
    expect(spec.qa.maxRepairAttempts).toBe(3);
    expect(validateWebsiteSlice2Spec(spec)).toEqual({ passed: true, failures: [] });
  });

  it('enforces the delivery contract and bounded repair', () => {
    const spec = createWebsiteSlice2Spec();
    const manifest = createWebsiteDeliveryManifest(spec);
    expect(manifest.status).toBe('READY_FOR_EXPORT');
    expect(manifest.folders).toEqual(WEBSITE_SLICE2_DELIVERY_PATHS);
    const repair = buildWebsiteRepairPlan({ failures: ['overflow', 'contrast', 'threeD', 'extra'] }, 99);
    expect(repair.maxAttempts).toBe(3);
    expect(repair.fixes).toHaveLength(3);
  });

  it('runs runtime QA gates', () => {
    expect(evaluateWebsiteRuntimeQa({ overflow: false, missingAlt: 0, missingLabels: 0, contrastPass: true, motionPass: true, threeDPass: true, lcpMs: 1900, cls: 0.04 }).passed).toBe(true);
    const failed = evaluateWebsiteRuntimeQa({ overflow: true, missingAlt: 1, missingLabels: 1, contrastPass: false, motionPass: true, threeDPass: false, lcpMs: 3000, cls: 0.2 });
    expect(failed.passed).toBe(false);
    expect(failed.repair.maxAttempts).toBe(3);
  });

  it('renders an accessible responsive runtime with real Three.js/GLTF imports', () => {
    const html = renderWebsiteSlice2Html(createWebsiteSlice2Spec({ title: 'Premium Studio' }));
    expect(html).toContain('three.module.js');
    expect(html).toContain('GLTFLoader.js');
    expect(html).toContain('prefers-reduced-motion');
    expect(html).toContain('Skip to content');
    expect(html).toContain('aria-label="Interactive 3D product visualization"');
    expect(html).toContain('autocomplete="email"');
    expect(html).toContain('data-website-engine="slice2"');
  });
});
