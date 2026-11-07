import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {unstable_splitSqlQuery} from 'wrangler';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';

test('captured candidate predecessor facts are asserted on both sides of a transaction',async()=>{
 const built=await build({stdin:{contents:`import {candidatePredecessorFactsAssertion} from './src/candidate-predecessor-facts.ts';
 const facts={jobId:'j',signatureId:'s',envelopeId:'e',taskId:'t',recipientName:'Ana',role:'ana',inputArtifactId:'d0',inputHash:'h0',inputObjectKey:'d0.pdf',inputPageCount:1,payloadJson:'{}',sessionHash:'session',otpRecipientEmail:'ana@example.com',otpVerifiedAt:1,consentedAt:2,previousHash:'',eventHash:'event',outputArtifactId:'signed:s',outputObjectKey:'d1.pdf',outputHash:'h1'};
 export default {async fetch(req,env){try {await env.DB.batch([candidatePredecessorFactsAssertion(env.DB,facts),env.DB.prepare('INSERT INTO test_writes VALUES (1)'),candidatePredecessorFactsAssertion(env.DB,facts),env.DB.prepare('DELETE FROM recipient_auth_assertions')]);return new Response('ok')}catch{return new Response('denied',{status:503})}}}` ,resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'browser',format:'esm',write:false});
 const mf=new Miniflare({modules:true,script:built.outputFiles[0].text,d1Databases:['DB']});
 try{
  const db=await mf.getD1Database('DB');for(const n of (await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort())await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${n}`,'utf8')).map(s=>db.prepare(s)));
  await db.exec(`INSERT INTO tenants VALUES ('a'); INSERT INTO templates VALUES ('p','a','src','["ana"]',1,'[]'); INSERT INTO envelopes VALUES ('e','a','p','IN_PROGRESS',1); INSERT INTO tasks VALUES ('t','e','ana','Ana','ana@example.com',1,'SIGNED'); INSERT INTO recipient_page_sessions VALUES ('session','a','e','t','https://example.com',1); INSERT INTO recipient_otp_verifications (task_id,session_hash,verified_at,recipient_email) VALUES ('t','session',1,'ana@example.com'); INSERT INTO recipient_page_sessions VALUES ('other','a','e','t','https://example.com',1); INSERT INTO artifacts VALUES ('d0','e','d0.pdf','h0'); INSERT INTO signature_records (id,envelope_id,task_id,sequence,session_hash,recipient_name,input_artifact_id,input_sha256,otp_verified_at,consented_at,otp_recipient_email) VALUES ('s','e','t',1,'session','Ana','d0','h0',1,2,'ana@example.com'); INSERT INTO signature_events VALUES ('s','e',1,'','event',3); INSERT INTO positioned_signature_inputs VALUES ('s','d0.pdf',1,'{}'); INSERT INTO signature_jobs VALUES ('j','s','DONE'); INSERT INTO signature_outputs VALUES ('j','signed:s','d1.pdf','h1'); CREATE TABLE test_writes (n INTEGER);`);
  const run=()=>mf.dispatchFetch('https://test.test/',{method:'POST'});
  assert.equal((await run()).status,200);await db.exec('DELETE FROM test_writes');
  for(const [change,restore] of [["UPDATE signature_records SET session_hash='other' WHERE id='s'","UPDATE signature_records SET session_hash='session' WHERE id='s'"],["UPDATE signature_records SET otp_recipient_email=NULL WHERE id='s'","UPDATE signature_records SET otp_recipient_email='ana@example.com' WHERE id='s'"],["UPDATE recipient_otp_verifications SET recipient_email='other@example.com' WHERE task_id='t'","UPDATE recipient_otp_verifications SET recipient_email='ana@example.com' WHERE task_id='t'"],["UPDATE recipient_otp_verifications SET verified_at=3 WHERE task_id='t'","UPDATE recipient_otp_verifications SET verified_at=1 WHERE task_id='t'"]]){
   await db.exec(change);assert.equal((await run()).status,503,change);await db.exec(restore);
  }
  for(const change of ["UPDATE signature_records SET session_hash='other' WHERE id='s'", "UPDATE signature_records SET otp_recipient_email=NULL WHERE id='s'", "UPDATE recipient_otp_verifications SET recipient_email='other@example.com' WHERE task_id='t'", "UPDATE recipient_otp_verifications SET verified_at=3 WHERE task_id='t'", "UPDATE signature_records SET consented_at=3 WHERE id='s'", "UPDATE signature_events SET event_hash='changed' WHERE signature_id='s'", "UPDATE positioned_signature_inputs SET payload_json='changed' WHERE signature_id='s'", "UPDATE tasks SET status='ACTIVE' WHERE id='t'", "UPDATE artifacts SET sha256='changed' WHERE id='d0'", "UPDATE signature_jobs SET status='PENDING' WHERE id='j'", "UPDATE signature_outputs SET sha256='changed' WHERE job_id='j'"]){
   await db.exec(`CREATE TRIGGER test_mutate AFTER INSERT ON test_writes BEGIN ${change}; END`);
   assert.equal((await run()).status,503,change);assert.equal((await db.prepare('SELECT count(*) AS n FROM test_writes').first<{n:number}>())?.n,0);await db.exec('DROP TRIGGER test_mutate');
  }
 }finally{await mf.dispose();}
});
