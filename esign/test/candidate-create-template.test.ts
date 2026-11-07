import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {unstable_splitSqlQuery} from 'wrangler';
import {Miniflare} from 'miniflare';
import {PDFDocument} from 'pdf-lib';
import {createCandidateTemplate} from '../src/candidate-create-template.ts';
import {createCandidateEnvelope} from '../src/candidate-provision-envelope.ts';

test('candidate template creation validates and binds source and metadata under authorization',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response()}}',d1Databases:['DB'],r2Buckets:['ARTIFACTS']});
 try {
  const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('ARTIFACTS');
  for(const n of (await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort())await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${n}`,'utf8')).map(s=>db.prepare(s)));
  const token='a'.repeat(32),hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))).toString('hex');
  await db.prepare('INSERT INTO tenants VALUES (?)').bind('a').run();await db.prepare('INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,?)').bind(hash,'a').run();
  const pdf=await PDFDocument.create();pdf.addPage([600,800]);const bytes=await pdf.save();
  const roles=['one','two'],fields=roles.map((role,i)=>({id:role,type:'Signature',role,page:1,required:true,rect:{x:.1,y:.1+i*.3,width:.5,height:.1}}));
  const env={DB:db as unknown as D1Database,ARTIFACTS:bucket as unknown as R2Bucket,CANDIDATE_TEMPLATE_WINDOW_MS:'60000',CANDIDATE_TEMPLATE_TENANT_LIMIT:'20',CANDIDATE_TEMPLATE_DATABASE_LIMIT:'20',CANDIDATE_TEMPLATE_RETAINED_LIMIT:'20',CANDIDATE_TEMPLATE_TENANT_RETAINED_LIMIT:'20'};
  const run=(key:string,source=bytes,r:unknown=roles,f:unknown=fields)=>createCandidateTemplate(env,token,key,source,r,f);
  await assert.rejects(createCandidateTemplate({...env,CANDIDATE_TEMPLATE_RETAINED_LIMIT:undefined},token,'missing',bytes,roles,fields));
  const [a,b]=await Promise.all([run('same'),run('same')]);assert.deepEqual(a,b);
  const provision={...env,ISOLATED_OTP_RECIPIENTS:JSON.stringify(['ana@example.com','marcus@example.com']),CANDIDATE_PROVISION_WINDOW_MS:'60000',CANDIDATE_PROVISION_TENANT_LIMIT:'10',CANDIDATE_PROVISION_DATABASE_LIMIT:'10',CANDIDATE_PROVISION_RETAINED_LIMIT:'10'};
  const envelope={templateId:a.id,recipients:[{role:'one',name:'Ana',email:'ana@example.com'},{role:'two',name:'Marcus',email:'marcus@example.com'}]};
  await createCandidateEnvelope(provision,token,'envelope',envelope);
  await db.prepare('UPDATE templates SET roles_json=? WHERE id=?').bind(JSON.stringify(['two','one']),a.id).run();
  await assert.rejects(createCandidateEnvelope(provision,token,'changed',envelope));
  await db.prepare('UPDATE templates SET roles_json=? WHERE id=?').bind(JSON.stringify(roles),a.id).run();
  let lost=false;const lostDb=new Proxy(db,{get(target,k){if(k==='batch')return async(s:any[])=>{const result=await target.batch(s);if(!lost){lost=true;throw new Error('lost');}return result;};const v=Reflect.get(target,k,target);return typeof v==='function'?v.bind(target):v;}});
  const committed=await createCandidateTemplate({...env,DB:lostDb as unknown as D1Database},token,'lost',bytes,roles,fields);assert.deepEqual(await run('lost'),committed);
  let lostPut=false;const lostBucket=new Proxy(bucket,{get(target,k){if(k==='put')return async(...args:Parameters<typeof target.put>)=>{const result=await target.put(...args);if(!lostPut){lostPut=true;throw new Error('lost');}return result;};const v=Reflect.get(target,k,target);return typeof v==='function'?v.bind(target):v;}});
  await assert.rejects(createCandidateTemplate({...env,ARTIFACTS:lostBucket as unknown as R2Bucket},token,'lost-put',bytes,roles,fields));await assert.rejects(run('lost-put',bytes,roles,[]));await run('lost-put');
  assert.equal((await db.prepare("SELECT count(*) n FROM candidate_template_reservations WHERE idempotency_key='lost-put'").first<{n:number}>())!.n,1);
  await assert.rejects(run('same',bytes,roles,[]));
  await assert.rejects(run('bad',bytes,['one'],fields));
  await assert.rejects(run('large',new Uint8Array(5*1024*1024+1)));
  await assert.rejects(createCandidateTemplate(env,'b'.repeat(32),'x',bytes,roles,fields));
  await db.exec(`CREATE TRIGGER template_race AFTER INSERT ON templates BEGIN UPDATE api_keys SET revoked_at=1 WHERE key_hash='${hash}'; END`);
  await assert.rejects(run('race'));await db.exec('DROP TRIGGER template_race');
  assert.equal((await db.prepare("SELECT count(*) n FROM candidate_created_templates WHERE idempotency_key='race'").first<{n:number}>())!.n,0);
  const row=await db.prepare('SELECT object_key FROM templates WHERE id=?').bind(a.id).first<{object_key:string}>();await bucket.put(row!.object_key,new Uint8Array([1]));await assert.rejects(run('same'));
  await db.prepare('UPDATE api_keys SET revoked_at=1 WHERE key_hash=?').bind(hash).run();await assert.rejects(run('same'));
 } finally {await mf.dispose();}
});

test('template reservations enforce shared and tenant issuance and retained attempt caps before writes',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response()}}',d1Databases:['DB'],r2Buckets:['ARTIFACTS']});
 try{
  const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('ARTIFACTS');
  for(const n of (await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort())await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${n}`,'utf8')).map(s=>db.prepare(s)));
  const tokens=['a'.repeat(32),'b'.repeat(32),'c'.repeat(32)];
  for(let i=0;i<3;i++){await db.prepare('INSERT INTO tenants VALUES (?)').bind(`t${i}`).run();const hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(tokens[i]))).toString('hex');await db.prepare('INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,?)').bind(hash,`t${i}`).run();}
  const pdf=await PDFDocument.create();pdf.addPage([600,800]);const bytes=await pdf.save(),roles=['one','two'],fields=roles.map((role,i)=>({id:role,type:'Signature',role,page:1,required:true,rect:{x:.1,y:.1+i*.3,width:.5,height:.1}}));
  const env={DB:db as unknown as D1Database,ARTIFACTS:bucket as unknown as R2Bucket,CANDIDATE_TEMPLATE_WINDOW_MS:'60000',CANDIDATE_TEMPLATE_TENANT_LIMIT:'1',CANDIDATE_TEMPLATE_DATABASE_LIMIT:'2',CANDIDATE_TEMPLATE_RETAINED_LIMIT:'3',CANDIDATE_TEMPLATE_TENANT_RETAINED_LIMIT:'1'};
  const run=(tenant:number,key:string)=>createCandidateTemplate(env,tokens[tenant],key,bytes,roles,fields);
  const results=await Promise.allSettled([run(0,'a'),run(0,'b')]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const winner=results[0].status==='fulfilled'?'a':'b';await run(0,winner);await assert.rejects(run(0,'c'));
  await run(1,'d');await assert.rejects(run(1,'e'));await assert.rejects(run(2,'shared-full'));
  assert.equal((await db.prepare('SELECT count(*) n FROM candidate_template_reservations').first<{n:number}>())!.n,2);
  assert.equal((await bucket.list()).objects.length,2);
  await db.prepare('UPDATE candidate_template_budgets SET started_at=0').run();
  await assert.rejects(run(0,'tenant-retained-full'));
  await run(2,'after-window');await assert.rejects(run(0,'retained-full'));assert.equal((await bucket.list()).objects.length,3);
  await assert.rejects(createCandidateTemplate({...env,CANDIDATE_TEMPLATE_DATABASE_LIMIT:'0'},tokens[0],winner,bytes,roles,fields));
 }finally{await mf.dispose();}
});

test('editor save binds one session to one reservation and rejects cross-session reuse',async()=>{
 const {issueCandidateEditorSession,exchangeCandidateEditorSession}=await import('../src/candidate-editor-session.ts');
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response()}}',d1Databases:['DB'],r2Buckets:['ARTIFACTS']});
 try{
  const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('ARTIFACTS');
  for(const n of (await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort())await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${n}`,'utf8')).map(s=>db.prepare(s)));
  const key='a'.repeat(32),keyHash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key))).toString('hex'),origin='https://editor.example.test',roles=['one','two'];
  await db.prepare('INSERT INTO tenants VALUES (?)').bind('a').run();await db.prepare('INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,?)').bind(keyHash,'a').run();await db.prepare('INSERT INTO editor_allowed_origins VALUES (?,?)').bind('a',origin).run();
  const policy={windowMs:60000,tenantIssuance:20,databaseIssuance:20,tenantOutstanding:20,databaseOutstanding:20,tenantRetained:20,databaseRetained:20};
  const session=async()=>{const p=await issueCandidateEditorSession(db as unknown as D1Database,key,origin,roles,0,policy);return {kind:'editor' as const,token:await exchangeCandidateEditorSession(db as unknown as D1Database,p.pageId,p.code,origin,0),origin};};
  const one=await session(),two=await session();const pdf=await PDFDocument.create();pdf.addPage([600,800]);const bytes=await pdf.save(),fields=roles.map((role,i)=>({id:role,type:'Signature',role,page:1,required:true,rect:{x:.1,y:.1+i*.3,width:.5,height:.1}}));
  const env={DB:db as unknown as D1Database,ARTIFACTS:bucket as unknown as R2Bucket,CANDIDATE_TEMPLATE_WINDOW_MS:'60000',CANDIDATE_TEMPLATE_TENANT_LIMIT:'20',CANDIDATE_TEMPLATE_DATABASE_LIMIT:'20',CANDIDATE_TEMPLATE_RETAINED_LIMIT:'20',CANDIDATE_TEMPLATE_TENANT_RETAINED_LIMIT:'20'};
  const run=(credential:typeof one,k:string,f:unknown=fields)=>createCandidateTemplate(env,credential,k,bytes,roles,f);
  const legacy=await session(), legacyHash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(legacy.token))).toString('hex');
  const legacyPage=(await db.prepare('SELECT page_id FROM editor_page_tokens WHERE token_hash=?').bind(legacyHash).first<{page_id:string}>())!.page_id;
  const legacyRoles=JSON.stringify(['First signer','two']);
  await db.prepare('UPDATE editor_page_entries SET preset_roles_json=? WHERE page_id=?').bind(legacyRoles,legacyPage).run();await db.prepare('UPDATE candidate_editor_bindings SET roles_json=? WHERE page_id=?').bind(legacyRoles,legacyPage).run();
  await assert.rejects(createCandidateTemplate(env,legacy,'legacy',bytes,JSON.parse(legacyRoles),fields));await assert.rejects(run(legacy,'legacy'));
  assert.equal((await db.prepare('SELECT roles_json FROM candidate_editor_bindings WHERE page_id=?').bind(legacyPage).first<{roles_json:string}>())!.roles_json,legacyRoles);
  const [a,b]=await Promise.all([run(one,'same'),run(one,'same')]);assert.deepEqual(a,b);
  await assert.rejects(run(one,'different'));await assert.rejects(run(two,'same'));await assert.rejects(run(one,'same',[]));
  await assert.rejects(createCandidateTemplate(env,key,'same',bytes,roles,fields));
  const three=await session();let lost=false;const lostDb=new Proxy(db,{get(target,k){if(k==='batch')return async(s:any[])=>{const result=await target.batch(s);if(!lost){lost=true;throw Error('lost');}return result;};const v=Reflect.get(target,k,target);return typeof v==='function'?v.bind(target):v;}});
  const afterLost=await createCandidateTemplate({...env,DB:lostDb as unknown as D1Database},three,'lost-editor',bytes,roles,fields);assert.deepEqual(await run(three,'lost-editor'),afterLost);
  const commitLost=await session();let batches=0;const commitLostDb=new Proxy(db,{get(target,k){if(k==='batch')return async(s:any[])=>{const result=await target.batch(s);if(++batches===2)throw Error('lost commit');return result;};const v=Reflect.get(target,k,target);return typeof v==='function'?v.bind(target):v;}});
  const committed=await createCandidateTemplate({...env,DB:commitLostDb as unknown as D1Database},commitLost,'lost-commit',bytes,roles,fields);assert.deepEqual(await run(commitLost,'lost-commit'),committed);
  const expired=await session();await db.exec(`CREATE TRIGGER editor_expire_reservation AFTER INSERT ON candidate_template_reservations WHEN NEW.idempotency_key='expire-editor' BEGIN UPDATE editor_page_tokens SET expires_at=0 WHERE token_hash='${Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(expired.token))).toString('hex')}'; END`);
  await assert.rejects(run(expired,'expire-editor'));await db.exec('DROP TRIGGER editor_expire_reservation');assert.equal((await db.prepare("SELECT count(*) n FROM candidate_template_reservations WHERE idempotency_key='expire-editor'").first<{n:number}>())!.n,0);
  const four=await session();await db.exec(`CREATE TRIGGER editor_save_race AFTER INSERT ON templates WHEN NEW.id<>'${a.id}' BEGIN UPDATE api_keys SET revoked_at=1 WHERE key_hash='${keyHash}'; END`);
  await assert.rejects(run(four,'race-editor'));await db.exec('DROP TRIGGER editor_save_race');assert.equal((await db.prepare("SELECT count(*) n FROM candidate_created_templates WHERE idempotency_key='race-editor'").first<{n:number}>())!.n,0);
  await db.prepare('UPDATE api_keys SET revoked_at=1 WHERE key_hash=?').bind(keyHash).run();await assert.rejects(run(one,'same'));
 }finally{await mf.dispose();}
});
