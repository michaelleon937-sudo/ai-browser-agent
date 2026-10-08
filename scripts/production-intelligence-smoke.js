// scripts/production-intelligence-smoke.js
// One-shot production HTTP smoke test. Disabled unless explicitly enabled by env.
// Uses the real CONTROL_TOKEN only inside the running process; never logs it.
import { promises as fs } from 'node:fs';
import { prospects } from '../database/index.js';
import { config } from '../config/index.js';
import { getControlToken } from '../control/auth.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runProductionIntelligenceSmoke() {
  if (process.env.PRODUCTION_CERTIFICATION_SMOKE !== 'true') return;

  const marker = '/data/.production-intelligence-smoke-complete';
  try {
    await fs.access(marker);
    if (process.env.PRODUCTION_OBJECTIVE_SMOKE !== 'true') {
      console.log('[cert-smoke] already completed; skipping');
      return;
    }
  } catch {}

  const token = getControlToken();
  const prospect = prospects.list({ limit: 1 })[0] || null;
  const base = `http://127.0.0.1:${config.dashboard.port}/api/control/v1/tools`;

  if (!token) {
    console.error('[cert-smoke] FAIL control token unavailable');
    return;
  }
  if (!prospect) {
    console.error('[cert-smoke] FAIL no prospect available for client/presentation smoke test');
    return;
  }

  await sleep(1000);

  const run = async (toolName, args, extra = {}) => {
    const response = await fetch(`${base}/${encodeURIComponent(toolName)}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-request-id': `cert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ...(extra.idempotencyKey ? { 'idempotency-key': extra.idempotencyKey } : {}),
      },
      body: JSON.stringify(args),
    });
    let body = null;
    try { body = await response.json(); } catch {}
    return { status: response.status, body };
  };

  const client = await run('client.intelligence', { prospectId: prospect.id });
  const presentation = await run('client.whatsapp_presentation', { prospectId: prospect.id, maxSamples: 3 });
  const revenue = await run('revenue.intelligence', { days: 30 });

  const clientResult = client.body?.result;
  const presentationResult = presentation.body?.result;
  const revenueResult = revenue.body?.result;

  const clientPass = client.status === 200 && client.body?.ok === true && clientResult?.ok === true && Boolean(clientResult?.qualification && clientResult?.client);
  const presentationPass = presentation.status === 200 && presentation.body?.ok === true && presentationResult?.ok === true && Boolean(presentationResult?.formattedMessage);
  const revenuePass = revenue.status === 200 && revenue.body?.ok === true && revenueResult?.ok === true && Boolean(revenueResult?.funnel);

  console.log('[cert-smoke] production intelligence HTTP certification', JSON.stringify({
    client: { status: client.status, pass: clientPass },
    presentation: { status: presentation.status, pass: presentationPass, externalSideEffect: presentationResult?.externalSideEffect },
    revenue: { status: revenue.status, pass: revenuePass },
    prospectFound: true,
    allPass: clientPass && presentationPass && revenuePass,
  }));

  if (clientPass && presentationPass && revenuePass) {
    await fs.writeFile(marker, JSON.stringify({
      completedAt: new Date().toISOString(),
      clientStatus: client.status,
      presentationStatus: presentation.status,
      revenueStatus: revenue.status,
    }), 'utf8');
    console.log('[cert-smoke] PASS');

  if (process.env.PRODUCTION_OBJECTIVE_SMOKE === 'true') {
  const objectivePlanResponse = await run('supervisor.plan', {
    objectiveDriven: true,
    objective: 'qualify this prospect and present the best offer',
    prospectId: prospect.id,
  });
  const objectivePlan = objectivePlanResponse.body?.result ?? objectivePlanResponse.body;
  const objectivePlanPass = objectivePlanResponse.status === 200 && objectivePlan?.objectiveDriven === true && objectivePlan?.plan?.planner === 'OBJECTIVE_DRIVEN_ORCHESTRATOR' && objectivePlan?.plan?.steps?.map((s) => s.tool).join(',') === 'client.intelligence,client.whatsapp_presentation,revenue.intelligence';
  const objectiveRunResponse = await run('supervisor.run_journey', {
    objectiveDriven: true,
    objective: 'qualify this prospect and present the best offer',
    prospectId: prospect.id,
  }, { idempotencyKey: 'cert-objective-' + prospect.id });
  const objectiveRun = objectiveRunResponse.body?.result ?? objectiveRunResponse.body;
  const objectiveRunPass = objectiveRunResponse.status === 200 && objectiveRun?.ok === true && objectiveRun?.status === 'COMPLETED' && objectiveRun?.completedSteps === 3 && objectiveRun?.externalSideEffect === false && objectiveRun?.results?.every((s) => s.status === 'success');
  const objectiveAllPass = objectivePlanPass && objectiveRunPass;
  console.log('[cert-objective]', JSON.stringify({ plan: { status: objectivePlanResponse.status, pass: objectivePlanPass }, execute: { status: objectiveRunResponse.status, pass: objectiveRunPass }, prospectFound: true, completedSteps: objectiveRun?.completedSteps ?? 0, externalSideEffect: objectiveRun?.externalSideEffect ?? null, allPass: objectiveAllPass }));
  if (!objectiveAllPass) throw new Error('Production objective orchestration certification failed');
  console.log('[cert-objective] PASS');
  }
  } else {
    console.error('[cert-smoke] FAIL');
  }
}
