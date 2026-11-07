import {unstable_splitSqlQuery} from 'wrangler';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {PDFDocument} from 'pdf-lib';
import app,{createV3TestApp} from '../src/worker.ts';
import {canonicalSignatureEvent} from '../src/signature-event.ts';
import {canonicalPositionedV3} from '../src/positioned-v3-snapshot.ts';
import {processPositionedSignatureJob} from '../src/positioned-signature-processing.ts';
import {processPositionedV3Job} from '../src/positioned-v3-processing.ts';
import {recordPositionedSignature} from '../src/positioned-signature-record.ts';
import {recordPositionedV3Signature} from '../src/positioned-v3-record.ts';

const sha=async(bytes:Uint8Array)=>Buffer.from(await crypto.subtle.digest('SHA-256',Uint8Array.from(bytes))).toString('hex');

test('historical 24-point v2/v3 pending and done snapshots fail closed without altering facts or PDFs', {timeout:120000},async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB'],r2Buckets:['ARTIFACTS','TEST_MAIL']});
 try{
  const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('ARTIFACTS'),mail=await mf.getR2Bucket('TEST_MAIL');
  for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort()){const sql=await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8');await db.batch(unstable_splitSqlQuery(sql).map(s=>db.prepare(s)));}
  const key='local-test-key-0123456789-abcdefghijklmnopqrstuvwxyz',origin='https://host.example.com',auth={authorization:`Bearer ${key}`};
  await db.batch([db.prepare("INSERT INTO tenants VALUES ('a')"),db.prepare("INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,'a')").bind(await sha(new TextEncoder().encode(key))),db.prepare("INSERT INTO tenant_page_origins VALUES ('a',?)").bind(origin)]);
  const env={DB:db,ARTIFACTS:bucket,TEST_MAIL:mail,LOCAL_TEST_MODE:'true',LOCAL_TEST_OTP_KEY:'local-test-pepper-at-least-32-bytes'};
  const post=(body:unknown,headers:Record<string,string>)=>({method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)});
  for(const version of [2,3] as const)for(const height of [27,64])for(const status of ['PENDING','DONE'] as const){
   const worker=version===2?app:createV3TestApp(),req=(path:string,init:RequestInit={})=>worker.fetch(new Request('http://localhost'+path,init),env),label=`v${version}/${height}/${status}`;
   const pdf=await PDFDocument.create();pdf.addPage([600,800]);const source=await pdf.save();const form=new FormData();form.set('file',new File([source],'synthetic.pdf'));form.set('roles','["ana","bob"]');const template=await (await req('/v1/templates',{method:'POST',headers:auth,body:form})).json();
   const fields=[{id:'a',type:'Signature',role:'ana',page:1,required:true,rect:{x:.05,y:.1,width:.25,height:.08}},{id:'b',type:'Signature',role:'bob',page:1,required:true,rect:{x:.05,y:.7,width:.25,height:.08}},...(version===3?[{id:'date',type:'Date signed',role:'ana',page:1,required:true,rect:{x:.35,y:.1,width:.35,height:.08}}]:[])];
   await db.prepare('UPDATE templates SET fields_json=? WHERE id=?').bind(JSON.stringify(fields),template.id).run();
   const created=await req('/v1/envelopes',post({templateId:template.id,recipients:[{role:'ana',name:'Ana',email:'ana@example.com'},{role:'bob',name:'Bob',email:'bob@example.com'}]},{...auth,'idempotency-key':`legacy-${version}-${height}-${status}`}));assert.equal(created.status,201,label);const envelope=await created.json();assert.equal((await req(`/v1/envelopes/${envelope.id}/prepare`,{method:'POST',headers:auth})).status,204);
   const tasks=(await (await req(`/v1/envelopes/${envelope.id}`,{headers:auth})).json()).tasks;
   const sessionFor=async(index:number)=>{const view=await (await req(`/v1/envelopes/${envelope.id}/tasks/${tasks[index].id}/recipient-view`,post({origin},auth))).json();const session=await (await req('/v1/page-sessions/exchange',post({code:view.code},{origin}))).json();const headers={origin,authorization:`Bearer ${session.token}`};const sent=await (await req('/v1/signing/otp',post({},headers))).json();const message=await (await mail.get(`test-mail/${sent.messageId}.json`))!.json() as {otp:string};assert.equal((await req('/v1/signing/otp/verify',post({otp:message.otp},headers))).status,204,label);return {token:session.token,headers};};
   const first=await sessionFor(0),current=await (await req('/v1/signing/current',{headers:first.headers})).json(),preview=await req('/v1/signing/signature-preview',post({fieldId:'a',text:'Ana'},first.headers));assert.equal(preview.status,200,label);
   const datePreview=version===3?await req('/v1/signing/text-preview',post({fieldId:'date'},first.headers)):null;if(datePreview)assert.equal(datePreview.status,200,label);
   const signed=await req('/v1/signing/sign',post({artifactId:current.id,artifactHash:current.sha256,consent:true,signatures:{a:'Ana'},signaturePreviews:{a:preview.headers.get('X-Signature-Preview')},...(datePreview?{datePreviewIds:{date:datePreview.headers.get('X-Date-Preview-Id')}}:{})},first.headers));assert.equal(signed.status,202,label);const {id}=await signed.json();
   const row=await db.prepare('SELECT r.*,e.event_hash,e.previous_hash,p.payload_json,p.input_object_key,j.id AS job_id FROM signature_records r JOIN signature_events e ON e.signature_id=r.id JOIN positioned_signature_inputs p ON p.signature_id=r.id JOIN signature_jobs j ON j.signature_id=r.id WHERE r.id=?').bind(id).first<any>();assert.ok(row);
   // Construct an internally consistent synthetic old-format record, not a corrupted hash.
   const payload=JSON.parse(row.payload_json);for(const f of payload.templateFields)f.rect.height=height/800;for(const f of payload.fields){f.rect.height=height/800;if(f.id==='a'){f.geometry.width*=24/30;f.geometry.height=24;}}
   const event={envelopeId:row.envelope_id,sequence:row.sequence,previousHash:row.previous_hash,signatureId:row.id,taskId:row.task_id,recipientName:row.recipient_name,artifactId:row.input_artifact_id,artifactHash:row.input_sha256,otpVerifiedAt:row.otp_verified_at,consentedAt:row.consented_at};
   const canonical=version===2?canonicalSignatureEvent(event,payload):canonicalPositionedV3(event,payload),eventHash=await sha(new TextEncoder().encode(canonical));
   await db.batch([db.prepare('UPDATE templates SET fields_json=? WHERE id=?').bind(JSON.stringify(payload.templateFields),template.id),db.prepare('UPDATE positioned_signature_inputs SET payload_json=? WHERE signature_id=?').bind(JSON.stringify(payload),id),db.prepare('UPDATE signature_events SET event_hash=? WHERE signature_id=?').bind(eventHash,id)]);
   let oldOutput:{artifact_id:string;object_key:string;sha256:string}|undefined;
   if(status==='DONE'){
    const old=await PDFDocument.load(source,{updateMetadata:false});const page=old.getPage(0);
    for(const f of payload.fields){const image=await bucket.get(`envelopes/${envelope.id}/signature-images/${id}/${f.id}.png`);assert.ok(image);const png=await old.embedPng(await image.arrayBuffer()),h=f.id==='a'?24:27,w=png.width*h/png.height;page.drawImage(png,{x:f.rect.x*600,y:800-f.rect.y*800-h,width:w,height:h});}
    const bytes=await old.save({useObjectStreams:false}),object_key=`envelopes/${envelope.id}/signed:${id}.pdf`;oldOutput={artifact_id:`signed:${id}`,object_key,sha256:await sha(bytes)};await bucket.put(object_key,bytes);
    await db.batch([db.prepare('INSERT INTO signature_outputs VALUES (?,?,?,?)').bind(row.job_id,oldOutput.artifact_id,object_key,oldOutput.sha256),db.prepare("UPDATE signature_jobs SET status='DONE' WHERE id=?").bind(row.job_id),db.prepare("UPDATE tasks SET status='ACTIVE' WHERE id=?").bind(tasks[1].id)]);
   }
   // A real pending predecessor keeps the next task unavailable. Also simulate
   // an incorrectly activated next task to exercise the record-layer guard.
   if(status==='PENDING'){
    assert.equal((await req(`/v1/envelopes/${envelope.id}/tasks/${tasks[1].id}/recipient-view`,post({origin},auth))).status,404,label);
    await db.prepare("UPDATE tasks SET status='ACTIVE' WHERE id=?").bind(tasks[1].id).run();
   }
   const second=await sessionFor(1);
   const tables=['signature_records','signature_events','positioned_signature_inputs','signature_jobs','signature_outputs'] as const;
   const before=await Promise.all(tables.map(async t=>JSON.stringify((await db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()).results)));
   const objects=(await bucket.list({prefix:`envelopes/${envelope.id}/`})).objects;const bytesBefore=await Promise.all(objects.map(async o=>[o.key,Buffer.from(await (await bucket.get(o.key))!.arrayBuffer()).toString('base64')]));
   const process=()=>version===2?processPositionedSignatureJob(db,bucket,row.job_id):processPositionedV3Job(db,bucket,row.job_id);
   await assert.rejects(process,/Signature geometry mismatch/,`${label}: valid old snapshot must fail on changed geometry`);
   assert.equal((await req(`/v1/envelopes/${envelope.id}/process`,{method:'POST',headers:auth})).status,503,label);
   const command={token:second.token,origin,now:Date.now(),artifactId:oldOutput?.artifact_id??current.id,artifactHash:oldOutput?.sha256??current.sha256};
   await assert.rejects(()=>version===2?recordPositionedSignature(db,bucket,{...command,signatures:{b:'Bob'}}):recordPositionedV3Signature(db,bucket,{...command,values:{b:'Bob'}}),status==='DONE'?/Signature geometry mismatch/:/Incomplete predecessor/,`${label}: predecessor must be revalidated before new facts`);
   const sign=await req('/v1/signing/sign',post({artifactId:command.artifactId,artifactHash:command.artifactHash,consent:true,signatures:{b:'Bob'},signaturePreviews:{b:'0'.repeat(64)}},second.headers));assert.equal(sign.status,409,label);
   assert.deepEqual(await Promise.all(tables.map(async t=>JSON.stringify((await db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()).results))),before,`${label}: existing event bytes and signing facts unchanged`);
   assert.deepEqual(await Promise.all(objects.map(async o=>[o.key,Buffer.from(await (await bucket.get(o.key))!.arrayBuffer()).toString('base64')])),bytesBefore,`${label}: existing PDF and evidence bytes unchanged`);
   assert.deepEqual((await bucket.list({prefix:`envelopes/${envelope.id}/`})).objects.map(o=>o.key).sort(),objects.map(o=>o.key).sort(),`${label}: no new objects`);
  }
 }finally{await mf.dispose();}
});
