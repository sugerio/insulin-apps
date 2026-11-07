// Deliberately omit 0027 in these isolated fixtures to exercise defense in depth under task tampering.
import {unstable_splitSqlQuery} from 'wrangler';
import {positionedV3TextGeometry} from '../src/positioned-v3-text-fit.ts';
import {signaturePreviewHash} from '../src/positioned-signature-preview.ts';
import {signatureGeometry} from '../src/positioned-signature-geometry.ts';
import {renderTypedSignature} from '../src/typed-signature-image.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {PDFDocument} from 'pdf-lib';
import app from '../src/worker.ts';
import {recordPositionedV3Signature} from '../src/positioned-v3-record.ts';
import {canonicalPositionedV3,validatePositionedV3} from '../src/positioned-v3-snapshot.ts';
import {processPositionedV3Job} from '../src/positioned-v3-processing.ts';
import {retryPositionedV3Signature} from '../src/positioned-v3-retry.ts';
import {finalizeLocalTestEvidence} from '../src/local-test-evidence.ts';
import {renderPositionedV3Text} from '../src/positioned-v3-text-render.ts';

const sha=async(bytes:Uint8Array)=>Buffer.from(await crypto.subtle.digest('SHA-256',Uint8Array.from(bytes))).toString('hex');
test('unmounted v3 transaction captures only the verified current role, time and image hashes atomically',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB'],r2Buckets:['ARTIFACTS','TEST_MAIL']});
 try{
  const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('ARTIFACTS'),mail=await mf.getR2Bucket('TEST_MAIL');
  for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')&&!n.startsWith('0027_')).sort()){const sql=await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8');await db.batch(unstable_splitSqlQuery(sql).map(s=>db.prepare(s)));}
  const key='local-test-key-0123456789-abcdefghijklmnopqrstuvwxyz',origin='https://host.example.com';
  await db.batch([db.prepare("INSERT INTO tenants VALUES ('tenant')"),db.prepare("INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,'tenant')").bind(await sha(new TextEncoder().encode(key))),db.prepare("INSERT INTO tenant_page_origins VALUES ('tenant',?)").bind(origin)]);
  const env={DB:db,ARTIFACTS:bucket,TEST_MAIL:mail,LOCAL_TEST_MODE:'true',LOCAL_TEST_OTP_KEY:'local-test-pepper-at-least-32-bytes',LOCAL_TEST_SEAL_KEY:'local-test-seal-key-at-least-32-bytes'};
  const req=(path:string,init:RequestInit={})=>app.fetch(new Request('http://localhost'+path,init),env),mgmt={authorization:`Bearer ${key}`};
  const post=(body:unknown,headers:Record<string,string>)=>({method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)});
  const pdf=await PDFDocument.create();pdf.addPage([600,800]);const form=new FormData();form.set('file',new File([await pdf.save()],'synthetic.pdf'));form.set('roles','["ana","bob"]');
  const template=await (await req('/v1/templates',{method:'POST',headers:mgmt,body:form})).json();
  const fields=[{id:'sig-a',type:'Signature',role:'ana',page:1,required:true,rect:{x:.05,y:.1,width:.25,height:.08}},{id:'sig-b',type:'Signature',role:'bob',page:1,required:true,rect:{x:.05,y:.7,width:.25,height:.08}}];
  await db.prepare('UPDATE templates SET fields_json=? WHERE id=?').bind(JSON.stringify(fields),template.id).run();
  const created=await req('/v1/envelopes',post({templateId:template.id,recipients:[{role:'ana',name:'Ana',email:'ana@example.com'},{role:'bob',name:'Bob',email:'bob@example.com'}]},{...mgmt,'idempotency-key':'v3-fixture'}));assert.equal(created.status,201);const envelope=await created.json();
  assert.equal((await req(`/v1/envelopes/${envelope.id}/prepare`,{method:'POST',headers:mgmt})).status,204);
  const tasks=(await (await req(`/v1/envelopes/${envelope.id}`,{headers:mgmt})).json()).tasks;
  const view=await (await req(`/v1/envelopes/${envelope.id}/tasks/${tasks[0].id}/recipient-view`,post({origin},mgmt))).json();
  const session=await (await req('/v1/page-sessions/exchange',post({code:view.code},{origin}))).json();const headers={origin,authorization:`Bearer ${session.token}`};
  const sent=await (await req('/v1/signing/otp',post({},headers))).json(),message=await (await mail.get(`test-mail/${sent.messageId}.json`))!.json() as {otp:string};assert.equal((await req('/v1/signing/otp/verify',post({otp:message.otp},headers))).status,204);
  const current=await (await req('/v1/signing/current',{headers})).json();
  const updated=[...fields,{id:'date-a',type:'Date signed',role:'ana',page:1,required:true,rect:{x:.35,y:.1,width:.3,height:.08}},{id:'title-a',type:'Title',role:'ana',page:1,required:true,rect:{x:.05,y:.3,width:.4,height:.08}}];
  await db.prepare('UPDATE templates SET fields_json=? WHERE id=?').bind(JSON.stringify(updated),template.id).run();
  const receipt=async(artifactHash:string,field:typeof fields[number],text:string)=>{const image=await renderTypedSignature(text);return signaturePreviewHash(artifactHash,JSON.stringify(['ana','bob']),JSON.stringify(updated),field.id,text,await sha(image),signatureGeometry(pdf.getPage(0),field,image));};
  const titleImage=await renderPositionedV3Text('Director'),titleReceipt=await signaturePreviewHash(current.sha256,JSON.stringify(['ana','bob']),JSON.stringify(updated),'title-a','Director',await sha(titleImage),positionedV3TextGeometry(pdf.getPage(0),updated[3],titleImage));
  const now=Date.now(),previewId=crypto.randomUUID(),sessionHash=await sha(new TextEncoder().encode(session.token)),date=new Date(now).toISOString().slice(0,10);await db.prepare('INSERT INTO positioned_v3_date_previews(session_hash,field_id,preview_id,date_text,image_sha256,artifact_id,artifact_sha256,roles_json,fields_json,expires_at,geometry_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(sessionHash,'date-a',previewId,date,await sha(await renderPositionedV3Text(date)),current.id,current.sha256,JSON.stringify(['ana','bob']),JSON.stringify(updated),now+300000,JSON.stringify(positionedV3TextGeometry(pdf.getPage(0),updated[2],await renderPositionedV3Text(date)))).run();const base={token:session.token,origin,now,artifactId:current.id,artifactHash:current.sha256,datePreviewIds:{'date-a':previewId},signaturePreviews:{'sig-a':await receipt(current.sha256,fields[0],'ANA')},textPreviews:{'title-a':titleReceipt}};
  for(const values of [{"sig-a":"ANA"},{"sig-a":"ANA","title-a":"Director","sig-b":"BOB"},{"sig-a":"ANA","title-a":"Director","date-a":"client"},{"sig-a":"ANA","title-a":"x".repeat(128)}])await assert.rejects(()=>recordPositionedV3Signature(db,bucket,{...base,values}));
  await assert.rejects(()=>recordPositionedV3Signature(db,bucket,{...base,origin:'https://wrong.example.com',values:{'sig-a':'ANA','title-a':'Director'}}));
  await assert.rejects(()=>recordPositionedV3Signature(db,bucket,{...base,artifactHash:'0'.repeat(64),values:{'sig-a':'ANA','title-a':'Director'}}));
  assert.equal((await db.prepare('SELECT count(*) AS n FROM signature_records').first())!.n,0);
  const values={'sig-a':'ANA','title-a':'Director'};
  await db.prepare('UPDATE recipient_otp_verifications SET recipient_email=NULL WHERE task_id=?').bind(tasks[0].id).run();
  await assert.rejects(()=>recordPositionedV3Signature(db,bucket,{...base,values}),'historical unbound verification must not authorize signing');
  await db.prepare('UPDATE recipient_otp_verifications SET recipient_email=? WHERE task_id=?').bind('ana@example.com',tasks[0].id).run();
  await db.prepare('UPDATE tasks SET recipient_email=? WHERE id=?').bind('other@example.test',tasks[0].id).run();
  await assert.rejects(()=>recordPositionedV3Signature(db,bucket,{...base,values}),'a changed recipient must not use an earlier OTP verification');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM signature_records').first())!.n,0);
  await db.prepare('UPDATE tasks SET recipient_email=? WHERE id=?').bind('ana@example.com',tasks[0].id).run();
  let changedRecipient=false;const recipientRace=new Proxy(db,{get(target,key){if(key==='batch')return async (statements:D1PreparedStatement[])=>{if(!changedRecipient){changedRecipient=true;await target.prepare('UPDATE tasks SET recipient_email=? WHERE id=?').bind('other@example.test',tasks[0].id).run();await target.prepare('UPDATE recipient_otp_verifications SET recipient_email=? WHERE task_id=?').bind('other@example.test',tasks[0].id).run();}return target.batch(statements);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  await assert.rejects(()=>recordPositionedV3Signature(recipientRace,bucket,{...base,values}),'recipient changed before signing commit must be rejected');assert.equal(changedRecipient,true);assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM signature_records').first())!.n,0);
  await db.prepare('UPDATE tasks SET recipient_email=? WHERE id=?').bind('ana@example.com',tasks[0].id).run();
  await db.prepare('UPDATE recipient_otp_verifications SET recipient_email=? WHERE task_id=?').bind('ana@example.com',tasks[0].id).run();
  const verified=(await db.prepare('SELECT verified_at FROM recipient_otp_verifications WHERE task_id=?').bind(tasks[0].id).first<{verified_at:number}>())!.verified_at;
  await db.prepare('UPDATE recipient_otp_verifications SET verified_at=? WHERE task_id=?').bind(now+1,tasks[0].id).run();await assert.rejects(()=>recordPositionedV3Signature(db,bucket,{...base,values}));await db.prepare('UPDATE recipient_otp_verifications SET verified_at=? WHERE task_id=?').bind(verified,tasks[0].id).run();
  await db.prepare('UPDATE recipient_page_sessions SET expires_at=? WHERE task_id=?').bind(now,tasks[0].id).run();await assert.rejects(()=>recordPositionedV3Signature(db,bucket,{...base,values}));
  const boundary=await db.prepare(`WITH clock(ms) AS (SELECT CAST(unixepoch('subsec')*1000 AS INTEGER)) SELECT ms>ms AS equal_allowed,ms+1>ms AS next_allowed,ms-1>ms AS prior_allowed FROM clock`).first<{equal_allowed:number;next_allowed:number;prior_allowed:number}>();assert.deepEqual(boundary,{equal_allowed:0,next_allowed:1,prior_allowed:0});
  const times=await db.prepare(`SELECT CAST(unixepoch('2026-01-01 00:00:00.001','subsec')*1000 AS INTEGER) AS first,CAST(unixepoch('2026-01-01 00:00:00.999','subsec')*1000 AS INTEGER) AS last,CAST(unixepoch('2026-01-01 00:00:01.000','subsec')*1000 AS INTEGER) AS next`).first<{first:number;last:number;next:number}>();assert.equal(times!.first,Date.parse('2026-01-01T00:00:00.001Z'));assert.equal(times!.last,Date.parse('2026-01-01T00:00:00.999Z'));assert.equal(times!.next,Date.parse('2026-01-01T00:00:01.000Z'));
  const expiry=Date.now()+200;await db.prepare('UPDATE recipient_page_sessions SET expires_at=? WHERE task_id=?').bind(expiry,tasks[0].id).run();
  let writes=0;const slowBucket=new Proxy(bucket,{get(target,prop){if(prop==='put')return async (...args:Parameters<R2Bucket['put']>)=>{await new Promise(resolve=>setTimeout(resolve,Math.max(0,expiry-Date.now()+50)));const result=await (target.put as any)(...args);writes++;return result;};const value=Reflect.get(target,prop);return typeof value==='function'?value.bind(target):value;}}) as R2Bucket;
  await assert.rejects(()=>recordPositionedV3Signature(db,slowBucket,{...base,values}));assert.ok(writes>0,'rejection can leave pre-commit images');
  for(const table of ['signature_records','signature_events','signature_jobs'])assert.equal((await db.prepare(`SELECT count(*) AS n FROM ${table}`).first())!.n,0);
  await db.prepare('UPDATE recipient_page_sessions SET expires_at=? WHERE task_id=?').bind(Date.now()+600000,tasks[0].id).run();
  for(const [column,changed,restored] of [['expires_at',0,now+300000],['date_text','2000-01-01',date],['preview_id',crypto.randomUUID(),previewId],['geometry_json',JSON.stringify({x:1,y:1,width:1,height:33.75}),JSON.stringify(positionedV3TextGeometry(pdf.getPage(0),updated[2],await renderPositionedV3Text(date)))]] as const){let changedOnce=false;const changingBucket=new Proxy(bucket,{get(target,prop){if(prop==='put')return async (...args:Parameters<R2Bucket['put']>)=>{const result=await (target.put as any)(...args);if(!changedOnce){changedOnce=true;await db.prepare(`UPDATE positioned_v3_date_previews SET ${column}=? WHERE session_hash=? AND field_id='date-a'`).bind(changed,sessionHash).run();}return result;};const value=Reflect.get(target,prop);return typeof value==='function'?value.bind(target):value;}}) as R2Bucket;await assert.rejects(()=>recordPositionedV3Signature(db,changingBucket,{...base,values}),`${column} changed before commit`);assert.equal(changedOnce,true);for(const table of ['signature_records','signature_events','signature_jobs'])assert.equal((await db.prepare(`SELECT count(*) AS n FROM ${table}`).first())!.n,0);await db.prepare(`UPDATE positioned_v3_date_previews SET ${column}=? WHERE session_hash=? AND field_id='date-a'`).bind(restored,sessionHash).run();}
  const race=await Promise.allSettled([recordPositionedV3Signature(db,bucket,{...base,values}),recordPositionedV3Signature(db,bucket,{...base,values})]);
  assert.equal(race.filter(r=>r.status==='fulfilled').length,1);const id=(race.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<string>).value;
  const row=await db.prepare('SELECT r.*,e.event_hash,e.event_version,e.previous_hash,p.payload_json,p.input_page_count FROM signature_records r JOIN signature_events e ON e.signature_id=r.id JOIN positioned_signature_inputs p ON p.signature_id=r.id WHERE r.id=?').bind(id).first<any>();
  assert.equal(row.event_version,3);assert.equal(row.consented_at,now);const snapshot=validatePositionedV3(JSON.parse(row.payload_json),row.input_page_count,now);
  assert.deepEqual(snapshot.fields.map(f=>[f.id,f.text]),[['sig-a','ANA'],['date-a',new Date(now).toISOString().slice(0,10)],['title-a','Director']]);
  const canonical=canonicalPositionedV3({envelopeId:row.envelope_id,sequence:row.sequence,previousHash:row.previous_hash,signatureId:row.id,taskId:row.task_id,recipientName:row.recipient_name,artifactId:row.input_artifact_id,artifactHash:row.input_sha256,otpVerifiedAt:row.otp_verified_at,consentedAt:row.consented_at},snapshot);assert.equal(await sha(new TextEncoder().encode(canonical)),row.event_hash);
  for(const field of snapshot.fields){const obj=await bucket.get(`envelopes/${envelope.id}/signature-images/${id}/${field.id}.png`);assert.ok(obj);assert.equal(await sha(new Uint8Array(await obj.arrayBuffer())),field.imageHash);}
  assert.equal((await db.prepare('SELECT count(*) AS n FROM signature_jobs').first())!.n,1);assert.equal((await db.prepare('SELECT status FROM tasks WHERE id=?').bind(tasks[0].id).first())!.status,'SIGNED');
  assert.equal(await retryPositionedV3Signature(db,bucket,{...base,values}),id);
  await db.prepare('UPDATE signature_records SET otp_recipient_email=NULL WHERE id=?').bind(id).run();
  assert.equal(await retryPositionedV3Signature(db,bucket,{...base,values}),null,'historical signature without a recipient snapshot cannot be replayed');
  await db.prepare('UPDATE signature_records SET otp_recipient_email=? WHERE id=?').bind('ana@example.com',id).run();
  await db.prepare('UPDATE tasks SET recipient_email=? WHERE id=?').bind('other@example.test',tasks[0].id).run();
  assert.equal(await retryPositionedV3Signature(db,bucket,{...base,values}),null,'a changed recipient cannot replay a signature');
  await db.prepare('UPDATE recipient_otp_verifications SET recipient_email=? WHERE task_id=?').bind('other@example.test',tasks[0].id).run();
  assert.equal(await retryPositionedV3Signature(db,bucket,{...base,values}),null,'replacing verification cannot retarget an already recorded signature');
  await db.prepare('UPDATE tasks SET recipient_email=? WHERE id=?').bind('ana@example.com',tasks[0].id).run();
  await db.prepare('UPDATE recipient_otp_verifications SET recipient_email=? WHERE task_id=?').bind('ana@example.com',tasks[0].id).run();
  const source=await db.prepare('SELECT object_key FROM artifacts WHERE id=?').bind(current.id).first<{object_key:string}>();const sourceBytes=await (await bucket.get(source!.object_key))!.arrayBuffer();await bucket.put(source!.object_key,'tampered');assert.equal(await retryPositionedV3Signature(db,bucket,{...base,values}),null);await bucket.put(source!.object_key,sourceBytes);
  assert.equal(await retryPositionedV3Signature(db,bucket,{...base,values:{...values,'title-a':'Changed'}}),null);
  assert.equal(await retryPositionedV3Signature(db,bucket,{...base,values:{...values,'date-a':new Date(now).toISOString().slice(0,10)}}),null);
  assert.equal(await retryPositionedV3Signature(db,bucket,{...base,origin:'https://evil.example.com',values}),null);
  assert.equal(await retryPositionedV3Signature(db,bucket,{...base,artifactHash:'0'.repeat(64),values}),null);
  const job=await db.prepare('SELECT id FROM signature_jobs WHERE signature_id=?').bind(id).first<{id:string}>();
  // A self-consistent snapshot and PNG for another role must not be replayed
  // through Ana's authenticated session and signature task.
  const bobImage=await renderTypedSignature('BOB'),bobImageKey=`envelopes/${envelope.id}/signature-images/${id}/sig-b.png`;await bucket.put(bobImageKey,bobImage);
  const forgedRole={...snapshot,role:'bob',fields:[{id:'sig-b',type:'Signature',page:1,rect:fields[1].rect,text:'BOB',imageHash:await sha(bobImage),geometry:signatureGeometry(pdf.getPage(0),fields[1],bobImage)}]};
  validatePositionedV3(forgedRole,row.input_page_count,now);
  const forgedCanonical=canonicalPositionedV3({envelopeId:row.envelope_id,sequence:row.sequence,previousHash:row.previous_hash,signatureId:row.id,taskId:row.task_id,recipientName:row.recipient_name,artifactId:row.input_artifact_id,artifactHash:row.input_sha256,otpVerifiedAt:row.otp_verified_at,consentedAt:row.consented_at},forgedRole);
  await db.batch([db.prepare('UPDATE positioned_signature_inputs SET payload_json=? WHERE signature_id=?').bind(JSON.stringify(forgedRole),id),db.prepare('UPDATE signature_events SET event_hash=? WHERE signature_id=?').bind(await sha(new TextEncoder().encode(forgedCanonical)),id)]);
  const beforeForged=await db.prepare(`SELECT j.status AS job,t.status AS task,e.status AS envelope,(SELECT count(*) FROM signature_outputs) AS outputs FROM signature_jobs j JOIN signature_records r ON r.id=j.signature_id JOIN tasks t ON t.id=r.task_id JOIN envelopes e ON e.id=r.envelope_id WHERE j.id=?`).bind(job!.id).first();const keysBeforeForged=(await bucket.list({prefix:`envelopes/${envelope.id}/`})).objects.map(o=>o.key).sort();
  assert.equal(await retryPositionedV3Signature(db,bucket,{...base,values:{'sig-b':'BOB'},datePreviewIds:{}}),null,'another role cannot replay through the original task session');
  assert.deepEqual(await db.prepare(`SELECT j.status AS job,t.status AS task,e.status AS envelope,(SELECT count(*) FROM signature_outputs) AS outputs FROM signature_jobs j JOIN signature_records r ON r.id=j.signature_id JOIN tasks t ON t.id=r.task_id JOIN envelopes e ON e.id=r.envelope_id WHERE j.id=?`).bind(job!.id).first(),beforeForged);assert.deepEqual((await bucket.list({prefix:`envelopes/${envelope.id}/`})).objects.map(o=>o.key).sort(),keysBeforeForged);assert.equal((beforeForged as any).job,'PENDING');assert.equal((beforeForged as any).outputs,0);
  await db.batch([db.prepare('UPDATE positioned_signature_inputs SET payload_json=? WHERE signature_id=?').bind(row.payload_json,id),db.prepare('UPDATE signature_events SET event_hash=? WHERE signature_id=?').bind(row.event_hash,id)]);await bucket.delete(bobImageKey);assert.equal(await retryPositionedV3Signature(db,bucket,{...base,values}),id,'original exact retry remains valid');
  // Recreate an authentic pre-upgrade pending event: signature geometry is
  // still 30pt, but neither 33.75pt text placement was captured in the event.
  const oldSnapshot=JSON.parse(row.payload_json);for(const field of oldSnapshot.fields)if(field.type!=='Signature')delete field.geometry;
  assert.equal(oldSnapshot.fields.find((f:any)=>f.type==='Signature').geometry.height,30);const oldTextImage=await renderPositionedV3Text(date);assert.equal(positionedV3TextGeometry(pdf.getPage(0),updated[2],oldTextImage).height,27);const oldTextHeight=33.75;assert.notEqual(oldTextHeight,27);
  const oldCanonical=canonicalPositionedV3({envelopeId:row.envelope_id,sequence:row.sequence,previousHash:row.previous_hash,signatureId:row.id,taskId:row.task_id,recipientName:row.recipient_name,artifactId:row.input_artifact_id,artifactHash:row.input_sha256,otpVerifiedAt:row.otp_verified_at,consentedAt:row.consented_at},oldSnapshot);
  await db.batch([db.prepare('UPDATE positioned_signature_inputs SET payload_json=? WHERE signature_id=?').bind(JSON.stringify(oldSnapshot),id),db.prepare('UPDATE signature_events SET event_hash=? WHERE signature_id=?').bind(await sha(new TextEncoder().encode(oldCanonical)),id)]);
  await assert.rejects(()=>processPositionedV3Job(db,bucket,job!.id),'old pending event without text geometry must not be redrawn at 27pt');
  assert.equal((await db.prepare('SELECT count(*) AS n FROM signature_outputs').first())!.n,0);
  await db.batch([db.prepare('UPDATE positioned_signature_inputs SET payload_json=? WHERE signature_id=?').bind(row.payload_json,id),db.prepare('UPDATE signature_events SET event_hash=? WHERE signature_id=?').bind(row.event_hash,id)]);
  // Even a self-consistent event hash must not make altered pending geometry
  // an acceptable exact retry, and replay must be strictly read-only.
  for(const [type,height] of [['Title',33.75],['Date signed',33.75],['Signature',33.75]] as const){
   const wrongGeometry=JSON.parse(row.payload_json);wrongGeometry.fields.find((f:any)=>f.type===type).geometry.height=height;
   const wrongCanonical=canonicalPositionedV3({envelopeId:row.envelope_id,sequence:row.sequence,previousHash:row.previous_hash,signatureId:row.id,taskId:row.task_id,recipientName:row.recipient_name,artifactId:row.input_artifact_id,artifactHash:row.input_sha256,otpVerifiedAt:row.otp_verified_at,consentedAt:row.consented_at},wrongGeometry);
   await db.batch([db.prepare('UPDATE positioned_signature_inputs SET payload_json=? WHERE signature_id=?').bind(JSON.stringify(wrongGeometry),id),db.prepare('UPDATE signature_events SET event_hash=? WHERE signature_id=?').bind(await sha(new TextEncoder().encode(wrongCanonical)),id)]);
   const before=await db.prepare(`SELECT j.status AS job,t.status AS task,e.status AS envelope,(SELECT count(*) FROM signature_outputs) AS outputs FROM signature_jobs j JOIN signature_records r ON r.id=j.signature_id JOIN tasks t ON t.id=r.task_id JOIN envelopes e ON e.id=r.envelope_id WHERE j.id=?`).bind(job!.id).first();const keysBefore=(await bucket.list({prefix:`envelopes/${envelope.id}/`})).objects.map(o=>o.key).sort();
   assert.equal(await retryPositionedV3Signature(db,bucket,{...base,values}),null,`pending ${type} geometry mismatch must reject retry`);
   assert.deepEqual(await db.prepare(`SELECT j.status AS job,t.status AS task,e.status AS envelope,(SELECT count(*) FROM signature_outputs) AS outputs FROM signature_jobs j JOIN signature_records r ON r.id=j.signature_id JOIN tasks t ON t.id=r.task_id JOIN envelopes e ON e.id=r.envelope_id WHERE j.id=?`).bind(job!.id).first(),before,`pending ${type} retry preserves database state`);assert.deepEqual((await bucket.list({prefix:`envelopes/${envelope.id}/`})).objects.map(o=>o.key).sort(),keysBefore,`pending ${type} retry creates no objects`);
   assert.equal((before as any).job,'PENDING');assert.equal((before as any).outputs,0);
   await assert.rejects(()=>processPositionedV3Job(db,bucket,job!.id),'captured geometry must match rendered geometry');
   await db.batch([db.prepare('UPDATE positioned_signature_inputs SET payload_json=? WHERE signature_id=?').bind(row.payload_json,id),db.prepare('UPDATE signature_events SET event_hash=? WHERE signature_id=?').bind(row.event_hash,id)]);
   assert.equal(await retryPositionedV3Signature(db,bucket,{...base,values}),id,`valid pending ${type} exact retry succeeds`);
  }
  await db.prepare('UPDATE signature_events SET sequence=7 WHERE signature_id=?').bind(id).run();await assert.rejects(()=>processPositionedV3Job(db,bucket,job!.id));assert.equal(await retryPositionedV3Signature(db,bucket,{...base,values}),null);await db.prepare('UPDATE signature_events SET sequence=1 WHERE signature_id=?').bind(id).run();
  const imageKey=`envelopes/${envelope.id}/signature-images/${id}/title-a.png`,saved=await (await bucket.get(imageKey))!.arrayBuffer();await bucket.put(imageKey,'tampered');assert.equal(await retryPositionedV3Signature(db,bucket,{...base,values}),null);await assert.rejects(()=>processPositionedV3Job(db,bucket,job!.id));await bucket.put(imageKey,saved);
  // Hold the processor before it writes the output, then replay while the job
  // remains pending. The retry must not perform the processor's write itself.
  let releaseOutput!:()=>void,enteredOutput!:()=>void;const outputGate=new Promise<void>(r=>releaseOutput=r),atOutput=new Promise<void>(r=>enteredOutput=r);
  const gatedBucket=new Proxy(bucket,{get(target,prop){if(prop==='put')return async (...args:Parameters<R2Bucket['put']>)=>{if(args[0]===`envelopes/${envelope.id}/signed:${id}.pdf`){enteredOutput();await outputGate;}return (target.put as any)(...args);};const value=Reflect.get(target,prop);return typeof value==='function'?value.bind(target):value;}}) as R2Bucket;
  const processing=processPositionedV3Job(db,gatedBucket,job!.id);try{await atOutput;assert.equal(await retryPositionedV3Signature(db,bucket,{...base,values}),id,'retry succeeds while processor is pending');assert.equal((await db.prepare('SELECT status FROM signature_jobs WHERE id=?').bind(job!.id).first())!.status,'PENDING');assert.equal((await db.prepare('SELECT count(*) AS n FROM signature_outputs').first())!.n,0);}finally{releaseOutput();}await processing;await processPositionedV3Job(db,bucket,job!.id);
  const output=await db.prepare('SELECT artifact_id,sha256,object_key FROM signature_outputs WHERE job_id=?').bind(job!.id).first<{artifact_id:string;sha256:string;object_key:string}>();assert.ok(output);
  const originalOutput=await (await bucket.get(output.object_key))!.arrayBuffer(),forged=new TextEncoder().encode('forged output');await bucket.put(output.object_key,forged);await db.prepare('UPDATE signature_outputs SET sha256=? WHERE job_id=?').bind(await sha(forged),job!.id).run();await assert.rejects(()=>processPositionedV3Job(db,bucket,job!.id));assert.equal(await retryPositionedV3Signature(db,bucket,{...base,values}),null);await bucket.put(output.object_key,originalOutput);await db.prepare('UPDATE signature_outputs SET sha256=? WHERE job_id=?').bind(output.sha256,job!.id).run();
  const secondView=await (await req(`/v1/envelopes/${envelope.id}/tasks/${tasks[1].id}/recipient-view`,post({origin},mgmt))).json();
  const secondSession=await (await req('/v1/page-sessions/exchange',post({code:secondView.code},{origin}))).json();const secondHeaders={origin,authorization:`Bearer ${secondSession.token}`};
  const secondSent=await (await req('/v1/signing/otp',post({},secondHeaders))).json(),secondMessage=await (await mail.get(`test-mail/${secondSent.messageId}.json`))!.json() as {otp:string};assert.equal((await req('/v1/signing/otp/verify',post({otp:secondMessage.otp},secondHeaders))).status,204);
  const secondCommand={token:secondSession.token,origin,now:Date.now(),artifactId:output.artifact_id,artifactHash:output.sha256,values:{'sig-b':'BOB'},signaturePreviews:{'sig-b':await receipt(output.sha256,fields[1],'BOB')}};
  await db.prepare('UPDATE templates SET fields_json=? WHERE id=?').bind(JSON.stringify(updated.map(f=>f.id==='title-a'?{...f,rect:{...f.rect,x:.1}}:f)),template.id).run();await assert.rejects(()=>recordPositionedV3Signature(db,bucket,secondCommand));await db.prepare('UPDATE templates SET fields_json=? WHERE id=?').bind(JSON.stringify(updated),template.id).run();
  const second=await recordPositionedV3Signature(db,bucket,secondCommand);
  const secondJob=await db.prepare('SELECT id FROM signature_jobs WHERE signature_id=?').bind(second).first<{id:string}>();await processPositionedV3Job(db,bucket,secondJob!.id);
  const final=await db.prepare('SELECT object_key FROM signature_outputs WHERE job_id=?').bind(secondJob!.id).first<{object_key:string}>();const finalBytes=await (await bucket.get(final!.object_key))!.arrayBuffer();
  const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');const doc=await pdfjs.getDocument({data:new Uint8Array(finalBytes)}).promise;const ops=await (await doc.getPage(1)).getOperatorList();assert.equal(ops.fnArray.filter((fn:number)=>fn===pdfjs.OPS.paintImageXObject).length,4);
  const transforms=ops.argsArray.filter((_:unknown,i:number)=>ops.fnArray[i]===pdfjs.OPS.transform),placed=[updated[0],updated[2],updated[3],updated[1]];assert.equal(transforms.length,16);
  for(let i=0;i<4;i++){const translate=transforms[i*4],scale=transforms[i*4+2],r=placed[i].rect;assert.equal(translate[4],r.x*600);assert.ok(Math.abs(translate[5]+scale[3]-(1-r.y)*800)<1e-5);assert.ok(scale[0]<=r.width*600&&scale[3]<=r.height*800);}
  await doc.destroy();
  const secondEvent=await db.prepare('SELECT previous_hash,sequence FROM signature_events WHERE signature_id=?').bind(second).first<{previous_hash:string;sequence:number}>();assert.equal(secondEvent!.previous_hash,row.event_hash);assert.equal(secondEvent!.sequence,2);
  const secondRow=await db.prepare('SELECT r.*,e.previous_hash,e.event_hash,p.payload_json FROM signature_records r JOIN signature_events e ON e.signature_id=r.id JOIN positioned_signature_inputs p ON p.signature_id=r.id WHERE r.id=?').bind(second).first<any>();const altered=JSON.parse(secondRow.payload_json);altered.templateFields.find((f:any)=>f.id==='title-a').rect.x=.1;
  const alteredCanonical=canonicalPositionedV3({envelopeId:secondRow.envelope_id,sequence:secondRow.sequence,previousHash:secondRow.previous_hash,signatureId:secondRow.id,taskId:secondRow.task_id,recipientName:secondRow.recipient_name,artifactId:secondRow.input_artifact_id,artifactHash:secondRow.input_sha256,otpVerifiedAt:secondRow.otp_verified_at,consentedAt:secondRow.consented_at},altered);
  await db.batch([db.prepare('UPDATE positioned_signature_inputs SET payload_json=? WHERE signature_id=?').bind(JSON.stringify(altered),second),db.prepare('UPDATE signature_events SET event_hash=? WHERE signature_id=?').bind(await sha(new TextEncoder().encode(alteredCanonical)),second)]);await assert.rejects(()=>processPositionedV3Job(db,bucket,secondJob!.id));assert.equal(await retryPositionedV3Signature(db,bucket,secondCommand),null);await db.batch([db.prepare('UPDATE positioned_signature_inputs SET payload_json=? WHERE signature_id=?').bind(secondRow.payload_json,second),db.prepare('UPDATE signature_events SET event_hash=? WHERE signature_id=?').bind(secondRow.event_hash,second)]);
  const sealKey=new TextEncoder().encode(env.LOCAL_TEST_SEAL_KEY);await finalizeLocalTestEvidence(db,bucket,'tenant',envelope.id,sealKey);await finalizeLocalTestEvidence(db,bucket,'tenant',envelope.id,sealKey,true);
  const seal=await (await bucket.get(`envelopes/${envelope.id}/local-test-evidence.json`))!.json() as {manifest:string};assert.equal(JSON.parse(seal.manifest).format,'esign-local-test-manifest-v3');
  await bucket.put(imageKey,'tampered');await assert.rejects(()=>finalizeLocalTestEvidence(db,bucket,'tenant',envelope.id,sealKey,true));await bucket.put(imageKey,saved);
  await db.prepare('UPDATE positioned_signature_inputs SET payload_json=? WHERE signature_id=?').bind(row.payload_json.replace('Director','Engineer'),id).run();await assert.rejects(()=>finalizeLocalTestEvidence(db,bucket,'tenant',envelope.id,sealKey,true));
 }finally{await mf.dispose();}
});
