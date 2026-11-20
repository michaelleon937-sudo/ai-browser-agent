import { describe, expect, it } from 'vitest';
import { evaluateAgentAction, isSafeResearchUrl, resolveAgentMode } from '../../agent/operating-modes.js';

describe('Nexora agent operating modes', () => {
  it('defaults to draft mode and fails closed to research for invalid modes', () => {
    expect(resolveAgentMode('')).toBe('draft');
    expect(resolveAgentMode('draft')).toBe('draft');
    expect(resolveAgentMode('research')).toBe('research');
    expect(resolveAgentMode('production')).toBe('research');
  });
  it('allows only public HTTP(S) research URLs', () => {
    expect(isSafeResearchUrl('https://example.com/services')).toBe(true);
    expect(isSafeResearchUrl('http://127.0.0.1:8787')).toBe(false);
    expect(isSafeResearchUrl('http://10.0.0.5/internal')).toBe(false);
    expect(isSafeResearchUrl('https://example.com/login')).toBe(false);
    expect(isSafeResearchUrl('https://checkout.stripe.com/pay')).toBe(false);
    expect(isSafeResearchUrl('file:///etc/passwd')).toBe(false);
  });
  it('allows public research but blocks draft creation in research-only mode', () => {
    expect(evaluateAgentAction({ mode:'research', tool:'web_search', args:{ query:'Tanzania branding prices' } }).allow).toBe(true);
    expect(evaluateAgentAction({ mode:'research', tool:'browser_navigate', args:{ url:'https://example.com' } }).allow).toBe(true);
    expect(evaluateAgentAction({ mode:'research', tool:'generate_website' }).allow).toBe(false);
  });
  it('allows internal drafts but gates browser interaction behind human approval', () => {
    expect(evaluateAgentAction({ mode:'draft', tool:'generate_proposal' }).allow).toBe(true);
    expect(evaluateAgentAction({ mode:'draft', tool:'prepare_outreach' }).allow).toBe(true);
    const result=evaluateAgentAction({ mode:'draft', tool:'browser_click', args:{target:'e1'}, observation:{elements:[{ref:'e1',tag:'A',text:'About us',href:'https://example.com/about'}]} });
    expect(result.allow).toBe(true); expect(result.requiresApproval).toBe(true); expect(result.approvalContext.target.label).toBe('About us');
  });
  it('blocks browser clicks on send, submit, publish and payment controls', () => {
    const result=evaluateAgentAction({ mode:'draft', tool:'browser_click', args:{target:'e1'}, observation:{elements:[{ref:'e1',tag:'BUTTON',text:'Send message'}]} });
    expect(result.allow).toBe(false); expect(result.reason).toMatch(/blocked/i);
  });
  it('requires visible targets from the current snapshot', () => {
    const result=evaluateAgentAction({ mode:'draft', tool:'browser_type', args:{target:'e99',text:'draft'}, observation:{elements:[]} });
    expect(result.allow).toBe(false); expect(result.reason).toMatch(/current browser snapshot/i);
  });
  it('blocks credential fields and form submission keys', () => {
    const password=evaluateAgentAction({ mode:'draft', tool:'browser_fill', args:{target:'e1',value:'secret'}, observation:{elements:[{ref:'e1',tag:'INPUT',type:'password',label:'Password'}]} });
    expect(password.allow).toBe(false);
    expect(evaluateAgentAction({ mode:'draft', tool:'browser_press', args:{key:'Enter'} }).allow).toBe(false);
    expect(evaluateAgentAction({ mode:'draft', tool:'browser_press', args:{key:'Control+Enter'} }).allow).toBe(false);
  });
  it('never enables arbitrary page JavaScript or unknown tools', () => {
    expect(evaluateAgentAction({ mode:'draft', tool:'browser_evaluate', args:{fn:'fetch("https://example.com")'} }).allow).toBe(false);
    expect(evaluateAgentAction({ mode:'draft', tool:'send_email' }).allow).toBe(false);
  });
});
