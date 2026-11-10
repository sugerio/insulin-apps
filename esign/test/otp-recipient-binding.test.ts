// Deliberately drop the task recipient trigger in these isolated fixtures to exercise defense in depth under task tampering.
import {MIGRATIONS_DIR,splitSql as unstable_splitSqlQuery} from './helpers/platform.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {issueRecipientCode,exchangeRecipientCode,verifyRecipientOtp,sendRecipientOtp} from '../src/app/server/esign/otp.ts';

/** Recipient sessions marked as having entered the emailed code. */
const verifiedSessions=async(db:D1Database)=>(await db.prepare('SELECT COUNT(*) AS n FROM access_sessions WHERE otp_verified_at IS NOT NULL').first<{n:number}>())!.n;

test('OTP verification binds the sent recipient across address changes and D1 races',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB']});
 try{
  const db=await mf.getD1Database('DB');for(const name of (await readdir(MIGRATIONS_DIR)).filter(n=>n.endsWith('.sql')).sort()){const sql=await readFile(new URL(name,MIGRATIONS_DIR),'utf8');await db.batch(unstable_splitSqlQuery(sql).map(s=>db.prepare(s)));}await db.exec('DROP TRIGGER immutable_task_recipient_email');
  const origin='https://host.example.com';await db.exec(`INSERT INTO tenants (id) VALUES ('a');INSERT INTO templates (id,tenant_id,object_key,roles_json,created_at,fields_json) VALUES ('ta','a','src','["ana"]',1,'[]');INSERT INTO envelopes (id,tenant_id,template_id,status,created_at,request_sha256) VALUES ('ea','a','ta','IN_PROGRESS',1,'hash');INSERT INTO tasks (id,envelope_id,role,recipient_name,recipient_email,routing_order,status) VALUES ('t1','ea','ana','Ana','ana@example.com',1,'ACTIVE');`);
  const now=Date.now(),code=await issueRecipientCode(db,{tenantId:'a',envelopeId:'ea',taskId:'t1',origin,now}),token=await exchangeRecipientCode(db,code,origin,now+1),pepper='synthetic-otp-secret-with-at-least-32-bytes';let otp='';
  await sendRecipientOtp(db,token,origin,now+2,new TextEncoder().encode(pepper),async(to,value)=>{assert.equal(to,'ana@example.com');otp=value;});
  await db.prepare("UPDATE tasks SET recipient_email='lee@example.test' WHERE id='t1'").run();
  assert.equal(await verifyRecipientOtp(db,token,origin,Date.now(),new TextEncoder().encode(pepper),otp),false,'a code sent to the old address must not verify after the task recipient changes');
  assert.equal(await verifiedSessions(db),0);
  await db.prepare("UPDATE tasks SET recipient_email='ana@example.com' WHERE id='t1'").run();let changed=false;
  const raceDb=new Proxy(db,{get(target,key){if(key==='batch')return async(stmts:D1PreparedStatement[])=>{if(!changed){changed=true;await target.prepare("UPDATE tasks SET recipient_email='lee@example.test' WHERE id='t1'").run();}return target.batch(stmts);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  assert.equal(await verifyRecipientOtp(raceDb,token,origin,Date.now(),new TextEncoder().encode(pepper),otp),false,'a recipient change immediately before verification batch must reject');assert.equal(changed,true);assert.equal(await verifiedSessions(db),0);
  await db.prepare("UPDATE tasks SET recipient_email='ana@example.com' WHERE id='t1'").run();
  const concurrent=await Promise.all([verifyRecipientOtp(db,token,origin,Date.now(),new TextEncoder().encode(pepper),otp),verifyRecipientOtp(db,token,origin,Date.now(),new TextEncoder().encode(pepper),otp)]);
  assert.deepEqual(concurrent,[true,true],'same-code concurrent verification is idempotent');assert.equal(await verifiedSessions(db),1);
  await db.prepare("UPDATE tasks SET recipient_email='lee@example.test' WHERE id='t1'").run();assert.equal(await verifyRecipientOtp(db,token,origin,Date.now(),new TextEncoder().encode(pepper),otp),false,'a replay must not reuse verification against a changed recipient');
  assert.equal((await db.prepare("SELECT sends FROM otp_challenges WHERE task_id='t1'").first())!.sends,1,'recipient changes do not reset send budget');
 }finally{await mf.dispose();}
});

test('the code is bound to the exact bytes of the task email',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB']});
 try{
  const db=await mf.getD1Database('DB');for(const name of (await readdir(MIGRATIONS_DIR)).filter(n=>n.endsWith('.sql')).sort()){const sql=await readFile(new URL(name,MIGRATIONS_DIR),'utf8');await db.batch(unstable_splitSqlQuery(sql).map(s=>db.prepare(s)));}await db.exec('DROP TRIGGER immutable_task_recipient_email');
  const origin='https://host.example.com';await db.exec(`INSERT INTO tenants (id) VALUES ('a');INSERT INTO templates (id,tenant_id,object_key,roles_json,created_at,fields_json) VALUES ('ta','a','src','["ana"]',1,'[]');INSERT INTO envelopes (id,tenant_id,template_id,status,created_at,request_sha256) VALUES ('ea','a','ta','IN_PROGRESS',1,'hash');INSERT INTO tasks (id,envelope_id,role,recipient_name,recipient_email,routing_order,status) VALUES ('t1','ea','ana','Ana','Ana@example.com',1,'ACTIVE');`);
  const now=Date.now(),code=await issueRecipientCode(db,{tenantId:'a',envelopeId:'ea',taskId:'t1',origin,now}),token=await exchangeRecipientCode(db,code,origin,now+1),pepper=new TextEncoder().encode('synthetic-otp-secret-with-at-least-32-bytes');let otp='';
  await sendRecipientOtp(db,token,origin,now+2,pepper,async(to,value)=>{assert.equal(to,'Ana@example.com');otp=value;});
  await db.prepare("UPDATE tasks SET recipient_email='ana@example.com' WHERE id='t1'").run();
  assert.equal(await verifyRecipientOtp(db,token,origin,now+3,pepper,otp),false,'local address binding is byte exact');
  await db.prepare("UPDATE tasks SET recipient_email='Ana@example.com' WHERE id='t1'").run();
  assert.equal(await verifyRecipientOtp(db,token,origin,now+4,pepper,otp),true,'the exact address verifies');
 }finally{await mf.dispose();}
});

test('an emailed code stays valid for 10 minutes and no longer',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB']});
 try{
  const db=await mf.getD1Database('DB');for(const name of (await readdir(MIGRATIONS_DIR)).filter(n=>n.endsWith('.sql')).sort()){const sql=await readFile(new URL(name,MIGRATIONS_DIR),'utf8');await db.batch(unstable_splitSqlQuery(sql).map(s=>db.prepare(s)));}
  const origin='https://host.example.com';await db.exec(`INSERT INTO tenants (id) VALUES ('a');INSERT INTO templates (id,tenant_id,object_key,roles_json,created_at,fields_json) VALUES ('ta','a','src','["ana"]',1,'[]');INSERT INTO envelopes (id,tenant_id,template_id,status,created_at,request_sha256) VALUES ('ea','a','ta','IN_PROGRESS',1,'hash');INSERT INTO tasks (id,envelope_id,role,recipient_name,recipient_email,routing_order,status) VALUES ('t1','ea','ana','Ana','ana@example.com',1,'ACTIVE');`);
  const pepper=new TextEncoder().encode('synthetic-otp-secret-with-at-least-32-bytes'),minute=60_000;
  const codeAt=async(now:number)=>{const code=await issueRecipientCode(db,{tenantId:'a',envelopeId:'ea',taskId:'t1',origin,now});const token=await exchangeRecipientCode(db,code,origin,now);let otp='';await sendRecipientOtp(db,token,origin,now,pepper,async(_to,value)=>{otp=value;});return {token,otp};};
  const late=Date.now(),first=await codeAt(late);
  assert.equal(await verifyRecipientOtp(db,first.token,origin,late+9*minute,pepper,first.otp),true,'nine minutes later it still verifies');
  await db.exec("UPDATE access_sessions SET otp_verified_at=NULL;DELETE FROM otp_challenges;");
  const second=await codeAt(late+20*minute);
  assert.equal(await verifyRecipientOtp(db,second.token,origin,late+20*minute+11*minute,pepper,second.otp),false,'eleven minutes later it has expired');
 }finally{await mf.dispose();}
});
