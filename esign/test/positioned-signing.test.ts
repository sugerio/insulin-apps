import {unstable_splitSqlQuery} from 'wrangler';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {PDFDocument} from 'pdf-lib';
import app from '../src/worker.ts';

test('positioned signatures bind each role and preserve a sequential PDF chain',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB'],r2Buckets:['ARTIFACTS','TEST_MAIL']});
 try {
  const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('ARTIFACTS');
  for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort()) {const sql=await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8');await db.batch(unstable_splitSqlQuery(sql).map(s=>db.prepare(s)));}
  const key='local-test-key-0123456789-abcdefghijklmnopqrstuvwxyz',origin='https://host.example.com';
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key))),n=>n.toString(16).padStart(2,'0')).join('');
  await db.prepare("INSERT INTO tenants VALUES ('a')").run();await db.prepare("INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,'a')").bind(hash).run();await db.prepare("INSERT INTO tenant_page_origins VALUES ('a',?)").bind(origin).run();
  const env={DB:db,ARTIFACTS:bucket,TEST_MAIL:await mf.getR2Bucket('TEST_MAIL'),LOCAL_TEST_MODE:'true',LOCAL_TEST_OTP_KEY:'local-test-pepper-at-least-32-bytes',LOCAL_TEST_SEAL_KEY:'local-test-seal-key-at-least-32-bytes'};
  const req=(path:string,init:RequestInit={})=>app.fetch(new Request('http://localhost'+path,init),env),mgmt={authorization:`Bearer ${key}`};
  const post=(body:unknown,headers:Record<string,string>)=>({method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)});
  const pdf=await PDFDocument.create();pdf.addPage([400,500]);const form=new FormData();form.set('file',new File([await pdf.save()],'synthetic.pdf'));form.set('roles','["ana","marcus"]');
  const template=await (await req('/v1/templates',{method:'POST',headers:mgmt,body:form})).json();
  const fields=[{id:'a',type:'Signature',role:'ana',page:1,required:true,rect:{x:.1,y:.2,width:.3,height:.1}},{id:'b',type:'Signature',role:'marcus',page:1,required:true,rect:{x:.5,y:.7,width:.3,height:.1}}];
  await db.prepare('UPDATE templates SET fields_json=? WHERE id=?').bind(JSON.stringify(fields),template.id).run();
  for(const type of ['Text box','Date signed','Title']) for(const role of ['ana','marcus']) for(const required of [true,false]) {
   const extra={id:'unsupported',type,role,page:1,required,rect:{x:.1,y:.4,width:.3,height:.1}};
   await db.prepare('UPDATE templates SET fields_json=? WHERE id=?').bind(JSON.stringify([...fields,extra]),template.id).run();
   const unsupported=await req('/v1/envelopes',post({templateId:template.id,recipients:[{role:'ana',name:'Ana',email:'ana@example.com'},{role:'marcus',name:'Marcus',email:'marcus@example.com'}]},{...mgmt,'idempotency-key':`unsupported-${type.replaceAll(' ','-')}-${role}-${required}`}));assert.equal(unsupported.status,422,`${type} ${role} required=${required}`);
  }
  assert.equal((await db.prepare('SELECT count(*) AS n FROM envelopes').first())!.n,0);
  await db.prepare('UPDATE templates SET fields_json=? WHERE id=?').bind(JSON.stringify([fields[0],{...fields[1],rect:{...fields[0].rect,x:.2}}]),template.id).run();
  const overlap=await req('/v1/envelopes',post({templateId:template.id,recipients:[{role:'ana',name:'Ana',email:'ana@example.com'},{role:'marcus',name:'Marcus',email:'marcus@example.com'}]},{...mgmt,'idempotency-key':'overlap'}));assert.equal(overlap.status,422);
  await db.prepare('UPDATE templates SET fields_json=? WHERE id=?').bind(JSON.stringify(fields),template.id).run();
  const created=await req('/v1/envelopes',post({templateId:template.id,recipients:[{role:'ana',name:'Ana',email:'ana@example.com'},{role:'marcus',name:'Marcus',email:'marcus@example.com'}]},{...mgmt,'idempotency-key':'positioned'}));assert.equal(created.status,201,await created.clone().text());const envelope=await created.json();
  assert.equal((await req(`/v1/envelopes/${envelope.id}/prepare`,{method:'POST',headers:mgmt})).status,204);
  const tasks=(await (await req(`/v1/envelopes/${envelope.id}`,{headers:mgmt})).json()).tasks;
  for(let i=0;i<2;i++) {
   const view=await (await req(`/v1/envelopes/${envelope.id}/tasks/${tasks[i].id}/recipient-view`,post({origin},mgmt))).json();const session=await (await req('/v1/page-sessions/exchange',post({code:view.code},{origin}))).json();const headers={origin,authorization:`Bearer ${session.token}`};
   assert.equal((await req('/v1/signing/current',{headers})).status,401);assert.equal((await req('/v1/signing/sign',post({artifactId:'missing',artifactHash:'0'.repeat(64),consent:true,signatures:{[fields[i].id]:'ANA'}},headers))).status,409);
   const sent=await (await req('/v1/signing/otp',post({},headers))).json();const otp=await (await env.TEST_MAIL.get(`test-mail/${sent.messageId}.json`))!.json() as {otp:string};assert.equal((await req('/v1/signing/otp/verify',post({otp:otp.otp},headers))).status,204);
   const current=await (await req('/v1/signing/current',{headers})).json();assert.deepEqual(current.fields,[fields[i]]);assert.equal(current.role,fields[i].role);assert.equal(current.recipientName,i?'Marcus':'Ana');
   const base={artifactId:current.id,artifactHash:current.sha256,consent:true};
   if(i===0){
    const invalidTemplates=[ [fields[0],{...fields[1],rect:{...fields[0].rect,x:.2}}], ...['Date signed','Title'].flatMap(type=>['ana','marcus'].map(role=>[...fields,{id:'extra',type,role,page:1,required:true,rect:{x:.1,y:.4,width:.3,height:.1}}])) ];
    for(const invalid of invalidTemplates){await db.prepare('UPDATE templates SET fields_json=? WHERE id=?').bind(JSON.stringify(invalid),template.id).run();assert.equal((await req('/v1/signing/current',{headers})).status,401);assert.equal((await req('/v1/signing/sign',post({...base,signatures:{a:'ANA'}},headers))).status,409);assert.equal((await db.prepare('SELECT count(*) AS n FROM signature_records').first())!.n,0);assert.equal((await db.prepare('SELECT count(*) AS n FROM signature_events').first())!.n,0);assert.equal((await db.prepare('SELECT count(*) AS n FROM signature_jobs').first())!.n,0);}
    await db.prepare('UPDATE templates SET fields_json=? WHERE id=?').bind(JSON.stringify(fields),template.id).run();
   }
   assert.equal((await req('/v1/signing/sign',post({...base,signatures:{}},headers))).status,409);
   assert.equal((await req('/v1/signing/sign',post({...base,signatures:{[fields[1-i].id]:'Wrong'}},headers))).status,409);
   const body={...base,signatures:{[fields[i].id]:i?'MARCUS':'ANA'}};
   const keyRow=i===0?await db.prepare('SELECT object_key FROM artifacts WHERE id=?').bind(current.id).first<{object_key:string}>():await db.prepare('SELECT object_key FROM signature_outputs WHERE artifact_id=?').bind(current.id).first<{object_key:string}>();const inputBytes=await (await bucket.get(keyRow!.object_key))!.arrayBuffer();await bucket.put(keyRow!.object_key,'tampered');assert.equal((await req('/v1/signing/sign',post(body,headers))).status,409);await bucket.put(keyRow!.object_key,inputBytes);
   assert.equal((await req('/v1/signing/sign',post({...body,consent:false},headers))).status,400);
   assert.equal((await req('/v1/signing/sign',post({...body,artifactHash:'0'.repeat(64)},headers))).status,409);
   if(i===0){
    const narrow=[{...fields[0],rect:{...fields[0].rect,width:.05}},{...fields[1],rect:{x:.17,y:.2,width:.2,height:.1}}];
    await db.prepare('UPDATE templates SET fields_json=? WHERE id=?').bind(JSON.stringify(narrow),template.id).run();
    const blocked=await req('/v1/signing/signature-preview',post({fieldId:'a',text:'Alexander'},headers));assert.equal(blocked.status,422,'other recipient field blocks expanded signature');
    assert.equal((await req('/v1/signing/sign',post({...base,signatures:{a:'Alexander'},signaturePreviews:{a:'0'.repeat(64)}},headers))).status,409);
    for(const table of ['signature_records','signature_events','signature_jobs'])assert.equal((await db.prepare(`SELECT count(*) AS n FROM ${table}`).first())!.n,0);
    await db.prepare('UPDATE templates SET fields_json=? WHERE id=?').bind(JSON.stringify(fields),template.id).run();
   }
   const previews=await req('/v1/signing/signature-preview',post({fieldId:fields[i].id,text:body.signatures[fields[i].id]},headers));assert.equal(previews.status,200);assert.equal(previews.headers.get('content-type'),'image/png');
   const signedBody={...body,signaturePreviews:{[fields[i].id]:previews.headers.get('X-Signature-Preview')}};if(i===0){const moved=fields.map(f=>f.id==='a'?{...f,rect:{...f.rect,x:.11}}:f);await db.prepare('UPDATE templates SET fields_json=? WHERE id=?').bind(JSON.stringify(moved),template.id).run();assert.equal((await req('/v1/signing/sign',post(signedBody,headers))).status,409,'changed geometry invalidates preview');assert.equal((await db.prepare('SELECT count(*) AS n FROM signature_records').first())!.n,0);await db.prepare('UPDATE templates SET fields_json=? WHERE id=?').bind(JSON.stringify(fields),template.id).run();}const race=await Promise.all([req('/v1/signing/sign',post(signedBody,headers)),req('/v1/signing/sign',post(signedBody,headers))]);assert.deepEqual(race.map(r=>r.status),[202,202]);const ids=await Promise.all(race.map(r=>r.json()));assert.equal(ids[0].id,ids[1].id);const id=ids[0].id;
   assert.equal((await (await req('/v1/signing/sign',post(body,headers))).json()).id,id);
   assert.equal((await req('/v1/signing/sign',post({...body,signatures:{[fields[i].id]:'CHANGED'}},headers))).status,409);
   const imageKey=`envelopes/${envelope.id}/signature-images/${id}/${fields[i].id}.png`;const imageBytes=await (await bucket.get(imageKey))!.arrayBuffer();await bucket.put(imageKey,'tampered');
   assert.equal((await req(`/v1/envelopes/${envelope.id}/process`,{method:'POST',headers:mgmt})).status,503);await bucket.put(imageKey,imageBytes);
   const processRace=await Promise.all([req(`/v1/envelopes/${envelope.id}/process`,{method:'POST',headers:mgmt}),req(`/v1/envelopes/${envelope.id}/process`,{method:'POST',headers:mgmt})]);assert.deepEqual(processRace.map(r=>r.status),[204,204]);
   await db.prepare('UPDATE signature_events SET event_version=3 WHERE signature_id=?').bind(id).run();
   assert.equal((await req(`/v1/envelopes/${envelope.id}/process`,{method:'POST',headers:mgmt})).status,503,'unmounted v3 DONE must not report success');
   await db.prepare('UPDATE signature_events SET event_version=2 WHERE signature_id=?').bind(id).run();
   await db.prepare('UPDATE recipient_page_sessions SET expires_at=0 WHERE task_id=?').bind(tasks[i].id).run();assert.equal((await req('/v1/signing/sign',post(body,headers))).status,409);
  }
  assert.equal((await req(`/v1/envelopes/${envelope.id}/finalize`,{method:'POST',headers:mgmt})).status,204);
  const final=await req(`/v1/envelopes/${envelope.id}/final-pdf`,{headers:mgmt});assert.equal(final.status,200);const finalBytes=await final.arrayBuffer();assert.equal((await PDFDocument.load(finalBytes.slice(0))).getPageCount(),1);
  const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');const doc=await pdfjs.getDocument({data:new Uint8Array(finalBytes)}).promise;const ops=await (await doc.getPage(1)).getOperatorList();
  const transforms=ops.argsArray.filter((_:unknown,i:number)=>ops.fnArray[i]===pdfjs.OPS.transform);assert.equal(ops.fnArray.filter((fn:number)=>fn===pdfjs.OPS.paintImageXObject).length,2);assert.equal(transforms.length,8);
  for(let i=0;i<2;i++){const translate=transforms[i*4],scale=transforms[i*4+2],r=fields[i].rect;assert.equal(translate[4],r.x*400);assert.ok(Math.abs(translate[5]+scale[3]-(1-r.y)*500)<1e-6);assert.ok(scale[0]<=r.width*400&&scale[3]<=r.height*500);}
  const image=(await db.prepare('SELECT signature_id,payload_json FROM positioned_signature_inputs ORDER BY rowid LIMIT 1').first()) as any;const payload=JSON.parse(image.payload_json),imageKey=`envelopes/${envelope.id}/signature-images/${image.signature_id}/${payload.fields[0].id}.png`;const saved=await (await bucket.get(imageKey))!.arrayBuffer();
  assert.equal((await req(`/v1/envelopes/${envelope.id}/certificate`,{headers:mgmt})).status,200);await bucket.put(imageKey,'tampered');assert.equal((await req(`/v1/envelopes/${envelope.id}/certificate`,{headers:mgmt})).status,503);assert.equal((await req(`/v1/envelopes/${envelope.id}/process`,{method:'POST',headers:mgmt})).status,503);await bucket.put(imageKey,saved);
  await db.prepare('UPDATE positioned_signature_inputs SET payload_json=? WHERE signature_id=?').bind(image.payload_json.replace('ANA','BOB'),image.signature_id).run();assert.equal((await req(`/v1/envelopes/${envelope.id}/certificate`,{headers:mgmt})).status,503);await db.prepare('UPDATE positioned_signature_inputs SET payload_json=? WHERE signature_id=?').bind(image.payload_json,image.signature_id).run();
 }finally{await mf.dispose();}
});
