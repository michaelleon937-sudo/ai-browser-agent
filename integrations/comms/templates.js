// Phase A1 templates
export const TEMPLATE_TYPES = Object.freeze({
  OUTREACH:'OUTREACH',SAMPLE:'SAMPLE',PROPOSAL:'PROPOSAL',QUOTE:'QUOTE',INVOICE:'INVOICE',
  PAYMENT_REQUEST:'PAYMENT_REQUEST',PAYMENT_CONFIRMATION:'PAYMENT_CONFIRMATION',
  FINAL_DELIVERY:'FINAL_DELIVERY',FOLLOW_UP:'FOLLOW_UP',REVISION:'REVISION',GENERIC:'GENERIC',
});
const s=(v,f='')=>v==null?f:String(v).trim();
function money(a,c){if(a==null||a==='')return null;const n=Number(a);if(!Number.isFinite(n))return s(a);return `${s(c,'TZS')} ${n.toLocaleString('en-US',{maximumFractionDigits:2})}`;}
export function renderTemplate(type, vars={}) {
  const t=String(type||'GENERIC').toUpperCase();
  const clientName=s(vars.clientName||vars.contactName,'there');
  const service=s(vars.service||vars.serviceName,'our services');
  const greeting=`Hi ${clientName},`;
  const signoff=['','Best regards',s(vars.senderName,'The team')].join('\n');
  let subject=s(vars.subject), body;
  switch(t){
    case 'OUTREACH': subject=subject||`Introduction — ${service}`; body=[greeting,'',s(vars.intro,`I wanted to introduce how we can help with ${service}.`),s(vars.callToAction,'If useful, I can share a sample or proposal.'),signoff].filter(Boolean).join('\n'); break;
    case 'SAMPLE': subject=subject||`Sample — ${service}`; body=[greeting,'',`Here is a sample related to ${service}.`,s(vars.artifactUrl||vars.sampleUrl)?`View sample: ${s(vars.artifactUrl||vars.sampleUrl)}`:s(vars.sampleNote,'Sample details included.'),'This is a preview only and is not the final paid deliverable.',signoff].join('\n'); break;
    case 'PROPOSAL': subject=subject||`Proposal — ${service}`; body=[greeting,'',`Please find our proposal for ${service}.`,s(vars.artifactUrl||vars.proposalUrl)?`Proposal: ${s(vars.artifactUrl||vars.proposalUrl)}`:s(vars.proposalSummary,''),'Pricing and scope as stated; nothing is confirmed until you accept.',signoff].filter(Boolean).join('\n'); break;
    case 'QUOTE': subject=subject||`Quote ${s(vars.quoteNumber||vars.quoteId,'')}`.trim(); body=[greeting,'',`Quote reference: ${s(vars.quoteNumber||vars.quoteId,'N/A')}`,`Service: ${service}`,money(vars.amount??vars.total??vars.subtotal,vars.currency)?`Amount: ${money(vars.amount??vars.total??vars.subtotal,vars.currency)}`:'',vars.validUntil?`Valid until: ${s(vars.validUntil)}`:'',s(vars.nextStep,'Reply if you would like to proceed.'),signoff].filter(Boolean).join('\n'); break;
    case 'INVOICE': case 'PAYMENT_REQUEST': {
      const inv=s(vars.invoiceNumber||vars.invoiceId,'N/A');
      subject=subject||(t==='PAYMENT_REQUEST'?`Payment request — Invoice ${inv}`:`Invoice ${inv}`);
      const pay=s(vars.paymentUrl);
      body=[greeting,'',`Invoice: ${inv}`,money(vars.amount??vars.total,vars.currency)?`Amount due: ${money(vars.amount??vars.total,vars.currency)}`:'',vars.dueDate?`Due: ${s(vars.dueDate)}`:'',pay?`Pay securely: ${pay}`:'A payment link will be provided once the payment request is created.','Do not share PINs, OTPs, or banking passwords in reply.',signoff].filter(Boolean).join('\n'); break;
    }
    case 'PAYMENT_CONFIRMATION': subject=subject||`Payment received — ${s(vars.invoiceNumber||vars.invoiceId,'invoice')}`; body=[greeting,'','We have verified receipt of your payment.',money(vars.amount,vars.currency)?`Amount: ${money(vars.amount,vars.currency)}`:'',s(vars.nextStep,'We will begin project work according to the agreed scope.'),signoff].filter(Boolean).join('\n'); break;
    case 'FINAL_DELIVERY': subject=subject||`Final delivery — ${service}`; body=[greeting,'',`Your final deliverable for ${service} is ready.`,s(vars.artifactUrl||vars.deliveryUrl)?`Access: ${s(vars.artifactUrl||vars.deliveryUrl)}`:s(vars.deliveryNote,''),'This is the paid final deliverable (not a sample preview).',signoff].filter(Boolean).join('\n'); break;
    case 'FOLLOW_UP': subject=subject||s(vars.subject,'Following up'); body=[greeting,'',s(vars.body,'I wanted to follow up on our earlier conversation.'),signoff].join('\n'); break;
    case 'REVISION': subject=subject||'Regarding your revision request'; body=[greeting,'',s(vars.body,'Thank you for the revision notes. We will review and respond with next steps.'),signoff].join('\n'); break;
    default: subject=subject||s(vars.subject,'Message'); body=[greeting,'',s(vars.body,''),signoff].filter(Boolean).join('\n');
  }
  return { messageType: TEMPLATE_TYPES[t]||TEMPLATE_TYPES.GENERIC, subject, bodyText: body, bodyHtml: null };
}
export function assertSafeClientContent(text){
  const t=String(text||'');
  for (const re of [/CONTROL_TOKEN/i,/SMTP_PASS/i,/sk_live_[a-zA-Z0-9]+/,/\/mnt\/[^\s]+/,/\/home\/workdir\/[^\s]+/,/\/var\/data\/[^\s]+/]) {
    if (re.test(t)) throw new Error('Client message content failed safety scan (secret or internal path)');
  }
}
