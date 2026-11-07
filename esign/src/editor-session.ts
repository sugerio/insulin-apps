const encode=new TextEncoder();
const hash=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encode.encode(value))),n=>n.toString(16).padStart(2,'0')).join('');
const random=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),n=>n.toString(16).padStart(2,'0')).join('');
function checkOrigin(origin:string){try{const url=new URL(origin);if(url.origin===origin&&(url.protocol==='https:'||(url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname))))return;}catch{}throw new Error('Invalid origin');}
export async function issueEditorCode(db:D1Database,tenantId:string,origin:string,now:number):Promise<string>{
  checkOrigin(origin);const code=random();
  const result=await db.prepare('INSERT INTO editor_codes (code_hash,tenant_id,origin,expires_at) SELECT ?,tenant_id,origin,? FROM editor_allowed_origins WHERE tenant_id=? AND origin=?').bind(await hash(code),now+120000,tenantId,origin).run();
  if(result.meta.changes!==1)throw new Error('Origin not allowed');return code;
}
export async function exchangeEditorCode(db:D1Database,code:string,origin:string,now:number):Promise<string>{
  checkOrigin(origin);if(!/^[a-f0-9]{64}$/.test(code))throw new Error('Invalid code');
  const codeHash=await hash(code),token=random();
  await db.batch([
    db.prepare('INSERT INTO editor_assertions SELECT CASE WHEN EXISTS (SELECT 1 FROM editor_codes c JOIN editor_allowed_origins o ON o.tenant_id=c.tenant_id AND o.origin=c.origin WHERE c.code_hash=? AND c.origin=? AND c.used_at IS NULL AND c.expires_at>?) THEN 1 ELSE 0 END').bind(codeHash,origin,now),
    db.prepare('INSERT INTO editor_sessions SELECT ?,tenant_id,origin,? FROM editor_codes WHERE code_hash=?').bind(await hash(token),now+900000,codeHash),
    db.prepare('UPDATE editor_codes SET used_at=? WHERE code_hash=?').bind(now,codeHash),
    db.prepare('DELETE FROM editor_assertions'),
  ]);return token;
}
export async function authorizeEditor(db:D1Database,token:string,origin:string,now:number):Promise<string>{
  checkOrigin(origin);if(!/^[a-f0-9]{64}$/.test(token))throw new Error('Invalid session');
  const row=await db.prepare('SELECT s.tenant_id FROM editor_sessions s JOIN editor_allowed_origins o ON o.tenant_id=s.tenant_id AND o.origin=s.origin WHERE s.token_hash=? AND s.origin=? AND s.expires_at>?').bind(await hash(token),origin,now).first<{tenant_id:string}>();
  if(!row)throw new Error('Invalid session');return row.tenant_id;
}

/** The page ID selects a CSP policy only; it does not authorize an exchange. */
export async function issueEditorPage(db:D1Database,tenantId:string,parentOrigin:string,now:number):Promise<{pageId:string;code:string}>{
  checkOrigin(parentOrigin);
  const pageId=random(),code=random();
  const result=await db.prepare('INSERT INTO editor_page_entries (page_id,code_hash,tenant_id,parent_origin,expires_at) SELECT ?,?,tenant_id,origin,? FROM editor_allowed_origins WHERE tenant_id=? AND origin=?').bind(pageId,await hash(code),now+120000,tenantId,parentOrigin).run();
  if(result.meta.changes!==1)throw new Error('Origin not allowed');
  return {pageId,code};
}
export async function editorPageParent(db:D1Database,pageId:string,now:number):Promise<string|null>{
  if(!/^[a-f0-9]{64}$/.test(pageId))return null;
  const row=await db.prepare('SELECT e.parent_origin FROM editor_page_entries e JOIN editor_allowed_origins o ON o.tenant_id=e.tenant_id AND o.origin=e.parent_origin WHERE NOT EXISTS (SELECT 1 FROM candidate_editor_bindings b WHERE b.page_id=e.page_id) AND e.page_id=? AND e.expires_at>?').bind(pageId,now).first<{parent_origin:string}>();
  return row?.parent_origin??null;
}
export async function exchangeEditorPage(db:D1Database,pageId:string,code:string,now:number):Promise<string>{
  if(!/^[a-f0-9]{64}$/.test(pageId)||!/^[a-f0-9]{64}$/.test(code))throw new Error('Invalid code');
  const token=random();
  await db.batch([
    db.prepare('INSERT INTO editor_page_assertions SELECT CASE WHEN EXISTS (SELECT 1 FROM editor_page_entries e JOIN editor_allowed_origins o ON o.tenant_id=e.tenant_id AND o.origin=e.parent_origin WHERE NOT EXISTS (SELECT 1 FROM candidate_editor_bindings b WHERE b.page_id=e.page_id) AND e.page_id=? AND e.code_hash=? AND e.used_at IS NULL AND e.expires_at>?) THEN 1 ELSE 0 END').bind(pageId,await hash(code),now),
    db.prepare('INSERT INTO editor_page_tokens (token_hash,page_id,expires_at) VALUES (?,?,?)').bind(await hash(token),pageId,now+900000),
    db.prepare('UPDATE editor_page_entries SET used_at=? WHERE page_id=?').bind(now,pageId),
    db.prepare('DELETE FROM editor_page_assertions'),
  ]);
  return token;
}
export async function authorizeEditorPage(db:D1Database,token:string,now:number):Promise<{tenantId:string;parentOrigin:string}>{
  if(!/^[a-f0-9]{64}$/.test(token))throw new Error('Invalid session');
  const row=await db.prepare('SELECT e.tenant_id,e.parent_origin FROM editor_page_tokens t JOIN editor_page_entries e ON e.page_id=t.page_id JOIN editor_allowed_origins o ON o.tenant_id=e.tenant_id AND o.origin=e.parent_origin WHERE NOT EXISTS (SELECT 1 FROM candidate_editor_bindings b WHERE b.page_id=e.page_id) AND t.token_hash=? AND t.expires_at>?').bind(await hash(token),now).first<{tenant_id:string;parent_origin:string}>();
  if(!row)throw new Error('Invalid session');
  return {tenantId:row.tenant_id,parentOrigin:row.parent_origin};
}

export async function editorPageContext(db:D1Database,token:string,now:number):Promise<{pageId:string;tenantId:string;parentOrigin:string;sourceTemplateId:string|null;sourceSha256:string|null;stagedObjectKey:string|null;stagedSha256:string|null;roles:string[];resultTemplateId:string|null}>{
  if(!/^[a-f0-9]{64}$/.test(token))throw new Error('Invalid session');
  const row=await db.prepare('SELECT e.page_id,e.tenant_id,e.parent_origin,e.source_template_id,e.source_sha256,e.staged_object_key,e.staged_sha256,e.preset_roles_json,e.result_template_id FROM editor_page_tokens t JOIN editor_page_entries e ON e.page_id=t.page_id JOIN editor_allowed_origins o ON o.tenant_id=e.tenant_id AND o.origin=e.parent_origin WHERE NOT EXISTS (SELECT 1 FROM candidate_editor_bindings b WHERE b.page_id=e.page_id) AND t.token_hash=? AND t.expires_at>?').bind(await hash(token),now).first<{page_id:string;tenant_id:string;parent_origin:string;source_template_id:string|null;source_sha256:string|null;staged_object_key:string|null;staged_sha256:string|null;preset_roles_json:string;result_template_id:string|null}>();
  if(!row)throw new Error('Invalid session');
  return {pageId:row.page_id,tenantId:row.tenant_id,parentOrigin:row.parent_origin,sourceTemplateId:row.source_template_id,sourceSha256:row.source_sha256,stagedObjectKey:row.staged_object_key,stagedSha256:row.staged_sha256,roles:JSON.parse(row.preset_roles_json),resultTemplateId:row.result_template_id};
}
