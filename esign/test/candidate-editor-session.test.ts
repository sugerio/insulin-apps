import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {unstable_splitSqlQuery} from 'wrangler';
import {Miniflare} from 'miniflare';
import {exchangeEditorPage,editorPageContext,authorizeEditorPage} from '../src/editor-session.ts';
import {issueCandidateEditorSession,exchangeCandidateEditorSession,authorizeCandidateEditorSession} from '../src/candidate-editor-session.ts';

test('candidate editor issuance and exchange are tenant, origin, role and credential bound',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response()}}',d1Databases:['DB']});
 try{
  const db=await mf.getD1Database('DB') as unknown as D1Database;
  for(const n of (await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort())await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${n}`,'utf8')).map(s=>db.prepare(s)));
  const key='a'.repeat(32),hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key))).toString('hex');
  await db.prepare("INSERT INTO tenants VALUES ('a'),('b')").run();
  await db.prepare("INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,'a')").bind(hash).run();
  await db.prepare("INSERT INTO editor_allowed_origins VALUES ('a','https://host.example.com'),('b','https://other.example.com')").run();
  const roles=['Buyer','Seller'];
  const policy={windowMs:60000,tenantIssuance:20,databaseIssuance:30,tenantOutstanding:20,databaseOutstanding:30,tenantRetained:20,databaseRetained:30};
  const issue=(k:string,o:string,r:string[],n:number)=>issueCandidateEditorSession(db,k,o,r,n,policy);
  await assert.rejects(issueCandidateEditorSession(db,key,'https://host.example.com',roles,100,undefined as never));
  await assert.rejects(issue(key,'https://other.example.com',roles,100));
  await assert.rejects(issue(key,'https://host.example.com',['Buyer','buyer'],100));
  await assert.rejects(issue(key,'https://host.example.com',['First signer','Second'],100));
  await assert.rejects(issue(key,'https://host.example.com',['签署人','Second'],100));
  const legacy=await issue(key,'https://host.example.com',roles,100);
  const legacyToken=await exchangeCandidateEditorSession(db,legacy.pageId,legacy.code,'https://host.example.com',100);
  const legacyRoles=JSON.stringify(['First signer','Second']);
  await db.prepare('UPDATE editor_page_entries SET preset_roles_json=? WHERE page_id=?').bind(legacyRoles,legacy.pageId).run();
  await db.prepare('UPDATE candidate_editor_bindings SET roles_json=? WHERE page_id=?').bind(legacyRoles,legacy.pageId).run();
  await assert.rejects(authorizeCandidateEditorSession(db,legacyToken,'https://host.example.com',100));
  assert.equal((await db.prepare('SELECT roles_json FROM candidate_editor_bindings WHERE page_id=?').bind(legacy.pageId).first<{roles_json:string}>())!.roles_json,legacyRoles);
  const expired=await issue(key,'https://host.example.com',roles,100);
  await db.prepare('UPDATE editor_page_entries SET expires_at=0 WHERE page_id=?').bind(expired.pageId).run();
  await assert.rejects(exchangeCandidateEditorSession(db,expired.pageId,expired.code,'https://host.example.com',120100));
  const issued=await issue(key,'https://host.example.com',roles,100);
  await assert.rejects(exchangeCandidateEditorSession(db,issued.pageId,issued.code,'https://other.example.com',101));
  const race=await Promise.allSettled([1,2].map(()=>exchangeCandidateEditorSession(db,issued.pageId,issued.code,'https://host.example.com',101)));
  assert.equal(race.filter(x=>x.status==='fulfilled').length,1);
  await assert.rejects(exchangeEditorPage(db,expired.pageId,expired.code,101));
  const token=(race.find(x=>x.status==='fulfilled') as PromiseFulfilledResult<string>).value;
  await assert.rejects(editorPageContext(db,token,102));
  await assert.rejects(authorizeEditorPage(db,token,102));
  assert.deepEqual(await authorizeCandidateEditorSession(db,token,'https://host.example.com',102),{tenantId:'a',roles});
  await assert.rejects(authorizeCandidateEditorSession(db,token,'https://other.example.com',102));
  await db.prepare('UPDATE editor_page_tokens SET expires_at=0 WHERE page_id=?').bind(issued.pageId).run();
  await assert.rejects(authorizeCandidateEditorSession(db,token,'https://host.example.com',900101));
  const revokedEntry=await issue(key,'https://host.example.com',roles,102);
  const liveEntry=await issue(key,'https://host.example.com',roles,102);
  const liveToken=await exchangeCandidateEditorSession(db,liveEntry.pageId,liveEntry.code,'https://host.example.com',102);
  assert.deepEqual(await authorizeCandidateEditorSession(db,liveToken,'https://host.example.com',102),{tenantId:'a',roles});
  await db.prepare('UPDATE api_keys SET revoked_at=1 WHERE key_hash=?').bind(hash).run();
  await assert.rejects(authorizeCandidateEditorSession(db,liveToken,'https://host.example.com',103));
  await assert.rejects(exchangeEditorPage(db,revokedEntry.pageId,revokedEntry.code,103));
  await assert.rejects(editorPageContext(db,token,103));
  await assert.rejects(issue(key,'https://host.example.com',roles,103));
  await db.prepare('UPDATE api_keys SET revoked_at=NULL WHERE key_hash=?').bind(hash).run();
  await assert.rejects(authorizeCandidateEditorSession(db,liveToken,'https://host.example.com',104));
  const fresh=await issue(key,'https://host.example.com',roles,105);
  await db.prepare("DELETE FROM editor_allowed_origins WHERE tenant_id='a'").run();
  await db.prepare("INSERT INTO editor_allowed_origins VALUES ('a','https://host.example.com')").run();
  await assert.rejects(exchangeCandidateEditorSession(db,fresh.pageId,fresh.code,'https://host.example.com',106));
  const tight={...policy,tenantOutstanding:1,databaseOutstanding:1};
  await db.prepare('UPDATE candidate_editor_budgets SET started_at=0').run();
  const raceIssue=await Promise.allSettled([1,2].map(()=>issueCandidateEditorSession(db,key,'https://host.example.com',roles,1000000,tight)));
  assert.equal(raceIssue.filter(x=>x.status==='fulfilled').length,1);
  const before=await db.prepare('SELECT page_id,code_hash,tenant_id,parent_origin,expires_at,used_at,preset_roles_json FROM editor_page_entries ORDER BY page_id').all();
  const retained={...policy,tenantRetained:1};
  await assert.rejects(issueCandidateEditorSession(db,key,'https://host.example.com',roles,2000000,retained));
  const after=await db.prepare('SELECT page_id,code_hash,tenant_id,parent_origin,expires_at,used_at,preset_roles_json FROM editor_page_entries ORDER BY page_id').all();
  assert.deepEqual(after.results,before.results);
  await db.prepare('UPDATE candidate_editor_budgets SET started_at=0').run();
  const shared={...policy,databaseIssuance:1};
  await issueCandidateEditorSession(db,key,'https://host.example.com',roles,3000000,shared);
  await assert.rejects(issueCandidateEditorSession(db,key,'https://host.example.com',roles,3000001,shared));
  await db.prepare('UPDATE candidate_editor_budgets SET started_at=0').run();
  const tenantCap={...policy,tenantIssuance:1};
  await issueCandidateEditorSession(db,key,'https://host.example.com',roles,4000000,tenantCap);
  await assert.rejects(issueCandidateEditorSession(db,key,'https://host.example.com',roles,4000001,tenantCap));
 }finally{await mf.dispose();}
});

test('candidate editor uses D1 time rather than supplied clock',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response()}}',d1Databases:['DB']});
 try {
  const db=await mf.getD1Database('DB') as unknown as D1Database;
  for(const n of (await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort())await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${n}`,'utf8')).map(s=>db.prepare(s)));
  const key='z'.repeat(32),keyHash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key))).toString('hex');
  await db.prepare("INSERT INTO tenants VALUES ('a')").run();
  await db.prepare("INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,'a')").bind(keyHash).run();
  await db.prepare("INSERT INTO editor_allowed_origins VALUES ('a','https://host.example.com')").run();
  const policy={windowMs:60000,tenantIssuance:10,databaseIssuance:10,tenantOutstanding:10,databaseOutstanding:10,tenantRetained:10,databaseRetained:10};
  const issued=await issueCandidateEditorSession(db,key,'https://host.example.com',['Buyer','Seller'],0,policy);
  const entry=await db.prepare('SELECT expires_at FROM editor_page_entries WHERE page_id=?').bind(issued.pageId).first<{expires_at:number}>();
  assert.ok(entry!.expires_at>Date.now()+110000);
  await db.prepare('UPDATE editor_page_entries SET expires_at=0 WHERE page_id=?').bind(issued.pageId).run();
  await assert.rejects(exchangeCandidateEditorSession(db,issued.pageId,issued.code,'https://host.example.com',0));
  const pending=await issueCandidateEditorSession(db,key,'https://host.example.com',['Buyer','Seller'],Number.MAX_SAFE_INTEGER,policy);
  await db.prepare(`CREATE TRIGGER expire_during_exchange AFTER INSERT ON editor_page_tokens BEGIN UPDATE editor_page_entries SET expires_at=0 WHERE page_id=NEW.page_id; END`).run();
  await assert.rejects(exchangeCandidateEditorSession(db,pending.pageId,pending.code,'https://host.example.com',0));
  assert.equal((await db.prepare('SELECT used_at FROM editor_page_entries WHERE page_id=?').bind(pending.pageId).first<{used_at:number|null}>())!.used_at,null);
  await db.prepare('DROP TRIGGER expire_during_exchange').run();
  const token=await exchangeCandidateEditorSession(db,pending.pageId,pending.code,'https://host.example.com',0);
  assert.deepEqual(await authorizeCandidateEditorSession(db,token,'https://host.example.com',Number.MAX_SAFE_INTEGER),{tenantId:'a',roles:['Buyer','Seller']});
  const tokenHash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))).toString('hex');
  await db.prepare('UPDATE editor_page_tokens SET expires_at=? WHERE token_hash=?').bind(Date.now()+100,tokenHash).run();
  await new Promise(resolve=>setTimeout(resolve,200));
  await assert.rejects(authorizeCandidateEditorSession(db,token,'https://host.example.com',0));
  const delayed=await issueCandidateEditorSession(db,key,'https://host.example.com',['Buyer','Seller'],0,policy);
  await db.prepare('UPDATE editor_page_entries SET expires_at=? WHERE page_id=?').bind(Date.now()+100,delayed.pageId).run();
  const slowDb=new Proxy(db,{get(target,property){if(property==='batch')return async (statements:D1PreparedStatement[])=>{await new Promise(resolve=>setTimeout(resolve,200));return target.batch(statements);};const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;}});
  await assert.rejects(exchangeCandidateEditorSession(slowDb,delayed.pageId,delayed.code,'https://host.example.com',0));
  await db.prepare('UPDATE candidate_editor_budgets SET started_at=?, issue_count=issue_limit').bind(Date.now()-policy.windowMs+100).run();
  await issueCandidateEditorSession(slowDb,key,'https://host.example.com',['Buyer','Seller'],0,policy);
  await db.prepare(`CREATE TRIGGER expire_budget_during_issue AFTER INSERT ON candidate_editor_bindings BEGIN UPDATE candidate_editor_budgets SET started_at=0; END`).run();
  await assert.rejects(issueCandidateEditorSession(db,key,'https://host.example.com',['Buyer','Seller'],0,policy));
  assert.equal((await db.prepare('SELECT count(*) AS n FROM candidate_editor_bindings').first<{n:number}>())!.n,4);
 } finally {await mf.dispose();}
});

test('forward migration tombstones all historical candidate bindings without rewriting evidence',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response()}}',d1Databases:['DB']});
 try {
  const db=await mf.getD1Database('DB') as unknown as D1Database;
  const migrations=(await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort();
  const apply=async(n:string)=>{await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${n}`,'utf8')).map(s=>db.prepare(s)));};
  for(const n of migrations.filter(n=>n<'0042'))await apply(n);
  const hash=async(s:string)=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))).toString('hex');
  const key='k'.repeat(32),keyHash=await hash(key),origin='https://host.example.com',roles=JSON.stringify(['Buyer','Seller']);
  await db.prepare("INSERT INTO tenants VALUES ('a')").run();
  const activeHash=await hash('m'.repeat(32));
  await db.prepare("INSERT INTO api_keys(key_hash,tenant_id,revoked_at) VALUES (?,'a',1),(?,'a',NULL)").bind(keyHash,activeHash).run();
  await db.prepare("INSERT INTO editor_allowed_origins VALUES ('a','https://present.example.com')").run();
  const pages=['a','b','c'].map(c=>c.repeat(64)),codes=['d','e','f'].map(c=>c.repeat(64)),token='1'.repeat(64);
  for(let i=0;i<pages.length;i++){
   await db.prepare("INSERT INTO editor_page_entries(page_id,code_hash,tenant_id,parent_origin,expires_at,preset_roles_json) VALUES (?,?,'a',?,9999999999999,?)").bind(pages[i],await hash(codes[i]),i===1?origin:'https://present.example.com',roles).run();
   await db.prepare('INSERT INTO candidate_editor_bindings VALUES (?,?,?)').bind(pages[i],i===0?keyHash:activeHash,roles).run();
  }
  await db.prepare('INSERT INTO editor_page_tokens VALUES (?,?,?)').bind(await hash(token),pages[2],9999999999999).run();
  const before=(await db.prepare('SELECT * FROM editor_page_entries ORDER BY page_id').all()).results;
  for(const n of migrations.filter(n=>n>='0042'))await apply(n);
  await db.prepare('UPDATE api_keys SET revoked_at=NULL WHERE key_hash=?').bind(keyHash).run();
  await db.prepare("INSERT INTO editor_allowed_origins VALUES ('a',?)").bind(origin).run();
  for(let i=0;i<pages.length;i++)await assert.rejects(exchangeCandidateEditorSession(db,pages[i],codes[i],i===1?origin:'https://present.example.com',100));
  await assert.rejects(authorizeCandidateEditorSession(db,token,'https://present.example.com',100));
  assert.deepEqual((await db.prepare('SELECT page_id FROM candidate_editor_revocations ORDER BY page_id').all()).results,pages.map(page_id=>({page_id})));
  assert.deepEqual((await db.prepare('SELECT * FROM editor_page_entries ORDER BY page_id').all()).results,before);
 }finally{await mf.dispose();}
});
