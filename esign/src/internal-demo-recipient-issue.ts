import {managementCredential} from './candidate-recovery-authorization.ts';

type IssuanceEnv={DB:D1Database;TEST_ISSUANCE_WINDOW_MS?:string;TEST_ISSUANCE_TENANT_LIMIT?:string;TEST_ISSUANCE_DATABASE_LIMIT?:string;TEST_OUTSTANDING_TENANT_LIMIT?:string;TEST_OUTSTANDING_DATABASE_LIMIT?:string};
const hex=(bytes:ArrayBuffer|Uint8Array)=>Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');
const digest=async(s:string)=>hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)));

/** Original recipient-view issuance with the existing candidate's database-local budgets. */
export async function issueInternalDemoRecipientView(env:IssuanceEnv,keyHash:string,tenant:string,envelope:string,task:string,origin:string):Promise<string> {
 const raw=[env.TEST_ISSUANCE_WINDOW_MS,env.TEST_ISSUANCE_TENANT_LIMIT,env.TEST_ISSUANCE_DATABASE_LIMIT,env.TEST_OUTSTANDING_TENANT_LIMIT,env.TEST_OUTSTANDING_DATABASE_LIMIT];
 if(raw.some(x=>typeof x!=='string'||!/^[1-9][0-9]{0,8}$/.test(x)))throw new Error('Unavailable');
 const [windowMs,tenantLimit,databaseLimit,tenantOutstanding,databaseOutstanding]=raw.map(Number);
 if(windowMs<60000||windowMs>86400000||[tenantLimit,databaseLimit,tenantOutstanding,databaseOutstanding].some(x=>x>100000))throw new Error('Unavailable');
 const db=env.DB,code=hex(crypto.getRandomValues(new Uint8Array(32))),codeHash=await digest(code);
 const budget=(scope:string,id:string,limit:number,outstanding:number)=>db.prepare(`INSERT INTO candidate_issuance_budgets(scope,scope_id,started_at,window_ms,issue_limit,outstanding_limit,issue_count,reservation)
 VALUES (?,?,CAST(unixepoch('subsec')*1000 AS INTEGER),?,?,?,1,?) ON CONFLICT(scope,scope_id) DO UPDATE SET
 started_at=CASE WHEN candidate_issuance_budgets.started_at+candidate_issuance_budgets.window_ms<=CAST(unixepoch('subsec')*1000 AS INTEGER) THEN excluded.started_at ELSE candidate_issuance_budgets.started_at END,
 window_ms=excluded.window_ms,issue_limit=excluded.issue_limit,outstanding_limit=excluded.outstanding_limit,
 issue_count=CASE WHEN candidate_issuance_budgets.started_at+candidate_issuance_budgets.window_ms<=CAST(unixepoch('subsec')*1000 AS INTEGER) THEN 1 ELSE candidate_issuance_budgets.issue_count+1 END,reservation=excluded.reservation
 WHERE candidate_issuance_budgets.started_at+candidate_issuance_budgets.window_ms<=CAST(unixepoch('subsec')*1000 AS INTEGER) OR (candidate_issuance_budgets.window_ms=excluded.window_ms AND candidate_issuance_budgets.issue_limit=excluded.issue_limit AND candidate_issuance_budgets.outstanding_limit=excluded.outstanding_limit AND candidate_issuance_budgets.issue_count<excluded.issue_limit)`).bind(scope,id,windowMs,limit,outstanding,codeHash);
 const results=await db.batch([
  db.prepare('SELECT token_hash,subject,email,mode,task_label FROM internal_demo_recipient_bindings LIMIT 0'),
  budget('database','shared',databaseLimit,databaseOutstanding),budget('tenant',tenant,tenantLimit,tenantOutstanding),
  db.prepare(`INSERT INTO recipient_page_codes(code_hash,tenant_id,envelope_id,task_id,origin,expires_at)
   SELECT ?1,e.tenant_id,e.id,t.id,o.origin,CAST(unixepoch('subsec')*1000 AS INTEGER)+120000 FROM api_keys k JOIN envelopes e ON e.tenant_id=k.tenant_id JOIN tasks t ON t.envelope_id=e.id JOIN tenant_page_origins o ON o.tenant_id=e.tenant_id AND o.origin=?2
   WHERE ${managementCredential} AND e.id=?4 AND t.id=?5 AND e.status='IN_PROGRESS' AND t.status='ACTIVE'
   AND EXISTS(SELECT 1 FROM candidate_issuance_budgets WHERE scope='database' AND scope_id='shared' AND reservation=?1)
   AND EXISTS(SELECT 1 FROM candidate_issuance_budgets WHERE scope='tenant' AND scope_id=e.tenant_id AND reservation=?1)
   AND (SELECT COUNT(*) FROM recipient_page_codes c WHERE NOT EXISTS(SELECT 1 FROM recipient_code_revocations r WHERE r.code_hash=c.code_hash) AND expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER) AND used_at IS NULL)<?6
   AND (SELECT COUNT(*) FROM recipient_page_codes c WHERE NOT EXISTS(SELECT 1 FROM recipient_code_revocations r WHERE r.code_hash=c.code_hash) AND tenant_id=e.tenant_id AND expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER) AND used_at IS NULL)<?7
   AND (SELECT COUNT(*) FROM recipient_page_codes)<10000
   AND NOT EXISTS(SELECT 1 FROM recipient_code_revocations WHERE code_hash=?1) AND NOT EXISTS(SELECT 1 FROM api_keys WHERE key_hash=?1) AND NOT EXISTS(SELECT 1 FROM recipient_page_sessions WHERE token_hash=?1) AND NOT EXISTS(SELECT 1 FROM editor_sessions WHERE token_hash=?1) AND NOT EXISTS(SELECT 1 FROM editor_page_tokens WHERE token_hash=?1) AND NOT EXISTS(SELECT 1 FROM editor_codes WHERE code_hash=?1) AND NOT EXISTS(SELECT 1 FROM editor_page_entries WHERE code_hash=?1)`).bind(codeHash,origin,keyHash,envelope,task,databaseOutstanding,tenantOutstanding),
  db.prepare('INSERT INTO recipient_auth_assertions SELECT CASE WHEN changes()=1 THEN 1 ELSE 0 END'),db.prepare('DELETE FROM recipient_auth_assertions')
 ]);
 if(results[3].meta.changes!==1)throw new Error('Unavailable');return code;
}
