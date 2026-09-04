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
