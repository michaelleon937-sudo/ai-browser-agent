import { describe, expect, it } from 'vitest';
import {
  DESIGN_DIRECTIONS,
  DESIGN_DIRECTION_NAMES,
  getDesignDirections,
  resolveDesignDirection,
  rankDesignDirections,
  buildArtDirectionMatrix,
} from '../../website-engine/design-library.js';
import { createDesignSpecification, createDesignVariations, resolveComposition } from '../../website-engine/index.js';

describe('professional website design library', () => {
  it('contains the verified professional expansion count', () => {
    expect(DESIGN_DIRECTIONS.length).toBe(145);
    expect(DESIGN_DIRECTION_NAMES.length).toBe(145);
  });

  it('has unique names and complete design-system fields', () => {
    expect(new Set(DESIGN_DIRECTION_NAMES).size).toBe(DESIGN_DIRECTIONS.length);
    for (const direction of DESIGN_DIRECTIONS) {
      expect(direction.name).toEqual(expect.any(String));
      expect(direction.category).toEqual(expect.any(String));
      expect(direction.typography.display).toEqual(expect.any(String));
      expect(direction.typography.body).toEqual(expect.any(String));
      expect(direction.color.background).toMatch(/^#[0-9a-f]{6}$/i);
      expect(direction.color.foreground).toMatch(/^#[0-9a-f]{6}$/i);
      expect(direction.color.accent).toMatch(/^#[0-9a-f]{6}$/i);
      expect(direction.grid).toEqual(expect.any(String));
      expect(direction.motion).toEqual(expect.any(String));
      expect(['flat', 'layered', 'glass', '3d']).toContain(direction.depth);
      expect(direction.radius).toEqual(expect.any(String));
      expect(Array.isArray(direction.keywords)).toBe(true);
    }
  });

  it('resolves exact and partial directions safely', () => {
    expect(resolveDesignDirection('Quiet Luxury').name).toBe('Quiet Luxury');
    expect(resolveDesignDirection('quiet luxury').name).toBe('Quiet Luxury');
    expect(resolveDesignDirection('Jewelry Atelier').category).toBe('fashion');
    expect(resolveDesignDirection('not-a-real-direction').name).toBe(DESIGN_DIRECTIONS[0].name);
  });

  it('ranks semantically relevant directions instead of category-only matches', () => {
    const luxuryJewelry = rankDesignDirections({
      industry: 'fashion',
      description: 'high-end fine jewelry and diamonds',
      audience: 'luxury buyers',
    });
    expect(luxuryJewelry[0].name).toBe('Jewelry Atelier');

    const robotics = rankDesignDirections({
      industry: 'technology',
      description: 'robotics automation laboratory with spatial 3D product demos',
    });
    expect(robotics[0].name).toBe('Robotics Lab');
  });

  it('builds an art-direction matrix from ranked directions', () => {
    const matrix = buildArtDirectionMatrix({ industry: 'hotel', description: 'luxury wellness retreat' }, 5);
    expect(matrix).toHaveLength(5);
    expect(matrix.every(item => item.name && item.category && item.visualSystem)).toBe(true);
  });

  it('propagates a selected direction into a real design specification', () => {
    const spec = createDesignSpecification({
      industry: 'automotive',
      brand: 'Apex Motors',
      visualDirection: 'Motorsport',
      description: 'performance automotive brand',
      use3D: true,
    });
    expect(spec.visualDirection).toBe('Motorsport');
    expect(spec.designDirection.name).toBe('Motorsport');
    expect(spec.designDirection.depth).toBe('3d');
    expect(spec.threeD.required).toBe(true);
    expect(resolveComposition(spec.designDirection)).toEqual(expect.objectContaining({
      hero: 'dynamic-feature',
    }));
  });

  it('generates materially distinct design variations from direction inputs', () => {
    const base = createDesignSpecification({
      industry: 'luxury',
      brand: 'Maison',
      description: 'luxury lifestyle brand',
    });
    const variations = createDesignVariations({
      ...base,
      artDirectionMatrix: [
        { name: 'Quiet Luxury' },
        { name: 'Cybersecurity Command' },
        { name: 'Jewelry Atelier' },
      ],
    }, { industry: 'luxury' });

    expect(variations).toHaveLength(3);
    expect(variations.map(v => v.designDirection)).toEqual([
      'Quiet Luxury',
      'Cybersecurity Command',
      'Jewelry Atelier',
    ]);
    expect(new Set(variations.map(v => v.grid)).size).toBeGreaterThan(1);
    expect(variations.every(v => v.composition && v.designDirection && v.designDirection.color)).toBe(true);
  });

  it('returns defensive copies from getDesignDirections', () => {
    const directions = getDesignDirections();
    directions[0].typography.display = 'Mutated';
    directions[0].color.background = '#000000';
    expect(DESIGN_DIRECTIONS[0].typography.display).not.toBe('Mutated');
    expect(DESIGN_DIRECTIONS[0].color.background).not.toBe('#000000');
  });
});
