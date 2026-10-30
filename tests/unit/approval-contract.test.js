import { afterAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tenant-security-'));
process.env.DATA_DIR = dataDir;
process.env.NEXORA_AGENT_SHARED_SECRET = 'test-only-shared-secret-that-is-at-least-32-characters';
process.env.AGENT_LEGACY_TENANT_ID = 'legacy-owner-tenant';
process.env.NODE_ENV = 'test';
const { getDb, closeDb, migrate } = await import('../../database/index.js');
migrate();
const { runWithTenantContext } = await import('../../control/tenant-context.js');
const { verifyAndConsumeApprovalContract } = await import('../../control/approval-contract.js');
const { hashRequest } = await import('../../control/idempotency.js');
function signed(claims) { const payload=Buffer.from(JSON.stringify(claims)).toString('base64url'); const signature=crypto.createHmac('sha256',process.env.NEXORA_AGENT_SHARED_SECRET).update(payload).digest('base64url'); return `v1.${payload}.${signature}`; }
function contract({tenantId='tenant-a',toolName='composio.hubspot.create_contact',args={email:'test@example.com'},exp=Math.floor(Date.now()/1000)+120,jti=crypto.randomUUID()}={}) { const now=Math.floor(Date.now()/1000); return signed({iss:'nexora-intelligence',aud:'ai-browser-agent',typ:'approval',tenantId,approvalId:'approval-123',sub:'operator-1',toolName,argsHash:hashRequest(toolName,args),oneTime:true,iat:now,exp,jti}); }
afterAll(()=>{closeDb();fs.rmSync(dataDir,{recursive:true,force:true});});
describe('signed Nexora approval contract',()=>{
 it('accepts a valid contract once and rejects replay',()=>{const args={email:'test@example.com'};const token=contract({args});const result=runWithTenantContext('tenant-a',()=>verifyAndConsumeApprovalContract(token,{tenantId:'tenant-a',operatorId:'operator-1',toolName:'composio.hubspot.create_contact',args}));expect(result.approvalId).toBe('approval-123');expect(()=>runWithTenantContext('tenant-a',()=>verifyAndConsumeApprovalContract(token,{tenantId:'tenant-a',operatorId:'operator-1',toolName:'composio.hubspot.create_contact',args}))).toThrow(/already been consumed/);});
 it('rejects a changed payload before consuming the contract',()=>{const args={email:'test@example.com'};const token=contract({args});expect(()=>runWithTenantContext('tenant-a',()=>verifyAndConsumeApprovalContract(token,{tenantId:'tenant-a',operatorId:'operator-1',toolName:'composio.hubspot.create_contact',args:{email:'other@example.com'}}))).toThrow(/exact payload/);expect(runWithTenantContext('tenant-a',()=>verifyAndConsumeApprovalContract(token,{tenantId:'tenant-a',operatorId:'operator-1',toolName:'composio.hubspot.create_contact',args})).approvalId).toBe('approval-123');});
 it('rejects a different tenant and expired token',()=>{const args={email:'test@example.com'};const token=contract({args});expect(()=>runWithTenantContext('tenant-b',()=>verifyAndConsumeApprovalContract(token,{tenantId:'tenant-b',operatorId:'operator-1',toolName:'composio.hubspot.create_contact',args}))).toThrow(/does not authorize/);const expired=contract({args,exp:Math.floor(Date.now()/1000)-1});expect(()=>runWithTenantContext('tenant-a',()=>verifyAndConsumeApprovalContract(expired,{tenantId:'tenant-a',operatorId:'operator-1',toolName:'composio.hubspot.create_contact',args}))).toThrow(/Expired or invalid/);});
 it('rejects a tampered signature',()=>{const args={email:'test@example.com'};const token=contract({args});expect(()=>runWithTenantContext('tenant-a',()=>verifyAndConsumeApprovalContract(token.slice(0,-1)+'x',{tenantId:'tenant-a',operatorId:'operator-1',toolName:'composio.hubspot.create_contact',args}))).toThrow(/Invalid token signature/);});
});
describe('tenant database isolation',()=>{it('stores rows in a separate SQLite database for each verified tenant',()=>{runWithTenantContext('tenant-a',()=>getDb().prepare("INSERT INTO tasks(id,name,goal,status,created_at,updated_at) VALUES('tenant-only','Tenant A','private','idle','now','now')").run());const rowA=runWithTenantContext('tenant-a',()=>getDb().prepare('SELECT id FROM tasks WHERE id=?').get('tenant-only'));const rowB=runWithTenantContext('tenant-b',()=>getDb().prepare('SELECT id FROM tasks WHERE id=?').get('tenant-only'));expect(rowA?.id).toBe('tenant-only');expect(rowB).toBeUndefined();});});
