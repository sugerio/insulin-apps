import {unstable_splitSqlQuery} from 'wrangler';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare} from 'miniflare';

test('v3 migration preserves historical events and foreign key constraints',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB']});
 try{
  const db=await mf.getD1Database('DB');
  const apply=async(name:string)=>{const sql=await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8');await db.batch(unstable_splitSqlQuery(sql).map(s=>db.prepare(s)));};
  for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')&&n<'0020').sort())await apply(name);
  await db.batch([
   db.prepare("INSERT INTO tenants(id) VALUES ('tenant')"),
   db.prepare("INSERT INTO templates(id,tenant_id,object_key,roles_json,created_at) VALUES ('template','tenant','object','[]',0)"),
   db.prepare("INSERT INTO envelopes(id,tenant_id,template_id,status,created_at) VALUES ('envelope','tenant','template','IN_PROGRESS',0)"),
   ...[1,2,3].flatMap(i=>[
    db.prepare(`INSERT INTO tasks(id,envelope_id,role,recipient_name,recipient_email,routing_order,status) VALUES ('task${i}','envelope','role${i}','Synthetic','a@example.com',${i},'SIGNED')`),
    db.prepare(`INSERT INTO recipient_page_sessions(token_hash,tenant_id,envelope_id,task_id,origin,expires_at) VALUES ('session${i}','tenant','envelope','task${i}','https://example.com',100)`),
    db.prepare(`INSERT INTO signature_records(id,envelope_id,task_id,sequence,session_hash,recipient_name,input_artifact_id,input_sha256,otp_verified_at,consented_at) VALUES ('signature${i}','envelope','task${i}',${i},'session${i}','Synthetic','artifact','hash',1,2)`)
   ]),
   db.prepare("INSERT INTO signature_events(signature_id,envelope_id,sequence,previous_hash,event_hash,event_version) VALUES ('signature1','envelope',1,'','hash1',1),('signature2','envelope',2,'hash1','hash2',2)"),
   db.prepare("INSERT INTO positioned_signature_inputs VALUES ('signature2','input',1,'{\"historical\":true}')")
  ]);
  const before=(await db.prepare('SELECT * FROM signature_events ORDER BY sequence').all()).results;
  const payload=(await db.prepare('SELECT * FROM positioned_signature_inputs').all()).results;
  await apply('0020_positioned_v3_events.sql');
  assert.deepEqual((await db.prepare('SELECT * FROM signature_events ORDER BY sequence').all()).results,before);
  assert.deepEqual((await db.prepare('SELECT * FROM positioned_signature_inputs').all()).results,payload);
  await db.prepare("INSERT INTO signature_events VALUES ('signature3','envelope',3,'hash2','hash3',3)").run();
  await assert.rejects(()=>db.prepare("UPDATE signature_events SET event_version=4 WHERE signature_id='signature3'").run());
  await assert.rejects(()=>db.prepare("UPDATE signature_events SET envelope_id='missing' WHERE signature_id='signature3'").run());
  await assert.rejects(()=>db.prepare("UPDATE signature_events SET signature_id='missing' WHERE signature_id='signature3'").run());
  await assert.rejects(()=>db.prepare("UPDATE signature_events SET sequence=2 WHERE signature_id='signature3'").run());
  assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
 }finally{await mf.dispose();}
});
