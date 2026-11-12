import type {BlobStore} from '../src/app/server/esign/blob-store.ts';
import {blobStore} from './helpers/platform.ts';
// Deliberately drop the task recipient trigger in these isolated fixtures to exercise defense in depth under task tampering.
import {MIGRATIONS_DIR,splitSql as unstable_splitSqlQuery} from './helpers/platform.ts';
import {textGeometry} from '../src/app/server/esign/field-render.ts';
import {signaturePreviewHash} from '../src/app/server/esign/field-render.ts';
import {signatureGeometry} from '../src/app/server/esign/field-render.ts';
import {renderTypedSignature} from '../src/app/server/esign/field-render.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {PDFDocument} from 'pdf-lib';
import app from './helpers/gateway.ts';
import {recordSignature,retrySignature} from '../src/app/server/esign/signature-record.ts';
import {processSignature} from '../src/app/server/esign/signature-processing.ts';
import {signatureEventHash} from '../src/app/server/esign/signatures.ts';
import {canonicalJson} from '../src/app/server/esign/canonical-json.ts';
import {finalizeLocalTestEvidence} from '../src/app/server/esign/seal/local.ts';
import {renderText} from '../src/app/server/esign/field-render.ts';

const sha=async(bytes:Uint8Array)=>Buffer.from(await crypto.subtle.digest('SHA-256',Uint8Array.from(bytes))).toString('hex');
test('a fields signature captures only the verified current role, time and image hashes atomically',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB']});
 try{
  const db=await mf.getD1Database('DB'),bucket=await blobStore(mf,'artifacts'),mail=await blobStore(mf,'test-mail');
  for(const name of (await readdir(MIGRATIONS_DIR)).filter(n=>n.endsWith('.sql')).sort()){const sql=await readFile(new URL(name,MIGRATIONS_DIR),'utf8');await db.batch(unstable_splitSqlQuery(sql).map(s=>db.prepare(s)));}await db.exec('DROP TRIGGER immutable_task_recipient_email');
  const immutability=unstable_splitSqlQuery(await readFile(new URL('../src/app/db/migrations/0001_triggers.sql',import.meta.url),'utf8')).find(sql=>sql.includes('signatures_facts_immutable'))!;
  /** A privileged edit that goes around the immutability trigger, as an operator with database access could. */
  const privileged=async(edit:()=>Promise<unknown>)=>{await db.prepare('DROP TRIGGER signatures_facts_immutable').run();try{await edit();}finally{await db.prepare(immutability).run();}};
  const key='local-test-key-0123456789-abcdefghijklmnopqrstuvwxyz',origin='https://host.example.com';
  await db.batch([db.prepare("INSERT INTO tenants (id) VALUES ('tenant')"),db.prepare("INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,'tenant')").bind(await sha(new TextEncoder().encode(key)))]);
  const env={DB:db,ARTIFACTS:bucket,TEST_MAIL:mail,SIGNING_PAGE_ORIGINS:origin,OTP_KEY:'local-test-pepper-at-least-32-bytes',TEST_SEAL_KEY:'local-test-seal-key-at-least-32-bytes'};
  const req=(path:string,init:RequestInit={})=>app.fetch(new Request('http://localhost'+path,init),env),mgmt={authorization:`Bearer ${key}`};
  const post=(body:unknown,headers:Record<string,string>)=>({method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)});
  const count=async()=>(await db.prepare('SELECT count(*) AS n FROM signatures').first<{n:number}>())!.n;
  const pdf=await PDFDocument.create();pdf.addPage([600,800]);const form=new FormData();form.set('file',new File([await pdf.save()],'synthetic.pdf'));form.set('roles','["ana","bob"]');
  const template=await (await req('/api/templates',{method:'POST',headers:mgmt,body:form})).json();
  const fields=[{id:'sig-a',type:'Signature',role:'ana',page:1,required:true,rect:{x:.05,y:.1,width:.25,height:.08}},{id:'sig-b',type:'Signature',role:'bob',page:1,required:true,rect:{x:.05,y:.7,width:.25,height:.08}}];
  const setFields=(value:unknown)=>db.prepare('UPDATE templates SET fields_json=? WHERE id=?').bind(JSON.stringify(value),template.id).run();
  await setFields(fields);
  const created=await req('/api/envelopes',post({templateId:template.id,recipients:[{role:'ana',name:'Ana',email:'ana@example.com'},{role:'bob',name:'Bob',email:'bob@example.com'}]},{...mgmt,'idempotency-key':'v3-fixture'}));assert.equal(created.status,201);const envelope=await created.json();
  assert.equal((await req(`/api/envelopes/${envelope.id}/prepare`,{method:'POST',headers:mgmt})).status,204);
  const tasks=(await (await req(`/api/envelopes/${envelope.id}`,{headers:mgmt})).json()).tasks;
  const view=await (await req(`/api/envelopes/${envelope.id}/tasks/${tasks[0].id}/recipient-view`,post({signedInEmail:tasks[0].recipientEmail,origin},mgmt))).json();
  const session=await (await req('/api/public/page-sessions/exchange',post({code:view.code},{origin}))).json();const headers={origin,'x-esign-session':session.token};
  const sent=await (await req('/api/public/signing/otp',post({},headers))).json(),message=await (await mail.get(`test-mail/${sent.messageId}.json`))!.json() as {otp:string};assert.equal((await req('/api/public/signing/otp/verify',post({otp:message.otp},headers))).status,204);
  const current=await (await req('/api/public/signing/current',{headers})).json();
  const updated=[...fields,{id:'date-a',type:'Date signed',role:'ana',page:1,required:true,rect:{x:.35,y:.1,width:.3,height:.08}},{id:'title-a',type:'Title',role:'ana',page:1,required:true,rect:{x:.05,y:.3,width:.4,height:.08}}];
  await setFields(updated);
  const receipt=async(artifactHash:string,field:typeof fields[number],text:string)=>{const image=await renderTypedSignature(text);return signaturePreviewHash(artifactHash,JSON.stringify(['ana','bob']),JSON.stringify(updated),field.id,text,await sha(image),signatureGeometry(pdf.getPage(0),field,image));};
  const titleImage=await renderText('Director'),titleReceipt=await signaturePreviewHash(current.sha256,JSON.stringify(['ana','bob']),JSON.stringify(updated),'title-a','Director',await sha(titleImage),textGeometry(pdf.getPage(0),updated[3],titleImage));
  const now=Date.now(),date=new Date(now).toISOString().slice(0,10);
  const base={token:session.token,origin,now,consent:true,artifactId:current.id,artifactHash:current.sha256,datePreviews:{'date-a':date},signaturePreviews:{'sig-a':await receipt(current.sha256,fields[0],'ANA')},textPreviews:{'title-a':titleReceipt}};
  for(const values of [{"sig-a":"ANA"},{"sig-a":"ANA","title-a":"Director","sig-b":"BOB"},{"sig-a":"ANA","title-a":"Director","date-a":"client"},{"sig-a":"ANA","title-a":"x".repeat(128)}])await assert.rejects(()=>recordSignature(db,bucket,{...base,values}));
  const values={'sig-a':'ANA','title-a':'Director'};
  await assert.rejects(()=>recordSignature(db,bucket,{...base,origin:'https://wrong.example.com',values}));
  await assert.rejects(()=>recordSignature(db,bucket,{...base,artifactHash:'0'.repeat(64),values}));
  await assert.rejects(()=>recordSignature(db,bucket,{...base,consent:false,values}));
  await assert.rejects(()=>recordSignature(db,bucket,{...base,datePreviews:{},values}),'the previewed date is required');
  await assert.rejects(()=>recordSignature(db,bucket,{...base,datePreviews:{'date-a':'2000-01-01'},values}),/date changed/,'another day\'s preview is refused');
  await assert.rejects(()=>recordSignature(db,bucket,{...base,signaturePreviews:{'sig-a':'0'.repeat(64)},values}),/preview changed/);
  assert.equal(await count(),0);
  const verified=(await db.prepare("SELECT otp_verified_at FROM access_sessions WHERE scope='recipient' AND subject_id=?").bind(tasks[0].id).first<{otp_verified_at:number}>())!.otp_verified_at;
  const setVerified=(value:number|null)=>db.prepare("UPDATE access_sessions SET otp_verified_at=? WHERE scope='recipient' AND subject_id=?").bind(value,tasks[0].id).run();
  await setVerified(null);
  await assert.rejects(()=>recordSignature(db,bucket,{...base,values}),'a session that has not entered the code must not sign');
  await setVerified(verified);
  assert.equal(await count(),0);
  // Changing the task's email afterwards is refused by a trigger (0001_triggers.sql, task-recipient-immutable.test.ts),
  // which this fixture omits: here the change lands between reading the signer and the commit.
  let changedRecipient=false;const recipientRace=new Proxy(db,{get(target,key){if(key==='batch')return async (statements:D1PreparedStatement[])=>{if(!changedRecipient){changedRecipient=true;await target.prepare('UPDATE tasks SET recipient_email=? WHERE id=?').bind('other@example.test',tasks[0].id).run();}return target.batch(statements);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  await assert.rejects(()=>recordSignature(recipientRace,bucket,{...base,values}),'recipient changed before signing commit must be rejected');assert.equal(changedRecipient,true);assert.equal(await count(),0);
  await db.prepare('UPDATE tasks SET recipient_email=? WHERE id=?').bind('ana@example.com',tasks[0].id).run();
  await setVerified(now+1);await assert.rejects(()=>recordSignature(db,bucket,{...base,values}),'a code entered after consent is refused');await setVerified(verified);
  const expiry=(await db.prepare("SELECT expires_at FROM access_sessions WHERE scope='recipient' AND subject_id=?").bind(tasks[0].id).first<{expires_at:number}>())!.expires_at;
  await db.prepare("UPDATE access_sessions SET expires_at=? WHERE scope='recipient' AND subject_id=?").bind(now,tasks[0].id).run();await assert.rejects(()=>recordSignature(db,bucket,{...base,values}));await db.prepare("UPDATE access_sessions SET expires_at=? WHERE scope='recipient' AND subject_id=?").bind(expiry,tasks[0].id).run();
  // The images go to R2 before the record; a template changed meanwhile rolls the record back.
  let changedOnce=false,writes=0;const changingBucket=new Proxy(bucket,{get(target,prop){if(prop==='put')return async (...args:Parameters<BlobStore['put']>)=>{const result=await (target.put as any)(...args);writes++;if(!changedOnce){changedOnce=true;await setFields(updated.map(f=>f.id==='title-a'?{...f,rect:{...f.rect,y:.31}}:f));}return result;};const value=Reflect.get(target,prop);return typeof value==='function'?value.bind(target):value;}});
  await assert.rejects(()=>recordSignature(db,changingBucket,{...base,values}),'template changed before commit');assert.equal(changedOnce,true);assert.ok(writes>0,'rejection can leave pre-commit images');assert.equal(await count(),0);
  await setFields(updated);
  const race=await Promise.allSettled([recordSignature(db,bucket,{...base,values}),recordSignature(db,bucket,{...base,values})]);
  assert.equal(race.filter(r=>r.status==='fulfilled').length,1,'only one of two concurrent signatures commits');const id=(race.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<string>).value;
  const row=(await db.prepare('SELECT * FROM signatures WHERE id=?').bind(id).first<any>())!,facts=JSON.parse(row.facts_json),render=JSON.parse(row.render_json);
  assert.equal(row.status,'PENDING');assert.equal(row.sequence,1);assert.equal(row.previous_hash,null);assert.equal(row.attempts,0);
  assert.equal(facts.version,1);assert.equal(facts.consentedAt,now);assert.equal(facts.otpVerifiedAt,verified);assert.equal(facts.recipientEmail,'ana@example.com');assert.equal(facts.role,'ana');assert.equal(facts.taskId,tasks[0].id);assert.equal(facts.sessionHash,await sha(new TextEncoder().encode(session.token)));
  assert.equal(render.version,1);assert.equal(render.kind,'fields');assert.equal(render.inputPageCount,1);assert.deepEqual(render.template,updated);
  assert.deepEqual(render.fields.map((f:any)=>[f.id,f.value]),[['sig-a','ANA'],['date-a',date],['title-a','Director']]);
  assert.equal(row.facts_json,canonicalJson(facts));assert.equal(row.render_json,canonicalJson(render));
  assert.equal(await signatureEventHash({previousHash:null,envelopeId:envelope.id,sequence:1,inputSha256:current.sha256},facts,render),row.event_hash);
  for(const field of render.fields){const obj=await bucket.get(`envelopes/${envelope.id}/signature-images/${id}/${field.id}.png`);assert.ok(obj);assert.equal(await sha(new Uint8Array(await obj.arrayBuffer())),field.imageSha256);}
  assert.equal(await count(),1);assert.equal((await db.prepare('SELECT status FROM tasks WHERE id=?').bind(tasks[0].id).first())!.status,'SIGNED');
  assert.equal(await retrySignature(db,bucket,{...base,values}),id);
  await db.prepare('UPDATE tasks SET recipient_email=? WHERE id=?').bind('other@example.test',tasks[0].id).run();
  assert.equal(await retrySignature(db,bucket,{...base,values}),null,'a changed recipient cannot replay a signature');
  await db.prepare('UPDATE tasks SET recipient_email=? WHERE id=?').bind('ana@example.com',tasks[0].id).run();
  await setVerified(verified+1);
  assert.equal(await retrySignature(db,bucket,{...base,values}),null,'a session verified at another time cannot replay the signature');
  await setVerified(verified);
  const source=await db.prepare('SELECT object_key FROM artifacts WHERE id=?').bind(current.id).first<{object_key:string}>();const sourceBytes=await (await bucket.get(source!.object_key))!.arrayBuffer();await bucket.put(source!.object_key,'tampered');assert.equal(await retrySignature(db,bucket,{...base,values}),null);await bucket.put(source!.object_key,sourceBytes);
  assert.equal(await retrySignature(db,bucket,{...base,values:{...values,'title-a':'Changed'}}),null);
  assert.equal(await retrySignature(db,bucket,{...base,values:{...values,'date-a':date}}),null);
  assert.equal(await retrySignature(db,bucket,{...base,datePreviews:{'date-a':'2000-01-01'},values}),null);
  assert.equal(await retrySignature(db,bucket,{...base,origin:'https://evil.example.com',values}),null);
  assert.equal(await retrySignature(db,bucket,{...base,artifactHash:'0'.repeat(64),values}),null);
  const state=async()=>({row:await db.prepare('SELECT s.status,s.output_sha256,t.status AS task,e.status AS envelope FROM signatures s JOIN tasks t ON t.id=s.task_id JOIN envelopes e ON e.id=s.envelope_id WHERE s.id=?').bind(id).first(),keys:(await bucket.list({prefix:`envelopes/${envelope.id}/`})).objects.map(o=>o.key).sort()});
  // A self-consistent record and PNG for another role must not be replayed through Ana's session and task.
  const bobImage=await renderTypedSignature('BOB'),bobImageKey=`envelopes/${envelope.id}/signature-images/${id}/sig-b.png`;await bucket.put(bobImageKey,bobImage);
  const forgedFacts={...facts,role:'bob'},forgedRender={...render,role:'bob',fields:[{id:'sig-b',type:'Signature',role:'bob',page:1,rect:fields[1].rect,value:'BOB',renderer:render.fields[0].renderer,imageSha256:await sha(bobImage),geometry:signatureGeometry(pdf.getPage(0),fields[1],bobImage)}]};
  const forgedHash=await signatureEventHash({previousHash:null,envelopeId:envelope.id,sequence:1,inputSha256:current.sha256},forgedFacts,forgedRender);
  await privileged(()=>db.prepare('UPDATE signatures SET facts_json=?,render_json=?,event_hash=? WHERE id=?').bind(canonicalJson(forgedFacts),canonicalJson(forgedRender),forgedHash,id).run());
  const beforeForged=await state();
  assert.equal(await retrySignature(db,bucket,{...base,values:{'sig-b':'BOB'},datePreviews:{}}),null,'another role cannot replay through the original task session');
  assert.deepEqual(await state(),beforeForged,'a refused retry writes nothing');assert.equal((beforeForged.row as any).status,'PENDING');
  await privileged(()=>db.prepare('UPDATE signatures SET facts_json=?,render_json=?,event_hash=? WHERE id=?').bind(row.facts_json,row.render_json,row.event_hash,id).run());await bucket.delete(bobImageKey);
  assert.equal(await retrySignature(db,bucket,{...base,values}),id,'original exact retry remains valid');
  // Even a self-consistent event hash must not make altered geometry an acceptable retry or rendering.
  for(const type of ['Title','Date signed','Signature']){
   const wrong=JSON.parse(row.render_json);wrong.fields.find((f:any)=>f.type===type).geometry.height=33.75;
   const wrongHash=await signatureEventHash({previousHash:null,envelopeId:envelope.id,sequence:1,inputSha256:current.sha256},facts,wrong);
   await privileged(()=>db.prepare('UPDATE signatures SET render_json=?,event_hash=? WHERE id=?').bind(canonicalJson(wrong),wrongHash,id).run());
   const before=await state();
   assert.equal(await retrySignature(db,bucket,{...base,values}),null,`pending ${type} geometry mismatch must reject retry`);
   assert.deepEqual(await state(),before,`pending ${type} retry writes nothing`);
   await assert.rejects(()=>processSignature(db,bucket,id),/Geometry mismatch/,'captured geometry must match rendered geometry');
   await privileged(()=>db.prepare('UPDATE signatures SET render_json=?,event_hash=? WHERE id=?').bind(row.render_json,row.event_hash,id).run());
   assert.equal(await retrySignature(db,bucket,{...base,values}),id,`valid pending ${type} exact retry succeeds`);
  }
  await assert.rejects(()=>db.prepare('UPDATE signatures SET sequence=7 WHERE id=?').bind(id).run(),/immutable/);
  const imageKey=`envelopes/${envelope.id}/signature-images/${id}/title-a.png`,saved=await (await bucket.get(imageKey))!.arrayBuffer();await bucket.put(imageKey,'tampered');assert.equal(await retrySignature(db,bucket,{...base,values}),null);await assert.rejects(()=>processSignature(db,bucket,id),/Image mismatch/);await bucket.put(imageKey,saved);
  // Hold the processor before it writes the output, then retry while the signature is still pending.
  // The retry must not perform the processor's write itself.
  let releaseOutput!:()=>void,enteredOutput!:()=>void;const outputGate=new Promise<void>(r=>releaseOutput=r),atOutput=new Promise<void>(r=>enteredOutput=r);
  const gatedBucket=new Proxy(bucket,{get(target,prop){if(prop==='put')return async (...args:Parameters<BlobStore['put']>)=>{if(args[0]===`envelopes/${envelope.id}/signed:${id}.pdf`){enteredOutput();await outputGate;}return (target.put as any)(...args);};const value=Reflect.get(target,prop);return typeof value==='function'?value.bind(target):value;}});
  const processing=processSignature(db,gatedBucket,id);try{await atOutput;assert.equal(await retrySignature(db,bucket,{...base,values}),id,'retry succeeds while processor is pending');assert.equal((await db.prepare('SELECT status FROM signatures WHERE id=?').bind(id).first())!.status,'PENDING');assert.equal(await bucket.get(`envelopes/${envelope.id}/signed:${id}.pdf`),null);}finally{releaseOutput();}await processing;await processSignature(db,bucket,id);
  const output=(await db.prepare('SELECT output_artifact_id AS artifact_id,output_sha256 AS sha256 FROM signatures WHERE id=?').bind(id).first<{artifact_id:string;sha256:string}>())!;assert.equal(output.artifact_id,`signed:${id}`);const outputKey=`envelopes/${envelope.id}/${output.artifact_id}.pdf`;
  await assert.rejects(()=>db.prepare('UPDATE signatures SET output_sha256=? WHERE id=?').bind('0'.repeat(64),id).run(),/final/);
  const originalOutput=await (await bucket.get(outputKey))!.arrayBuffer();await bucket.put(outputKey,new TextEncoder().encode('forged output'));await assert.rejects(()=>processSignature(db,bucket,id),/Output integrity failure/);assert.equal(await retrySignature(db,bucket,{...base,values}),null);await bucket.put(outputKey,originalOutput);assert.equal(await retrySignature(db,bucket,{...base,values}),id);
  const secondView=await (await req(`/api/envelopes/${envelope.id}/tasks/${tasks[1].id}/recipient-view`,post({signedInEmail:tasks[1].recipientEmail,origin},mgmt))).json();
  const secondSession=await (await req('/api/public/page-sessions/exchange',post({code:secondView.code},{origin}))).json();const secondHeaders={origin,'x-esign-session':secondSession.token};
  const secondSent=await (await req('/api/public/signing/otp',post({},secondHeaders))).json(),secondMessage=await (await mail.get(`test-mail/${secondSent.messageId}.json`))!.json() as {otp:string};assert.equal((await req('/api/public/signing/otp/verify',post({otp:secondMessage.otp},secondHeaders))).status,204);
  const secondCommand={token:secondSession.token,origin,now:Date.now(),consent:true,artifactId:output.artifact_id,artifactHash:output.sha256,values:{'sig-b':'BOB'},signaturePreviews:{'sig-b':await receipt(output.sha256,fields[1],'BOB')}};
  await setFields(updated.map(f=>f.id==='title-a'?{...f,rect:{...f.rect,x:.1}}:f));await assert.rejects(()=>recordSignature(db,bucket,secondCommand),'every signer signs the same placed fields');await setFields(updated);
  const second=await recordSignature(db,bucket,secondCommand);
  await processSignature(db,bucket,second);
  const secondRow=(await db.prepare('SELECT * FROM signatures WHERE id=?').bind(second).first<any>())!;assert.equal(secondRow.previous_hash,row.event_hash);assert.equal(secondRow.sequence,2);assert.equal(secondRow.input_sha256,output.sha256);
  const finalBytes=await (await bucket.get(`envelopes/${envelope.id}/${secondRow.output_artifact_id}.pdf`))!.arrayBuffer();
  const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');const doc=await pdfjs.getDocument({data:new Uint8Array(finalBytes)}).promise;const ops=await (await doc.getPage(1)).getOperatorList();assert.equal(ops.fnArray.filter((fn:number)=>fn===pdfjs.OPS.paintImageXObject).length,4);
  const transforms=ops.argsArray.filter((_:unknown,i:number)=>ops.fnArray[i]===pdfjs.OPS.transform),placed=[updated[0],updated[2],updated[3],updated[1]];assert.equal(transforms.length,16);
  for(let i=0;i<4;i++){const translate=transforms[i*4],scale=transforms[i*4+2],r=placed[i].rect;assert.equal(translate[4],r.x*600);// Title and Date signed text sits 9 × 78/96 points below the box's top, on v3's baseline.
    const drop=placed[i].type==='Signature'?0:9*78/96;assert.ok(Math.abs(translate[5]+scale[3]-((1-r.y)*800-drop))<1e-5);assert.ok(scale[0]<=r.width*600&&drop+scale[3]<=r.height*800);}
  await doc.destroy();
  // A second signature claiming other placed fields than the first fails closed, even with a matching hash.
  const altered=JSON.parse(secondRow.render_json);altered.template.find((f:any)=>f.id==='title-a').rect.x=.1;
  const alteredHash=await signatureEventHash({previousHash:row.event_hash,envelopeId:envelope.id,sequence:2,inputSha256:output.sha256},JSON.parse(secondRow.facts_json),altered);
  await privileged(()=>db.prepare('UPDATE signatures SET render_json=?,event_hash=? WHERE id=?').bind(canonicalJson(altered),alteredHash,second).run());await assert.rejects(()=>processSignature(db,bucket,second),/Template snapshot mismatch/);assert.equal(await retrySignature(db,bucket,secondCommand),null);
  await privileged(()=>db.prepare('UPDATE signatures SET render_json=?,event_hash=? WHERE id=?').bind(secondRow.render_json,secondRow.event_hash,second).run());
  const sealKey=new TextEncoder().encode(env.TEST_SEAL_KEY);await finalizeLocalTestEvidence(db,bucket,'tenant',envelope.id,sealKey);await finalizeLocalTestEvidence(db,bucket,'tenant',envelope.id,sealKey,true);
  const seal=await (await bucket.get(`envelopes/${envelope.id}/local-test-evidence.json`))!.json() as {manifest:string};const manifest=JSON.parse(seal.manifest);assert.equal(manifest.format,'esign-evidence-manifest-v1');assert.deepEqual(manifest.records.map((r:any)=>r.render.kind),['fields','fields']);
  await bucket.put(imageKey,'tampered');await assert.rejects(()=>finalizeLocalTestEvidence(db,bucket,'tenant',envelope.id,sealKey,true));await bucket.put(imageKey,saved);
  await finalizeLocalTestEvidence(db,bucket,'tenant',envelope.id,sealKey,true);
  await privileged(()=>db.prepare('UPDATE signatures SET render_json=? WHERE id=?').bind(row.render_json.replace('Director','Engineer'),id).run());await assert.rejects(()=>finalizeLocalTestEvidence(db,bucket,'tenant',envelope.id,sealKey,true));
 }finally{await mf.dispose();}
});
