// The first isolated fixture omits 0027 to exercise the OTP pre-send tampering check.
import {unstable_splitSqlQuery} from 'wrangler';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {issueRecipientCode,exchangeRecipientCode,verifyRecipientOtp} from '../src/page-authorization.ts';
const module=await import('../src/isolated-cloudflare-otp.ts').catch(()=>({}));

test('isolated email uses exact runtime allowlist, trusted session and atomic persistent send budgets',async()=>{
 assert.equal(typeof module.sendIsolatedCloudflareOtp,'function','isolated OTP integration missing');
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB']});
 try{
  const db=await mf.getD1Database('DB');for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')&&!n.startsWith('0027_')).sort()){const sql=await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8');await db.batch(unstable_splitSqlQuery(sql).map(s=>db.prepare(s)));}
  await db.exec('DROP TRIGGER isolated_otp_quota_no_update; DROP TRIGGER isolated_otp_quota_no_delete'); // Separate scenarios reuse this disposable fixture.
  const origin='https://host.example.com';await db.exec(`INSERT INTO tenants VALUES ('a');INSERT INTO tenants VALUES ('b');INSERT INTO tenants VALUES ('c');INSERT INTO templates VALUES ('ta','a','src-a','["ana"]',1,'[]');INSERT INTO templates VALUES ('tb','b','src-b','["ana"]',1,'[]');INSERT INTO envelopes VALUES ('ea','a','ta','IN_PROGRESS',1);INSERT INTO envelopes VALUES ('eb','b','tb','IN_PROGRESS',1);INSERT INTO templates VALUES ('tc','c','src-c','["ana"]',1,'[]');INSERT INTO envelopes VALUES ('ea2','a','ta','IN_PROGRESS',1);INSERT INTO envelopes VALUES ('ec','c','tc','IN_PROGRESS',1);INSERT INTO tasks VALUES ('t1','ea','ana','Ana','ana@example.com',1,'ACTIVE');INSERT INTO tasks VALUES ('t2','eb','ana','Lee','lee@example.test',1,'ACTIVE');INSERT INTO tasks VALUES ('t3','ea2','ana','Ana','ana@example.com',1,'ACTIVE');INSERT INTO tasks VALUES ('t4','ec','ana','Lee','lee@example.test',1,'ACTIVE');INSERT INTO tenant_page_origins VALUES ('a','${origin}');INSERT INTO tenant_page_origins VALUES ('b','${origin}');INSERT INTO tenant_page_origins VALUES ('c','${origin}');`);
  const now=Date.now(),makeSession=async(tenantId:string,envelopeId:string,taskId:string)=>{const code=await issueRecipientCode(db,{tenantId,envelopeId,taskId,origin,now});return exchangeRecipientCode(db,code,origin,now+1);};
  const token1=await makeSession('a','ea','t1'),token2=await makeSession('b','eb','t2'),token3=await makeSession('a','ea2','t3'),token4=await makeSession('c','ec','t4'),pepper='synthetic-otp-secret-with-at-least-32-bytes';
  let sends=0,otp='';const email={send:async(message:{from:string;to:string;text:string})=>{sends++;assert.equal(message.from,'sign@example.com');assert.ok(['ana@example.com','lee@example.test'].includes(message.to));const found=message.text.match(/\b\d{6}\b/);assert.ok(found);otp=found![0];}};
  const env={DB:db,SEND_EMAIL:email,ISOLATED_OTP_ENABLED:'true',ISOLATED_OTP_FROM:'sign@example.com',ISOLATED_OTP_RECIPIENTS:'["ana@example.com","lee@example.test"]',ISOLATED_OTP_PEPPER:pepper,ISOLATED_OTP_WINDOW_MS:'900000',ISOLATED_OTP_TENANT_LIMIT:'1',ISOLATED_OTP_ACCOUNT_LIMIT:'2'};
  for(const invalid of [{...env,ISOLATED_OTP_ENABLED:'false'},{...env,ISOLATED_OTP_FROM:'sénd@example.com'},{...env,ISOLATED_OTP_RECIPIENTS:''},{...env,ISOLATED_OTP_RECIPIENTS:'["ana@example.com"]'},{...env,ISOLATED_OTP_TENANT_LIMIT:'0'},{...env,ISOLATED_OTP_PEPPER:''}])await assert.rejects(()=>module.sendIsolatedCloudflareOtp!(invalid,token1,origin));
  await assert.rejects(()=>module.sendIsolatedCloudflareOtp!(env,token1,'https://other.example.com'));assert.equal(sends,0);
  const token1Hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token1))),x=>x.toString(16).padStart(2,'0')).join('');const expiry=(await db.prepare('SELECT expires_at FROM recipient_page_sessions WHERE token_hash=?').bind(token1Hash).first<{expires_at:number}>())!.expires_at;
  await db.prepare('UPDATE recipient_page_sessions SET expires_at=? WHERE token_hash=?').bind(Date.now()+3600000,token1Hash).run();await assert.rejects(()=>module.sendIsolatedCloudflareOtp!(env,token1,origin),'overlong session must fail closed');await db.prepare('UPDATE recipient_page_sessions SET expires_at=? WHERE token_hash=?').bind(expiry,token1Hash).run();
  await db.prepare('INSERT INTO api_keys(key_hash,tenant_id,revoked_at) VALUES (?,?,?)').bind(token1Hash,'b',1).run();await assert.rejects(()=>module.sendIsolatedCloudflareOtp!(env,token1,origin),'a colliding revoked cross-tenant management key cannot authorize OTP');await db.prepare('DELETE FROM api_keys WHERE key_hash=?').bind(token1Hash).run();
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM isolated_otp_send_budgets').first())!.n,0);assert.equal(sends,0);
  let recipientChanged=false;const changingDb=new Proxy(db,{get(target,key){if(key==='batch')return async (statements:D1PreparedStatement[])=>{const out=await target.batch(statements);await target.prepare("UPDATE tasks SET recipient_email='lee@example.test' WHERE id='t1'").run();recipientChanged=true;return out;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  await assert.rejects(()=>module.sendIsolatedCloudflareOtp!({...env,DB:changingDb},token1,origin),'changed recipient cannot receive a previously reserved OTP');assert.equal(recipientChanged,true);assert.equal(sends,0);assert.equal((await db.prepare("SELECT send_count FROM isolated_otp_send_budgets WHERE scope_kind='account'").first())!.send_count,1,'ambiguous failures consume the budget');
  await db.exec("UPDATE tasks SET recipient_email='ana@example.com' WHERE id='t1';DELETE FROM recipient_otp_challenges;DELETE FROM isolated_otp_quota_reservations;DELETE FROM isolated_otp_send_budgets");
  let challengeChanged=false;const challengeDb=new Proxy(db,{get(target,key){if(key==='batch')return async (statements:D1PreparedStatement[])=>{const out=await target.batch(statements);await target.prepare("UPDATE recipient_otp_challenges SET otp_hash=? WHERE task_id='t1'").bind('0'.repeat(64)).run();challengeChanged=true;return out;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  await assert.rejects(()=>module.sendIsolatedCloudflareOtp!({...env,DB:challengeDb},token1,origin),'a replaced OTP challenge must not be sent');assert.equal(challengeChanged,true);assert.equal(sends,0);await db.exec('DELETE FROM recipient_otp_challenges;DELETE FROM isolated_otp_quota_reservations;DELETE FROM isolated_otp_send_budgets');
  let attemptsExhausted=false;const exhaustedDb=new Proxy(db,{get(target,key){if(key==='batch')return async (statements:D1PreparedStatement[])=>{const out=await target.batch(statements);await target.prepare("UPDATE recipient_otp_challenges SET attempts=5 WHERE task_id='t1'").run();attemptsExhausted=true;return out;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  await assert.rejects(()=>module.sendIsolatedCloudflareOtp!({...env,DB:exhaustedDb},token1,origin),'an exhausted challenge must not be sent');assert.equal(attemptsExhausted,true);assert.equal(sends,0);assert.equal((await db.prepare("SELECT send_count FROM isolated_otp_send_budgets WHERE scope_kind='account'").first())!.send_count,1,'a rejected dispatch still consumes the reservation');await db.exec('DELETE FROM recipient_otp_challenges;DELETE FROM isolated_otp_quota_reservations;DELETE FROM isolated_otp_send_budgets');
  const concurrent=await Promise.allSettled([module.sendIsolatedCloudflareOtp!(env,token1,origin),module.sendIsolatedCloudflareOtp!(env,token1,origin)]);
  assert.equal(concurrent.filter(x=>x.status==='fulfilled').length,1);assert.equal(sends,1);assert.equal((await db.prepare('SELECT sends FROM recipient_otp_challenges WHERE task_id=?').bind('t1').first())!.sends,1);
  assert.equal(await verifyRecipientOtp(db,token1,origin,Date.now(),new TextEncoder().encode(pepper),otp),true);
  await assert.rejects(()=>module.sendIsolatedCloudflareOtp!(env,token1,origin));assert.equal(sends,1);
  await assert.rejects(()=>module.sendIsolatedCloudflareOtp!(env,token3,origin),'separate task in same tenant is rate-limited');assert.equal((await db.prepare("SELECT send_count FROM isolated_otp_send_budgets WHERE scope_kind='account'").first())!.send_count,1,'failed tenant reservation rolls back the account reservation');
  await assert.rejects(()=>module.sendIsolatedCloudflareOtp!({...env,ISOLATED_OTP_TENANT_LIMIT:'2'},token3,origin),'a mid-window limit increase must not bypass the persisted budget');assert.equal(sends,1);
  await assert.rejects(()=>module.sendIsolatedCloudflareOtp!({...env,ISOLATED_OTP_WINDOW_MS:'60000'},token2,origin),'window changes during an active budget must not widen it');assert.equal((await db.prepare("SELECT send_count FROM isolated_otp_send_budgets WHERE scope_kind='account'").first())!.send_count,1);
  await assert.rejects(()=>module.sendIsolatedCloudflareOtp!({...env,ISOLATED_OTP_ACCOUNT_LIMIT:'3'},token2,origin),'account limit changes during an active budget must not widen it');assert.equal((await db.prepare("SELECT send_count FROM isolated_otp_send_budgets WHERE scope_kind='account'").first())!.send_count,1);
  await module.sendIsolatedCloudflareOtp!(env,token2,origin);assert.equal(sends,2);
  await assert.rejects(()=>module.sendIsolatedCloudflareOtp!(env,token4,origin),'different tenant cannot exceed the shared account budget');assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM isolated_otp_send_budgets WHERE scope_kind='tenant' AND scope_id='c'").first())!.n,0);
  assert.deepEqual((await db.prepare('SELECT scope_kind,scope_id,send_count FROM isolated_otp_send_budgets ORDER BY scope_kind,scope_id').all()).results,[{scope_kind:'account',scope_id:'',send_count:2},{scope_kind:'tenant',scope_id:'a',send_count:1},{scope_kind:'tenant',scope_id:'b',send_count:1}]);
  await db.exec("UPDATE recipient_otp_challenges SET next_send_at=0,consumed_by=NULL WHERE task_id='t1'");
  await assert.rejects(()=>module.sendIsolatedCloudflareOtp!(env,token1,origin));assert.equal(sends,2,'tenant and account budgets persist even after task cooldown');
  const tokenHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token2))),x=>x.toString(16).padStart(2,'0')).join('');await db.prepare('UPDATE recipient_page_sessions SET expires_at=0 WHERE token_hash=?').bind(tokenHash).run();await assert.rejects(()=>module.sendIsolatedCloudflareOtp!(env,token2,origin));assert.equal(sends,2);
  await db.exec('UPDATE isolated_otp_send_budgets SET window_started_at=window_started_at-900001');let failedCalls=0;
  const failing={...env,SEND_EMAIL:{send:async()=>{failedCalls++;throw new Error('synthetic provider detail');}}};
  await assert.rejects(()=>module.sendIsolatedCloudflareOtp!(failing,token3,origin),{message:'Isolated OTP unavailable'});assert.equal(failedCalls,1);assert.equal((await db.prepare("SELECT sends FROM recipient_otp_challenges WHERE task_id='t3'").first())!.sends,1);assert.equal((await db.prepare("SELECT send_count FROM isolated_otp_send_budgets WHERE scope_kind='account'").first())!.send_count,1);assert.equal((await db.prepare("SELECT send_count FROM isolated_otp_send_budgets WHERE scope_kind='tenant' AND scope_id='a'").first())!.send_count,1);
  await assert.rejects(()=>module.sendIsolatedCloudflareOtp!(failing,token3,origin));assert.equal(failedCalls,1,'ambiguous provider failure does not restore budgets');
  const token4Hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token4))),x=>x.toString(16).padStart(2,'0')).join('');let expired=false;
  const racedDb=new Proxy(db,{get(target,key){if(key==='batch')return async (statements:D1PreparedStatement[])=>{const out=await target.batch(statements);await target.prepare('UPDATE recipient_page_sessions SET expires_at=0 WHERE token_hash=?').bind(token4Hash).run();expired=true;return out;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  await assert.rejects(()=>module.sendIsolatedCloudflareOtp!({...env,DB:racedDb},token4,origin),'a session expiring before send must not reach the provider');assert.equal(expired,true);assert.equal(sends,2);
  await db.exec('UPDATE isolated_otp_send_budgets SET window_started_at=window_started_at-900001');const largerBudgets={...env,ISOLATED_OTP_TENANT_LIMIT:'10',ISOLATED_OTP_ACCOUNT_LIMIT:'10'};
  for(let i=0;i<2;i++){await db.exec("UPDATE recipient_otp_challenges SET next_send_at=0 WHERE task_id='t3'");const fresh=await makeSession('a','ea2','t3');await module.sendIsolatedCloudflareOtp!(largerBudgets,fresh,origin);}
  await db.exec("UPDATE recipient_otp_challenges SET next_send_at=0 WHERE task_id='t3'");const fourthTaskSession=await makeSession('a','ea2','t3');await assert.rejects(()=>module.sendIsolatedCloudflareOtp!(largerBudgets,fourthTaskSession,origin),'task is capped at three lifetime attempts');assert.equal((await db.prepare("SELECT sends FROM recipient_otp_challenges WHERE task_id='t3'").first())!.sends,3);
  assert.equal((await db.prepare("SELECT send_count FROM isolated_otp_send_budgets WHERE scope_kind='account'").first())!.send_count,2,'task limit failure rolls back account budget');

 }finally{await mf.dispose();}
});

test('isolated OTP service uses the workerd Cloudflare Email binding without returning a code',async()=>{
 const {build}=await import('esbuild');
 const source=`import {sendIsolatedCloudflareOtp} from './src/isolated-cloudflare-otp.ts';export default {async fetch(req,env){try{const body=await req.json();await sendIsolatedCloudflareOtp(env,body.token,body.origin);return Response.json({status:'accepted'},{headers:{'cache-control':'no-store'}});}catch{return Response.json({error:'unavailable'},{status:503,headers:{'cache-control':'no-store'}});}}}`;
 const bundled=await build({stdin:{contents:source,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser'});
 const mf=new Miniflare({modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-01-01',d1Databases:['DB'],email:{send_email:[{name:'SEND_EMAIL',allowed_sender_addresses:['sign@example.com'],allowed_destination_addresses:['ana@example.com','lee@example.test']}]},bindings:{ISOLATED_OTP_ENABLED:'true',ISOLATED_OTP_FROM:'sign@example.com',ISOLATED_OTP_RECIPIENTS:'["ana@example.com","lee@example.test"]',ISOLATED_OTP_PEPPER:'synthetic-otp-secret-with-at-least-32-bytes',ISOLATED_OTP_WINDOW_MS:'900000',ISOLATED_OTP_TENANT_LIMIT:'2',ISOLATED_OTP_ACCOUNT_LIMIT:'3'}});
 try{
  const db=await mf.getD1Database('DB');for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort()){const sql=await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8');await db.batch(unstable_splitSqlQuery(sql).map(s=>db.prepare(s)));}
  const origin='https://host.example.com';await db.exec(`INSERT INTO tenants VALUES ('a');INSERT INTO templates VALUES ('ta','a','src-a','["ana"]',1,'[]');INSERT INTO envelopes VALUES ('ea','a','ta','IN_PROGRESS',1);INSERT INTO tasks VALUES ('t1','ea','ana','Ana','ana@example.com',1,'ACTIVE');INSERT INTO tenant_page_origins VALUES ('a','${origin}');`);
  const now=Date.now(),code=await issueRecipientCode(db,{tenantId:'a',envelopeId:'ea',taskId:'t1',origin,now}),token=await exchangeRecipientCode(db,code,origin,now+1);
  const send=()=>mf.dispatchFetch('https://local.test/',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token,origin})});
  const first=await send(),body=await first.text();assert.equal(first.status,200);assert.equal(first.headers.get('cache-control'),'no-store');assert.deepEqual(JSON.parse(body),{status:'accepted'});assert.equal(body.includes(token),false);assert.equal(body.includes('ana@example.com'),false);
  assert.equal((await db.prepare("SELECT sends FROM recipient_otp_challenges WHERE task_id='t1'").first())!.sends,1);const repeated=await send();assert.equal(repeated.status,503);assert.equal((await db.prepare("SELECT sends FROM recipient_otp_challenges WHERE task_id='t1'").first())!.sends,1);
 }finally{await mf.dispose();}
});

test('isolated synthetic sink routes distinct task labels to one configured destination and fails closed',async()=>{
 const {sendIsolatedCloudflareOtp,verifyIsolatedCloudflareOtp}=await import('../src/isolated-cloudflare-otp.ts');
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response()}}',d1Databases:['DB']});
 try{
  const db=await mf.getD1Database('DB');for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())await db.batch(unstable_splitSqlQuery(await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8')).map(s=>db.prepare(s)));
  const origin='https://host.example.com',sink=['sink','example.test'].join('@');
  await db.exec(`INSERT INTO tenants VALUES ('a');INSERT INTO templates VALUES ('ta','a','src','[]',1,'[]');INSERT INTO envelopes VALUES ('ea','a','ta','IN_PROGRESS',1);INSERT INTO tasks VALUES ('t1','ea','one','One','one@example.test',1,'ACTIVE');INSERT INTO tasks VALUES ('t2','ea','two','Two','two@example.test',2,'ACTIVE');INSERT INTO tenant_page_origins VALUES ('a','${origin}');`);
  const session=async(taskId:string)=>{const now=Date.now(),code=await issueRecipientCode(db,{tenantId:'a',envelopeId:'ea',taskId,origin,now});return exchangeRecipientCode(db,code,origin,now+1);};
  const tokens=await Promise.all([session('t1'),session('t2')]);const messages:{to:string;text:string}[]=[];
  const env={DB:db,SEND_EMAIL:{send:async(m:{to:string;text:string})=>{messages.push(m);}},ISOLATED_OTP_ENABLED:'true',ISOLATED_OTP_SYNTHETIC_SINK_ENABLED:'true',ISOLATED_OTP_SYNTHETIC_SINK:sink,ISOLATED_OTP_FROM:'sign@example.com',ISOLATED_OTP_PEPPER:'synthetic-otp-secret-with-at-least-32-bytes',ISOLATED_OTP_WINDOW_MS:'900000',ISOLATED_OTP_TENANT_LIMIT:'10',ISOLATED_OTP_ACCOUNT_LIMIT:'10'};
  for(const invalid of [{...env,ISOLATED_OTP_SYNTHETIC_SINK:''},{...env,ISOLATED_OTP_SYNTHETIC_SINK:'bad\n'},{...env,ISOLATED_OTP_SYNTHETIC_SINK_ENABLED:'false'}])await assert.rejects(()=>sendIsolatedCloudflareOtp(invalid,tokens[0],origin));
  for(const recipients of ['["one@example.test","two@example.test"]','not-json','']) {
   const conflict={...env,ISOLATED_OTP_RECIPIENTS:recipients};
   await assert.rejects(()=>sendIsolatedCloudflareOtp(conflict,tokens[0],origin));
   await assert.rejects(()=>verifyIsolatedCloudflareOtp(conflict,tokens[0],origin,'123456'));
  }
  for(const table of ['isolated_otp_send_budgets','isolated_otp_quota_reservations','recipient_otp_challenges','recipient_otp_verifications'])assert.equal((await db.prepare(`SELECT count(*) AS n FROM ${table}`).first<{n:number}>())!.n,0);
  assert.equal(messages.length,0);
  const results=await Promise.allSettled([sendIsolatedCloudflareOtp(env,tokens[0],origin),sendIsolatedCloudflareOtp(env,tokens[0],origin),sendIsolatedCloudflareOtp(env,tokens[1],origin)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,2);assert.equal(messages.length,2);assert.ok(messages.every(m=>m.to===sink&&!m.text.includes('one@example.test')&&!m.text.includes('two@example.test')));
  const before=(await db.prepare('SELECT * FROM recipient_otp_challenges ORDER BY task_id').all()).results;
  for(const recipients of ['["one@example.test","two@example.test"]','not-json',''])await assert.rejects(()=>verifyIsolatedCloudflareOtp({...env,ISOLATED_OTP_RECIPIENTS:recipients},tokens[0],origin,messages[0].text.match(/\b\d{6}\b/)![0]));
  assert.deepEqual((await db.prepare('SELECT * FROM recipient_otp_challenges ORDER BY task_id').all()).results,before);
  for(const token of tokens){let verified=false;for(const m of messages){const otp=m.text.match(/\b\d{6}\b/)![0];if(await verifyIsolatedCloudflareOtp(env,token,origin,otp)){verified=true;break;}}assert.equal(verified,true);}
  assert.equal((await db.prepare('SELECT count(*) AS n FROM isolated_otp_quota_reservations').first<{n:number}>())!.n,2);
  await db.exec("UPDATE recipient_otp_challenges SET next_send_at=0 WHERE task_id='t1'");
  const third=await session('t1');let calls=0;
  await assert.rejects(()=>sendIsolatedCloudflareOtp({...env,SEND_EMAIL:{send:async()=>{calls++;throw new Error(sink);}}},third,origin),{message:'Isolated OTP unavailable'});
  await assert.rejects(()=>sendIsolatedCloudflareOtp(env,third,origin));assert.equal(calls,1);
  await db.exec("UPDATE recipient_otp_challenges SET next_send_at=0 WHERE task_id='t1'");
  await sendIsolatedCloudflareOtp(env,await session('t1'),origin);
  await db.exec("UPDATE recipient_otp_challenges SET next_send_at=0,window_started_at=0 WHERE task_id='t1'");
  const fourth=await session('t1');await assert.rejects(()=>sendIsolatedCloudflareOtp(env,fourth,origin));
  assert.equal((await db.prepare("SELECT count(*) AS n FROM isolated_otp_quota_reservations WHERE task_id='t1'").first<{n:number}>())!.n,3);
  await db.prepare("INSERT INTO tasks VALUES ('t3','ea','three','Three',?,3,'ACTIVE')").bind(sink).run();
  const sameSinkToken=await session('t3');await sendIsolatedCloudflareOtp(env,sameSinkToken,origin);
  const sameSinkMessage=messages.at(-1)!;assert.equal(sameSinkMessage.to,sink);
  assert.equal(await verifyIsolatedCloudflareOtp(env,sameSinkToken,origin,sameSinkMessage.text.match(/\b\d{6}\b/)![0]),true);

 }finally{await mf.dispose();}
});
