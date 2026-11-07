import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {unstable_splitSqlQuery} from 'wrangler';
import {Miniflare} from 'miniflare';
import {reserveCandidateTemplateAdmission} from '../src/candidate-template-admission.ts';

test('template admission authenticates and atomically spends tenant and shared budgets before reading a body',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response()}}',d1Databases:['DB']});
 try {
  const db=await mf.getD1Database('DB');
  for(const n of (await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort())await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${n}`,'utf8')).map(s=>db.prepare(s)));
  const token='a'.repeat(32), hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))).toString('hex');
  await db.prepare('INSERT INTO tenants VALUES (?)').bind('a').run();await db.prepare('INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,?)').bind(hash,'a').run();
  const env={DB:db as unknown as D1Database,CANDIDATE_TEMPLATE_ADMISSION_WINDOW_MS:'60000',CANDIDATE_TEMPLATE_ADMISSION_TENANT_LIMIT:'2',CANDIDATE_TEMPLATE_ADMISSION_DATABASE_LIMIT:'2'};
  await assert.rejects(reserveCandidateTemplateAdmission({...env,CANDIDATE_TEMPLATE_ADMISSION_WINDOW_MS:undefined},token));
  await assert.rejects(reserveCandidateTemplateAdmission(env,'b'.repeat(32)));
  const results=await Promise.allSettled([1,2,3].map(()=>reserveCandidateTemplateAdmission(env,token)));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,2);
  assert.equal((await db.prepare("SELECT issue_count FROM candidate_template_admission_budgets WHERE scope='database'").first<{issue_count:number}>())?.issue_count,2);
  const other='c'.repeat(32), otherHash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(other))).toString('hex');
  await db.prepare('INSERT INTO tenants VALUES (?)').bind('b').run();await db.prepare('INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,?)').bind(otherHash,'b').run();
  await assert.rejects(reserveCandidateTemplateAdmission(env,other));
  assert.equal((await db.prepare("SELECT count(*) n FROM candidate_template_admission_budgets WHERE scope='tenant' AND scope_id='b'").first<{n:number}>())?.n,0);
  await db.exec('DELETE FROM candidate_template_admission_budgets');
  let lost=false;const lostDb=new Proxy(db,{get(target,k){if(k==='batch')return async(s:Parameters<typeof target.batch>[0])=>{const result=await target.batch(s);if(!lost){lost=true;throw Error('lost response');}return result;};const value=Reflect.get(target,k,target);return typeof value==='function'?value.bind(target):value;}});
  await assert.rejects(reserveCandidateTemplateAdmission({...env,DB:lostDb as unknown as D1Database},token));
  assert.equal((await db.prepare("SELECT issue_count FROM candidate_template_admission_budgets WHERE scope='database'").first<{issue_count:number}>())?.issue_count,1);
  const beforePolicy=(await db.prepare('SELECT scope,scope_id,started_at,window_ms,issue_limit,issue_count,reservation FROM candidate_template_admission_budgets ORDER BY scope').all()).results;
  await assert.rejects(reserveCandidateTemplateAdmission({...env,CANDIDATE_TEMPLATE_ADMISSION_DATABASE_LIMIT:'3'},token));
  assert.deepEqual((await db.prepare('SELECT scope,scope_id,started_at,window_ms,issue_limit,issue_count,reservation FROM candidate_template_admission_budgets ORDER BY scope').all()).results,beforePolicy,'policy change with remaining capacity rolls back tenant budget');
  const revokeDb=new Proxy(db,{get(target,k){if(k==='batch')return async(s:Parameters<typeof target.batch>[0])=>{await target.prepare('UPDATE api_keys SET revoked_at=1 WHERE key_hash=?').bind(hash).run();return target.batch(s);};const value=Reflect.get(target,k,target);return typeof value==='function'?value.bind(target):value;}});
  await assert.rejects(reserveCandidateTemplateAdmission({...env,DB:revokeDb as unknown as D1Database},token));
  assert.deepEqual((await db.prepare('SELECT scope,scope_id,started_at,window_ms,issue_limit,issue_count,reservation FROM candidate_template_admission_budgets ORDER BY scope').all()).results,beforePolicy,'revocation between authentication and batch rolls back budgets');
  assert.equal((await db.prepare('SELECT count(*) n FROM recipient_auth_assertions').first<{n:number}>())!.n,0);
  await db.prepare('UPDATE api_keys SET revoked_at=NULL').run();
  await assert.rejects(reserveCandidateTemplateAdmission({...env,CANDIDATE_TEMPLATE_ADMISSION_DATABASE_LIMIT:'1'},token));
  await db.prepare('UPDATE api_keys SET revoked_at=1').run();await assert.rejects(reserveCandidateTemplateAdmission(env,token));
 } finally {await mf.dispose();}
});

test('editor admission derives tenant from session and rechecks revocation inside budget batch',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response()}}',d1Databases:['DB']});
 try {
  const db=await mf.getD1Database('DB');
  for(const n of (await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort())await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${n}`,'utf8')).map(s=>db.prepare(s)));
  const {issueCandidateEditorSession,exchangeCandidateEditorSession}=await import('../src/candidate-editor-session.ts');
  const key='d'.repeat(32), hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key))).toString('hex'), origin='https://host.example.test';
  await db.prepare('INSERT INTO tenants VALUES (?)').bind('editor-tenant').run();
  await db.prepare('INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,?)').bind(hash,'editor-tenant').run();
  await db.prepare('INSERT INTO editor_allowed_origins VALUES (?,?)').bind('editor-tenant',origin).run();
  const d=db as unknown as D1Database;
  const page=await issueCandidateEditorSession(d,key,origin,['buyer','seller'],0,{windowMs:60000,tenantIssuance:5,databaseIssuance:5,tenantOutstanding:5,databaseOutstanding:5,tenantRetained:5,databaseRetained:5});
  const token=await exchangeCandidateEditorSession(d,page.pageId,page.code,origin,0);
  const env={DB:d,CANDIDATE_TEMPLATE_ADMISSION_WINDOW_MS:'60000',CANDIDATE_TEMPLATE_ADMISSION_TENANT_LIMIT:'5',CANDIDATE_TEMPLATE_ADMISSION_DATABASE_LIMIT:'5'};
  const session={kind:'editor' as const,token,origin};
  await assert.rejects(reserveCandidateTemplateAdmission(env,{...session,origin:'https://wrong.example.test'}));
  await reserveCandidateTemplateAdmission(env,session);
  assert.equal((await db.prepare("SELECT issue_count FROM candidate_template_admission_budgets WHERE scope='tenant' AND scope_id='editor-tenant'").first<{issue_count:number}>())?.issue_count,1);
  await db.prepare('UPDATE editor_page_tokens SET expires_at=0 WHERE page_id=?').bind(page.pageId).run();
  await assert.rejects(reserveCandidateTemplateAdmission(env,session));
  await db.prepare("UPDATE editor_page_tokens SET expires_at=CAST(unixepoch('subsec')*1000 AS INTEGER)+60000 WHERE page_id=?").bind(page.pageId).run();
  await db.prepare('UPDATE editor_page_entries SET preset_roles_json=? WHERE page_id=?').bind('["other","seller"]',page.pageId).run();
  await assert.rejects(reserveCandidateTemplateAdmission(env,session));
  await db.prepare('UPDATE editor_page_entries SET preset_roles_json=? WHERE page_id=?').bind('["buyer","seller"]',page.pageId).run();
  const revokeDb=new Proxy(db,{get(target,k){if(k==='batch')return async(s:Parameters<typeof target.batch>[0])=>{await target.prepare('UPDATE api_keys SET revoked_at=1 WHERE key_hash=?').bind(hash).run();return target.batch(s);};const value=Reflect.get(target,k,target);return typeof value==='function'?value.bind(target):value;}});
  await assert.rejects(reserveCandidateTemplateAdmission({...env,DB:revokeDb as unknown as D1Database},session));
  assert.equal((await db.prepare("SELECT issue_count FROM candidate_template_admission_budgets WHERE scope='tenant'").first<{issue_count:number}>())?.issue_count,1);
  await assert.rejects(reserveCandidateTemplateAdmission(env,session));
 } finally {await mf.dispose();}
});
