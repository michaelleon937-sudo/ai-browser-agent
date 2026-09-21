// tests/unit/outreach-prep.test.js
// Phase 5A — outreach preparation: pure helpers, no network.

import { describe, it, expect } from 'vitest';
import {
  extractVerifiedEmail,
  computeOutreachContentHash,
  buildOutreachDraft,
} from '../../integrations/outreach-prep.js';

describe('extractVerifiedEmail', () => {
  it('returns normalized email when present and valid', () => {
    expect(extractVerifiedEmail({ contact_email: 'Info@Example.com' })).toBe('info@example.com');
  });

  it('returns null when missing', () => {
    expect(extractVerifiedEmail({ contact_email: null })).toBeNull();
    expect(extractVerifiedEmail({})).toBeNull();
  });

  it('returns null for invalid email (no domain guessing)', () => {
    expect(extractVerifiedEmail({ contact_email: 'not-an-email' })).toBeNull();
    expect(extractVerifiedEmail({ contact_email: 'info@' })).toBeNull();
    expect(extractVerifiedEmail({ website_url: 'https://example.com' })).toBeNull();
  });

  it('never invents an email from business name or domain', () => {
    expect(extractVerifiedEmail({
      business_name: 'Acme Realty',
      website_url: 'https://acme-realty.com',
      contact_email: '',
    })).toBeNull();
  });
});

describe('computeOutreachContentHash', () => {
  const base = {
    recipient: 'a@example.com',
    channel: 'email',
    subject: 'Hello',
    body: 'Body text',
    proposalId: 'prop1',
  };

  it('is deterministic for the same content', () => {
    expect(computeOutreachContentHash(base)).toBe(computeOutreachContentHash({ ...base }));
  });

  it('changes when body changes', () => {
    expect(computeOutreachContentHash(base)).not.toBe(
      computeOutreachContentHash({ ...base, body: 'Body text changed' }),
    );
  });

  it('changes when recipient changes', () => {
    expect(computeOutreachContentHash(base)).not.toBe(
      computeOutreachContentHash({ ...base, recipient: 'b@example.com' }),
    );
  });

  it('changes when subject changes', () => {
    expect(computeOutreachContentHash(base)).not.toBe(
      computeOutreachContentHash({ ...base, subject: 'Other' }),
    );
  });

  it('normalizes recipient case', () => {
    expect(computeOutreachContentHash(base)).toBe(
      computeOutreachContentHash({ ...base, recipient: 'A@Example.COM' }),
    );
  });
});

describe('buildOutreachDraft', () => {
  const prospect = {
    id: 'p1',
    business_name: 'Austin Premier Realty',
    contact_email: 'hello@austinpremier.example',
  };
  const opportunity = { id: 'o1', prospect_id: 'p1', status: 'AWAITING_APPROVAL' };
  const proposal = {
    id: 'prop1',
    prospect_id: 'p1',
    opportunity_id: 'o1',
    status: 'READY',
    pitch: 'We noticed a likely opportunity for website improvement.',
    service_recommendation: 'Website redesign',
    value_proposition: 'Clearer property presentation.',
    call_to_action: 'Happy to share more detail.',
    assumptions_json: JSON.stringify(['Pricing not included']),
  };

  it('builds email draft with verified recipient and content hash', () => {
    const draft = buildOutreachDraft({ prospect, opportunity, proposal, channel: 'email' });
    expect(draft.channel).toBe('email');
    expect(draft.recipient).toBe('hello@austinpremier.example');
    expect(draft.subject).toContain('Austin Premier Realty');
    expect(draft.body).toContain('speculative');
    expect(draft.body).not.toMatch(/we already spoke|as you requested|guaranteed results/i);
    expect(draft.contentHash).toBe(
      computeOutreachContentHash({
        recipient: draft.recipient,
        channel: draft.channel,
        subject: draft.subject,
        body: draft.body,
        proposalId: proposal.id,
      }),
    );
  });

  it('fails when no public email exists', () => {
    expect(() => buildOutreachDraft({
      prospect: { ...prospect, contact_email: null },
      opportunity,
      proposal,
    })).toThrow(/verified public contact email/i);
  });

  it('fails for non-email channel in Phase 5A', () => {
    expect(() => buildOutreachDraft({
      prospect,
      opportunity,
      proposal,
      channel: 'linkedin',
    })).toThrow(/Unsupported outreach channel/i);
  });
});
