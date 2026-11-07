import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {issueRecipientCode,exchangeRecipientCode} from '../src/page-authorization.ts';
const candidate=await import('../src/synthetic-cloudflare-otp-test.ts').catch(()=>({}));

test('unmounted synthetic OTP wiring reaches only a local Cloudflare Email simulation and R2',async()=>{
 assert.equal(typeof candidate.sendSyntheticCloudflareOtpTest,'function','synthetic Cloudflare OTP wiring is missing');
 const source=`import {sendSyntheticCloudflareOtpTest} from './src/synthetic-cloudflare-otp-test.ts';import {putArtifact} from './src/artifact-store.ts';export default {async fetch(req,env){try{const body=await req.json();if(body.action==='otp'){await sendSyntheticCloudflareOtpTest(env.DB,env.SEND_EMAIL,body.token,body.origin,body.now,new TextEncoder().encode('synthetic-test-pepper-not-a-production-secret'));return Response.json({status:'SYNTHETIC_ONLY'});}if(body.action==='r2'){const result=await putArtifact(env.ARTIFACTS,'synthetic/input',new TextEncoder().encode('synthetic document'));return Response.json(result);}return new Response(null,{status:404});}catch{return Response.json({error:'unavailable'},{status:503});}}}`;
 const built=await build({stdin:{contents:source,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser'});
 const mf=new Miniflare({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-01-01',d1Databases:['DB'],r2Buckets:['ARTIFACTS'],email:{send_email:[{name:'SEND_EMAIL',allowed_sender_addresses:['sign@example.com'],allowed_destination_addresses:['ana@example.com']}]}});
 try{
  const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('ARTIFACTS');
  for(const name of ['0001_tenants.sql','0002_templates.sql','0003_envelopes.sql','0006_page_authorization.sql','0009_otp_lifecycle.sql','0025_otp_recipient_binding.sql','0029_recipient_session_revocations.sql','0030_recipient_code_revocations.sql', '0050_task_expiry.sql']){const sql=await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8');await db.batch(sql.split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));}
  await db.exec(`INSERT INTO tenants VALUES ('tenant');INSERT INTO templates VALUES ('template','tenant','source','["ana"]',1);INSERT INTO envelopes VALUES ('envelope','tenant','template','IN_PROGRESS',1);INSERT INTO tasks VALUES ('task','envelope','ana','Ana','ana@example.com',1,'ACTIVE');INSERT INTO tenant_page_origins VALUES ('tenant','https://host.example.com');`);
  const now=Date.now(),origin='https://host.example.com',code=await issueRecipientCode(db,{tenantId:'tenant',envelopeId:'envelope',taskId:'task',origin,now}),token=await exchangeRecipientCode(db,code,origin,now+1);
  const request=(body:unknown)=>mf.dispatchFetch('https://local.test/',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const artifact=await request({action:'r2'});assert.equal(artifact.status,200);assert.equal(await (await bucket.get('synthetic/input'))!.text(),'synthetic document');assert.equal((await request({action:'r2'})).status,503);
  const invalid=await request({action:'otp',token,origin:'https://other.example.com',now:now+2});assert.equal(invalid.status,503);assert.equal((await db.prepare('SELECT count(*) AS n FROM recipient_otp_challenges').first())!.n,0);
  await db.prepare("UPDATE tasks SET recipient_email='bob@example.com' WHERE id='task'").run();assert.equal((await request({action:'otp',token,origin,now:now+2})).status,503);assert.equal((await db.prepare('SELECT count(*) AS n FROM recipient_otp_challenges').first())!.n,0);await db.prepare("UPDATE tasks SET recipient_email='ana@example.com' WHERE id='task'").run();
  let calls=0;const failing={send:async()=>{calls++;throw new Error('synthetic provider failure');}},pepper=new TextEncoder().encode('synthetic-test-pepper-not-a-production-secret');
  await assert.rejects(()=>candidate.sendSyntheticCloudflareOtpTest!(db,failing,token,origin,now+2,pepper),{message:'Email delivery failed'});assert.equal(calls,1);assert.equal((await db.prepare('SELECT sends FROM recipient_otp_challenges').first())!.sends,1);
  await assert.rejects(()=>candidate.sendSyntheticCloudflareOtpTest!(db,failing,token,origin,now+3,pepper));assert.equal(calls,1,'ambiguous send still consumes the cooldown');
  const sent=await request({action:'otp',token,origin,now:now+60002});assert.equal(sent.status,200);const body=await sent.json();assert.deepEqual(body,{status:'SYNTHETIC_ONLY'});assert.equal((await db.prepare('SELECT count(*) AS n FROM recipient_otp_challenges').first())!.n,1);
  const replay=await request({action:'otp',token,origin,now:now+60003});assert.equal(replay.status,503);assert.equal((await db.prepare('SELECT sends FROM recipient_otp_challenges').first())!.sends,2);
 }finally{await mf.dispose();}
});
