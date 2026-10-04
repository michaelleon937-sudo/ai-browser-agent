import { describe, expect, it } from 'vitest';
import { analyzeBrief, createDesignSpecification, createDesignVariations, buildWebsite, resolveComposition } from '../../website-engine/index.js';
import { resolveDesignDirection, rankDesignDirections, buildArtDirectionMatrix } from '../../website-engine/design-library.js';

const scenarios = [
  ['Luxury Hotel','Luxury five-star beachfront resort website with cinematic photography, immersive storytelling, premium booking experience and subtle 3D.',['hotel','hospitality'],['Luxury Hotel','Resort','Hospitality Editorial']],
  ['SaaS','B2B AI SaaS platform for enterprise teams with dashboard-heavy product storytelling, technical credibility and conversion-focused pricing.',['saas','futuristic'],['AI SaaS Premium','AI / Technology','Data Editorial']],
  ['Luxury Automotive','Premium electric vehicle brand website with cinematic product presentation, interactive 3D vehicle exploration and sophisticated editorial storytelling.',['automotive','futuristic'],['Electric Mobility','Automotive Luxury','Luxury Automotive Light']],
  ['Real Estate','Luxury real estate developer presenting high-end residences with interactive floorplans, architectural visualization and lead generation.',['realestate','architecture'],['Luxury Property','Interactive Floorplan','Developer Luxury']],
  ['Church','Modern church website focused on services, sermons, ministries, events, community and online giving.',['church','community'],['Church Modern','Modern Ministry','Digital Ministry']],
  ['Restaurant','Premium fine dining restaurant with reservation conversion, menu storytelling, chef profile and immersive food photography.',['restaurant','hospitality'],['Fine Dining','Restaurant Editorial','Chef Portfolio']],
  ['Fashion','Luxury fashion brand with runway collection, editorial lookbook and premium commerce experience.',['fashion','luxury'],['Luxury Fashion','Fashion Lookbook','Runway Black']],
  ['Healthcare','Modern healthcare clinic focused on patient trust, services, accessibility and appointment conversion.',['healthcare','community'],['Healthcare Premium','Healthcare']],
  ['Education','Modern education platform for students with structured learning content and accessible navigation.',['education','community'],['Education','Learning Lab']],
  ['Creative Agency','Creative design agency showcasing art direction, case studies, motion work and experimental portfolio pieces.',['agency','creative'],['Creative Studio','Art Direction','Motion First Studio']],
];

describe('Phase B design intelligence pipeline',()=>{
  for(const [name,brief,industryHints,directionHints] of scenarios){
    it(name+' derives the right industry signals and ranked visual systems',()=>{
      const a=analyzeBrief({description:brief});
      expect(industryHints).toContain(a.industry);
      expect(a.designDirectionRank.slice(0,5).some(d=>industryHints.includes(d.category)||directionHints.includes(d.name))).toBe(true);
      const matrix=buildArtDirectionMatrix({description:brief},5);
      expect(matrix).toHaveLength(5);
      expect(matrix.every(x=>x.visualSystem?.typography&&x.visualSystem?.color&&x.visualSystem?.grid&&x.visualSystem?.motion&&x.visualSystem?.depth)).toBe(true);
    });
    it(name+' propagates selected intelligence into generated website output',()=>{
      const site=buildWebsite({description:brief});
      expect(site.designIntelligence.selectedDirection).toBe(site.spec.designDirection);
      expect(site.designIntelligence.composition).toEqual(site.spec.composition);
      expect(site.files['index.html']).toContain('data-composition=');
      expect(site.files['index.html']).toContain('data-grid=');
      expect(site.files['index.html']).toContain('data-motion=');
      expect(site.files['styles.css']).toContain('--display:');
      expect(site.files['styles.css']).toContain('--accent:');
      expect(site.spec.pages.length).toBeGreaterThan(2);
    });
  }

  it('preserves exact direction resolution over partial matches',()=>{
    expect(resolveDesignDirection('Cyber').name).toBe('Cyber');
    expect(resolveDesignDirection(' cyber ').name).toBe('Cyber');
    expect(resolveDesignDirection('CYBER').name).toBe('Cyber');
    expect(resolveDesignDirection('Cybersecurity Command').name).toBe('Cybersecurity Command');
    expect(resolveDesignDirection('security').name).toBe('Cybersecurity Command');
    expect(resolveDesignDirection('unknown design language').name).toBe('Luxury Editorial');
  });

  it('produces materially different compositions for luxury, SaaS and brutalist systems',()=>{
    const luxury=createDesignSpecification({description:'luxury fashion editorial',visualDirection:'Luxury Fashion'});
    const saas=createDesignSpecification({description:'enterprise AI SaaS dashboard',visualDirection:'AI SaaS Premium'});
    const brutal=createDesignSpecification({description:'experimental creative agency',visualDirection:'Brutalist'});
    expect(new Set([luxury.composition.hero,saas.composition.hero,brutal.composition.hero]).size).toBe(3);
    expect(luxury.grid).toBe('runway editorial');
    expect(saas.grid).toBe('spatial');
    expect(brutal.grid).toBe('raw asymmetric');
  });

  it('generates three or more intentional variations with inherited design tokens',()=>{
    const spec=createDesignSpecification({description:'luxury resort in Zanzibar'});
    const vars=createDesignVariations(spec,{description:'luxury resort in Zanzibar'});
    expect(vars.length).toBeGreaterThanOrEqual(3);
    expect(vars.every(v=>v.colorSystem?.background&&v.typography?.display&&v.grid&&v.composition&&v.motionLanguage)).toBe(true);
    expect(new Set(vars.slice(0,3).map(v=>v.designDirection)).size).toBe(3);
  });

  it('keeps the design specification as the propagation source of truth',()=>{
    const spec=createDesignSpecification({description:'premium electric vehicle with interactive 3D'});
    expect(spec.designDirection).toBeTruthy();
    expect(spec.colorSystem.accent).toBe(spec.designDirection.color.accent);
    expect(spec.typography.display).toBe(spec.designDirection.typography.display);
    expect(spec.grid).toBe(spec.designDirection.grid);
    expect(spec.composition).toEqual(resolveComposition(spec.designDirection));
    expect(spec.threeD.required).toBe(true);
  });
});
