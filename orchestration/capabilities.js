// orchestration/capabilities.js
// Capability registry for supervisor delegation. Does not reimplement engines.

export const CAPABILITIES = Object.freeze({
  RESEARCH: 'research',
  BROWSER: 'browser',
  CREATIVE: 'creative',
  WEBSITE: 'website',
  RELATIONSHIP: 'relationship',
  SALES: 'sales',
  QA: 'qa',
  DELIVERY: 'delivery',
  CRM: 'crm',
  REPAIR: 'repair',
});

/** Map classification / intent signals to ordered capabilities. */
export function selectCapabilities({ classification, requestedService, goal } = {}) {
  const c = String(classification || '').toUpperCase();
  const service = String(requestedService || goal || '').toLowerCase();
  const selected = new Set([CAPABILITIES.CRM]);

  if (/website|landing|web/.test(service)) selected.add(CAPABILITIES.WEBSITE);
  if (/logo|brand|graphic|poster|flyer|social|video|3d|creative|design/.test(service)) {
    selected.add(CAPABILITIES.CREATIVE);
  }
  if (c === 'REQUEST_FOR_SERVICE' || c === 'REQUEST_FOR_QUOTE') selected.add(CAPABILITIES.SALES);
  if (c === 'REVISION_REQUEST') selected.add(CAPABILITIES.QA);
  if (c === 'INTERESTED' || c === 'FOLLOW_UP') selected.add(CAPABILITIES.RELATIONSHIP);
  if (/research|prospect|search/.test(service)) selected.add(CAPABILITIES.RESEARCH);
  if (/browser|scrape|navigate/.test(service)) selected.add(CAPABILITIES.BROWSER);

  selected.add(CAPABILITIES.QA);
  selected.add(CAPABILITIES.DELIVERY);
  return [...selected];
}

export function describeCapability(name) {
  const map = {
    [CAPABILITIES.RESEARCH]: { module: 'integrations/web-search + prospecting', sideEffects: false },
    [CAPABILITIES.BROWSER]: { module: 'browser + control/tools/browser', sideEffects: false },
    [CAPABILITIES.CREATIVE]: { module: 'creative-engine', sideEffects: 'none until approved render' },
    [CAPABILITIES.WEBSITE]: { module: 'website-engine', sideEffects: 'none until approved deploy' },
    [CAPABILITIES.RELATIONSHIP]: { module: 'relationship-engine + follow-up-engine', sideEffects: false },
    [CAPABILITIES.SALES]: { module: 'opportunity-intelligence + proposal-generation', sideEffects: false },
    [CAPABILITIES.QA]: { module: 'visual-qa + production QA', sideEffects: false },
    [CAPABILITIES.DELIVERY]: { module: 'client-delivery (approval-gated)', sideEffects: 'none until send_approved' },
    [CAPABILITIES.CRM]: { module: 'message-classification + CRM stores', sideEffects: false },
    [CAPABILITIES.REPAIR]: { module: 'control/repair + website selfRepair', sideEffects: false, maxAttempts: 3 },
  };
  return map[name] || { module: 'unknown', sideEffects: false };
}
