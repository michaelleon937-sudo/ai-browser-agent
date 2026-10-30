import crypto from 'node:crypto';
import { runWithTenantContext } from './tenant-context.js';
const ISSUER = 'nexora-intelligence';
const AUDIENCE = 'ai-browser-agent-control';
function secret() { const value = String(process.env.NEXORA_AGENT_SHARED_SECRET || ''); if (value.length < 32) { const err = new Error('NEXORA_AGENT_SHARED_SECRET is not configured'); err.status = 503; throw err; } return value; }
function safeEqual(a,b) { const x=Buffer.from(String(a||'')); const y=Buffer.from(String(b||'')); return x.length===y.length && crypto.timingSafeEqual(x,y); }
export function signClaims(claims) { const body=Buffer.from(JSON.stringify(claims)).toString('base64url'); const sig=crypto.createHmac('sha256',secret()).update(body).digest('base64url'); return `v1.${body}.${sig}`; }
export function verifyClaims(token, expectedType, audience, maxTtlSeconds) {
  if(typeof token!=='string'||token.length>8192) throw Object.assign(new Error('Signed Nexora token required'),{status:401});
  const parts=token.split('.'); if(parts.length!==3||parts[0]!=='v1') throw Object.assign(new Error('Malformed signed token'),{status:401});
  const expected=crypto.createHmac('sha256',secret()).update(parts[1]).digest('base64url'); if(!safeEqual(parts[2],expected)) throw Object.assign(new Error('Invalid token signature'),{status:401});
  let p; try { p=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8')); } catch { throw Object.assign(new Error('Invalid token payload'),{status:401}); }
  const now=Math.floor(Date.now()/1000);
  if(p.iss!==ISSUER||p.aud!==audience||p.typ!==expectedType||typeof p.tenantId!=='string'||!p.tenantId||!Number.isInteger(p.iat)||!Number.isInteger(p.exp)||p.iat>now+30||p.exp<=now||p.exp-p.iat>maxTtlSeconds) throw Object.assign(new Error('Expired or invalid token claims'),{status:401});
  return p;
}
export function authenticateTenantToken(req) { const token=req.headers['x-nexora-tenant-token']; const claims=verifyClaims(token,'tenant',AUDIENCE,600); return {tenantId:claims.tenantId,operatorId:claims.sub||claims.tenantId}; }
export function tenantContextMiddleware(req,res,next) { try { const identity=authenticateTenantToken(req); req.nexoraTenant=identity; return runWithTenantContext(identity.tenantId,()=>next()); } catch(err) { return res.status(err.status||401).json({ok:false,error:err.message||'Tenant authentication failed'}); } }
