import {unstable_splitSqlQuery} from 'wrangler';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {PDFDocument} from 'pdf-lib';
import app from '../src/worker.ts';
import {processEnvelopeStep} from '../src/envelope-completion.ts';

test('isolated v3 HTTP flow binds role input, server date and exact retry',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB'],r2Buckets:['ARTIFACTS','TEST_MAIL']});
 try{
  const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('ARTIFACTS'),mail=await mf.getR2Bucket('TEST_MAIL');
  for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort()){const sql=await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8');await db.batch(unstable_splitSqlQuery(sql).map(s=>db.prepare(s)));}
  const key='local-test-key-0123456789-abcdefghijklmnopqrstuvwxyz',origin='https://host.example.com',hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key))).toString('hex');
  await db.batch([db.prepare("INSERT INTO tenants VALUES ('a')"),db.prepare("INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,'a')").bind(hash)]);
  const env={DB:db,ARTIFACTS:bucket,TEST_MAIL:mail,LOCAL_TEST_MODE:'true',SIGNING_PAGE_ORIGINS:origin,LOCAL_TEST_OTP_KEY:'local-test-pepper-at-least-32-bytes',LOCAL_TEST_SEAL_KEY:'local-test-seal-key-at-least-32-bytes'};
  const req=(path:string,init:RequestInit={})=>app.fetch(new Request('http://localhost'+path,init),env),mgmt={authorization:`Bearer ${key}`};
  const post=(body:unknown,headers:Record<string,string>)=>({method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)});
  const count=async()=>(await db.prepare('SELECT count(*) AS n FROM signatures').first<{n:number}>())!.n;
  const pdf=await PDFDocument.create();pdf.addPage([600,800]);const form=new FormData();form.set('file',new File([await pdf.save()],'synthetic.pdf'));form.set('roles','["ana","marcus"]');
  const template=await (await req('/v1/templates',{method:'POST',headers:mgmt,body:form})).json();
  const fields=[{id:'a',type:'Signature',role:'ana',page:1,required:true,rect:{x:.05,y:.1,width:.25,height:.08}},{id:'date',type:'Date signed',role:'ana',page:1,required:true,rect:{x:.35,y:.1,width:.4,height:.08}},{id:'title',type:'Title',role:'ana',page:1,required:true,rect:{x:.05,y:.3,width:.4,height:.08}},{id:'b',type:'Signature',role:'marcus',page:1,required:true,rect:{x:.05,y:.7,width:.25,height:.08}},{id:'title-b',type:'Title',role:'marcus',page:1,required:true,rect:{x:.35,y:.7,width:.4,height:.08}},{id:'date-b',type:'Date signed',role:'marcus',page:1,required:true,rect:{x:.05,y:.85,width:.4,height:.08}}];
  const setFields=(value:unknown)=>db.prepare('UPDATE templates SET fields_json=? WHERE id=?').bind(JSON.stringify(value),template.id).run();
  await setFields(fields);
  const body={templateId:template.id,recipients:[{role:'ana',name:'Ana',email:'ana@example.com'},{role:'marcus',name:'Marcus',email:'marcus@example.com'}]},headers={...mgmt,'idempotency-key':'v3-http'};
  const created=await req('/v1/envelopes',post(body,headers));assert.equal(created.status,201,'the Worker accepts Date signed and Title');const envelope=await created.json();assert.equal((await req(`/v1/envelopes/${envelope.id}/prepare`,{method:'POST',headers:mgmt})).status,204);
  const tasks=(await (await req(`/v1/envelopes/${envelope.id}`,{headers:mgmt})).json()).tasks;let previous='';
  for(let i=0;i<2;i++){
   const view=await (await req(`/v1/envelopes/${envelope.id}/tasks/${tasks[i].id}/recipient-view`,post({origin},mgmt))).json(),session=await (await req('/v1/page-sessions/exchange',post({code:view.code},{origin}))).json(),h={origin,authorization:`Bearer ${session.token}`};
   const sent=await (await req('/v1/signing/otp',post({},h))).json(),message=await (await mail.get(`test-mail/${sent.messageId}.json`))!.json() as {otp:string};assert.equal((await req('/v1/signing/otp/verify',post({otp:message.otp},h))).status,204);
   const current=await (await req('/v1/signing/current',{headers:h})).json();assert.deepEqual(current.fields,fields.filter(f=>f.role===(i?'marcus':'ana')));assert.equal(current.v3,true);if(i)assert.equal(current.sha256,previous);
   const fieldId=i?'date-b':'date';

   // The date preview is the server's UTC date; nothing about it is stored.
   const date=await req('/v1/signing/preview',post({fieldId},h));assert.equal(date.status,200);assert.equal(date.headers.get('content-type'),'image/png');
   const previewDate=date.headers.get('x-preview-text')!;assert.match(previewDate,/^\d{4}-\d{2}-\d{2}$/);assert.equal(previewDate,new Date().toISOString().slice(0,10));
   assert.equal(date.headers.get('x-date-preview-id'),null);assert.match(date.headers.get('access-control-expose-headers')!,/X-Preview-Text/);
   const datePreviews={[fieldId]:previewDate};
   if(!i){
    assert.equal((await req('/v1/signing/preview',post({fieldId:'date',text:'client'},h))).status,422);assert.equal((await req('/v1/signing/preview',post({fieldId:'title',text:'Director'},h))).status,200);const tooLong=await req('/v1/signing/preview',post({fieldId:'title',text:'X'.repeat(128)},h));assert.equal(tooLong.status,422,'unrenderably small title must not receive a preview');assert.equal((await tooLong.json()).error,'title_does_not_fit');assert.equal((await req('/v1/signing/preview',post({fieldId:'title',text:'X'.repeat(17)},h))).status,200,'fixed-size title fits');assert.equal((await req('/v1/signing/preview',post({fieldId:'title',text:'X'.repeat(18)},h))).status,422,'title exceeding fixed width is rejected');
    await setFields(fields.map(f=>f.id==='title'?{...f,rect:{...f.rect,width:.02}}:f));const tooSmall=await req('/v1/signing/preview',post({fieldId:'title',text:'X'},h));assert.equal(tooSmall.status,422,'unsupported physical field must not receive a preview');assert.match((await tooSmall.json()).error,/invalid_preview|title_does_not_fit/);await setFields(fields);
    await setFields(fields.map(f=>f.id==='date'?{...f,rect:{...f.rect,height:.02}}:f));
    assert.equal((await req('/v1/signing/preview',post({fieldId:'date'},h))).status,422,'fixed date must fit before preview');
    assert.equal((await req('/v1/signing/sign',post({artifactId:current.id,artifactHash:current.sha256,consent:true,title:'Director',signatures:{a:'ANA',title:'Director'},datePreviews},h))).status,409,'date must fit before signing');
    assert.equal(await count(),0);await setFields(fields);
    await setFields(fields.map(f=>f.id==='a'?{...f,rect:{...f.rect,width:.04}}:f.id==='date'?{...f,rect:{...f.rect,x:.12}}:f));
    assert.equal((await req('/v1/signing/preview',post({fieldId:'a',text:'Alexander'},h))).status,422,'signature cannot cover date field');
    assert.equal((await req('/v1/signing/sign',post({artifactId:current.id,artifactHash:current.sha256,consent:true,title:'Director',signatures:{a:'Alexander',title:'Director'},signaturePreviews:{a:'0'.repeat(64)},datePreviews},h))).status,409);
    assert.equal(await count(),0);
    await setFields(fields.map(f=>f.id==='a'?{...f,rect:{...f.rect,x:.95,width:.05}}:f));
    assert.equal((await req('/v1/signing/preview',post({fieldId:'a',text:'Alexander'},h))).status,422,'signature cannot cross page boundary');
    await setFields(fields);
   }else assert.equal((await req('/v1/signing/preview',post({fieldId:'title',text:'Director'},h))).status,422,'another role\'s field gets no preview');
   const signatureId=i?'b':'a',signaturePreview=await req('/v1/signing/preview',post({fieldId:signatureId,text:i?'MARCUS':'ANA'},h));assert.equal(signaturePreview.status,200);const titleId=i?'title-b':'title',titlePreview=await req('/v1/signing/preview',post({fieldId:titleId,text:i?'Manager':'Director'},h));assert.equal(titlePreview.status,200);const base={artifactId:current.id,artifactHash:current.sha256,consent:true,title:i?'Manager':'Director',signaturePreviews:{[signatureId]:signaturePreview.headers.get('X-Signature-Preview')},textPreviews:{[titleId]:titlePreview.headers.get('X-Text-Preview')}},values=i?{b:'MARCUS','title-b':'Manager'}:{a:'ANA',title:'Director'};
   assert.equal((await req('/v1/signing/sign',post({...base,signatures:i?{b:'MARCUS','title-b':'Manager',title:'wrong'}:{a:'ANA'},datePreviews},h))).status,i?409:422,'a Title field must carry the Review title');
   assert.equal((await req('/v1/signing/sign',post({...base,title:'Someone else',signatures:values,datePreviews},h))).status,422,'Title field and Review title must match');
   assert.equal((await req('/v1/signing/sign',post({...base,signatures:{...values,[fieldId]:previewDate},datePreviews},h))).status,409,'the date is never taken from the signer');
   assert.equal((await req('/v1/signing/sign',post({...base,signatures:values},h))).status,409,'the previewed date is required');
   assert.equal((await req('/v1/signing/sign',post({...base,signatures:values,datePreviews:{[fieldId]:'forged'}},h))).status,409,'a malformed date is rejected');
   // A page showing another day's date is told to refresh it.
   const stale=await req('/v1/signing/sign',post({...base,signatures:values,datePreviews:{[fieldId]:'2000-01-01'}},h));assert.equal(stale.status,409);assert.equal((await stale.json()).error,'date_changed');
   assert.equal(await count(),i);
   await setFields(fields.map(f=>f.id===fieldId?{...f,rect:{...f.rect,x:f.rect.x+.01}}:f));assert.equal((await req('/v1/signing/sign',post({...base,signatures:values,datePreviews},h))).status,409,'a changed template invalidates the previews');await setFields(fields);
   assert.equal((await req('/v1/signing/sign',post({...base,signatures:values,datePreviews,textPreviews:{}},h))).status,409,'title preview binding is required');
   const before=Date.now();const signed=await Promise.all([req('/v1/signing/sign',post({...base,signatures:values,datePreviews,now:0},h)),req('/v1/signing/sign',post({...base,signatures:values,datePreviews,now:0},h))]);const after=Date.now();assert.deepEqual(signed.map(r=>r.status),[202,202]);const first=await signed[0].json(),second=await signed[1].json(),id=first.id;assert.equal(second.id,id,'concurrent identical signing returns one committed fact');
   assert.equal(await count(),i+1);
   assert.equal((await (await req('/v1/signing/sign',post({...base,signatures:values,datePreviews},h))).json()).id,id,'an exact retry returns the same signature');
   assert.equal((await req('/v1/signing/sign',post({...base,signatures:values,datePreviews:{[fieldId]:'2000-01-01'}},h))).status,409,'a retry repeats the date that was drawn');
   assert.equal((await req('/v1/signing/sign',post({...base,signatures:{...values,[i?'b':'title']:'Changed'},datePreviews},h))).status,409);
   const row=(await db.prepare('SELECT * FROM signatures WHERE id=?').bind(id).first<any>())!;const facts=JSON.parse(row.facts_json),render=JSON.parse(row.render_json);
   assert.equal(row.status,'PENDING');assert.equal(row.sequence,i+1);assert.equal(render.kind,'fields');assert.equal(facts.recipientEmail,i?'marcus@example.com':'ana@example.com');
   assert.ok(facts.consentedAt>=before&&facts.consentedAt<=after&&facts.consentedAt>=facts.otpVerifiedAt);
   assert.equal(render.fields.find((f:any)=>f.id===fieldId).value,previewDate,'date artwork must exactly match the server preview');
   assert.deepEqual(render.fields.map((f:any)=>f.id),fields.filter(f=>f.role===(i?'marcus':'ana')).map(f=>f.id));
   assert.equal(await processEnvelopeStep(env.DB,env.ARTIFACTS,'a',envelope.id),'processed');assert.equal(await processEnvelopeStep(env.DB,env.ARTIFACTS,'a',envelope.id),'processed');
   const output=(await db.prepare('SELECT output_sha256 AS sha256,output_artifact_id FROM signatures WHERE id=?').bind(id).first<{sha256:string;output_artifact_id:string}>())!,objectKey=`envelopes/${envelope.id}/${output.output_artifact_id}.pdf`;
   const saved=await (await bucket.get(objectKey))!.arrayBuffer();await bucket.put(objectKey,'tampered');
   assert.equal(await processEnvelopeStep(env.DB,env.ARTIFACTS,'a',envelope.id),'processing_failed');
   assert.equal((await req('/v1/signing/sign',post({...base,signatures:values,datePreviews},h))).status,409,'a changed signed PDF fails closed');
   await bucket.put(objectKey,saved);assert.equal((await (await req('/v1/signing/sign',post({...base,signatures:values,datePreviews},h))).json()).id,id);
   previous=output.sha256;
  }
 }finally{await mf.dispose();}
});
