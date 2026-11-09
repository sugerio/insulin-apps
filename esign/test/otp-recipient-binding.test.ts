// Deliberately omit 0027 in these isolated fixtures to exercise defense in depth under task tampering.
import {unstable_splitSqlQuery} from 'wrangler';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {issueRecipientCode,exchangeRecipientCode,verifyRecipientOtp,sendRecipientOtp} from '../src/page-authorization.ts';

test('OTP verification binds the sent recipient across address changes and D1 races',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB']});
 try{
  const db=await mf.getD1Database('DB');for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')&&!n.startsWith('0027_')).sort()){const sql=await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8');await db.batch(unstable_splitSqlQuery(sql).map(s=>db.prepare(s)));}
  const origin='https://host.example.com';await db.exec(`INSERT INTO tenants VALUES ('a');INSERT INTO templates VALUES ('ta','a','src','["ana"]',1,'[]');INSERT INTO envelopes VALUES ('ea','a','ta','IN_PROGRESS',1);INSERT INTO tasks VALUES ('t1','ea','ana','Ana','ana@example.com',1,'ACTIVE');INSERT INTO tenant_page_origins VALUES ('a','${origin}');`);
  const now=Date.now(),code=await issueRecipientCode(db,{tenantId:'a',envelopeId:'ea',taskId:'t1',origin,now}),token=await exchangeRecipientCode(db,code,origin,now+1),pepper='synthetic-otp-secret-with-at-least-32-bytes';let otp='';
  await sendRecipientOtp(db,token,origin,now+2,new TextEncoder().encode(pepper),async(to,value)=>{assert.equal(to,'ana@example.com');otp=value;});
  await db.prepare("UPDATE tasks SET recipient_email='lee@example.test' WHERE id='t1'").run();
  assert.equal(await verifyRecipientOtp(db,token,origin,Date.now(),new TextEncoder().encode(pepper),otp),false,'a code sent to the old address must not verify after the task recipient changes');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM recipient_otp_verifications').first())!.n,0);
  await db.prepare("UPDATE recipient_otp_challenges SET recipient_email='lee@example.test' WHERE task_id='t1'").run();
  assert.equal(await verifyRecipientOtp(db,token,origin,Date.now(),new TextEncoder().encode(pepper),otp),false,'rewriting the address snapshot cannot rebind the OTP MAC');
  await db.prepare("UPDATE recipient_otp_challenges SET recipient_email='ana@example.com' WHERE task_id='t1'").run();
  await db.prepare("UPDATE tasks SET recipient_email='ana@example.com' WHERE id='t1'").run();let changed=false;
  const raceDb=new Proxy(db,{get(target,key){if(key==='batch')return async(stmts:D1PreparedStatement[])=>{if(!changed){changed=true;await target.prepare("UPDATE tasks SET recipient_email='lee@example.test' WHERE id='t1'").run();}return target.batch(stmts);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  assert.equal(await verifyRecipientOtp(raceDb,token,origin,Date.now(),new TextEncoder().encode(pepper),otp),false,'a recipient change immediately before verification batch must reject');assert.equal(changed,true);assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM recipient_otp_verifications').first())!.n,0);
  await db.prepare("UPDATE tasks SET recipient_email='ana@example.com' WHERE id='t1'").run();
  const concurrent=await Promise.all([verifyRecipientOtp(db,token,origin,Date.now(),new TextEncoder().encode(pepper),otp),verifyRecipientOtp(db,token,origin,Date.now(),new TextEncoder().encode(pepper),otp)]);
  assert.deepEqual(concurrent,[true,true],'same-code concurrent verification is idempotent');assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM recipient_otp_verifications').first())!.n,1);
  await db.prepare("UPDATE tasks SET recipient_email='lee@example.test' WHERE id='t1'").run();assert.equal(await verifyRecipientOtp(db,token,origin,Date.now(),new TextEncoder().encode(pepper),otp),false,'a replay must not reuse verification against a changed recipient');
  assert.equal((await db.prepare("SELECT sends FROM recipient_otp_challenges WHERE task_id='t1'").first())!.sends,1,'recipient changes do not reset send budget');
 }finally{await mf.dispose();}
});

test('new local test messages remain byte-exact while historical unbound challenges fail closed',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB']});
 try{
  const db=await mf.getD1Database('DB');for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')&&!n.startsWith('0027_')).sort()){const sql=await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8');await db.batch(unstable_splitSqlQuery(sql).map(s=>db.prepare(s)));}
  const origin='https://host.example.com';await db.exec(`INSERT INTO tenants VALUES ('a');INSERT INTO templates VALUES ('ta','a','src','["ana"]',1,'[]');INSERT INTO envelopes VALUES ('ea','a','ta','IN_PROGRESS',1);INSERT INTO tasks VALUES ('t1','ea','ana','Ana','Ana@example.com',1,'ACTIVE');INSERT INTO tenant_page_origins VALUES ('a','${origin}');`);
  const now=Date.now(),code=await issueRecipientCode(db,{tenantId:'a',envelopeId:'ea',taskId:'t1',origin,now}),token=await exchangeRecipientCode(db,code,origin,now+1),pepper=new TextEncoder().encode('synthetic-otp-secret-with-at-least-32-bytes');let otp='';
  await sendRecipientOtp(db,token,origin,now+2,pepper,async(to,value)=>{assert.equal(to,'Ana@example.com');otp=value;});
  await db.prepare("UPDATE tasks SET recipient_email='ana@example.com' WHERE id='t1'").run();
  assert.equal(await verifyRecipientOtp(db,token,origin,now+3,pepper,otp),false,'local address binding is byte exact');
  await db.prepare("UPDATE tasks SET recipient_email='Ana@example.com' WHERE id='t1'").run();
  await db.prepare("UPDATE recipient_otp_challenges SET recipient_email=NULL WHERE task_id='t1'").run();
  assert.equal(await verifyRecipientOtp(db,token,origin,now+3,pepper,otp),false,'historical challenge with no recipient cannot be inferred');
  const old=await db.prepare("SELECT otp_hash,recipient_email FROM recipient_otp_challenges WHERE task_id='t1'").first();assert.equal(old!.recipient_email,null,'historical challenge remains unchanged');
 }finally{await mf.dispose();}
});

test('migration leaves historical challenges and verifications unbound and untouched',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB']});
 try{
  const db=await mf.getD1Database('DB');
  for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')&&n<'0025_otp_recipient_binding.sql').sort()){const sql=await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8');await db.batch(unstable_splitSqlQuery(sql).map(s=>db.prepare(s)));}
  for(const name of ['0029_recipient_session_revocations.sql','0030_recipient_code_revocations.sql']) {const sql=await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8');await db.batch(unstable_splitSqlQuery(sql).map(s=>db.prepare(s)));}
  const origin='https://host.example.com',now=Date.now(),pepper=new TextEncoder().encode('synthetic-otp-secret-with-at-least-32-bytes'),otp='123456';
  await db.exec(`INSERT INTO tenants VALUES ('a');INSERT INTO templates VALUES ('ta','a','src','["ana"]',1,'[]');INSERT INTO envelopes VALUES ('ea','a','ta','IN_PROGRESS',1);INSERT INTO tasks VALUES ('t1','ea','ana','Ana','ana@example.com',1,'ACTIVE');INSERT INTO tenant_page_origins VALUES ('a','${origin}');`);
  const code=await issueRecipientCode(db,{tenantId:'a',envelopeId:'ea',taskId:'t1',origin,now}),token=await exchangeRecipientCode(db,code,origin,now+1);
  const sessionHash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))).toString('hex');
  const key=await crypto.subtle.importKey('raw',pepper,{name:'HMAC',hash:'SHA-256'},false,['sign']);const legacyHash=Buffer.from(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(JSON.stringify(['t1',otp])))).toString('hex');
  await db.prepare('INSERT INTO recipient_otp_challenges(task_id,session_hash,otp_hash,expires_at,attempts,window_started_at,next_send_at,sends) VALUES (?,?,?,?,?,?,?,?)').bind('t1',sessionHash,legacyHash,now+300000,2,now,now+60000,2).run();
  await db.prepare('INSERT INTO recipient_otp_verifications(task_id,session_hash,verified_at) VALUES (?,?,?)').bind('t1',sessionHash,now).run();
  const beforeChallenge=await db.prepare('SELECT * FROM recipient_otp_challenges').first(),beforeVerification=await db.prepare('SELECT * FROM recipient_otp_verifications').first();
  const sql=await readFile(new URL('../migrations/0025_otp_recipient_binding.sql',import.meta.url),'utf8');await db.batch(unstable_splitSqlQuery(sql).map(s=>db.prepare(s)));
  assert.equal(await verifyRecipientOtp(db,token,origin,now+2,pepper,otp),false);
  const challenge=await db.prepare('SELECT * FROM recipient_otp_challenges').first(),verification=await db.prepare('SELECT * FROM recipient_otp_verifications').first();
  assert.deepEqual(challenge,{...beforeChallenge,recipient_email:null});assert.deepEqual(verification,{...beforeVerification,recipient_email:null});
 }finally{await mf.dispose();}
});

test('an emailed code stays valid for 10 minutes and no longer',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB']});
 try{
  const db=await mf.getD1Database('DB');for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort()){const sql=await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8');await db.batch(unstable_splitSqlQuery(sql).map(s=>db.prepare(s)));}
  const origin='https://host.example.com';await db.exec(`INSERT INTO tenants VALUES ('a');INSERT INTO templates VALUES ('ta','a','src','["ana"]',1,'[]');INSERT INTO envelopes VALUES ('ea','a','ta','IN_PROGRESS',1);INSERT INTO tasks VALUES ('t1','ea','ana','Ana','ana@example.com',1,'ACTIVE');INSERT INTO tenant_page_origins VALUES ('a','${origin}');`);
  const pepper=new TextEncoder().encode('synthetic-otp-secret-with-at-least-32-bytes'),minute=60_000;
  const codeAt=async(now:number)=>{const code=await issueRecipientCode(db,{tenantId:'a',envelopeId:'ea',taskId:'t1',origin,now});const token=await exchangeRecipientCode(db,code,origin,now);let otp='';await sendRecipientOtp(db,token,origin,now,pepper,async(_to,value)=>{otp=value;});return {token,otp};};
  const late=Date.now(),first=await codeAt(late);
  assert.equal(await verifyRecipientOtp(db,first.token,origin,late+9*minute,pepper,first.otp),true,'nine minutes later it still verifies');
  await db.exec('DELETE FROM recipient_otp_verifications;DELETE FROM recipient_otp_challenges;');
  const second=await codeAt(late+20*minute);
  assert.equal(await verifyRecipientOtp(db,second.token,origin,late+20*minute+11*minute,pepper,second.otp),false,'eleven minutes later it has expired');
 }finally{await mf.dispose();}
});
