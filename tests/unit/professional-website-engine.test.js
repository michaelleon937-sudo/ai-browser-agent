import{describe,it,expect}from"vitest";
import{listRegisteredTools}from"../../control/index.js";
import{MCP_TOOL_DEFINITIONS}from"../../mcp/tools.js";
import{analyzeBrief,createDesignSpecification,createDesignVariations,generateDesignSystem,buildWebsite,runQualityChecks,runSecurityChecks,runVisualQa,runRenderedVisualQa,prepareDelivery,summarizeEngine}from"../../website-engine/index.js";
describe("Professional Website & Design Engine",()=>{
it("brief intelligence",()=>expect(analyzeBrief({description:"premium luxury hotel"}).style).toBe("luxury"));
it("architecture intelligence",()=>expect(analyzeBrief({description:"architecture interior"}).industry).toBe("architecture"));
it("3D intelligence",()=>{const a=analyzeBrief({description:"futuristic 3d product"});expect(a.use3D).toBe(true);});
it("spec source of truth",()=>expect(createDesignSpecification({industry:"saas"})).toHaveProperty("typography"));
it("design library directions",()=>{const names=createDesignVariations(createDesignSpecification({})).map(x=>x.name);expect(names.slice(0,3)).toEqual(["Luxury Editorial","Modern Minimal","Futuristic 3D"]);expect(names.length).toBeGreaterThanOrEqual(5);});
it("tokens",()=>expect(generateDesignSystem(createDesignSpecification({}))).toHaveProperty("tokens"));
it("responsive",()=>{const p=buildWebsite({industry:"restaurant"});expect(p.files["styles.css"]).toContain("@media");expect(p.files["index.html"]).toContain("viewport")});
it("alt and lazy images",()=>{const h=buildWebsite({}).files["index.html"];expect(h).toMatch(/alt="/);expect(h).toContain('loading="lazy"')});
it("reduced motion",()=>expect(buildWebsite({}).files["styles.css"]).toContain("prefers-reduced-motion"));
it("focus",()=>expect(buildWebsite({}).files["styles.css"]).toContain(":focus-visible"));
it("progressive 3D",()=>expect(buildWebsite({use3D:true}).files["app.js"]).toContain("canWebGL"));
it("pointer interaction",()=>expect(buildWebsite({use3D:true}).files["app.js"]).toContain("pointerdown"));
it("quality",()=>expect(runQualityChecks(buildWebsite({}),buildWebsite({}).spec).failures).toEqual([]));
it("security",()=>expect(runSecurityChecks(buildWebsite({})).failures).toEqual([]));
it("visual QA",()=>expect(runVisualQa(buildWebsite({})).failures).toEqual([]));
it("rendered visual QA evidence",async()=>{const r=await runRenderedVisualQa(buildWebsite({}));expect(r.available).toBe(true);expect(r.passed).toBe(true);expect(r.viewportCount).toBe(3);expect(r.screenshotsGenerated).toBe(3);expect(r.viewports.every(v=>v.screenshot.sha256&&v.screenshot.bytes>0)).toBe(true)});
it("delivery gate",()=>expect(prepareDelivery(buildWebsite({})).status).toBe("AWAITING_APPROVAL"));
it("failed delivery blocked",()=>{const p=buildWebsite({});p.qa.security.failures=["x"];expect(prepareDelivery(p).status).toBe("BLOCKED")});
it("ecommerce",()=>expect(buildWebsite({industry:"ecommerce"}).spec.industryModules).toContain("cart"));
it("restaurant",()=>expect(buildWebsite({industry:"restaurant"}).spec.industryModules).toContain("reservations"));
it("church",()=>expect(buildWebsite({industry:"church"}).spec.industryModules).toContain("sermons"));
it("real estate",()=>expect(buildWebsite({industry:"realestate"}).spec.industryModules).toContain("floor plans"));
it("saas",()=>expect(buildWebsite({industry:"saas"}).spec.industryModules).toContain("pricing"));
it("architecture",()=>expect(buildWebsite({industry:"architecture"}).spec.industryModules).toContain("visualization"));
it("audit",()=>expect(buildWebsite({}).audit.map(x=>x.event)).toContain("design.specification"));
it("capabilities",()=>expect(summarizeEngine().features).toContain("approval-gated-delivery"));
it("no secret",()=>expect(JSON.stringify(buildWebsite({}).files)).not.toMatch(/CONTROL_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY/));
});

it("exact website control lifecycle is registered",()=>{const names=listRegisteredTools();expect(names).toEqual(expect.arrayContaining(["website.create_design_spec","website.preview","website.revise","website.visual_qa","website.prepare_deployment","website.deploy","website.rollback","website.status","website.delivery"]));});
it("exact website MCP lifecycle is exposed",()=>{const names=MCP_TOOL_DEFINITIONS.map(x=>x.controlName);expect(names).toEqual(expect.arrayContaining(["website.create_design_spec","website.preview","website.revise","website.visual_qa","website.prepare_deployment","website.deploy","website.rollback","website.status","website.delivery"]));});

import { createDesignSpecification, buildWebsite } from '../../website-engine/index.js';
import { DESIGN_DIRECTIONS } from '../../website-engine/design-library.js';

describe('design composition engine',()=>{
  it('maps materially different directions to composition profiles',()=>{
    const luxury=createDesignSpecification({industry:'fashion',visualDirection:'Luxury Fashion'});
    const brutal=createDesignSpecification({industry:'agency',visualDirection:'Brutalist'});
    const spatial=createDesignSpecification({industry:'technology',visualDirection:'Futuristic 3D',use3D:true});
    expect(luxury.composition.hero).not.toBe(brutal.composition.hero);
    expect(spatial.composition.hero).not.toBe(luxury.composition.hero);
    expect(DESIGN_DIRECTIONS.length).toBeGreaterThanOrEqual(50);
  });
  it('emits composition data attributes into generated pages',()=>{
    const site=buildWebsite({industry:'restaurant',visualDirection:'Fine Dining'});
    const html=site.files['index.html'];
    expect(html).toMatch(/data-composition=/);
    expect(html).toMatch(/data-section-style=/);
    expect(html).toMatch(/data-card-style=/);
  });
});
