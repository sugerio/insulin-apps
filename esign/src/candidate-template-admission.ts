import {managementCredential} from './candidate-recovery-authorization.ts';

type AdmissionEnv = {
  DB: D1Database;
  CANDIDATE_TEMPLATE_ADMISSION_WINDOW_MS?: string;
  CANDIDATE_TEMPLATE_ADMISSION_TENANT_LIMIT?: string;
  CANDIDATE_TEMPLATE_ADMISSION_DATABASE_LIMIT?: string;
};

type AdmissionCredential = string | {kind:'editor'; token:string; origin:string};

/** Fixed-window admission, consumed even when a subsequent upload fails. */
export async function reserveCandidateTemplateAdmission(env: AdmissionEnv, credential: AdmissionCredential): Promise<void> {
  const raw = [env.CANDIDATE_TEMPLATE_ADMISSION_WINDOW_MS, env.CANDIDATE_TEMPLATE_ADMISSION_TENANT_LIMIT, env.CANDIDATE_TEMPLATE_ADMISSION_DATABASE_LIMIT];
  if (raw.some(v => !v || !/^[1-9][0-9]*$/.test(v))) throw new Error('Unavailable');
  const [windowMs, tenantLimit, databaseLimit] = raw.map(Number);
  if (!Number.isSafeInteger(windowMs) || windowMs < 60000 || windowMs > 86400000 || [tenantLimit,databaseLimit].some(v => !Number.isSafeInteger(v) || v < 1 || v > 1000)) throw new Error('Unavailable');
  const token=typeof credential==='string'?credential:credential.token;
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error('Unauthorized');
  const keyHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))), v => v.toString(16).padStart(2,'0')).join('');
  const db=env.DB;
  const editor=typeof credential==='string'?null:credential;
  const editorQuery=`SELECT e.tenant_id,b.roles_json FROM editor_page_tokens t JOIN editor_page_entries e ON e.page_id=t.page_id JOIN candidate_editor_bindings b ON b.page_id=e.page_id JOIN api_keys k ON k.key_hash=b.key_hash AND k.tenant_id=e.tenant_id JOIN editor_allowed_origins o ON o.tenant_id=e.tenant_id AND o.origin=e.parent_origin WHERE t.token_hash=? AND e.parent_origin=? AND t.expires_at>CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AND e.preset_roles_json=b.roles_json AND NOT EXISTS (SELECT 1 FROM candidate_editor_revocations r WHERE r.page_id=e.page_id) AND ${managementCredential.replace('k.key_hash = ?', 'k.key_hash = b.key_hash')}`;
  const row=editor?await db.prepare(editorQuery).bind(keyHash,editor.origin).first<{tenant_id:string;roles_json:string}>():await db.prepare(`SELECT k.tenant_id FROM api_keys k WHERE ${managementCredential}`).bind(keyHash).first<{tenant_id:string;roles_json?:string}>();
  if (!row) throw new Error('Unauthorized');
  const marker=crypto.randomUUID();
  const guard=()=>editor?db.prepare(`INSERT INTO recipient_auth_assertions SELECT CASE WHEN EXISTS (SELECT 1 FROM (${editorQuery}) WHERE tenant_id=? AND roles_json=?) THEN 1 ELSE 0 END`).bind(keyHash,editor.origin,row.tenant_id,row.roles_json):db.prepare(`INSERT INTO recipient_auth_assertions SELECT CASE WHEN EXISTS (SELECT 1 FROM api_keys k WHERE ${managementCredential} AND k.tenant_id=?) THEN 1 ELSE 0 END`).bind(keyHash,row.tenant_id);
  const budget=(scope:string,id:string,limit:number)=>db.prepare(`INSERT INTO candidate_template_admission_budgets VALUES (?,?,CAST(unixepoch('subsec')*1000 AS INTEGER),?,?,1,?)
    ON CONFLICT(scope,scope_id) DO UPDATE SET
      started_at=CASE WHEN started_at+window_ms<=CAST(unixepoch('subsec')*1000 AS INTEGER) THEN excluded.started_at ELSE started_at END,
      window_ms=excluded.window_ms,issue_limit=excluded.issue_limit,
      issue_count=CASE WHEN started_at+window_ms<=CAST(unixepoch('subsec')*1000 AS INTEGER) THEN 1 ELSE issue_count+1 END,reservation=excluded.reservation
    WHERE started_at+window_ms<=CAST(unixepoch('subsec')*1000 AS INTEGER) OR (window_ms=excluded.window_ms AND issue_limit=excluded.issue_limit AND issue_count<excluded.issue_limit)`).bind(scope,id,windowMs,limit,marker);
  await db.batch([guard(),budget('tenant',row.tenant_id,tenantLimit),budget('database','shared',databaseLimit),
    db.prepare(`INSERT INTO recipient_auth_assertions SELECT CASE WHEN EXISTS (SELECT 1 FROM candidate_template_admission_budgets WHERE scope='tenant' AND scope_id=? AND reservation=?) AND EXISTS (SELECT 1 FROM candidate_template_admission_budgets WHERE scope='database' AND scope_id='shared' AND reservation=?) THEN 1 ELSE 0 END`).bind(row.tenant_id,marker,marker),guard(),db.prepare('DELETE FROM recipient_auth_assertions')]);
}
