import { describe,it,expect } from 'vitest';
import { classifyObjective,planObjective,validateObjectivePlan } from '../../orchestration/objective-engine.js';
describe('objective-driven orchestration',()=>{
 it('classifies objectives',()=>{expect(classifyObjective('qualify this prospect and present the best offer')).toBe('CLIENT_REVENUE');expect(classifyObjective('increase revenue and close more sales')).toBe('REVENUE_GROWTH');});
 it('composes existing intelligence in dependency order',()=>{const p=planObjective({objective:'qualify this prospect and present the best offer',prospectId:'p1'});expect(p.steps.map(s=>s.tool)).toEqual(['client.intelligence','client.whatsapp_presentation','revenue.intelligence']);expect(p.steps[1].dependsOn).toContain(p.steps[0].id);expect(validateObjectivePlan(p).ok).toBe(true);});
 it('rejects unsupported tools',()=>{const p=planObjective({objective:'analyze the business'});expect(validateObjectivePlan({...p,steps:[{...p.steps[0],tool:'invented.tool'}]}).ok).toBe(false);});
});