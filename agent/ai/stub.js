// agent/ai/stub.js
// Deterministic AI provider used for tests and local runs without external API.
// Implements the same `nextAction({...})` contract as the real providers, but
// follows a scripted sequence based on the goal string.


export function stubProvider() {
  return {
    name: 'stub',
    async nextAction({ goal, history }) {
      // Heuristic scripted plan that actually works against https://example.com and
      // theagenttest.site / practice automation sites, depending on the goal.
      const g = String(goal || '').toLowerCase();
      const steps = history?.steps || [];


      const call = (tool, args, reasoning) => ({ action: { tool, args, reasoning }, done: false });


      // Detect a previous failure so the stub can recover.
      const lastStep = steps[steps.length - 1];
      const lastFailed = lastStep?.status === 'failed';


      // ── Test-only: force failures for recovery test ─────────────────
      if (/force failure/.test(g)) {
        return call('browser_evaluate', { fn: 'throw new Error("intentional")' }, 'force a runtime failure');
      }


      // ── Generic navigation-to-info goal ─────────────────────────
      if (/example\.com|status code|http status|headers/.test(g)) {
        if (!steps.some((s) => s.tool === 'browser_navigate')) {
          return call('browser_navigate', { url: 'https://example.com' }, 'go to example.com');
        }
        if (!steps.some((s) => s.tool === 'browser_get_page_info')) {
          return call('browser_get_page_info', {}, 'inspect page');
        }
        return { action: { tool: 'task_complete', args: { result: 'Visited example.com and read page info.' }, reasoning: 'done' }, done: true };
      }


      // ── Prospecting + Opportunity Intelligence (Phase 2/3) smoke-test ──
      if (/missing prospect|unknown prospect|opportunity for a prospect that does not exist/.test(g)) {
        if (lastFailed && lastStep?.tool === 'analyze_opportunity') {
          return { action: { tool: 'task_fail', args: { reason: lastStep.errorMessage || 'analyze_opportunity failed' }, reasoning: 'the prospect could not be found, so the task cannot proceed' }, done: true };
        }
        if (!steps.some((s) => s.tool === 'analyze_opportunity')) {
          return call('analyze_opportunity', { prospectId: 'does-not-exist-prospect-id' }, 'attempt to analyze a nonexistent prospect');
        }
        return { action: { tool: 'task_complete', args: { result: 'done' }, reasoning: 'done' }, done: true };
      }

      if (/prospect.*opportunity|opportunity.*prospect|analyze.*opportunity/.test(g)) {
        const saveProspectStep = steps.find((s) => s.tool === 'save_prospect');
        const analyzeOppStep = steps.find((s) => s.tool === 'analyze_opportunity');
        const saveOppStep = steps.find((s) => s.tool === 'save_opportunity');

        if (!saveProspectStep) {
          return call('save_prospect', {
            businessName: 'Example Property Tanzania',
            websiteUrl: null,
            location: 'Dar es Salaam, Tanzania',
            serviceGaps: ['No public contact information found on the page (no email or phone detected).'],
            sourceUrl: 'https://example-realty.com',
          }, 'save the discovered prospect');
        }
        if (!analyzeOppStep) {
          const prospectId = saveProspectStep.observation?.prospectId;
          return call('analyze_opportunity', { prospectId }, 'analyze the opportunity for this prospect');
        }
        if (!saveOppStep) {
          const obs = analyzeOppStep.observation || {};
          return call('save_opportunity', {
            prospectId: obs.prospectId,
            score: obs.score,
            priority: obs.priority,
            opportunityType: obs.opportunityType,
            summary: obs.summary,
            identifiedProblems: obs.identifiedProblems,
            recommendedServices: obs.recommendedServices,
            recommendedSampleType: obs.recommendedSampleType,
            confidence: obs.confidence,
          }, 'save the validated opportunity');
        }
        return { action: { tool: 'task_complete', args: { result: 'Prospect analyzed and opportunity saved.' }, reasoning: 'done' }, done: true };
      }


      // ── Website Engine (Phase 1) smoke-test goal ─────────────────
      if (/generate.*website|website.*sample|real.estate website/.test(g)) {
        if (!steps.some((s) => s.tool === 'generate_website')) {
          return call('generate_website', {
            prospectName: 'Example Property Tanzania',
            businessType: 'Real Estate Agency',
            location: 'Dar es Salaam, Tanzania',
            websiteGoal: 'Showcase available properties and generate inquiries',
            brandStyle: 'modern',
            primaryColor: '#1a2b4c',
            secondaryColor: '#c9a227',
            sections: ['hero', 'about', 'services', 'properties', 'why', 'contact', 'cta', 'footer'],
            services: ['Property sales', 'Property rentals', 'Property management'],
            propertyListings: [
              { title: 'Sample listing — replace with real data', location: 'Dar es Salaam', price: 'TBD', description: 'Placeholder property for the speculative sample.' },
            ],
            contactInformation: { phone: '', email: '', address: 'Dar es Salaam, Tanzania' },
            callToAction: 'Book a viewing',
          }, 'generate a speculative website sample for the prospect');
        }
        return { action: { tool: 'task_complete', args: { result: 'Generated a speculative website sample.' }, reasoning: 'done' }, done: true };
      }


      // ── Form-filling practice goal ──────────────────────────────
      if (/fill.*form|practice.*automation|automationexercise|theautomation/.test(g)) {
        const done = (s) => steps.some((x) => x.tool === s);
        if (!done('browser_navigate')) {
          return call('browser_navigate', { url: 'https://theautomationplace.com/' }, 'open automation practice site');
        }
        if (!done('browser_snapshot')) {
          return call('browser_snapshot', {}, 'inspect page structure');
        }
        return { action: { tool: 'task_complete', args: { result: 'Smoke test of browser automation primitives completed.' }, reasoning: 'done' }, done: true };
      }


      // ── Generic safe default: navigate, snapshot, read, complete ─
      // Fail safely if the most recent attempt failed.
      if (lastFailed) {
        return { action: { tool: 'task_fail', args: { reason: 'Stub: previous step failed; stopping safely.' }, reasoning: 'give up safely' }, done: true };
      }
      if (!steps.some((s) => s.tool === 'browser_navigate')) {
        return call('browser_navigate', { url: 'https://example.com' }, 'open example.com');
      }
      if (!steps.some((s) => s.tool === 'browser_get_page_info')) {
        return call('browser_get_page_info', {}, 'read page info');
      }
      return { action: { tool: 'task_complete', args: { result: 'Stub completed generic goal.' }, reasoning: 'done' }, done: true };
    },
  };
}
