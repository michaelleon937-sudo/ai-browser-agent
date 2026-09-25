// integrations/payments/provider.js
import crypto from 'node:crypto';
import { getPaymentMode, assertPaymentExecutionAllowed, redactSecrets } from './mode.js';

export class PaymentProvider {
  get name() { return 'base'; }
  async createPaymentRequest() { throw new Error('createPaymentRequest not implemented'); }
  async getPaymentStatus() { throw new Error('getPaymentStatus not implemented'); }
  async verifyPayment() { throw new Error('verifyPayment not implemented'); }
  async handleWebhook() { throw new Error('handleWebhook not implemented'); }
  async refundPayment() { throw new Error('refundPayment not implemented'); }
}

const mockLedger = new Map();
export function _resetMockLedger() { mockLedger.clear(); }
export function _getMockLedger() { return mockLedger; }

export class MockMpesaProvider extends PaymentProvider {
  get name() { return 'mpesa'; }
  async createPaymentRequest({ amount, currency, invoiceId, idempotencyKey }) {
    const id = `mpesa_${idempotencyKey || invoiceId}_${Date.now()}`;
    mockLedger.set(id, { status: 'PENDING', amount: Number(amount), currency: currency || 'KES', invoiceId, provider: 'mpesa' });
    return { ok: true, providerPaymentId: id, status: 'PENDING', checkoutUrl: null };
  }
  async getPaymentStatus(providerPaymentId) {
    const row = mockLedger.get(providerPaymentId);
    if (!row) return { ok: false, status: 'UNKNOWN', error: 'not found' };
    return { ok: true, status: row.status, amount: row.amount, currency: row.currency };
  }
  async verifyPayment({ providerPaymentId, amount, currency }) {
    const row = mockLedger.get(providerPaymentId);
    if (!row) return { ok: false, verified: false, status: 'UNKNOWN', reason: 'not found' };
    if (row.status !== 'SUCCEEDED') return { ok: true, verified: false, status: row.status, reason: 'not succeeded at provider' };
    if (Number(amount) !== Number(row.amount)) return { ok: false, verified: false, status: row.status, reason: 'amount mismatch' };
    if (currency && currency !== row.currency) return { ok: false, verified: false, status: row.status, reason: 'currency mismatch' };
    return { ok: true, verified: true, status: 'SUCCEEDED', amount: row.amount, currency: row.currency, providerTransactionId: `txn_${providerPaymentId}` };
  }
  async handleWebhook({ body }) {
    if (!body || body.simulate !== true) return { ok: false, verified: false, reason: 'unverified or non-simulated mpesa webhook' };
    const providerPaymentId = body.providerPaymentId;
    const row = mockLedger.get(providerPaymentId);
    if (!row) return { ok: false, verified: false, reason: 'unknown payment' };
    if (body.forceStatus === 'SUCCEEDED') { row.status = 'SUCCEEDED'; mockLedger.set(providerPaymentId, row); }
    else if (body.forceStatus === 'FAILED') { row.status = 'FAILED'; mockLedger.set(providerPaymentId, row); }
    return { ok: true, verified: body.forceStatus === 'SUCCEEDED', eventId: body.eventId || `mpesa_evt_${providerPaymentId}`, eventType: body.eventType || 'payment.status', providerPaymentId, status: row.status, amount: row.amount, currency: row.currency, providerTransactionId: body.forceStatus === 'SUCCEEDED' ? `txn_${providerPaymentId}` : null };
  }
  async refundPayment() { return { ok: false, error: 'refund not implemented in mock' }; }
}

export class MockStripeProvider extends PaymentProvider {
  get name() { return 'stripe'; }
  async createPaymentRequest({ amount, currency, invoiceId, idempotencyKey }) {
    const id = `stripe_${idempotencyKey || invoiceId}_${Date.now()}`;
    mockLedger.set(id, { status: 'PENDING', amount: Number(amount), currency: (currency || 'USD').toUpperCase(), invoiceId, provider: 'stripe' });
    return { ok: true, providerPaymentId: id, status: 'PENDING', checkoutUrl: `https://checkout.stripe.test/mock/${id}` };
  }
  async getPaymentStatus(providerPaymentId) {
    const row = mockLedger.get(providerPaymentId);
    if (!row) return { ok: false, status: 'UNKNOWN', error: 'not found' };
    return { ok: true, status: row.status, amount: row.amount, currency: row.currency };
  }
  async verifyPayment({ providerPaymentId, amount, currency }) {
    const row = mockLedger.get(providerPaymentId);
    if (!row) return { ok: false, verified: false, status: 'UNKNOWN', reason: 'not found' };
    if (row.status !== 'SUCCEEDED') return { ok: true, verified: false, status: row.status, reason: 'not succeeded at provider' };
    if (Number(amount) !== Number(row.amount)) return { ok: false, verified: false, status: row.status, reason: 'amount mismatch' };
    if (currency && currency.toUpperCase() !== row.currency) return { ok: false, verified: false, status: row.status, reason: 'currency mismatch' };
    return { ok: true, verified: true, status: 'SUCCEEDED', amount: row.amount, currency: row.currency, providerTransactionId: `ch_${providerPaymentId}` };
  }
  async handleWebhook({ body, headers = {} }) {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (secret) {
      const sig = headers['stripe-signature'] || headers['Stripe-Signature'];
      if (sig !== `mock_sig_${secret}`) return { ok: false, verified: false, reason: 'invalid stripe signature' };
    } else if (!body || body.simulate !== true) {
      return { ok: false, verified: false, reason: 'unverified stripe webhook (no simulate flag)' };
    }
    const providerPaymentId = body.providerPaymentId || body.data?.object?.id;
    const row = mockLedger.get(providerPaymentId);
    if (!row) return { ok: false, verified: false, reason: 'unknown payment' };
    if (body.forceStatus === 'SUCCEEDED' || body.type === 'checkout.session.completed') { row.status = 'SUCCEEDED'; mockLedger.set(providerPaymentId, row); }
    else if (body.forceStatus === 'FAILED') { row.status = 'FAILED'; mockLedger.set(providerPaymentId, row); }
    return { ok: true, verified: row.status === 'SUCCEEDED', eventId: body.eventId || body.id || `stripe_evt_${providerPaymentId}`, eventType: body.eventType || body.type || 'payment_intent.succeeded', providerPaymentId, status: row.status, amount: row.amount, currency: row.currency, providerTransactionId: row.status === 'SUCCEEDED' ? `ch_${providerPaymentId}` : null };
  }
  async refundPayment() { return { ok: false, error: 'refund not implemented in mock' }; }
}

export function verifyStripeSignature(rawBody, signatureHeader, webhookSecret, toleranceSec = 300) {
  if (!webhookSecret) return { ok: false, reason: 'STRIPE_WEBHOOK_SECRET not configured' };
  if (!signatureHeader) return { ok: false, reason: 'missing Stripe-Signature header' };
  const parts = String(signatureHeader).split(',').map((p) => p.trim());
  let timestamp = null; const v1s = [];
  for (const p of parts) { const [k, v] = p.split('='); if (k === 't') timestamp = v; if (k === 'v1') v1s.push(v); }
  if (!timestamp || v1s.length === 0) return { ok: false, reason: 'malformed Stripe-Signature' };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'invalid signature timestamp' };
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > toleranceSec) return { ok: false, reason: 'signature timestamp outside tolerance' };
  const payload = `${timestamp}.${rawBody}`;
  const expected = crypto.createHmac('sha256', webhookSecret).update(payload, 'utf8').digest('hex');
  const match = v1s.some((sig) => { try { return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(sig, 'utf8')); } catch { return false; } });
  if (!match) return { ok: false, reason: 'signature mismatch' };
  return { ok: true, timestamp: ts };
}

export class SandboxStripeProvider extends PaymentProvider {
  get name() { return 'stripe'; }
  _secretKey() { return process.env.STRIPE_SECRET_KEY || ''; }
  _webhookSecret() { return process.env.STRIPE_WEBHOOK_SECRET || ''; }
  _requireSandboxCreds() {
    const key = this._secretKey();
    if (!key) return { ok: false, error: 'STRIPE_SECRET_KEY not configured for sandbox', status: 'FAILED' };
    if (key.startsWith('sk_live_')) return { ok: false, error: 'Live Stripe keys are not allowed in PAYMENT_MODE=sandbox', status: 'FAILED' };
    return { ok: true, key };
  }
  async createPaymentRequest({ amount, currency, invoiceId, idempotencyKey }) {
    const creds = this._requireSandboxCreds(); if (!creds.ok) return { ok: false, error: creds.error, status: 'FAILED' };
    try {
      const res = await fetch('https://api.stripe.com/v1/payment_intents', {
        method: 'POST',
        headers: { Authorization: `Bearer ${creds.key}`, 'Content-Type': 'application/x-www-form-urlencoded', ...(idempotencyKey ? { 'Idempotency-Key': String(idempotencyKey) } : {}) },
        body: new URLSearchParams({ amount: String(Math.round(Number(amount) * 100)), currency: String(currency || 'usd').toLowerCase(), 'metadata[invoiceId]': String(invoiceId || ''), 'automatic_payment_methods[enabled]': 'true' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: data?.error?.message || `Stripe API ${res.status}`, status: res.status >= 500 ? 'UNKNOWN' : 'FAILED' };
      return { ok: true, providerPaymentId: data.id, status: data.status === 'succeeded' ? 'SUCCEEDED' : 'PENDING', checkoutUrl: null, raw: { id: data.id, status: data.status } };
    } catch (err) { return { ok: false, error: `Stripe network error: ${err.message}`, status: 'UNKNOWN' }; }
  }
  async getPaymentStatus(providerPaymentId) {
    const creds = this._requireSandboxCreds(); if (!creds.ok) return { ok: false, status: 'UNKNOWN', error: creds.error };
    try {
      const res = await fetch(`https://api.stripe.com/v1/payment_intents/${providerPaymentId}`, { headers: { Authorization: `Bearer ${creds.key}` } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, status: 'UNKNOWN', error: data?.error?.message || `Stripe API ${res.status}` };
      const status = data.status === 'succeeded' ? 'SUCCEEDED' : data.status === 'canceled' ? 'CANCELLED' : data.status === 'processing' ? 'PROCESSING' : 'PENDING';
      return { ok: true, status, amount: data.amount != null ? Number(data.amount) / 100 : undefined, currency: data.currency ? String(data.currency).toUpperCase() : undefined };
    } catch (err) { return { ok: false, status: 'UNKNOWN', error: `Stripe network error: ${err.message}` }; }
  }
  async verifyPayment({ providerPaymentId, amount, currency }) {
    const st = await this.getPaymentStatus(providerPaymentId);
    if (!st.ok) return { ok: false, verified: false, status: st.status || 'UNKNOWN', reason: st.error };
    if (st.status !== 'SUCCEEDED') return { ok: true, verified: false, status: st.status, reason: 'not succeeded at provider' };
    if (amount != null && st.amount != null && Number(amount) !== Number(st.amount)) return { ok: false, verified: false, status: st.status, reason: 'amount mismatch' };
    if (currency && st.currency && String(currency).toUpperCase() !== String(st.currency).toUpperCase()) return { ok: false, verified: false, status: st.status, reason: 'currency mismatch' };
    return { ok: true, verified: true, status: 'SUCCEEDED', amount: st.amount, currency: st.currency, providerTransactionId: providerPaymentId };
  }
  async handleWebhook({ body, headers = {}, rawBody }) {
    const secret = this._webhookSecret();
    const sig = headers['stripe-signature'] || headers['Stripe-Signature'] || '';
    const raw = rawBody != null ? String(rawBody) : (typeof body === 'string' ? body : JSON.stringify(body || {}));
    const verified = verifyStripeSignature(raw, sig, secret);
    if (!verified.ok) return { ok: false, verified: false, reason: verified.reason };
    let event = body;
    if (typeof body === 'string') { try { event = JSON.parse(body); } catch { return { ok: false, verified: false, reason: 'malformed JSON body' }; } }
    if (!event || !event.id || !event.type) return { ok: false, verified: false, reason: 'malformed Stripe event' };
    const obj = event.data?.object || {};
    const providerPaymentId = obj.id || obj.payment_intent || null;
    let status = 'PENDING';
    if (event.type === 'payment_intent.succeeded' || event.type === 'checkout.session.completed') status = 'SUCCEEDED';
    else if (event.type === 'payment_intent.payment_failed') status = 'FAILED';
    const amount = obj.amount != null ? Number(obj.amount) / 100 : undefined;
    const currency = obj.currency ? String(obj.currency).toUpperCase() : undefined;
    return { ok: true, verified: status === 'SUCCEEDED', eventId: event.id, eventType: event.type, providerPaymentId, status, amount, currency, providerTransactionId: status === 'SUCCEEDED' ? providerPaymentId : null };
  }
  async refundPayment() { return { ok: false, error: 'refund not implemented in Phase 8A sandbox' }; }
}

export class SandboxMpesaProvider extends PaymentProvider {
  get name() { return 'mpesa'; }
  _cfg() {
    return {
      apiUrl: process.env.MPESA_API_URL || 'https://sandbox.safaricom.co.ke',
      consumerKey: process.env.MPESA_CONSUMER_KEY || process.env.MPESA_CLIENT_ID || '',
      consumerSecret: process.env.MPESA_CONSUMER_SECRET || process.env.MPESA_CLIENT_SECRET || '',
      shortcode: process.env.MPESA_SHORTCODE || process.env.MPESA_BUSINESS_ID || '',
      passkey: process.env.MPESA_PASSKEY || '',
      callbackUrl: process.env.MPESA_CALLBACK_URL || '',
      callbackSecret: process.env.MPESA_CALLBACK_SECRET || '',
      phoneNumber: process.env.MPESA_PHONE_NUMBER || '',
      transactionType: process.env.MPESA_TRANSACTION_TYPE || 'CustomerPayBillOnline',
      accountReference: process.env.MPESA_ACCOUNT_REFERENCE || 'Invoice',
      transactionDesc: process.env.MPESA_TRANSACTION_DESC || 'Invoice payment',
    };
  }
  _validateSandboxEndpoint(apiUrl) {
    try {
      const url = new URL(apiUrl);
      if (url.protocol !== 'https:' || url.hostname !== 'sandbox.safaricom.co.ke' || url.port || url.pathname !== '' || url.search || url.hash) {
        return { ok: false, error: 'Refusing non-sandbox M-Pesa API URL in PAYMENT_MODE=sandbox' };
      }
      return { ok: true, baseUrl: url.origin };
    } catch {
      return { ok: false, error: 'Invalid M-Pesa sandbox API URL' };
    }
  }
  _requireSandboxCreds() {
    const c=this._cfg();
    const endpoint=this._validateSandboxEndpoint(c.apiUrl);
    if(!endpoint.ok) return endpoint;
    const missing=[];
    if(!c.consumerKey) missing.push('MPESA_CONSUMER_KEY');
    if(!c.consumerSecret) missing.push('MPESA_CONSUMER_SECRET');
    if(!c.shortcode) missing.push('MPESA_SHORTCODE');
    if(!c.passkey) missing.push('MPESA_PASSKEY');
    if(!c.callbackUrl) missing.push('MPESA_CALLBACK_URL');
    if(!c.phoneNumber) missing.push('MPESA_PHONE_NUMBER');
    if(missing.length) return {ok:false,error:'M-Pesa sandbox credentials incomplete ('+missing.join(', ')+')'};
    let callback;
    try { callback=new URL(c.callbackUrl); } catch { return {ok:false,error:'Invalid MPESA_CALLBACK_URL'}; }
    if(callback.protocol!=='https:') return {ok:false,error:'MPESA_CALLBACK_URL must use HTTPS'};
    return {ok:true,cfg:c,baseUrl:endpoint.baseUrl};
  }
  _timestamp() {
    const d=new Date(),p=n=>String(n).padStart(2,'0');
    return d.getUTCFullYear()+p(d.getUTCMonth()+1)+p(d.getUTCDate())+p(d.getUTCHours())+p(d.getUTCMinutes())+p(d.getUTCSeconds());
  }
  _password(shortcode,passkey,timestamp) {
    return Buffer.from(String(shortcode)+String(passkey)+String(timestamp),'utf8').toString('base64');
  }
  async _accessToken(cfg,baseUrl) {
    const auth=Buffer.from(cfg.consumerKey+':'+cfg.consumerSecret,'utf8').toString('base64');
    try {
      const res=await fetch(baseUrl+'/oauth/v1/generate?grant_type=client_credentials',{method:'GET',headers:{Authorization:'Basic '+auth,Accept:'application/json'}});
      const data=await res.json().catch(()=>({}));
      if(!res.ok) return {ok:false,error:'M-Pesa sandbox authentication failed (HTTP '+res.status+')'};
      if(!data.access_token) return {ok:false,error:'M-Pesa sandbox authentication response missing access token'};
      return {ok:true,token:data.access_token};
    } catch(err) { return {ok:false,error:'M-Pesa sandbox network error: '+err.message}; }
  }
  async createPaymentRequest({amount,currency,invoiceId,idempotencyKey}) {
    const creds=this._requireSandboxCreds();
    if(!creds.ok) return {ok:false,error:creds.error,status:'FAILED'};
    if(String(currency||'KES').toUpperCase()!=='KES') return {ok:false,error:'M-Pesa Daraja sandbox requires KES currency',status:'FAILED'};
    const numericAmount=Number(amount);
    if(!Number.isFinite(numericAmount)||numericAmount<=0||!Number.isInteger(numericAmount)) return {ok:false,error:'M-Pesa amount must be a positive integer KES amount',status:'FAILED'};
    const existing=idempotencyKey?[...mockLedger.values()].find(r=>r.provider==='mpesa'&&r.idempotencyKey===String(idempotencyKey)):null;
    if(existing) return {ok:true,providerPaymentId:existing.checkoutRequestId,status:existing.status,checkoutUrl:null,duplicate:true};
    const token=await this._accessToken(creds.cfg,creds.baseUrl);
    if(!token.ok) return {ok:false,error:token.error,status:'UNKNOWN'};
    const timestamp=this._timestamp();
    const payload={BusinessShortCode:creds.cfg.shortcode,Password:this._password(creds.cfg.shortcode,creds.cfg.passkey,timestamp),Timestamp:timestamp,TransactionType:creds.cfg.transactionType,Amount:numericAmount,PartyA:creds.cfg.phoneNumber,PartyB:creds.cfg.shortcode,PhoneNumber:creds.cfg.phoneNumber,CallBackURL:creds.cfg.callbackUrl,AccountReference:String(invoiceId||creds.cfg.accountReference).slice(0,12),TransactionDesc:String(creds.cfg.transactionDesc).slice(0,13)};
    try {
      const res=await fetch(creds.baseUrl+'/mpesa/stkpush/v1/processrequest',{method:'POST',headers:{Authorization:'Bearer '+token.token,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(payload)});
      const data=await res.json().catch(()=>({}));
      if(!res.ok||String(data.ResponseCode||'')!=='0'||!data.CheckoutRequestID) return {ok:false,error:'M-Pesa sandbox STK request failed (HTTP '+res.status+')',status:res.status>=500?'UNKNOWN':'FAILED'};
      const row={status:'PENDING',amount:numericAmount,currency:'KES',invoiceId,provider:'mpesa',idempotencyKey:idempotencyKey?String(idempotencyKey):null,checkoutRequestId:String(data.CheckoutRequestID),merchantRequestId:data.MerchantRequestID?String(data.MerchantRequestID):null,transactionId:null};
      mockLedger.set(row.checkoutRequestId,row);
      return {ok:true,providerPaymentId:row.checkoutRequestId,status:'PENDING',checkoutUrl:null};
    } catch(err) { return {ok:false,error:'M-Pesa sandbox network error: '+err.message,status:'UNKNOWN'}; }
  }
  async getPaymentStatus(providerPaymentId) {
    const creds=this._requireSandboxCreds();
    if(!creds.ok) return {ok:false,status:'UNKNOWN',error:creds.error};
    const row=mockLedger.get(String(providerPaymentId));
    if(!row||row.provider!=='mpesa') return {ok:false,status:'UNKNOWN',error:'unknown M-Pesa sandbox transaction'};
    const token=await this._accessToken(creds.cfg,creds.baseUrl);
    if(!token.ok) return {ok:false,status:'UNKNOWN',error:token.error};
    const timestamp=this._timestamp();
    const payload={BusinessShortCode:creds.cfg.shortcode,Password:this._password(creds.cfg.shortcode,creds.cfg.passkey,timestamp),Timestamp:timestamp,CheckoutRequestID:String(providerPaymentId)};
    try {
      const res=await fetch(creds.baseUrl+'/mpesa/stkpushquery/v1/query',{method:'POST',headers:{Authorization:'Bearer '+token.token,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(payload)});
      const data=await res.json().catch(()=>({}));
      if(!res.ok) return {ok:false,status:'UNKNOWN',error:'M-Pesa sandbox query failed (HTTP '+res.status+')'};
      const resultCode=data.ResultCode!=null?Number(data.ResultCode):null;
      if(resultCode===0) {
        const receipt=data.MpesaReceiptNumber||data.MpesaReceipt||row.transactionId;
        if(receipt) row.transactionId=String(receipt);
        row.status='SUCCEEDED'; mockLedger.set(row.checkoutRequestId,row);
        return {ok:true,status:'SUCCEEDED',amount:row.amount,currency:row.currency,providerTransactionId:row.transactionId||null};
      }
      if(resultCode!=null) {
        row.status='FAILED'; mockLedger.set(row.checkoutRequestId,row);
        return {ok:true,status:'FAILED',amount:row.amount,currency:row.currency,providerTransactionId:row.transactionId||null,reason:data.ResultDesc||'M-Pesa provider returned failure'};
      }
      return {ok:true,status:'PENDING',amount:row.amount,currency:row.currency,providerTransactionId:row.transactionId||null};
    } catch(err) { return {ok:false,status:'UNKNOWN',error:'M-Pesa sandbox network error: '+err.message}; }
  }
  async verifyPayment({providerPaymentId,amount,currency}) {
    const st=await this.getPaymentStatus(providerPaymentId);
    if(!st.ok) return {ok:false,verified:false,status:st.status||'UNKNOWN',reason:st.error};
    if(st.status!=='SUCCEEDED') return {ok:true,verified:false,status:st.status,reason:st.reason||'not succeeded at provider'};
    if(!st.providerTransactionId) return {ok:false,verified:false,status:'SUCCEEDED',reason:'missing provider transaction identity'};
    if(amount!=null&&Number(amount)!==Number(st.amount)) return {ok:false,verified:false,status:st.status,reason:'amount mismatch'};
    if(currency&&String(currency).toUpperCase()!==String(st.currency).toUpperCase()) return {ok:false,verified:false,status:st.status,reason:'currency mismatch'};
    return {ok:true,verified:true,status:'SUCCEEDED',amount:st.amount,currency:st.currency,providerTransactionId:st.providerTransactionId};
  }
  async handleWebhook({body,headers={}}) {
    const shared=this._cfg().callbackSecret;
    if(shared) {
      const got=headers['x-mpesa-signature']||headers['X-Mpesa-Signature']||'';
      const expected=crypto.createHash('sha256').update(shared,'utf8').digest('hex');
      const candidate=crypto.createHash('sha256').update(String(got),'utf8').digest('hex');
      if(!got||!crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(candidate))) return {ok:false,verified:false,reason:'invalid M-Pesa callback authentication'};
    }
    if(!body||typeof body!=='object') return {ok:false,verified:false,reason:'malformed M-Pesa callback body'};
    const stk=body.Body?.stkCallback;
    if(!stk||!stk.CheckoutRequestID||stk.ResultCode==null) return {ok:false,verified:false,reason:'malformed M-Pesa STK callback'};
    const checkoutId=String(stk.CheckoutRequestID);
    const row=mockLedger.get(checkoutId);
    if(!row||row.provider!=='mpesa') return {ok:false,verified:false,reason:'unknown payment'};
    const items=Array.isArray(stk.CallbackMetadata?.Item)?stk.CallbackMetadata.Item:[];
    const valueOf=name=>items.find(i=>i&&i.Name===name)?.Value;
    const success=Number(stk.ResultCode)===0;
    const callbackAmount=valueOf('Amount')!=null?Number(valueOf('Amount')):undefined;
    const receipt=valueOf('MpesaReceiptNumber');
    if(success) {
      if(!Number.isFinite(callbackAmount)||callbackAmount!==Number(row.amount)) return {ok:false,verified:false,reason:'amount mismatch in M-Pesa callback'};
      if(!receipt) return {ok:false,verified:false,reason:'missing M-Pesa receipt number'};
      row.status='SUCCEEDED'; row.transactionId=String(receipt); mockLedger.set(checkoutId,row);
    } else {
      row.status='FAILED'; mockLedger.set(checkoutId,row);
    }
    const eventId=String(stk.CheckoutRequestID)+':'+String(stk.ResultCode)+':'+String(receipt||'');
    return {ok:true,verified:success,eventId,eventType:'mpesa.stk.callback',providerPaymentId:checkoutId,status:success?'SUCCEEDED':'FAILED',amount:callbackAmount!=null?callbackAmount:row.amount,currency:row.currency,providerTransactionId:success?row.transactionId:null};
  }
  async refundPayment(){return {ok:false,error:'refund not implemented in Phase 8B sandbox'};}
}

export function getPaymentProvider(name) {
  assertPaymentExecutionAllowed();
  const mode = getPaymentMode();
  const n = String(name || '').toLowerCase();
  if (mode === 'mock') {
    if (n === 'mpesa') return new MockMpesaProvider();
    if (n === 'stripe') return new MockStripeProvider();
    throw new Error(`Unknown payment provider: ${name}`);
  }
  if (mode === 'sandbox') {
    if (n === 'mpesa') return new SandboxMpesaProvider();
    if (n === 'stripe') return new SandboxStripeProvider();
    throw new Error(`Unknown sandbox payment provider: ${name}`);
  }
  throw new Error('Unsupported PAYMENT_MODE for provider selection');
}

export { getPaymentMode, redactSecrets };
