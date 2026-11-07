import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {unstable_splitSqlQuery} from 'wrangler';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';

test('candidate recovery transaction guard rolls back on management revocation or credential collision',async()=>{
 const built=await build({stdin:{contents:`import {candidateRecoveryAuthorizationAssertion} from './src/candidate-recovery-authorization.ts'; export default {async fetch(req,env){try {await env.DB.batch([candidateRecoveryAuthorizationAssertion(env.DB,{keyHash:'key',tenantId:'a',envelopeId:'e'}),env.DB.prepare("INSERT INTO test_recovery_writes VALUES (1)"),candidateRecoveryAuthorizationAssertion(env.DB,{keyHash:'key',tenantId:'a',envelopeId:'e'}),env.DB.prepare('DELETE FROM recipient_auth_assertions')]);return new Response('ok')}catch{return new Response('unavailable',{status:503})}}}`,resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'browser',format:'esm',write:false});
 const mf=new Miniflare({modules:true,script:built.outputFiles[0].text,d1Databases:['DB']});
 try {
  const db=await mf.getD1Database('DB');for(const n of (await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort())await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${n}`,'utf8')).map(s=>db.prepare(s)));
  await db.exec(`INSERT INTO tenants VALUES ('a'),('b'); INSERT INTO templates VALUES ('p','a','src','["ana"]',1,'[]'); INSERT INTO envelopes VALUES ('e','a','p','IN_PROGRESS',1); INSERT INTO api_keys (key_hash,tenant_id) VALUES ('key','a'); CREATE TABLE test_recovery_writes (n INTEGER);`);
  const run=()=>mf.dispatchFetch('https://test.test/',{method:'POST'});
  assert.equal((await run()).status,200);await db.exec('DELETE FROM test_recovery_writes');
  for(const change of ["UPDATE api_keys SET revoked_at=1 WHERE key_hash='key'", "INSERT INTO editor_codes (code_hash,tenant_id,expires_at) VALUES ('key','b',1)"]){
   await db.exec(`CREATE TRIGGER test_revoke AFTER INSERT ON test_recovery_writes BEGIN ${change}; END`);
   assert.equal((await run()).status,503);assert.equal((await db.prepare('SELECT count(*) AS n FROM test_recovery_writes').first<{n:number}>())?.n,0);await db.exec('DROP TRIGGER test_revoke');
  }
  await db.exec("UPDATE envelopes SET tenant_id='b' WHERE id='e'");assert.equal((await run()).status,503);
 }finally{await mf.dispose();}
});
