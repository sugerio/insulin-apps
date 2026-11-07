import {unstable_splitSqlQuery} from 'wrangler';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {makeLocalTestSeal,finalizeLocalTestEvidence} from '../src/local-test-evidence.ts';

const hash=(data:string|Uint8Array)=>createHash('sha256').update(data).digest('hex');
test('pre-v2 completed v1 evidence verifies after migration without rewriting any object',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB'],r2Buckets:['ARTIFACTS']});
 try{const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('ARTIFACTS');const migrations=(await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort();const apply=async(name:string)=>{const sql=await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8');await db.batch(unstable_splitSqlQuery(sql).map(s=>db.prepare(s)));};for(const name of migrations.filter(n=>n<'0017'))await apply(name);
  const sourceBytes=new TextEncoder().encode('synthetic v1 source'),outputBytes=new TextEncoder().encode('synthetic v1 output'),source={id:'d0',object_key:'d0.pdf',sha256:hash(sourceBytes)};await bucket.put(source.object_key,sourceBytes);await bucket.put('d1.pdf',outputBytes);
  const eventHash=hash(JSON.stringify(['esign-signature-event-v1','env',1,'','sig','task','Ana','d0',source.sha256,1000,1001]));
  await db.exec(`INSERT INTO tenants VALUES ('tenant');INSERT INTO templates(id,tenant_id,object_key,roles_json,created_at) VALUES ('tpl','tenant','source','["ana"]',1);INSERT INTO envelopes VALUES ('env','tenant','tpl','COMPLETED',1);INSERT INTO tasks VALUES ('task','env','ana','Ana','ana@example.com',1,'SIGNED');INSERT INTO recipient_page_sessions VALUES ('session','tenant','env','task','https://host.example.com',999999);INSERT INTO artifacts VALUES ('d0','env','d0.pdf','${source.sha256}');INSERT INTO signature_records VALUES ('sig','env','task',1,'session','Ana','d0','${source.sha256}',1000,1001);INSERT INTO signature_events (signature_id,envelope_id,sequence,previous_hash,event_hash) VALUES ('sig','env',1,'','${eventHash}');INSERT INTO signature_jobs VALUES ('job','sig','DONE');INSERT INTO signature_outputs VALUES ('job','d1','d1.pdf','${hash(outputBytes)}');`);
  const signatures=[{id:'sig',sequence:1,task_id:'task',recipient_name:'Ana',input_artifact_id:'d0',input_sha256:source.sha256,otp_verified_at:1000,consented_at:1001,previous_hash:'',event_hash:eventHash,artifact_id:'d1',object_key:'d1.pdf',sha256:hash(outputBytes)}];
  const manifest=JSON.stringify({format:'esign-local-test-manifest-v1',envelopeId:'env',source,signatures,finalArtifactId:'d1',finalSha256:hash(outputBytes)}),key=new TextEncoder().encode('local-test-seal-key-at-least-32-bytes'),seal=await makeLocalTestSeal(manifest,key,1001),evidence=new TextEncoder().encode(JSON.stringify(seal));await bucket.put('envelopes/env/local-test-evidence.json',evidence);await db.prepare('INSERT INTO local_test_evidence VALUES (?,?,?)').bind('env','envelopes/env/local-test-evidence.json',hash(evidence)).run();
  await apply('0017_positioned_signatures.sql');const verified=await finalizeLocalTestEvidence(db,bucket,'tenant','env',key,true);assert.equal(verified?.finalSha256,hash(outputBytes));assert.deepEqual(new Uint8Array(await (await bucket.get('envelopes/env/local-test-evidence.json'))!.arrayBuffer()),evidence);assert.deepEqual(new Uint8Array(await (await bucket.get('d1.pdf'))!.arrayBuffer()),outputBytes);assert.equal((await db.prepare('SELECT event_version FROM signature_events').first())!.event_version,1);
 }finally{await mf.dispose();}
});
