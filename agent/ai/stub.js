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


      // ── Regression test: many permanent DNS failures must NOT exhaust
      //    the global retry budget (production bug: "Total retries
      //    exceeded (8)" after just a handful of dead domains).
      if (/dead domain|multiple.*nonexistent|exhaust.*retry budget/.test(g)) {
        const deadDomains = [
          'https://this-domain-does-not-exist-1.invalid',
          'https://this-domain-does-not-exist-2.invalid',
          'https://this-domain-does-not-exist-3.invalid',
          'https://this-domain-does-not-exist-4.invalid',
          'https://this-domain-does-not-exist-5.invalid',
        ];
        const triedCount = steps.filter((s) => s.tool === 'browser_navigate' && deadDomains.includes(s.action?.args?.url)).length;
        if (triedCount < deadDomains.length) {
          return call('browser_navigate', { url: deadDomains[triedCount] }, `try candidate source ${triedCount + 1}`);
        }
        if (!steps.some((s) => s.tool === 'browser_navigate' && s.action?.args?.url === 'https://example.com')) {
          return call('browser_navigate', { url: 'https://example.com' }, 'all prior sources were dead ends; try a working source');
        }
        return { action: { tool: 'task_complete', args: { result: 'Recovered after multiple dead-end sources and found a working one.' }, reasoning: 'done' }, done: true };
      }




      // ── Sample & Proposal Generation (Phase 4) smoke-test ───────────
      const phase4Match = String(goal || '').match(/create a sample and proposal for opportunity (\S+)(?: using sampleType (\S+))?/i);
      if (phase4Match) {
        const opportunityId = phase4Match[1];
        const requestedSampleType = phase4Match[2] || 'website';
        const createSampleStep = steps.find((s) => s.tool === 'create_sample');
        const saveSampleStep = steps.find((s) => s.tool === 'save_sample');
        const generateProposalStep = steps.find((s) => s.tool === 'generate_proposal');
        const saveProposalStep = steps.find((s) => s.tool === 'save_proposal');

        if (!createSampleStep) {
          return call('create_sample', { opportunityId, sampleType: requestedSampleType }, 'create a speculative sample for this opportunity');
        }
        if (!saveSampleStep) {
          const obs = createSampleStep.observation || {};
          return call('save_sample', {
            opportunityId,
            sampleType: obs.sampleType,
            contentKind: obs.contentKind,
            content: obs.content,
            websiteSampleId: obs.websiteSampleId,
            previewPath: obs.previewPath,
          }, 'save the created sample, using the exact output of create_sample');
        }
        if (!generateProposalStep) {
          const sampleId = saveSampleStep.observation?.sampleId;
          return call('generate_proposal', { opportunityId, sampleId }, 'draft a proposal for this opportunity');
        }
        if (!saveProposalStep) {
          const sampleId = saveSampleStep.observation?.sampleId;
          const obs = generateProposalStep.observation || {};
          return call('save_proposal', {
            opportunityId,
            sampleId,
            pitch: obs.pitch,
            serviceRecommendation: obs.serviceRecommendation,
            valueProposition: obs.valueProposition,
            suggestedPackage: obs.suggestedPackage,
            callToAction: obs.callToAction,
            assumptions: obs.assumptions,
          }, 'save the proposal');
        }
        return { action: { tool: 'task_complete', args: { result: 'Sample and proposal created; opportunity now awaiting approval.' }, reasoning: 'done' }, done: true };
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


      if (/prospect|opportunity|real.?estate|dar es salaam|property tanzania|analyze.*opportunity|save.*opportunity/.test(g)) {
        if (!steps.some((s) => s.tool === 'save_prospect')) {
          return call('save_prospect', {
            businessName: 'Example Property Tanzania',
            websiteUrl: 'https://example.com',
            location: 'Dar es Salaam, Tanzania',
            contactEmail: '',
            contactPhone: '',
            notes: 'Stub prospect for Phase 2/3 pipeline test',
            source: 'stub',
          }, 'save a stub prospect');
        }
        const saveProspect = steps.find((s) => s.tool === 'save_prospect' && s.status === 'success');
        const prospectId = saveProspect?.observation?.prospectId;
        if (prospectId && !steps.some((s) => s.tool === 'analyze_opportunity')) {
          return call('analyze_opportunity', { prospectId }, 'analyze opportunity for saved prospect');
        }
        if (prospectId && !steps.some((s) => s.tool === 'save_opportunity')) {
          const analysis = steps.find((s) => s.tool === 'analyze_opportunity' && s.status === 'success');
          const obs = analysis?.observation || {};
          return call('save_opportunity', {
            prospectId,
            score: obs.score ?? 70,
            priority: obs.priority ?? 'MEDIUM',
            opportunityType: obs.opportunityType ?? 'website_upgrade',
            recommendedServices: obs.recommendedServices ?? ['website'],
            recommendedSampleType: obs.recommendedSampleType ?? 'website',
          }, 'save the opportunity analysis');
        }
        return { action: { tool: 'task_complete', args: { result: 'Prospect saved, opportunity analyzed and saved.' }, reasoning: 'done' }, done: true };
      }


      // ── Website generation goal ────────────────────────────
      if (/generate.*website|website sample|speculative.*website|example property tanzania/.test(g) && !/prospect|opportunity/.test(g)) {
        if (!steps.some((s) => s.tool === 'generate_website')) {
          return call('generate_website', {
            prospectName: 'Example Property Tanzania',
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


      // ── Form-filling practice goal ────────────────────────────
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


      // ── Generic safe default: navigate, snapshot, read, complete ─────
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
