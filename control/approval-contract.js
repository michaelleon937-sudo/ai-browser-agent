import { getDb } from '../database/index.js';
import { hashRequest } from './idempotency.js';
import { verifyClaims } from './tenant-auth.js';
export function verifyAndConsumeApprovalContract(token,{tenantId,operatorId,toolName,args}) {
  const p=verifyClaims(token,'approval','ai-browser-agent',300);
  if(p.tenantId!==tenantId||p.sub!==operatorId||p.toolName!==toolName||p.oneTime!==true||typeof p.approvalId!=='string'||typeof p.jti!=='string'||!p.jti||p.argsHash!==hashRequest(toolName,args)) throw Object.assign(new Error('Approval contract does not authorize this tenant, tool, or exact payload'),{status:403,code:'approval_contract_mismatch'});
  const db=getDb(); db.exec('CREATE TABLE IF NOT EXISTS approval_contract_uses (jti TEXT PRIMARY KEY, approval_id TEXT NOT NULL, tenant_id TEXT NOT NULL, tool_name TEXT NOT NULL, consumed_at TEXT NOT NULL, expires_at INTEGER NOT NULL)');
  const now=Math.floor(Date.now()/1000); const result=db.prepare('INSERT OR IGNORE INTO approval_contract_uses(jti,approval_id,tenant_id,tool_name,consumed_at,expires_at) VALUES(?,?,?,?,?,?)').run(p.jti,p.approvalId,p.tenantId,p.toolName,new Date().toISOString(),p.exp);
  if(result.changes!==1) throw Object.assign(new Error('Approval contract has already been consumed'),{status:409,code:'approval_contract_replayed'});
  return {approvalId:p.approvalId,tenantId:p.tenantId,toolName:p.toolName,jti:p.jti};
}
