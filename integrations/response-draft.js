// integrations/response-draft.js
// Phase 6 — assisted reply drafting (INTERNAL ONLY).
// Never sends. Never invents pricing, payment, or work-started claims.

import { getConversationIntelligence } from './conversation-intelligence.js';
import { getAuthoritativeFacts } from './client-memory.js';

export function draftClientReply({ conversationId, tone = 'professional' } = {}) {
  if (!conversationId) throw new Error('conversationId is required');
  const intel = getConversationIntelligence(conversationId);
  if (!intel.conversation) {
    return { ok: false, draft: '', warnings: ['conversation not found'], autoSend: false };
  }
  const facts = getAuthoritativeFacts({
    companyId: intel.company?.id,
    contactId: intel.contact?.id,
    prospectId: intel.prospect?.id,
  });
  const warnings = [];
  const who = intel.contact?.name || intel.contact?.email || 'there';
  const service = facts.requested_service?.value || intel.insight?.requested_service || null;
  const quantity = facts.quantity?.value || null;
  const deadline = facts.deadline?.value || intel.insight?.deadline || null;
  const budget = facts.budget?.value || intel.insight?.budget || null;
  if (!service) warnings.push('service not confirmed — draft stays generic');
  if (!budget) warnings.push('budget UNKNOWN — do not invent pricing');
  if (!deadline) warnings.push('deadline not confirmed as calendar date');
  const lines = [
    `Hi ${who},`,
    '',
    'Thank you for your message — I appreciated the detail.',
  ];
  if (service && quantity) lines.push(`I understand you are interested in ${service} (${quantity}).`);
  else if (service) lines.push(`I understand you are interested in ${service}.`);
  else lines.push('I understand you are interested in continuing the discussion.');
  if (deadline) lines.push(`You mentioned a timing preference of "${deadline}". We can confirm a realistic schedule once requirements are finalized.`);
  lines.push('');
  lines.push('I will prepare next steps internally and follow up with confirmed details.');
  lines.push('No pricing, payment, or delivery commitment is implied until we confirm scope with you.');
  lines.push('');
  lines.push('Best regards');
  return {
    ok: true,
    draft: lines.join('\n'),
    warnings,
    autoSend: false,
    requiresHumanApproval: true,
    conversationId,
    context: {
      service: service || 'UNKNOWN',
      quantity: quantity || 'UNKNOWN',
      deadline: deadline || 'UNKNOWN',
      budget: budget || 'UNKNOWN',
      classification: intel.insight?.current_classification || null,
      nextAction: intel.nextAction || null,
    },
  };
}
