// integrations/outreach-prep.js
// Phase 5A — Outreach preparation (draft only).
//
// Pure helpers: no network, no SMTP, no browser, no side effects.
// Builds a professional email draft strictly from stored prospect /
// opportunity / proposal data. Never invents contact addresses or facts.

import crypto from 'node:crypto';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

/**
 * Returns a normalized verified public email or null.
 * Does not invent or domain-guess addresses.
 */
export function extractVerifiedEmail(prospect) {
  const raw = prospect?.contact_email ?? prospect?.contactEmail ?? null;
  if (raw == null) return null;
  const email = String(raw).trim();
  if (!email) return null;
  if (!EMAIL_RE.test(email)) return null;
  return email.toLowerCase();
}

/**
 * Deterministic content hash binding recipient, channel, subject, body, proposal.
 * Any change invalidates a prior approval binding.
 */
export function computeOutreachContentHash({ recipient, channel, subject, body, proposalId }) {
  const payload = JSON.stringify({
    recipient: String(recipient || '').trim().toLowerCase(),
    channel: String(channel || '').trim().toLowerCase(),
    subject: String(subject || ''),
    body: String(body || ''),
    proposalId: String(proposalId || ''),
  });
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

function parseJsonMaybe(value, fallback) {
  if (Array.isArray(value) || (value && typeof value === 'object')) return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return fallback;
}

/**
 * Build a professional outreach email draft from stored records only.
 * @returns {{ channel, recipient, subject, body, contentHash, assumptions: string[] }}
 */
export function buildOutreachDraft({ prospect, opportunity, proposal, channel = 'email' } = {}) {
  if (!prospect) throw new Error('buildOutreachDraft requires a prospect');
  if (!opportunity) throw new Error('buildOutreachDraft requires an opportunity');
  if (!proposal) throw new Error('buildOutreachDraft requires a proposal');
  if (channel !== 'email') {
    throw new Error(`Unsupported outreach channel for Phase 5A: ${channel}`);
  }

  const recipient = extractVerifiedEmail(prospect);
  if (!recipient) {
    throw new Error('No verified public contact email on prospect; cannot prepare outreach');
  }

  const businessName = prospect.business_name || prospect.businessName || 'your team';
  const pitch = proposal.pitch || '';
  const service = proposal.service_recommendation || proposal.serviceRecommendation || '';
  const valueProp = proposal.value_proposition || proposal.valueProposition || '';
  const cta = proposal.call_to_action || proposal.callToAction || 'Happy to share more detail if useful — no obligation.';
  const assumptions = parseJsonMaybe(proposal.assumptions_json ?? proposal.assumptions, []);

  const subject = `Ideas for ${businessName} — speculative concept only`;

  const bodyLines = [
    `Hello ${businessName},`,
    '',
    'I came across your public website and put together a short, speculative concept that may be relevant. Nothing has been published or submitted on your behalf.',
    '',
  ];
  if (pitch) {
    bodyLines.push(pitch, '');
  }
  if (service) {
    bodyLines.push(`Suggested focus: ${service}`, '');
  }
  if (valueProp) {
    bodyLines.push(valueProp, '');
  }
  bodyLines.push(
    cta,
    '',
    'This message references only publicly available information and a local draft sample/proposal prepared for review. No results, testimonials, or prior relationship are claimed.',
    '',
    'Best regards',
  );

  const body = bodyLines.join('\n');
  const proposalId = proposal.id;
  const contentHash = computeOutreachContentHash({
    recipient,
    channel: 'email',
    subject,
    body,
    proposalId,
  });

  return {
    channel: 'email',
    recipient,
    subject,
    body,
    contentHash,
    assumptions: Array.isArray(assumptions) ? assumptions : [],
  };
}
