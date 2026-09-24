// integrations/next-action.js
// Internal next-action recommendations only — never sends or charges.

export const NEXT_ACTIONS = Object.freeze({
  CREATE_OPPORTUNITY: 'CREATE_OPPORTUNITY',
  PREPARE_QUOTE: 'PREPARE_QUOTE',
  REQUEST_INFORMATION: 'REQUEST_INFORMATION',
  CREATE_REVISION_TASK: 'CREATE_REVISION_TASK',
  PREPARE_NEXT_STEP: 'PREPARE_NEXT_STEP',
  HAND_OFF_TO_BILLING: 'HAND_OFF_TO_BILLING',
  FOLLOW_UP: 'FOLLOW_UP',
  QUALIFY_LEAD: 'QUALIFY_LEAD',
  NO_ACTION: 'NO_ACTION',
  REVIEW_MANUALLY: 'REVIEW_MANUALLY',
});

export function recommendNextAction({
  classification, intent, requestedService, unresolvedQuestions = [],
  prospectStatus, hasBudget, messageCount = 0,
} = {}) {
  const c = String(classification || '').toUpperCase();
  if (c === 'PAYMENT_RELATED') return { action: NEXT_ACTIONS.HAND_OFF_TO_BILLING, reason: 'Client message is payment-related; internal billing hand-off suggested.', externalSideEffect: false };
  if (c === 'REJECTION') return { action: NEXT_ACTIONS.NO_ACTION, reason: 'Client declined contact; do not pursue automatically.', externalSideEffect: false };
  if (c === 'REVISION_REQUEST') return { action: NEXT_ACTIONS.CREATE_REVISION_TASK, reason: 'Client requested revisions to existing work.', externalSideEffect: false };
  if (c === 'APPROVAL') return { action: NEXT_ACTIONS.PREPARE_NEXT_STEP, reason: 'Client approved prior material; prepare next internal step.', externalSideEffect: false };
  if (c === 'REQUEST_FOR_QUOTE') return { action: NEXT_ACTIONS.PREPARE_QUOTE, reason: 'Client requested pricing/quote.', externalSideEffect: false };
  if (c === 'REQUEST_FOR_SERVICE') {
    if ((unresolvedQuestions && unresolvedQuestions.length > 0) || !requestedService) {
      return { action: NEXT_ACTIONS.REQUEST_INFORMATION, reason: 'Service interest detected but required details are missing.', externalSideEffect: false };
    }
    return { action: NEXT_ACTIONS.CREATE_OPPORTUNITY, reason: 'Clear service request; create/update opportunity internally.', externalSideEffect: false };
  }
  if (c === 'INFORMATION_REQUEST' || c === 'QUESTION') return { action: NEXT_ACTIONS.REQUEST_INFORMATION, reason: 'Client asked questions; prepare informational response (manual send).', externalSideEffect: false };
  if (c === 'INTERESTED') {
    if (prospectStatus === 'CONTACTED' || prospectStatus === 'REPLIED') {
      return { action: NEXT_ACTIONS.QUALIFY_LEAD, reason: 'Positive reply; qualify before marking customer.', externalSideEffect: false };
    }
    return { action: NEXT_ACTIONS.FOLLOW_UP, reason: 'Interest expressed; plan human follow-up.', externalSideEffect: false };
  }
  if (c === 'FOLLOW_UP') return { action: NEXT_ACTIONS.FOLLOW_UP, reason: 'Client is following up; prioritize response.', externalSideEffect: false };
  if (messageCount === 0) return { action: NEXT_ACTIONS.NO_ACTION, reason: 'No messages in conversation.', externalSideEffect: false };
  return { action: NEXT_ACTIONS.REVIEW_MANUALLY, reason: 'Classification does not map to a specific automated recommendation.', externalSideEffect: false };
}
