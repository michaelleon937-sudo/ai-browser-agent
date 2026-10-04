import { describe, expect, it } from 'vitest';
import { DESIGN_DIRECTIONS, DESIGN_DIRECTION_NAMES, getDesignDirections, rankDesignDirections, buildArtDirectionMatrix, resolveDesignDirection } from '../../website-engine/design-library.js';

describe('website design direction library',()=>{
  it('contains broad professional art-direction coverage',()=>{expect(DESIGN_DIRECTIONS.length).toBeGreaterThanOrEqual(50);expect(DESIGN_DIRECTION_NAMES).toContain('Luxury Editorial');expect(DESIGN_DIRECTION_NAMES).toContain('Futuristic 3D');expect(DESIGN_DIRECTION_NAMES).toContain('Swiss Grid');expect(DESIGN_DIRECTION_NAMES).toContain('Fine Dining');expect(DESIGN_DIRECTION_NAMES).toContain('Interactive Floorplan');});
  it('ranks directions from the brief',()=>{const r=rankDesignDirections({industry:'restaurant',style:'luxury'});expect(r.length).toBe(DESIGN_DIRECTIONS.length);expect(r[0].matchScore).toBeGreaterThan(0);});
  it('builds a bounded art-direction matrix',()=>{expect(buildArtDirectionMatrix({industry:'architecture',use3D:true},5)).toHaveLength(5);});
  it('resolves named directions',()=>{expect(resolveDesignDirection('Luxury Fashion').name).toBe('Luxury Fashion');expect(getDesignDirections().length).toBe(DESIGN_DIRECTIONS.length);});
});
