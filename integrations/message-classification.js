// integrations/message-classification.js
// Phase 6 CRM — rule-based inbound message classification and structured extraction.

export const MESSAGE_CLASSIFICATIONS = [
  'INTERESTED', 'QUESTION', 'REQUEST_FOR_QUOTE', 'REQUEST_FOR_SERVICE',
  'REVISION_REQUEST', 'APPROVAL', 'REJECTION', 'INFORMATION_REQUEST',
  'FOLLOW_UP', 'PAYMENT_RELATED', 'GENERAL', 'UNKNOWN',
];

export function classifyInboundMessage({ subject = '', body = '' } = {}) {
  const text = `${subject || ''}\n${body || ''}`.trim();
  const lower = text.toLowerCase();
  if (!text) {
    return { classification: 'UNKNOWN', intent: null, confidence: 'low', extracted: emptyExtracted() };
  }
  const rules = [
    { classification: 'PAYMENT_RELATED', patterns: [/\binvoice\b/, /\bpayment\b/, /\bpaid\b/, /\bbilling\b/, /\bwire transfer\b/, /\bpaypal\b/] },
    { classification: 'REJECTION', patterns: [/\bnot interested\b/, /\bno thank you\b/, /\bunsubscribe\b/, /\bstop contacting\b/, /\bdo not contact\b/, /\bopt out\b/] },
    { classification: 'APPROVAL', patterns: [/\bapproved\b/, /\blooks good\b/, /\bgo ahead\b/, /\bplease proceed\b/, /\bgreen light\b/, /\bwe accept\b/] },
    { classification: 'REVISION_REQUEST', patterns: [/\brevision\b/, /\brevise\b/, /\bchange(s)?\b/, /\bedit\b/, /\bupdate the\b/, /\bmake the following\b/] },
    { classification: 'REQUEST_FOR_QUOTE', patterns: [/\bquote\b/, /\bpricing\b/, /\bhow much\b/, /\bcost estimate\b/, /\brate card\b/] },
    { classification: 'REQUEST_FOR_SERVICE', patterns: [/\bneed (a |your )?(website|landing page|seo|redesign)\b/, /\blooking for\b/, /\bcan you (build|create|design)\b/, /\bwe want to hire\b/] },
    { classification: 'INFORMATION_REQUEST', patterns: [/\bcan you send\b/, /\bmore information\b/, /\bdetails about\b/, /\bportfolio\b/, /\bcase stud/] },
    { classification: 'FOLLOW_UP', patterns: [/\bfollowing up\b/, /\bjust checking in\b/, /\bany update\b/, /\bcircle back\b/] },
    { classification: 'INTERESTED', patterns: [/\binterested\b/, /\blet'?s talk\b/, /\bschedule a (call|meeting)\b/, /\bdemo\b/, /\bnext steps\b/] },
    { classification: 'QUESTION', patterns: [/\?/, /\bhow (do|does|long|soon)\b/, /\bwhat (is|are|about)\b/, /\bwhen can\b/] },
  ];
  let classification = 'GENERAL';
  for (const rule of rules) {
    if (rule.patterns.some((re) => re.test(lower))) {
      classification = rule.classification;
      break;
    }
  }
  const extracted = extractStructuredFields(text, lower);
  const intent = classification === 'UNKNOWN' ? null
    : [classification.toLowerCase().replace(/_/g, ' '),
      extracted.requestedService && `service=${extracted.requestedService}`,
      extracted.requestedNextAction && `next=${extracted.requestedNextAction}`,
    ].filter(Boolean).join('; ');
  return {
    classification,
    intent,
    confidence: classification === 'GENERAL' || classification === 'UNKNOWN' ? 'low' : 'medium',
    extracted,
  };
}

function emptyExtracted() {
  return {
    requestedService: null, quantity: null, deadline: null, budget: null,
    brandOrBusinessName: null, requestedDeliverables: null, urgency: null,
    explicitQuestions: [], requestedNextAction: null,
  };
}

function extractStructuredFields(text, lower) {
  const out = emptyExtracted();
  const serviceMatch = lower.match(/\b(website redesign|website|landing page|seo|logo|branding|web development|mobile app)\b/);
  if (serviceMatch) out.requestedService = serviceMatch[1];
  const qtyMatch = text.match(/\b(\d{1,4})\s*(pages?|units?|hours?|items?)\b/i);
  if (qtyMatch) out.quantity = `${qtyMatch[1]} ${qtyMatch[2]}`;
  const deadlineMatch = text.match(/\b(by|before|deadline[:\s]+|due[:\s]+)\s*([A-Za-z]+\s+\d{1,2}(?:,\s*\d{4})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|next week|end of (?:the )?month|asap)\b/i);
  if (deadlineMatch) out.deadline = deadlineMatch[2];
  const budgetMatch = text.match(/\b(?:budget|up to|around)\s*[\$£€]?\s*([\d,]+(?:\.\d{2})?)\b/i);
  if (budgetMatch) out.budget = budgetMatch[1].replace(/,/g, '');
  const brandMatch = text.match(/\b(?:for|our|my)\s+(?:company|business|brand)\s+([A-Z][A-Za-z0-9&.\- ]{1,40})/);
  if (brandMatch) out.brandOrBusinessName = brandMatch[1].trim();
  if (/\basap\b|\burgent\b|\bimmediately\b/.test(lower)) out.urgency = 'high';
  else if (/\bthis week\b|\bsoon\b/.test(lower)) out.urgency = 'medium';
  out.explicitQuestions = text.split(/(?<=[?])\s+/).map((s) => s.trim()).filter((s) => s.endsWith('?') && s.length > 3).slice(0, 5);
  if (/\bschedule\b|\bbook a call\b|\bmeet\b/.test(lower)) out.requestedNextAction = 'schedule_call';
  else if (/\bsend (a )?quote\b|\bpricing\b/.test(lower)) out.requestedNextAction = 'send_quote';
  else if (/\brevise\b|\brevision\b/.test(lower)) out.requestedNextAction = 'revise_deliverable';
  const deliverables = [];
  if (/\blanding page\b/.test(lower)) deliverables.push('landing_page');
  if (/\bwebsite\b/.test(lower)) deliverables.push('website');
  if (/\blogo\b/.test(lower)) deliverables.push('logo');
  if (deliverables.length) out.requestedDeliverables = deliverables;
  return out;
}
