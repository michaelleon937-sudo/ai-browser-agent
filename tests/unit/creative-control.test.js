import { describe,it,expect } from 'vitest';
import { executeTool,listRegisteredTools } from '../../control/index.js';
import { evaluatePolicy } from '../../control/policy.js';

describe('creative control integration',()=>{
  it('registers read-only creative planning and provider status',()=>{expect(listRegisteredTools()).toEqual(expect.arrayContaining(['creative.capabilities','creative.preflight','creative.plan','creative.render']));expect(evaluatePolicy({toolName:'creative.plan'}).allow).toBe(true);});
  it('requires approval before provider spending/rendering',()=>{const p=evaluatePolicy({toolName:'creative.render',args:{approved:false}});expect(p.allow).toBe(false);expect(p.status).toBe(403);});
  it('allows an explicitly approved render through policy',()=>{const p=evaluatePolicy({toolName:'creative.render',args:{approved:true}});expect(p.allow).toBe(true);});
});
