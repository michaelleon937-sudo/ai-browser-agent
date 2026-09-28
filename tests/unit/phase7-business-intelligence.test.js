import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let db;
let companies;
let contacts;
let prospects;
let invoices;
let payments;
let projects;
let clientMemory;
let MEMORY_CONFIDENCE;
let relationshipStates;
let clientTimelineEvents;
let followUpRecommendations;
let clientRevenueSnapshots;

let evaluateRelationship;
let computeRelationshipState;
let assertRelationshipTransition;
let RELATIONSHIP_STATES;
let generateFollowUps;
let listFollowUps;
let resolveFollowUp;
let buildClientTimeline;
let computeRevenueHistory;
let detectDormantClients;
let detectRepeatBusiness;
let linkOpportunityToClient;
let assessProjectReadiness;
let getClientIntelligence;
let businessIntelligenceQuery;
let generateBusinessAnalystBrief;
let biTools;
let isAllowedTool;
let isMutatingTool;
let isForbiddenTool;

const tmpDir = path.join(os.tmpdir(), 'phase7bi-' + Date.now());

beforeAll(async () => {
  fs.mkdirSync(tmpDir, { recursive: true });
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
  process.env.DATA_DIR = tmpDir;
  process.env.AI_PROVIDER = 'stub';
  process.env.PAYMENT_MODE = 'mock';
  process.env.LIVE_PAYMENTS_ENABLED = 'false';

  db = await import('../../database/index.js');
  ({
    companies, contacts, prospects, invoices, payments, projects,
    clientMemory, MEMORY_CONFIDENCE, relationshipStates, clientTimelineEvents,
    followUpRecommendations, clientRevenueSnapshots,
  } = db);
  db.migrate();

  ({
    evaluateRelationship, computeRelationshipState, assertRelationshipTransition, RELATIONSHIP_STATES,
  } = await import('../../integrations/relationship-engine.js'));
  ({ generateFollowUps, listFollowUps, resolveFollowUp } = await import('../../integrations/follow-up-engine.js'));
  ({
    buildClientTimeline, computeRevenueHistory, detectDormantClients, detectRepeatBusiness,
    linkOpportunityToClient, assessProjectReadiness, getClientIntelligence,
    businessIntelligenceQuery, generateBusinessAnalystBrief,
  } = await import('../../integrations/client-intelligence.js'));
  ({ biTools } = await import('../../control/tools/bi.js'));
  ({ isAllowedTool, isMutatingTool, isForbiddenTool } = await import('../../control/policy.js'));
});

beforeEach(() => {
  const d = db.getDb();
  for (const t of [
    'follow_up_recommendations', 'client_timeline_events', 'relationship_states',
    'client_revenue_snapshots', 'client_memory', 'payments', 'invoices', 'projects',
    'inbound_messages', 'conversations', 'contacts', 'companies',
  ]) {
    try { d.prepare(`DELETE FROM ${t}`).run(); } catch { /* ignore */ }
  }
});

afterAll(() => {
  try { db.closeDb(); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

function seedCompany(name = 'Acme Corp') {
  return companies.create({ name, domain: name.toLowerCase().replace(/\s+/g, '') + '.test' });
}

describe('Phase 7 BI — relationship state machine', () => {
  it('computes NEW for empty evidence', () => {
    expect(computeRelationshipState({}).state).toBe(RELATIONSHIP_STATES.NEW);
  });
  it('computes ENGAGED for multiple messages', () => {
    expect(computeRelationshipState({ messageCount: 3 }).state).toBe(RELATIONSHIP_STATES.ENGAGED);
  });
  it('computes PAID when paid invoice present', () => {
    expect(computeRelationshipState({ hasPaidInvoice: true }).state).toBe(RELATIONSHIP_STATES.PAID);
  });
  it('computes ACTIVE_PROJECT over PAID when both true', () => {
    expect(computeRelationshipState({ hasPaidInvoice: true, hasActiveProject: true }).state).toBe(RELATIONSHIP_STATES.ACTIVE_PROJECT);
  });
  it('rejects invalid transitions', () => {
    expect(() => assertRelationshipTransition('NEW', 'PAID')).toThrow(/Invalid relationship/);
  });
  it('allows valid transitions', () => {
    expect(() => assertRelationshipTransition('NEW', 'CONTACTED')).not.toThrow();
    expect(() => assertRelationshipTransition('CUSTOMER', 'ACTIVE_PROJECT')).not.toThrow();
  });
  it('persists relationship evaluation for a company', () => {
    const company = seedCompany('Rel Co');
    const result = evaluateRelationship({ companyId: company.id, persist: true });
    expect(result.ok).toBe(true);
    expect(result.state).toBeTruthy();
    const current = relationshipStates.getCurrent({ companyId: company.id });
    expect(current).toBeTruthy();
    expect(current.state).toBe(result.state);
  });
});

describe('Phase 7 BI — client memory rules', () => {
  it('does not let INFERRED overwrite CONFIRMED_BY_CLIENT', () => {
    const company = seedCompany('Mem Co');
    const first = clientMemory.upsertFact({
      companyId: company.id, key: 'brand_name', value: 'Confirmed Brand',
      confidence: MEMORY_CONFIDENCE.CONFIRMED_BY_CLIENT, source: 'client_message',
    });
    expect(first.changed).toBe(true);
    const blocked = clientMemory.upsertFact({
      companyId: company.id, key: 'brand_name', value: 'Inferred Brand',
      confidence: MEMORY_CONFIDENCE.INFERRED, source: 'inference',
    });
    expect(blocked.blocked).toBe(true);
    expect(blocked.entry.value).toBe('Confirmed Brand');
  });
  it('stores history when confirmed value changes', () => {
    const company = seedCompany('Hist Co');
    clientMemory.upsertFact({
      companyId: company.id, key: 'budget', value: '1000',
      confidence: MEMORY_CONFIDENCE.CONFIRMED_BY_SYSTEM, source: 'operator',
    });
    clientMemory.upsertFact({
      companyId: company.id, key: 'budget', value: '2000',
      confidence: MEMORY_CONFIDENCE.CONFIRMED_BY_CLIENT, source: 'client_message',
    });
    const rows = clientMemory.list({ companyId: company.id, key: 'budget', limit: 10 });
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });
});

describe('Phase 7 BI — timeline', () => {
  it('records and lists timeline events', () => {
    const company = seedCompany('Time Co');
    const event = clientTimelineEvents.record({
      companyId: company.id, eventType: 'NOTE', title: 'Kickoff note',
      summary: 'Discussed scope', source: 'operator', confidence: 'CONFIRMED_BY_SYSTEM',
    });
    expect(event.id).toBeTruthy();
    expect(clientTimelineEvents.list({ companyId: company.id }).some((e) => e.id === event.id)).toBe(true);
  });
  it('buildClientTimeline returns events for company', () => {
    const company = seedCompany('Build Time Co');
    clientTimelineEvents.record({ companyId: company.id, eventType: 'MEETING', title: 'Discovery call', source: 'operator' });
    const result = buildClientTimeline({ companyId: company.id });
    expect(result.ok).toBe(true);
    expect(result.events.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Phase 7 BI — follow-up engine', () => {
  it('generates recommendations without external side effects', () => {
    const company = seedCompany('Follow Co');
    const result = generateFollowUps({ companyId: company.id, persist: true });
    expect(result.ok).toBe(true);
    expect(result.externalSideEffect).toBe(false);
    expect(result.recommendations.length).toBeGreaterThanOrEqual(1);
    for (const r of result.recommendations) expect(r.external_side_effect).toBe(0);
  });
  it('lists and resolves follow-ups', () => {
    const company = seedCompany('Resolve Co');
    const created = generateFollowUps({ companyId: company.id, persist: true });
    const id = created.recommendations[0].id;
    expect(listFollowUps({ companyId: company.id, status: 'OPEN' }).recommendations.some((r) => r.id === id)).toBe(true);
    const resolved = resolveFollowUp(id, { resolvedBy: 'tester' });
    expect(resolved.ok).toBe(true);
    expect(resolved.recommendation.status).toBe('RESOLVED');
  });
});

describe('Phase 7 BI — revenue & readiness', () => {
  it('computes zero revenue for new client', () => {
    const company = seedCompany('Rev Co');
    const result = computeRevenueHistory({ companyId: company.id, persist: true });
    expect(result.ok).toBe(true);
    expect(result.snapshot.total_invoiced ?? result.snapshot.totalInvoiced ?? 0).toBe(0);
  });
  it('assessProjectReadiness is advisory and not auto-start', () => {
    const company = seedCompany('Ready Co');
    const result = assessProjectReadiness({ companyId: company.id });
    expect(result.ok).toBe(true);
    expect(result.note).toMatch(/approval-gated/i);
  });
});

describe('Phase 7 BI — intelligence & BI queries', () => {
  it('returns client intelligence dossier', () => {
    const company = seedCompany('Intel Co');
    const result = getClientIntelligence({ companyId: company.id, refreshRelationship: true });
    expect(result.ok).toBe(true);
    expect(result.company.id).toBe(company.id);
    expect(result.authoritativeFacts).toBeTruthy();
  });
  it('businessIntelligenceQuery lists available queries', () => {
    const result = businessIntelligenceQuery({ query: 'unknown' });
    expect(result.ok).toBe(true);
    expect(result.availableQueries).toContain('dormant');
  });
  it('revenue_summary query works', () => {
    const result = businessIntelligenceQuery({ query: 'revenue_summary' });
    expect(result.ok).toBe(true);
    expect(result.summary).toBeTruthy();
  });
  it('analyst brief includes no-auto constraints', () => {
    const company = seedCompany('Analyst Co');
    const result = generateBusinessAnalystBrief({ companyId: company.id });
    expect(result.ok).toBe(true);
    expect(result.brief.constraints.noAutomaticCommunication).toBe(true);
    expect(result.brief.constraints.noAutomaticPayment).toBe(true);
    expect(result.brief.constraints.noAutomaticWon).toBe(true);
  });
  it('detectDormantClients returns structure', () => {
    const result = detectDormantClients({ limit: 10, dormantDays: 60 });
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.dormant)).toBe(true);
  });
  it('detectRepeatBusiness returns structure', () => {
    const result = detectRepeatBusiness({ limit: 10 });
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.opportunities)).toBe(true);
  });
});

describe('Phase 7 BI — control tools & policy', () => {
  it('registers bi tools as allowed', () => {
    expect(isAllowedTool('bi.get_relationship')).toBe(true);
    expect(isAllowedTool('bi.generate_followups')).toBe(true);
    expect(isAllowedTool('bi.analyst_brief')).toBe(true);
    expect(isForbiddenTool('bi.get_relationship')).toBe(false);
  });
  it('marks mutating bi tools correctly', () => {
    expect(isMutatingTool('bi.evaluate_relationship')).toBe(true);
    expect(isMutatingTool('bi.record_timeline_event')).toBe(true);
    expect(isMutatingTool('bi.get_relationship')).toBe(false);
    expect(isMutatingTool('bi.list_followups')).toBe(false);
  });
  it('bi tools execute get_relationship', async () => {
    const company = seedCompany('Tool Co');
    evaluateRelationship({ companyId: company.id, persist: true });
    const result = await biTools['bi.get_relationship']({ companyId: company.id });
    expect(result.ok).toBe(true);
  });
  it('bi tools generate followups', async () => {
    const company = seedCompany('Tool Follow Co');
    const result = await biTools['bi.generate_followups']({ companyId: company.id });
    expect(result.ok).toBe(true);
    expect(result.externalSideEffect).toBe(false);
  });
  it('bi tools analyst brief', async () => {
    const company = seedCompany('Tool Brief Co');
    const result = await biTools['bi.analyst_brief']({ companyId: company.id });
    expect(result.ok).toBe(true);
    expect(result.brief.constraints.recommendationsOnly).toBe(true);
  });
});

describe('Phase 7 BI — no automatic external actions', () => {
  it('follow-up recommendations never set external_side_effect', () => {
    const company = seedCompany('Safe Co');
    const result = generateFollowUps({ companyId: company.id, persist: true });
    for (const r of result.recommendations) expect(Number(r.external_side_effect)).toBe(0);
  });
  it('relationship evaluation does not change prospect to WON', () => {
    const company = seedCompany('No Won Co');
    const result = evaluateRelationship({ companyId: company.id, persist: true });
    expect(result.state).not.toBe('WON');
    expect(Object.values(RELATIONSHIP_STATES)).not.toContain('WON');
  });
});
