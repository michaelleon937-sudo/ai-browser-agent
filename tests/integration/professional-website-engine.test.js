import{describe,it,expect}from"vitest";
import{buildWebsite,prepareDelivery}from"../../website-engine/index.js";
describe("professional website generation integration",()=>{
it("runs brief to gated delivery",()=>{const p=buildWebsite({name:"Studio",industry:"architecture",use3D:true});expect(p.id).toMatch(/^site_/);expect(Object.keys(p.files)).toEqual(expect.arrayContaining(["index.html","styles.css","app.js","README.md"]));expect(p.qa.security.failures).toEqual([]);expect(prepareDelivery(p).status).toBe("AWAITING_APPROVAL")});
it("keeps deployment gated",()=>expect(prepareDelivery(buildWebsite({})).deployment).toBe("approval-gated"));
});
