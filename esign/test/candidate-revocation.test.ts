import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {unstable_splitSqlQuery} from 'wrangler';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {exchangeRecipientCode} from '../src/page-authorization.ts';
import {sendIsolatedCloudflareOtp,verifyIsolatedCloudflareOtp} from '../src/isolated-cloudflare-otp.ts';
const hash=async(s:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),b=>b.toString(16).padStart(2,'0')).join('');
const key='synthetic-management-key-0123456789-abcdefghijklmnopqrstuvwxyz',origin='https://host.example.com';
test('private task revocation invalidates issued codes and sessions after OTP send and verification',async()=>{
 const built=await build({entryPoints:['src/candidate-worker.ts'],bundle:true,platform:'browser',format:'esm',write:false,external:['cloudflare:workers']});
 const mf=new Miniflare({workers:[{name:'caller',modules:true,script:`export default {fetch(r,e){return new URL(r.url).pathname.startsWith('/v1/envelopes/')?e.M.fetch(r):e.R.fetch(r)}}`,serviceBindings:{M:{name:'candidate',entrypoint:'PrivateManagement'},R:{name:'candidate',entrypoint:'PrivateRecipient'}}},{name:'candidate',modules:true,script:built.outputFiles[0].text,d1Databases:['DB'],r2Buckets:['ARTIFACTS'],bindings:{TEST_ISSUANCE_WINDOW_MS:'60000',TEST_ISSUANCE_TENANT_LIMIT:'50',TEST_ISSUANCE_DATABASE_LIMIT:'50',TEST_OUTSTANDING_TENANT_LIMIT:'50',TEST_OUTSTANDING_DATABASE_LIMIT:'50'}}]});
 try{
  const db=await mf.getD1Database('DB','candidate'),bucket=await mf.getR2Bucket('ARTIFACTS','candidate');
  for(const n of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())await db.batch(unstable_splitSqlQuery(await readFile(new URL(`../migrations/${n}`,import.meta.url),'utf8')).map(s=>db.prepare(s)));
  const pdf='%PDF synthetic';await db.exec(`INSERT INTO tenants VALUES ('a'),('b'); INSERT INTO templates VALUES ('p','a','src','["ana"]',1,'[]'); INSERT INTO envelopes VALUES ('e','a','p','IN_PROGRESS',1); INSERT INTO tasks VALUES ('t','e','ana','Ana','ana@example.com',1,'ACTIVE'); INSERT INTO tenant_page_origins VALUES ('a','${origin}'); INSERT INTO artifacts VALUES ('d','e','document','${await hash(pdf)}');`);await bucket.put('document',pdf);
  await db.prepare('INSERT INTO api_keys(key_hash,tenant_id,revoked_at) VALUES (?, ?, NULL)').bind(await hash(key),'a').run();
  const post=(path:string,body:unknown,auth=false)=>mf.dispatchFetch('https://caller.test'+path,{method:'POST',headers:auth?{authorization:`Bearer ${key}`}:{},body:JSON.stringify(body)});
  const base='/v1/envelopes/e/tasks/t/';const issue=async()=>{const r=await post(base+'recipient-view',{origin},true);assert.equal(r.status,200);return (await r.json() as {code:string}).code;};
  const exchange=async(code:string)=>post('/v1/page-sessions/exchange',{code,origin});
  const token=async()=>{const r=await exchange(await issue());assert.equal(r.status,200);return (await r.json() as {token:string}).token;};
  const revoke=()=>post(base+'recipient-revoke',{},true);
  let otp='';const env={DB:db,SEND_EMAIL:{send:async(m:{text:string})=>{otp=m.text.match(/\b\d{6}\b/)![0];}},ISOLATED_OTP_ENABLED:'true',ISOLATED_OTP_FROM:'sign@example.com',ISOLATED_OTP_RECIPIENTS:'["ana@example.com","lee@example.test"]',ISOLATED_OTP_PEPPER:'synthetic-otp-secret-with-at-least-32-bytes',ISOLATED_OTP_WINDOW_MS:'900000',ISOLATED_OTP_TENANT_LIMIT:'10',ISOLATED_OTP_ACCOUNT_LIMIT:'10'};
  const concurrentCode=await issue(); const concurrent=await Promise.all([revoke(),exchange(concurrentCode)]); assert.equal(concurrent[0].status,204); if(concurrent[1].status===200){const won=await concurrent[1].json() as {token:string};assert.ok(await db.prepare('SELECT 1 FROM recipient_session_revocations WHERE token_hash=?').bind(await hash(won.token)).first());} else {assert.notEqual(concurrent[1].status,200);assert.equal((await db.prepare('SELECT used_at FROM recipient_page_codes WHERE code_hash=?').bind(await hash(concurrentCode)).first<{used_at:number|null}>())!.used_at,null);}
  const first=await token(),unused=await issue();await sendIsolatedCloudflareOtp(env,first,origin);
  assert.equal((await revoke()).status,204);assert.equal((await db.prepare('SELECT used_at FROM recipient_page_codes WHERE code_hash=?').bind(await hash(unused)).first<{used_at:number|null}>())!.used_at,null, 'revocation must not invent usage');assert.notEqual((await exchange(unused)).status,200);await assert.rejects(()=>exchangeRecipientCode(db,unused,origin,Date.now()));assert.ok(await db.prepare('SELECT 1 FROM recipient_code_revocations WHERE code_hash=?').bind(await hash(unused)).first());assert.equal(await verifyIsolatedCloudflareOtp(env,first,origin,otp),false);await assert.rejects(()=>sendIsolatedCloudflareOtp(env,first,origin));
  const second=await token();await db.exec('UPDATE recipient_otp_challenges SET next_send_at=0');await sendIsolatedCloudflareOtp(env,second,origin);assert.equal(await verifyIsolatedCloudflareOtp(env,second,origin,otp),true);
  assert.equal((await post('/v1/document',{token:second,origin})).status,200);assert.equal((await revoke()).status,204);assert.notEqual((await post('/v1/document',{token:second,origin})).status,200);
  assert.notEqual((await post('/v1/envelopes/e/tasks/missing/recipient-revoke',{},true)).status,204);
  assert.notEqual((await post(base+'recipient-revoke',{},false)).status,204);
  const publicWorker=await mf.getWorker('candidate');assert.equal((await publicWorker.fetch('https://candidate.test'+base+'recipient-revoke',{method:'POST'})).status,404);
  // A code tombstone inserted between exchange statements rolls back both usage and session.
  const tombstoneRace=await issue();const tombstoneHash=await hash(tombstoneRace);
  await db.exec(`CREATE TRIGGER code_revoke_during_exchange AFTER INSERT ON recipient_page_sessions BEGIN INSERT INTO recipient_code_revocations VALUES ('${tombstoneHash}',1); END`);
  assert.notEqual((await exchange(tombstoneRace)).status,200);await db.exec('DROP TRIGGER code_revoke_during_exchange');
  assert.equal((await db.prepare('SELECT used_at FROM recipient_page_codes WHERE code_hash=?').bind(tombstoneHash).first<{used_at:number|null}>())!.used_at,null);
  assert.equal(await db.prepare('SELECT 1 FROM recipient_code_revocations WHERE code_hash=?').bind(tombstoneHash).first(),null);
  const lateCode=await issue(),lateHash=await hash(lateCode);
  await db.exec(`CREATE TRIGGER code_revoke_after_use AFTER UPDATE ON recipient_page_codes WHEN NEW.code_hash='${lateHash}' BEGIN INSERT INTO recipient_code_revocations VALUES (NEW.code_hash,1); END`);
  assert.notEqual((await exchange(lateCode)).status,200);await db.exec('DROP TRIGGER code_revoke_after_use');
  assert.equal((await db.prepare('SELECT used_at FROM recipient_page_codes WHERE code_hash=?').bind(lateHash).first<{used_at:number|null}>())!.used_at,null);
  // Revocation during exchange must roll the inserted session and code consumption back.
  const racingCode=await issue();
  await db.exec(`CREATE TRIGGER revoke_during_exchange AFTER INSERT ON recipient_page_sessions BEGIN INSERT INTO recipient_session_revocations VALUES (NEW.token_hash,1); END`);
  assert.notEqual((await exchange(racingCode)).status,200);await db.exec('DROP TRIGGER revoke_during_exchange');
  assert.equal((await db.prepare('SELECT used_at FROM recipient_page_codes WHERE code_hash=?').bind(await hash(racingCode)).first<{used_at:number|null}>())!.used_at,null);
  const third=await token();await db.exec('UPDATE recipient_otp_challenges SET next_send_at=0');await sendIsolatedCloudflareOtp(env,third,origin);
  // Revocation between challenge consumption and verification insertion rolls back consumption.
  await db.exec(`CREATE TRIGGER revoke_during_verify AFTER UPDATE ON recipient_otp_challenges WHEN NEW.consumed_by IS NOT NULL BEGIN INSERT OR IGNORE INTO recipient_session_revocations VALUES (NEW.session_hash,1); END`);
  await assert.rejects(()=>verifyIsolatedCloudflareOtp(env,third,origin,otp));await db.exec('DROP TRIGGER revoke_during_verify');
  assert.equal((await db.prepare('SELECT consumed_by FROM recipient_otp_challenges').first<{consumed_by:string|null}>())!.consumed_by,null);
  // A revocation injected after OTP reservation forces the whole reservation to roll back.
  const sendRace=await token();await db.exec('UPDATE recipient_otp_challenges SET next_send_at=0,window_started_at=0');
  await db.exec(`CREATE TRIGGER revoke_during_reservation AFTER UPDATE ON recipient_otp_challenges WHEN NEW.isolated_issue_id IS NOT NULL BEGIN INSERT OR IGNORE INTO recipient_session_revocations VALUES (NEW.session_hash,1); END`);
  const before=(await db.prepare("SELECT send_count FROM isolated_otp_send_budgets WHERE scope_kind='account'").first<{send_count:number}>())!.send_count;
  await assert.rejects(()=>sendIsolatedCloudflareOtp(env,sendRace,origin));await db.exec('DROP TRIGGER revoke_during_reservation');
  assert.equal((await db.prepare("SELECT send_count FROM isolated_otp_send_budgets WHERE scope_kind='account'").first<{send_count:number}>())!.send_count,before);
  // A session inserted mid-revocation is detected by its closing transaction assertion.
  const codeForRace=await issue();
  await db.exec(`CREATE TRIGGER session_during_revoke AFTER INSERT ON recipient_code_revocations WHEN NEW.code_hash='${await hash(codeForRace)}' BEGIN INSERT INTO recipient_page_sessions VALUES ('injected','a','e','t','${origin}',9999999999999); END`);
  assert.notEqual((await revoke()).status,204);await db.exec('DROP TRIGGER session_during_revoke');
  assert.equal((await db.prepare('SELECT used_at FROM recipient_page_codes WHERE code_hash=?').bind(await hash(codeForRace)).first<{used_at:number|null}>())!.used_at,null);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM recipient_page_sessions WHERE token_hash='injected'").first<{n:number}>())!.n,0);
  // The provider callback happens after the final database read: delivery cannot be recalled.
  const fourth=await token();await db.exec("DROP TRIGGER isolated_otp_quota_no_delete; DELETE FROM isolated_otp_quota_reservations; UPDATE recipient_otp_challenges SET next_send_at=0,window_started_at=0");let delivered=false;
  await sendIsolatedCloudflareOtp({...env,SEND_EMAIL:{send:async(m:{text:string})=>{otp=m.text.match(/\b\d{6}\b/)![0];assert.equal((await revoke()).status,204);delivered=true;}}},fourth,origin);
  assert.equal(delivered,true);assert.equal(await verifyIsolatedCloudflareOtp(env,fourth,origin,otp),false);
 }finally{await mf.dispose();}
});
