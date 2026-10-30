// MCP gateway uses the same signed tenant token as the Control HTTP API.
import { tenantContextMiddleware } from '../control/tenant-auth.js';
export function mcpBearerAuth(req,res,next){
  if(String(process.env.NEXORA_AGENT_SHARED_SECRET||'').length>=32)return tenantContextMiddleware(req,res,next);
  if((process.env.NODE_ENV||'production')==='production')return res.status(503).json({error:'NEXORA_AGENT_SHARED_SECRET is required'});
  const expected=String(process.env.CONTROL_TOKEN||'');const m=String(req.headers.authorization||'').match(/^Bearer\s+(.+)$/i);
  if(!expected||!m||m[1].trim()!==expected)return res.status(401).json({error:'Unauthorized'});
  req.mcpAuth={operatorId:'mcp-operator',authenticated:true};return next();
}
export function isMcpTokenConfigured(){return String(process.env.NEXORA_AGENT_SHARED_SECRET||'').length>=32||((process.env.NODE_ENV||'production')!=='production'&&Boolean(process.env.CONTROL_TOKEN));}
