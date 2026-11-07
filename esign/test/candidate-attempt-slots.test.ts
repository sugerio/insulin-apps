import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {unstable_splitSqlQuery} from 'wrangler';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';

test('candidate attempt slots are bounded, replayable and revocation guarded',async()=>{
 const built=await build({stdin:{contents:`import {reserveCandidateAttempt} from './src/candidate-attempt-slots.ts'; export default {async fetch(req,env){try {const db=req.headers.has('x-lose-response')?new Proxy(env.DB,{get(target,prop){if(prop==='batch')return async (...args)=>{await target.batch(...args);throw new Error('response lost')};const value=target[prop];return typeof value==='function'?value.bind(target):value}}):env.DB;return Response.json(await reserveCandidateAttempt(db,{sessionHash:'hash',tenantId:'a',envelopeId:'e',taskId:'t',origin:'https://host.example.com'},await req.text()))} catch {return new Response('unavailable',{status:503})}}}`,resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'browser',format:'esm',write:false});
 const mf=new Miniflare({modules:true,script:built.outputFiles[0].text,d1Databases:['DB']});
 try {
  const db=await mf.getD1Database('DB');for(const n of (await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort())await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${n}`,'utf8')).map(s=>db.prepare(s)));
  await db.exec(`INSERT INTO tenants VALUES ('a'); INSERT INTO templates VALUES ('p','a','src','["ana"]',1,'[]'); INSERT INTO envelopes VALUES ('e','a','p','IN_PROGRESS',1); INSERT INTO tasks VALUES ('t','e','ana','Ana','ana@example.com',1,'ACTIVE'); INSERT INTO tenant_page_origins VALUES ('a','https://host.example.com'); INSERT INTO recipient_page_sessions VALUES ('hash','a','e','t','https://host.example.com',CAST(unixepoch('subsec')*1000 AS INTEGER)+800000); INSERT INTO recipient_otp_verifications(task_id,session_hash,verified_at,recipient_email) VALUES ('t','hash',1,'ana@example.com');`);
  const run=(hash:string)=>mf.dispatchFetch('https://test.test/',{method:'POST',body:hash});
  await db.exec("CREATE TRIGGER revoke_slot AFTER INSERT ON candidate_v3_attempt_slots BEGIN INSERT INTO recipient_session_revocations VALUES ('hash',1); END");
  assert.equal((await run('a'.repeat(64))).status,503);assert.equal((await db.prepare('SELECT count(*) AS n FROM candidate_v3_attempt_slots').first<{n:number}>())?.n,0);assert.equal((await db.prepare('SELECT count(*) AS n FROM recipient_session_revocations').first<{n:number}>())?.n,0);await db.exec('DROP TRIGGER revoke_slot');
  const lost=await mf.dispatchFetch('https://test.test/',{method:'POST',headers:{'x-lose-response':'1'},body:'a'.repeat(64)});assert.equal(lost.status,503);
  const first=await run('a'.repeat(64));assert.equal(first.status,200);const id=await first.json();
  const same=await Promise.all(Array.from({length:4},()=>run('a'.repeat(64))));for(const r of same){assert.equal(r.status,200);assert.deepEqual(await r.json(),id);}
  const others=await Promise.all(['b','c','d','e','f'].map(c=>run(c.repeat(64))));assert.equal(others.filter(r=>r.status===200).length,4);assert.equal(others.filter(r=>r.status===503).length,1);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM candidate_v3_attempt_slots').first<{n:number}>())?.n,5);
  const before=await db.prepare('SELECT * FROM candidate_v3_attempt_slots ORDER BY slot').all();
  for(const sql of ["UPDATE candidate_v3_attempt_slots SET request_hash='changed' WHERE slot=1", "UPDATE candidate_v3_attempt_slots SET slot=1 WHERE slot=1", "DELETE FROM candidate_v3_attempt_slots WHERE slot=1"]) await assert.rejects(db.prepare(sql).run());
  assert.deepEqual((await db.prepare('SELECT * FROM candidate_v3_attempt_slots ORDER BY slot').all()).results,before.results);
  assert.equal((await run('a'.repeat(64))).status,200);
  await db.exec("INSERT INTO recipient_session_revocations VALUES ('hash',1)");assert.equal((await run('a'.repeat(64))).status,503);
 }finally{await mf.dispose();}
});

test('immutable attempt migration preserves existing reservations',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response()}}',d1Databases:['DB']});
 try {
  const db=await mf.getD1Database('DB');
  const names=(await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort();
  for(const n of names.filter(n=>!n.startsWith('0032_'))) await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${n}`,'utf8')).map(s=>db.prepare(s)));
  await db.prepare("INSERT INTO candidate_v3_attempt_slots VALUES ('a','e','t',?,3)").bind('a'.repeat(64)).run();
  const before=(await db.prepare('SELECT * FROM candidate_v3_attempt_slots').all()).results;
  const migration=names.find(n=>n.startsWith('0032_'))!;
  await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${migration}`,'utf8')).map(s=>db.prepare(s)));
  assert.deepEqual((await db.prepare('SELECT * FROM candidate_v3_attempt_slots').all()).results,before);
  await assert.rejects(db.prepare('DELETE FROM candidate_v3_attempt_slots').run());
 }finally{await mf.dispose();}
});
