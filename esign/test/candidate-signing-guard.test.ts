import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {unstable_splitSqlQuery} from 'wrangler';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';

test('candidate signing assertion rolls back when authority changes in the transaction',async()=>{
 const built=await build({stdin:{contents:`import {candidateSigningAuthorizationAssertion} from './src/candidate-signing-authorization.ts'; export default {async fetch(req,env){try {await env.DB.batch([env.DB.prepare(await req.text()),candidateSigningAuthorizationAssertion(env.DB,{sessionHash:'hash',tenantId:'a',envelopeId:'e',taskId:'t',origin:'https://host.example.com'}),env.DB.prepare('DELETE FROM recipient_auth_assertions')]);return new Response('ok')}catch{return new Response('denied',{status:403})}}}`,resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'browser',format:'esm',write:false});
 const mf=new Miniflare({modules:true,script:built.outputFiles[0].text,d1Databases:['DB']});
 try{
  const db=await mf.getD1Database('DB');for(const n of (await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort())await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${n}`,'utf8')).map(s=>db.prepare(s)));
  await db.exec(`INSERT INTO tenants VALUES ('a'),('b'); INSERT INTO templates VALUES ('p','a','src','["ana"]',1,'[]'); INSERT INTO envelopes VALUES ('e','a','p','IN_PROGRESS',1); INSERT INTO tasks VALUES ('t','e','ana','Ana','ana@example.com',1,'ACTIVE'); INSERT INTO tenant_page_origins VALUES ('a','https://host.example.com'); INSERT INTO recipient_page_sessions VALUES ('hash','a','e','t','https://host.example.com',CAST(unixepoch('subsec')*1000 AS INTEGER)+800000); INSERT INTO recipient_otp_verifications(task_id,session_hash,verified_at,recipient_email) VALUES ('t','hash',1,'ana@example.com');`);
  const run=(sql:string)=>mf.dispatchFetch('https://test.test/',{method:'POST',body:sql});
  assert.equal((await run("UPDATE tasks SET recipient_name='Ana'")).status,200);
  for(const sql of ["INSERT INTO recipient_session_revocations VALUES ('hash',1)","INSERT INTO api_keys(key_hash,tenant_id,revoked_at) VALUES ('hash','b',1)","UPDATE recipient_otp_verifications SET recipient_email='other@example.com'","UPDATE recipient_page_sessions SET expires_at=0","UPDATE recipient_page_sessions SET expires_at=CAST(unixepoch('subsec')*1000 AS INTEGER)+1000000","UPDATE recipient_otp_verifications SET verified_at=CAST(unixepoch('subsec')*1000 AS INTEGER)+60000","UPDATE recipient_page_sessions SET tenant_id='b'","UPDATE tasks SET status='SIGNED'","DELETE FROM tenant_page_origins"]){assert.equal((await run(sql)).status,403,sql);}
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM recipient_session_revocations').first<{n:number}>())?.n,0);
 }finally{await mf.dispose()}
});

test('second signing authorization bounds the route and rolls back transaction mutations',async()=>{
 const built=await build({stdin:{contents:`import {candidateSecondSigningAuthorizationAssertion} from './src/candidate-signing-authorization.ts'; export default {async fetch(req,env){try {await env.DB.batch([candidateSecondSigningAuthorizationAssertion(env.DB,{sessionHash:'hash',tenantId:'a',envelopeId:'e',taskId:'second',origin:'https://host.example.com'},'first'),env.DB.prepare(await req.text()),candidateSecondSigningAuthorizationAssertion(env.DB,{sessionHash:'hash',tenantId:'a',envelopeId:'e',taskId:'second',origin:'https://host.example.com'},'first'),env.DB.prepare('DELETE FROM recipient_auth_assertions')]);return new Response('ok')}catch{return new Response('denied',{status:403})}}}`,resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'browser',format:'esm',write:false});
 const mf=new Miniflare({modules:true,script:built.outputFiles[0].text,d1Databases:['DB']});
 try{
  const db=await mf.getD1Database('DB');for(const n of (await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort())await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${n}`,'utf8')).map(s=>db.prepare(s)));
  await db.exec(`INSERT INTO tenants VALUES ('a'),('b'); INSERT INTO templates VALUES ('p','a','src','["ana","lee"]',1,'[]'); INSERT INTO envelopes VALUES ('e','a','p','IN_PROGRESS',1); INSERT INTO tasks VALUES ('first','e','ana','Ana','ana@example.com',1,'SIGNED'),('second','e','lee','Lee','lee@example.com',2,'ACTIVE'); INSERT INTO tenant_page_origins VALUES ('a','https://host.example.com'); INSERT INTO recipient_page_sessions VALUES ('hash','a','e','second','https://host.example.com',CAST(unixepoch('subsec')*1000 AS INTEGER)+800000); INSERT INTO recipient_otp_verifications(task_id,session_hash,verified_at,recipient_email) VALUES ('second','hash',1,'lee@example.com'); INSERT INTO recipient_page_sessions VALUES ('prior','a','e','first','https://host.example.com',9999999999999); INSERT INTO artifacts VALUES ('d0','e','d0.pdf','h0'); INSERT INTO signature_records (id,envelope_id,task_id,sequence,session_hash,recipient_name,input_artifact_id,input_sha256,otp_verified_at,consented_at) VALUES ('s','e','first',1,'prior','Ana','d0','h0',1,2);`);
  const run=(sql:string)=>mf.dispatchFetch('https://test.test/',{method:'POST',body:sql});
  assert.equal((await run("UPDATE tasks SET recipient_name='Lee' WHERE id='second'")).status,200);
  for(const sql of ["INSERT INTO recipient_session_revocations VALUES ('hash',1)","INSERT INTO api_keys(key_hash,tenant_id,revoked_at) VALUES ('hash','b',1)","UPDATE recipient_otp_verifications SET recipient_email='other@example.com'","UPDATE recipient_page_sessions SET expires_at=0","UPDATE tasks SET status='ACTIVE' WHERE id='first'","UPDATE tasks SET routing_order=3 WHERE id='first'","INSERT INTO tasks VALUES ('third','e','x','X','x@example.com',3,'PENDING')","UPDATE signature_records SET sequence=2 WHERE id='s'"]){assert.equal((await run(sql)).status,403,sql);}
 }finally{await mf.dispose()}
});

test('second signing composition rejects predecessor scope mismatches before creating statements',async()=>{
 const {candidateSecondAssertions}=await import('../src/candidate-verified-predecessor.ts');
 const guard={sessionHash:'hash',tenantId:'a',envelopeId:'e',taskId:'second',origin:'https://host.example.com'};
 const db={} as D1Database;
 assert.throws(()=>candidateSecondAssertions(db,guard,{envelopeId:'other',taskId:'first'} as any),/scope mismatch/);
 assert.throws(()=>candidateSecondAssertions(db,guard,{envelopeId:'e',taskId:'second'} as any),/scope mismatch/);
});
