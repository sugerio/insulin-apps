import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {build} from 'esbuild';
import {unstable_splitSqlQuery} from 'wrangler';
import {issueRecipientCode,exchangeRecipientCode} from '../src/page-authorization.ts';

test('isolated OTP shared lifetime quotas reserve before provider dispatch and never retry a session',async()=>{
 const source=`import {sendIsolatedCloudflareOtp} from './src/isolated-cloudflare-otp.ts';export default {async fetch(req,env){try{const {token,origin,fail,loseBatch}=await req.json();if(loseBatch){const db=env.DB;env.DB=new Proxy(db,{get(target,key){if(key==='batch')return async statements=>{await target.batch(statements);throw Error('lost D1 response');};const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;}});}env.SEND_EMAIL={send:async()=>{await env.DB.prepare('INSERT INTO test_dispatch DEFAULT VALUES').run();if(fail)throw Error('provider uncertainty');}};await sendIsolatedCloudflareOtp(env,token,origin);return new Response(null,{status:204});}catch{return new Response(null,{status:503});}}}`;
 const script=(await build({stdin:{contents:source,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser'})).outputFiles[0].text;
 const bindings={ISOLATED_OTP_ENABLED:'true',ISOLATED_OTP_FROM:'sign@example.com',ISOLATED_OTP_RECIPIENTS:'["ana@example.com","lee@example.test"]',ISOLATED_OTP_PEPPER:'synthetic-otp-secret-with-at-least-32-bytes',ISOLATED_OTP_WINDOW_MS:'900000',ISOLATED_OTP_TENANT_LIMIT:'100',ISOLATED_OTP_ACCOUNT_LIMIT:'100'};
 const mf=new Miniflare({workers:['one','two'].map(name=>({name,modules:true,script,compatibilityDate:'2026-01-01',d1Databases:{DB:'shared-otp-db'},bindings}))});
 try{
  const db=await mf.getD1Database('DB');for(const n of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())await db.batch(unstable_splitSqlQuery(await readFile(new URL(`../migrations/${n}`,import.meta.url),'utf8')).map(s=>db.prepare(s)));
  await db.exec(`CREATE TABLE test_dispatch (id INTEGER PRIMARY KEY); INSERT INTO tenants VALUES ('a'); INSERT INTO templates VALUES ('ta','a','src','["ana"]',1,'[]'); INSERT INTO envelopes VALUES ('ea','a','ta','IN_PROGRESS',1); INSERT INTO tenant_page_origins VALUES ('a','https://host.example.com');`);
  const origin='https://host.example.com',tokens:string[]=[];
  for(let i=0;i<14;i++){await db.prepare("INSERT INTO envelopes VALUES (?,'a','ta','IN_PROGRESS',1)").bind(`e${i}`).run();await db.prepare("INSERT INTO tasks VALUES (?, ?,'ana','Ana','ana@example.com',1,'ACTIVE')").bind(`t${i}`,`e${i}`).run();const now=Date.now(),code=await issueRecipientCode(db,{tenantId:'a',envelopeId:`e${i}`,taskId:`t${i}`,origin,now});tokens.push(await exchangeRecipientCode(db,code,origin,now+1));}
  const workers=await Promise.all(['one','two'].map(name=>mf.getWorker(name)));
  const send=(i:number,fail=false,loseBatch=false)=>workers[i%2].fetch('https://local.test/',{method:'POST',body:JSON.stringify({token:tokens[i],origin,fail,loseBatch})});
  const replies=await Promise.all(tokens.map((_,i)=>send(i)));assert.equal(replies.filter(r=>r.status===204).length,10);assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM test_dispatch').first())!.n,10);
  assert.equal((await send(0)).status,503);assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM test_dispatch').first())!.n,10);
  await assert.rejects(()=>db.exec("UPDATE isolated_otp_quota_reservations SET reserved_at=0"));await assert.rejects(()=>db.exec("DELETE FROM isolated_otp_quota_reservations"));
  const unused=replies.findIndex(r=>r.status===503);assert.notEqual(unused,-1);assert.equal((await send(unused)).status,503,'quota never resets');
  await db.exec('DROP TRIGGER isolated_otp_quota_no_update; DROP TRIGGER isolated_otp_quota_no_delete; DELETE FROM isolated_otp_quota_reservations; DELETE FROM isolated_otp_send_budgets; DELETE FROM recipient_otp_challenges; DELETE FROM test_dispatch');
  assert.equal((await send(1,false,true)).status,503);assert.equal((await send(1)).status,503);assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM isolated_otp_quota_reservations').first())!.n,1);
  assert.equal((await send(0,true)).status,503);assert.equal((await send(0,true)).status,503);assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM test_dispatch').first())!.n,1);
  for(let i=0;i<2;i++){await db.exec("UPDATE recipient_otp_challenges SET next_send_at=0 WHERE task_id='t0'");const now=Date.now(),code=await issueRecipientCode(db,{tenantId:'a',envelopeId:'e0',taskId:'t0',origin,now});tokens[0]=await exchangeRecipientCode(db,code,origin,now+1);assert.equal((await send(0)).status,204);}
  await db.exec("UPDATE isolated_otp_quota_reservations SET reserved_at=0; UPDATE recipient_otp_challenges SET next_send_at=0,window_started_at=0 WHERE task_id='t0'");const now=Date.now(),code=await issueRecipientCode(db,{tenantId:'a',envelopeId:'e0',taskId:'t0',origin,now});tokens[0]=await exchangeRecipientCode(db,code,origin,now+1);assert.equal((await send(0)).status,503,'task lifetime quota cannot be reset');assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM test_dispatch').first())!.n,3);
 }finally{await mf.dispose();}
});
