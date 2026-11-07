import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,readdir,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Miniflare} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import {PDFDocument,PDFName,PDFRawStream} from 'pdf-lib';

test('single Worker D1/R2 management, editor and recipient lifecycle', {timeout:120000}, async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'consolidated-lifecycle-')); let mf:Miniflare|undefined;
 const origin='https://page.example.test', key='a'.repeat(64);
 try {
  const output=process.env.ESIGN_EXACT_BUILD!;
  const bindings:Record<string,string>={HOST_ENABLED:'true',RECIPIENT_GATEWAY_ORIGIN:origin,EDITOR_GATEWAY_ORIGIN:origin,MANAGEMENT_GATEWAY_ENABLED:'true',RECIPIENT_GATEWAY_ENABLED:'true',EDITOR_GATEWAY_ENABLED:'true',TRUSTED_RECIPIENT_ORIGINS:origin,TRUSTED_EDITOR_ORIGINS:origin,ISOLATED_OTP_ENABLED:'true',ISOLATED_OTP_SYNTHETIC_SINK_ENABLED:'true',ISOLATED_OTP_SYNTHETIC_SINK:'sink@example.test',ISOLATED_OTP_FROM:'sender@example.test',ISOLATED_OTP_PEPPER:'synthetic-otp-secret-with-at-least-32-bytes',ISOLATED_OTP_WINDOW_MS:'900000',ISOLATED_OTP_TENANT_LIMIT:'10',ISOLATED_OTP_ACCOUNT_LIMIT:'10'};
  for(const name of ['CANDIDATE_TEMPLATE_ADMISSION_WINDOW_MS','CANDIDATE_TEMPLATE_WINDOW_MS','CANDIDATE_PROVISION_WINDOW_MS','TEST_ISSUANCE_WINDOW_MS','TEST_EDITOR_WINDOW_MS']) bindings[name]='60000';
  for(const name of ['CANDIDATE_TEMPLATE_ADMISSION_TENANT_LIMIT','CANDIDATE_TEMPLATE_ADMISSION_DATABASE_LIMIT','CANDIDATE_TEMPLATE_TENANT_LIMIT','CANDIDATE_TEMPLATE_DATABASE_LIMIT','CANDIDATE_TEMPLATE_RETAINED_LIMIT','CANDIDATE_TEMPLATE_TENANT_RETAINED_LIMIT','CANDIDATE_PROVISION_TENANT_LIMIT','CANDIDATE_PROVISION_DATABASE_LIMIT','CANDIDATE_PROVISION_RETAINED_LIMIT','TEST_ISSUANCE_TENANT_LIMIT','TEST_ISSUANCE_DATABASE_LIMIT','TEST_OUTSTANDING_TENANT_LIMIT','TEST_OUTSTANDING_DATABASE_LIMIT',...['TENANT_ISSUANCE','DATABASE_ISSUANCE','TENANT_OUTSTANDING','DATABASE_OUTSTANDING','TENANT_RETAINED','DATABASE_RETAINED'].map(x=>'TEST_EDITOR_'+x)]) bindings[name]='100';
  mf=new Miniflare({modules:true,script:await readFile(join(output,'consolidated-worker.mjs'),'utf8'),compatibilityDate:'2026-01-01',d1Databases:['DB'],r2Buckets:['ARTIFACTS'],email:{send_email:[{name:'SEND_EMAIL',allowed_sender_addresses:['sender@example.test'],allowed_destination_addresses:['sink@example.test']}]},assets:{directory:join(output,'client'),binding:'ASSETS',routerConfig:{invoke_user_worker_ahead_of_assets:true,has_user_worker:true}},bindings,ratelimits:Object.fromEntries(['MANAGEMENT','RECIPIENT','EDITOR'].flatMap((name,i)=>[[name+'_RATE_LIMITER',{namespace_id:String(9100+i*2),simple:{limit:1000,period:60 as const}}],[name+'_LOCATION_RATE_LIMITER',{namespace_id:String(9101+i*2),simple:{limit:1000,period:60 as const}}]]))});
  const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('ARTIFACTS');
  for(const n of (await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort()) await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${n}`,'utf8')).map(s=>db.prepare(s)));
  const digest=async(s:string)=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))).toString('hex');
  await db.prepare('INSERT INTO tenants VALUES (?)').bind('tenant').run(); await db.prepare('INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,?)').bind(await digest(key),'tenant').run();
  await db.prepare('INSERT INTO tenant_page_origins VALUES (?,?)').bind('tenant',origin).run(); await db.prepare('INSERT INTO editor_allowed_origins VALUES (?,?)').bind('tenant',origin).run();
  const otherKey='b'.repeat(32); await db.prepare('INSERT INTO tenants VALUES (?)').bind('other').run(); await db.prepare('INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,?)').bind(await digest(otherKey),'other').run();
  const run=(path:string,init:RequestInit={})=>mf!.dispatchFetch(origin+path,{...init,headers:{'cf-connecting-ip':'192.0.2.1',...init.headers}} as any);
  const page=await run('/candidate.html'); assert.equal(page.status,200); assert.match(page.headers.get('content-security-policy')!,/connect-src https:\/\/page\.example\.test https:\/\/page\.example\.test/);
  const management=(path:string,init:RequestInit={})=>run(path,{...init,headers:{authorization:`Bearer ${key}`,...init.headers}});
  const json=(path:string,data:object)=>run(path,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(data)});
  const post=(path:string,data:object,extra:Record<string,string>={})=>management(path,{method:'POST',headers:{'content-type':'application/json',...extra},body:JSON.stringify(data)});
  const ok=async(r:Response,status=200)=>{assert.equal(r.status,status,await r.clone().text());return r;};
  const roles=['one','two'],fields=roles.map((role,i)=>({id:role,type:'Signature',role,page:1,required:true,rect:{x:.1,y:.1+i*.3,width:.5,height:.1}}));
  const pdf=await PDFDocument.create();pdf.addPage([600,800]);const bytes=await pdf.save();
  const form=new FormData();form.set('file',new File([bytes as BlobPart],'source.pdf',{type:'application/pdf'}));form.set('roles',JSON.stringify(roles));form.set('fields',JSON.stringify(fields));
  const upload=new Request(origin+'/upload',{method:'POST',body:form});
  const template=await (await ok(await management('/v1/templates',{method:'POST',headers:{'idempotency-key':'template1','content-type':upload.headers.get('content-type')!},body:await upload.arrayBuffer()}))).json() as {id:string};
  const issued=await (await ok(await post('/v1/editor-sessions',{origin,roles}))).json() as {pageId:string;code:string};
  assert.equal((await json('/v1/page-sessions/exchange',{code:issued.code})).status,401);
  const editor=await (await ok(await json('/v1/editor-sessions/exchange',issued))).json() as {token:string};
  assert.equal((await json('/v1/editor-sessions/exchange',issued)).status,401);
  assert.equal((await ok(await json('/v1/editor-sessions/context',{token:editor.token}))).status,200);
  assert.equal((await run('/v1/me',{headers:{authorization:`Bearer ${editor.token}`}})).status,401);
  const invalidEditor=await json('/v1/fields',{token:editor.token}); assert.equal(invalidEditor.status,401); assert.deepEqual(await invalidEditor.json(),{error:'invalid_session'});
  for(const mode of ['expired','revoked'] as const){
   const credential=await (await ok(await post('/v1/editor-sessions',{origin,roles}))).json() as {pageId:string;code:string};
   if(mode==='expired') await db.prepare('UPDATE editor_page_entries SET expires_at=0 WHERE page_id=?').bind(credential.pageId).run();
   else await db.prepare('INSERT INTO candidate_editor_revocations VALUES (?)').bind(credential.pageId).run();
   assert.equal((await json('/v1/editor-sessions/exchange',credential)).status,401);
   assert.equal((await db.prepare('SELECT used_at FROM editor_page_entries WHERE page_id=?').bind(credential.pageId).first<{used_at:number|null}>())!.used_at,null);
  }
  for(const mode of ['expired','revoked'] as const){
   const credential=await (await ok(await post('/v1/editor-sessions',{origin,roles}))).json() as {pageId:string;code:string};
   const token=(await (await ok(await json('/v1/editor-sessions/exchange',credential))).json() as {token:string}).token;
   if(mode==='expired') await db.prepare('UPDATE editor_page_tokens SET expires_at=0 WHERE token_hash=?').bind(await digest(token)).run();
   else await db.prepare('INSERT INTO candidate_editor_revocations VALUES (?)').bind(credential.pageId).run();
   assert.equal((await json('/v1/editor-sessions/context',{token})).status,401);
  }
  const badForm=new FormData();badForm.set('file',new File([bytes as BlobPart],'source.pdf'));badForm.set('fields',JSON.stringify([{...fields[0],role:'other'}]));
  const badUpload=new Request(origin+'/upload',{method:'POST',body:badForm});
  assert.equal((await run('/v1/editor-sessions/save',{method:'POST',headers:{origin,'x-editor-token':editor.token,'idempotency-key':'editor1','content-type':badUpload.headers.get('content-type')!},body:await badUpload.arrayBuffer()})).status,503);
  const editorForm=new FormData();editorForm.set('file',new File([bytes as BlobPart],'source.pdf'));editorForm.set('fields',JSON.stringify(fields));
  const editorUpload=new Request(origin+'/upload',{method:'POST',body:editorForm});
  const editorBytes=await editorUpload.arrayBuffer(),editorType=editorUpload.headers.get('content-type')!;
  const saveEditor=(id:string)=>run('/v1/editor-sessions/save',{method:'POST',headers:{origin,'x-editor-token':editor.token,'idempotency-key':id,'content-type':editorType},body:editorBytes});
  await ok(await saveEditor('editor_good')); assert.equal((await saveEditor('editor_other')).status,503);
  const envelope=await (await ok(await post('/v1/envelopes',{templateId:template.id,recipients:[{role:'one',name:'Ana',email:'ana@example.com'},{role:'two',name:'Marcus',email:'marcus@example.com'}]},{'idempotency-key':'envelope1'}))).json() as {id:string};
  await ok(await management(`/v1/envelopes/${envelope.id}/prepare`,{method:'POST'}));
  const tasks=(await (await ok(await management(`/v1/envelopes/${envelope.id}/tasks`))).json() as {tasks:{id:string}[]}).tasks;
  const foreign=(path:string,method='GET')=>run(path,{method,headers:{authorization:`Bearer ${otherKey}`}});
  assert.equal((await foreign(`/v1/envelopes/${envelope.id}/tasks`)).status,404);
  assert.equal((await foreign(`/v1/envelopes/${envelope.id}/tasks/${tasks[0].id}/recipient-revoke`,'POST')).status,503);
  assert.equal((await db.prepare('SELECT count(*) n FROM recipient_session_revocations').first<{n:number}>())!.n,0);
  for(const [path,method,headers] of [
   ['/v1/me?x=1','GET',{authorization:`Bearer ${key}`}],
   ['/v1/fields?x=1','POST',{origin,'content-type':'application/json'}],
   ['/v1/fields','GET',{origin}],
   ['/candidate.html?x=1','GET',{authorization:`Bearer ${key}`}],
   ['/v1/document/','POST',{origin,'content-type':'application/json'}],
  ] as [string,string,Record<string,string>][]) assert.equal((await run(path,{method,headers,...(method==='POST'?{body:JSON.stringify({token:editor.token})}:{})})).status,404,path);
  assert.equal((await run('/v1/sign',{method:'POST',headers:{origin,'content-type':'application/json',authorization:`Bearer ${key}`},body:'{}'})).status,403);
  assert.equal((await json('/v1/fields',{token:key})).status,401);
  const revokePath=`/v1/envelopes/${envelope.id}/tasks/${tasks[0].id}/recipient-revoke`;
  const revokedCode=await (await ok(await post(`/v1/envelopes/${envelope.id}/tasks/${tasks[0].id}/recipient-view`,{origin}))).json() as {code:string};
  const revokedSessionCode=await (await ok(await post(`/v1/envelopes/${envelope.id}/tasks/${tasks[0].id}/recipient-view`,{origin}))).json() as {code:string};
  const revokedSession=(await (await ok(await json('/v1/page-sessions/exchange',revokedSessionCode))).json() as {token:string}).token;
  await ok(await management(revokePath,{method:'POST'}),204);
  assert.equal((await json('/v1/page-sessions/exchange',revokedCode)).status,401);
  assert.equal((await json('/v1/document',{token:revokedSession})).status,401);
  assert.equal((await db.prepare('SELECT used_at FROM recipient_page_codes WHERE code_hash=?').bind(await digest(revokedCode.code)).first<{used_at:number|null}>())!.used_at,null);
  let previous=''; let firstOutput:{artifact_id:string;object_key:string;sha256:string}|undefined;
  for(let i=0;i<2;i++){
   const code=await (await ok(await post(`/v1/envelopes/${envelope.id}/tasks/${tasks[i].id}/recipient-view`,{origin}))).json() as {code:string};
   assert.equal((await json('/v1/editor-sessions/exchange',{pageId:issued.pageId,code:code.code})).status,401);
   if(i===0){
    const expiredSessionCode=await (await ok(await post(`/v1/envelopes/${envelope.id}/tasks/${tasks[i].id}/recipient-view`,{origin}))).json() as {code:string};
    const expiredSession=(await (await ok(await json('/v1/page-sessions/exchange',expiredSessionCode))).json() as {token:string}).token;
    await db.prepare('UPDATE recipient_page_sessions SET expires_at=0 WHERE token_hash=?').bind(await digest(expiredSession)).run();
    assert.equal((await json('/v1/document',{token:expiredSession})).status,401);
    const expired=await (await ok(await post(`/v1/envelopes/${envelope.id}/tasks/${tasks[i].id}/recipient-view`,{origin}))).json() as {code:string};
    await db.prepare('UPDATE recipient_page_codes SET expires_at=0 WHERE code_hash=?').bind(await digest(expired.code)).run();
    assert.equal((await json('/v1/page-sessions/exchange',expired)).status,401);
    assert.equal((await db.prepare('SELECT used_at FROM recipient_page_codes WHERE code_hash=?').bind(await digest(expired.code)).first<{used_at:number|null}>())!.used_at,null);
   }
   const session=await (await ok(await json('/v1/page-sessions/exchange',code))).json() as {token:string};
   assert.equal((await json('/v1/page-sessions/exchange',code)).status,401);
   assert.equal((await json('/v1/otp/send',{token:session.token})).status,204);
   assert.equal((await db.prepare('SELECT count(*) n FROM recipient_otp_challenges').first<{n:number}>())!.n,i+1);
   assert.equal((await run('/v1/me',{headers:{authorization:`Bearer ${session.token}`}})).status,401);
   assert.equal((await json('/v1/editor-sessions/context',{token:session.token})).status,401);
   assert.equal((await json('/v1/fields',{token:session.token})).status,401);
   assert.equal((await json('/v1/document',{token:session.token})).status,401);
   // Temporarily authorize this session to obtain a real preview, then remove the fixture.
   // The same complete payload must fail when no verification exists or only another session is verified.
   const sessionHash=await digest(session.token), email=i===0?'ana@example.com':'marcus@example.com';
   await db.prepare('INSERT INTO recipient_otp_verifications(task_id,session_hash,verified_at,recipient_email) VALUES (?,?,1,?)').bind(tasks[i].id,sessionHash,email).run();
   const before=await (await ok(await json('/v1/fields',{token:session.token}))).json() as {artifactId:string;artifactHash:string};
   const name=i===0?'Ana':'Marcus', field=roles[i];
   const preview=await ok(await json('/v1/preview',{token:session.token,fieldId:field,text:name}));
   const previewHash=preview.headers.get('x-signature-preview'); assert.ok(previewHash);
   const validSign={token:session.token,artifactId:before.artifactId,artifactHash:before.artifactHash,consent:true,idempotencyKey:`sign_req_${i}`,values:{[field]:name},signaturePreviews:{[field]:previewHash}};
   await db.prepare('DELETE FROM recipient_otp_verifications WHERE task_id=? AND session_hash=?').bind(tasks[i].id,sessionHash).run();
   const signCount=async()=> (await db.prepare('SELECT count(*) n FROM signature_records').first<{n:number}>())!.n;
   assert.equal(await signCount(),i);
   const unverifiedSign=await json('/v1/sign',validSign); assert.equal(unverifiedSign.status,401); assert.deepEqual(await unverifiedSign.json(),{error:'invalid_session'});
   assert.equal(await signCount(),i);
   // A verification bound to another session cannot authorize this session.
   const otherCode=await (await ok(await post(`/v1/envelopes/${envelope.id}/tasks/${tasks[i].id}/recipient-view`,{origin}))).json() as {code:string};
   const other=await (await ok(await json('/v1/page-sessions/exchange',otherCode))).json() as {token:string};
   await db.prepare('INSERT INTO recipient_otp_verifications(task_id,session_hash,verified_at,recipient_email) VALUES (?,?,1,?)').bind(tasks[i].id,await digest(other.token),email).run();
   assert.equal((await json('/v1/document',{token:session.token})).status,401);
   assert.equal((await json('/v1/sign',validSign)).status,401);
   assert.equal(await signCount(),i);
   // Correctly bind this session; no OTP provider or mail is invoked.
   await db.prepare('DELETE FROM recipient_otp_verifications WHERE task_id=? AND session_hash=?').bind(tasks[i].id,await digest(other.token)).run();
   await db.prepare('INSERT INTO recipient_otp_verifications(task_id,session_hash,verified_at,recipient_email) VALUES (?,?,1,?)').bind(tasks[i].id,sessionHash,email).run();
   const storedArtifact=await db.prepare('SELECT object_key FROM artifacts WHERE envelope_id=?').bind(envelope.id).first<{object_key:string}>(); assert.ok(storedArtifact);
   if(i===0){const saved=await bucket.get(storedArtifact.object_key); assert.ok(saved); const savedBytes=await saved.arrayBuffer(); await bucket.delete(storedArtifact.object_key); const unavailable=await json('/v1/document',{token:session.token}); assert.equal(unavailable.status,503); assert.deepEqual(await unavailable.json(),{error:'unavailable'}); await bucket.put(storedArtifact.object_key,savedBytes);}
   const current=await (await ok(await json('/v1/fields',{token:session.token}))).json() as {artifactId:string;artifactHash:string};
   if(i===0) assert.equal(current.artifactId,`d0:${envelope.id}`); else {assert.equal(current.artifactId,firstOutput!.artifact_id);assert.equal(current.artifactHash,firstOutput!.sha256);assert.notEqual(current.artifactHash,previous);}
   const document=Buffer.from(await (await ok(await json('/v1/document',{token:session.token}))).arrayBuffer());
   assert.equal(Buffer.from(await crypto.subtle.digest('SHA-256',document)).toString('hex'),current.artifactHash);
   assert.equal(document.subarray(0,5).toString(),'%PDF-');
   const stored=await db.prepare('SELECT object_key,sha256 FROM artifacts WHERE envelope_id=?').bind(envelope.id).first<{object_key:string;sha256:string}>(); assert.ok(stored);
   if(i===0){const source=await bucket.get(stored.object_key);assert.ok(source);assert.deepEqual(document,Buffer.from(await source.arrayBuffer()));assert.deepEqual(document,Buffer.from(bytes));assert.equal(current.artifactHash,stored.sha256);}
   else {const source=await bucket.get(firstOutput!.object_key);assert.ok(source);assert.deepEqual(document,Buffer.from(await source.arrayBuffer()));}
   assert.deepEqual(current,before);
   assert.equal((await json('/v1/sign',{...validSign,token:editor.token})).status,401);
   assert.equal((await json('/v1/sign',{...validSign,token:key})).status,401);
   assert.equal(await signCount(),i);
   const signed=await (await ok(await json('/v1/sign',{token:session.token,artifactId:current.artifactId,artifactHash:current.artifactHash,consent:true,idempotencyKey:`sign_req_${i}`,values:{[field]:name},signaturePreviews:{[field]:preview.headers.get('x-signature-preview')}}),202)).json() as {status:string};
   assert.equal(signed.status,'PROCESSED_UNSEALED'); previous=current.artifactHash;
   const outputRow=await db.prepare('SELECT o.artifact_id,o.object_key,o.sha256 FROM signature_outputs o JOIN signature_jobs j ON j.id=o.job_id JOIN signature_records r ON r.id=j.signature_id WHERE r.task_id=?').bind(tasks[i].id).first<{artifact_id:string;object_key:string;sha256:string}>();
   assert.ok(outputRow); const object=await bucket.get(outputRow.object_key); assert.ok(object);
   const outputBytes=Buffer.from(await object.arrayBuffer());
   assert.equal(Buffer.from(await crypto.subtle.digest('SHA-256',outputBytes)).toString('hex'),outputRow.sha256);
   assert.equal(outputBytes.subarray(0,5).toString(),'%PDF-');
   const signedPdf=await PDFDocument.load(outputBytes); assert.equal(signedPdf.getPageCount(),1);
   const images=signedPdf.context.enumerateIndirectObjects().filter(([,obj])=>obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype'))===PDFName.of('Image'));
   assert.ok(images.length>=i+1,'each signing step embeds a signature image');
   assert.notDeepEqual(outputBytes,document);
   if(i===0)firstOutput=outputRow; else assert.notEqual(outputRow.sha256,firstOutput!.sha256);
  }
  assert.equal((await db.prepare('SELECT count(*) n FROM signature_outputs').first<{n:number}>())!.n,2);
 }finally{await mf?.dispose();await rm(dir,{recursive:true,force:true});}
});
