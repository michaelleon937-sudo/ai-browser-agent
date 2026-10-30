// Control API authentication: production requires a signed, tenant-scoped Nexora token.
import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { authenticateTenantToken } from './tenant-auth.js';
export class ControlAuthError extends Error { constructor(message,status=401){super(message);this.name='ControlAuthError';this.status=status;} }
export function getControlToken(){return String(process.env.NEXORA_AGENT_SHARED_SECRET||config.control?.token||process.env.CONTROL_TOKEN||'');}
export function isProductionEnv(){return (process.env.NODE_ENV||config.env||'production')==='production';}
export function assertControlConfigured(){const shared=String(process.env.NEXORA_AGENT_SHARED_SECRET||'');if(shared.length>=32)return shared;const legacy=String(config.control?.token||process.env.CONTROL_TOKEN||'');if(!isProductionEnv()&&legacy)return legacy;throw new ControlAuthError('NEXORA_AGENT_SHARED_SECRET is required for tenant-scoped Control API authentication',503);}
export function timingSafeEqualString(a,b){const x=Buffer.from(String(a||''));const y=Buffer.from(String(b||''));return x.length===y.length&&crypto.timingSafeEqual(x,y);}
export function extractBearerToken(req){const h=req.headers?.authorization||'';const m=String(Array.isArray(h)?h[0]:h).match(/^Bearer\s+(.+)$/i);return m?m[1].trim():'';}
export function authenticateControlRequest(req){const shared=String(process.env.NEXORA_AGENT_SHARED_SECRET||'');if(shared.length>=32)return {...authenticateTenantToken(req),authenticated:true};if(isProductionEnv())throw new ControlAuthError('NEXORA_AGENT_SHARED_SECRET is required in production',503);const expected=assertControlConfigured();const provided=extractBearerToken(req);if(!provided||!timingSafeEqualString(provided,expected))throw new ControlAuthError('Unauthorized');return {operatorId:'control-operator',tenantId:null,authenticated:true,legacy:true};}
export function controlAuthMiddleware(req,res,next){try{req.nexoraTenant=req.nexoraTenant||authenticateControlRequest(req);req.controlAuth=req.nexoraTenant;return next();}catch(err){return res.status(err.status||401).json({ok:false,error:err.message||'Unauthorized'});}}
