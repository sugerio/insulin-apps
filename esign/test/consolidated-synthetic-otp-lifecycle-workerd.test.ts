import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,readdir,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {MockAgent} from 'undici';
import {Miniflare} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import {PDFDocument,PDFName,PDFRawStream} from 'pdf-lib';
import {signaturePreviewHash} from '../src/positioned-signature-preview.ts';
import {signatureGeometry} from '../src/positioned-signature-geometry.ts';
import {renderTypedSignature} from '../src/typed-signature-image.ts';
import {stagedAssetPaths,validateStagedManifest,validateStagedPaths} from './staged-artifact-manifest.ts';

for(const quotaCase of ['per-task','global','staged'] as const) test(`single Worker synthetic OTP lifecycle and ${quotaCase} lifetime quota`, {timeout:120000,skip:quotaCase==='staged'&&!process.env.ESIGN_STAGED_DIR}, async()=>{
 const staged=quotaCase==='staged', stagedDir=process.env.ESIGN_STAGED_DIR;
 if(staged) await validateStagedPaths(stagedDir!);
 const config=staged ? JSON.parse(await readFile(join(stagedDir!,'wrangler.json'),'utf8')) : undefined;
 const origin=staged ? config.vars.RECIPIENT_GATEWAY_ORIGIN as string : 'https://page.example.test', key='a'.repeat(64);
 const mockAgent=new MockAgent(); mockAgent.disableNetConnect();
 const dir=await mkdtemp(join(await realpath(tmpdir()),'consolidated-lifecycle-')); let mf:Miniflare|undefined;
 try {
  const output=staged ? join(stagedDir!,'build') : join(dir,'build');
  if(staged){
   const assets=await stagedAssetPaths(join(output,'client'));
   const pins=validateStagedManifest(await readFile(join(stagedDir!,'SHA256.txt'),'utf8'),assets);
   for(const [path,hash] of pins) assert.equal(createHash('sha256').update(await readFile(join(stagedDir!,path))).digest('hex'),hash,path);
   assert.equal(config.vars.EDITOR_GATEWAY_ORIGIN,origin);
  } else {const build=spawnSync(process.execPath,['scripts/build-candidate-assets.ts',output],{encoding:'utf8',env:{...process.env,VITE_CANDIDATE_GATEWAY_ORIGIN:origin,VITE_CANDIDATE_EDITOR_GATEWAY_ORIGIN:origin}}); assert.equal(build.status,0,build.stderr);}
  const bindings:Record<string,string>={HOST_ENABLED:'true',RECIPIENT_GATEWAY_ORIGIN:origin,EDITOR_GATEWAY_ORIGIN:origin,MANAGEMENT_GATEWAY_ENABLED:'true',RECIPIENT_GATEWAY_ENABLED:'true',EDITOR_GATEWAY_ENABLED:'true',TRUSTED_RECIPIENT_ORIGINS:origin,TRUSTED_EDITOR_ORIGINS:origin,ISOLATED_OTP_ENABLED:'true',ISOLATED_OTP_SYNTHETIC_SINK_ENABLED:'true',ISOLATED_OTP_SYNTHETIC_SINK:'sink@example.test',ISOLATED_OTP_FROM:'sender@example.test',ISOLATED_OTP_PEPPER:'synthetic-only-pepper-at-least-32-bytes',ISOLATED_OTP_WINDOW_MS:'86400000',ISOLATED_OTP_TENANT_LIMIT:'100',ISOLATED_OTP_ACCOUNT_LIMIT:'100'};
  for(const name of ['CANDIDATE_TEMPLATE_ADMISSION_WINDOW_MS','CANDIDATE_TEMPLATE_WINDOW_MS','CANDIDATE_PROVISION_WINDOW_MS','TEST_ISSUANCE_WINDOW_MS','TEST_EDITOR_WINDOW_MS']) bindings[name]='60000';
  for(const name of ['CANDIDATE_TEMPLATE_ADMISSION_TENANT_LIMIT','CANDIDATE_TEMPLATE_ADMISSION_DATABASE_LIMIT','CANDIDATE_TEMPLATE_TENANT_LIMIT','CANDIDATE_TEMPLATE_DATABASE_LIMIT','CANDIDATE_TEMPLATE_RETAINED_LIMIT','CANDIDATE_TEMPLATE_TENANT_RETAINED_LIMIT','CANDIDATE_PROVISION_TENANT_LIMIT','CANDIDATE_PROVISION_DATABASE_LIMIT','CANDIDATE_PROVISION_RETAINED_LIMIT','TEST_ISSUANCE_TENANT_LIMIT','TEST_ISSUANCE_DATABASE_LIMIT','TEST_OUTSTANDING_TENANT_LIMIT','TEST_OUTSTANDING_DATABASE_LIMIT',...['TENANT_ISSUANCE','DATABASE_ISSUANCE','TENANT_OUTSTANDING','DATABASE_OUTSTANDING','TENANT_RETAINED','DATABASE_RETAINED'].map(x=>'TEST_EDITOR_'+x)]) bindings[name]='100';
  if(staged) Object.assign(bindings,config.vars,{ISOLATED_OTP_FROM:'sender@example.test',ISOLATED_OTP_SYNTHETIC_SINK:'sink@example.test',ISOLATED_OTP_PEPPER:'synthetic-only-pepper-at-least-32-bytes'});
  // Test-only wrapper captures the Cloudflare Email binding; no network provider is used.
  const wrapperSource=`import worker from './artifact.mjs'; const mail=[]; export default {fetch(req,env){if(new URL(req.url).pathname==='/__test/mail')return Response.json(mail); return worker.fetch(req,{...env,SEND_EMAIL:{async send(message){mail.push(message)}}});}}`;
  const rateLimits=staged ? Object.fromEntries(config.ratelimits.map((r:{name:string;namespace_id:string;simple:{limit:number;period:60}})=>[r.name,{namespace_id:r.namespace_id,simple:r.simple}])) : Object.fromEntries(['MANAGEMENT','RECIPIENT','EDITOR'].flatMap((name,i)=>[[name+'_RATE_LIMITER',{namespace_id:String(9100+i*2),simple:{limit:1000,period:60 as const}}],[name+'_LOCATION_RATE_LIMITER',{namespace_id:String(9101+i*2),simple:{limit:1000,period:60 as const}}]]));
  mf=new Miniflare({modules:[{type:'ESModule',path:'wrapper.mjs',contents:wrapperSource},{type:'ESModule',path:'artifact.mjs',contents:await readFile(join(output,'consolidated-worker.mjs'),'utf8')}],compatibilityDate:staged?config.compatibility_date:'2026-01-01',// workerd rejects this redundant flag, which is already default at the staged date.
  compatibilityFlags:staged?config.compatibility_flags.filter((flag:string)=>flag!=='formdata_parser_supports_files'):[],d1Databases:['DB'],r2Buckets:['ARTIFACTS'],assets:{directory:join(output,'client'),binding:'ASSETS',routerConfig:{invoke_user_worker_ahead_of_assets:true,has_user_worker:true}},bindings,ratelimits:rateLimits,fetchMock:mockAgent});
  const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('ARTIFACTS');
  for(const n of (await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort()) await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${n}`,'utf8')).map(s=>db.prepare(s)));
  const digest=async(s:string)=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))).toString('hex');
  await db.prepare('INSERT INTO tenants VALUES (?)').bind('tenant').run(); await db.prepare('INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,?)').bind(await digest(key),'tenant').run();
  await db.prepare('INSERT INTO tenant_page_origins VALUES (?,?)').bind('tenant',origin).run(); await db.prepare('INSERT INTO editor_allowed_origins VALUES (?,?)').bind('tenant',origin).run();
  const otherKey='b'.repeat(32); await db.prepare('INSERT INTO tenants VALUES (?)').bind('other').run(); await db.prepare('INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,?)').bind(await digest(otherKey),'other').run();
  const run=(path:string,init:RequestInit={})=>mf!.dispatchFetch(origin+path,{...init,headers:{'cf-connecting-ip':'192.0.2.1',...init.headers}} as any);
  if(staged){
   const assets=await stagedAssetPaths(join(output,'client'));
   for(const page of ['candidate.html','candidate-editor.html']) assert.ok(assets.includes(page),`missing entry page ${page}`);
   for(const asset of assets){
    const response=await run('/'+asset); assert.equal(response.status,200,asset);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),await readFile(join(output,'client',asset)),asset);
    const csp=response.headers.get('content-security-policy');
    assert.ok(csp,asset); for(const directive of ["default-src 'none'","script-src 'self'",`connect-src ${origin} ${origin}`,"frame-ancestors 'none'","base-uri 'none'","form-action 'none'"]) assert.ok(csp.split(';').map(x=>x.trim()).includes(directive),`${asset}: ${directive}`);
   }
   for(const page of ['candidate.html','candidate-editor.html']) {
    const html=await readFile(join(output,'client',page),'utf8');
    const references=[...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map(match=>match[1].slice(1));
    assert.ok(references.length>0,`${page}: no referenced assets`);
    for(const reference of references) assert.ok(assets.includes(reference),`${page}: missing ${reference}`);
   }
  }
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
  if(!staged) for(const mode of ['expired','revoked'] as const){
   const credential=await (await ok(await post('/v1/editor-sessions',{origin,roles}))).json() as {pageId:string;code:string};
   if(mode==='expired') await db.prepare('UPDATE editor_page_entries SET expires_at=0 WHERE page_id=?').bind(credential.pageId).run();
   else await db.prepare('INSERT INTO candidate_editor_revocations VALUES (?)').bind(credential.pageId).run();
   assert.equal((await json('/v1/editor-sessions/exchange',credential)).status,401);
   assert.equal((await db.prepare('SELECT used_at FROM editor_page_entries WHERE page_id=?').bind(credential.pageId).first<{used_at:number|null}>())!.used_at,null);
  }
  if(!staged) for(const mode of ['expired','revoked'] as const){
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
  const envelope=await (await ok(await post('/v1/envelopes',{templateId:template.id,recipients:[{role:'one',name:'Ana',email:'first-label@example.test'},{role:'two',name:'Marcus',email:'second-label@example.test'}]},{'idempotency-key':'envelope1'}))).json() as {id:string};
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
  if(!staged){
  const revokePath=`/v1/envelopes/${envelope.id}/tasks/${tasks[0].id}/recipient-revoke`;
  const revokedCode=await (await ok(await post(`/v1/envelopes/${envelope.id}/tasks/${tasks[0].id}/recipient-view`,{origin}))).json() as {code:string};
  const revokedSessionCode=await (await ok(await post(`/v1/envelopes/${envelope.id}/tasks/${tasks[0].id}/recipient-view`,{origin}))).json() as {code:string};
  const revokedSession=(await (await ok(await json('/v1/page-sessions/exchange',revokedSessionCode))).json() as {token:string}).token;
  await ok(await management(revokePath,{method:'POST'}),204);
  assert.equal((await json('/v1/page-sessions/exchange',revokedCode)).status,401);
  assert.equal((await json('/v1/document',{token:revokedSession})).status,401);
  assert.equal((await db.prepare('SELECT used_at FROM recipient_page_codes WHERE code_hash=?').bind(await digest(revokedCode.code)).first<{used_at:number|null}>())!.used_at,null);
  }
  let previous=''; let firstOutput:{artifact_id:string;object_key:string;sha256:string}|undefined;
  for(let i=0;i<2;i++){
   const code=await (await ok(await post(`/v1/envelopes/${envelope.id}/tasks/${tasks[i].id}/recipient-view`,{origin}))).json() as {code:string};
   assert.equal((await json('/v1/editor-sessions/exchange',{pageId:issued.pageId,code:code.code})).status,401);
   if(i===0 && !staged){
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
   assert.equal((await run('/v1/me',{headers:{authorization:`Bearer ${session.token}`}})).status,401);
   assert.equal((await json('/v1/editor-sessions/context',{token:session.token})).status,401);
   assert.equal((await json('/v1/fields',{token:session.token})).status,401);
   assert.equal((await json('/v1/document',{token:session.token})).status,401);
   // Only the same-origin OTP routes can create the session-bound verification.
   const sessionHash=await digest(session.token);
   assert.equal((await json('/v1/otp/send',{token:key,origin})).status,503);
   await ok(await json('/v1/otp/send',{token:session.token,origin}),204);
   const messages=await (await run('/__test/mail')).json() as {from:string;to:string;text:string}[];
   assert.equal(messages.length,i+1); const message=messages[i];
   assert.equal(message.from,'sender@example.test'); assert.equal(message.to,'sink@example.test');
   assert.ok(!message.text.includes('first-label@example.test')&&!message.text.includes('second-label@example.test'));
   const otp=message.text.match(/\b\d{6}\b/)?.[0]; assert.ok(otp);
   assert.equal((await json('/v1/otp/verify',{token:session.token,origin,otp:otp==='000000'?'000001':'000000'})).status,401);
   assert.equal((await json('/v1/fields',{token:session.token})).status,401);
   await ok(await json('/v1/otp/verify',{token:session.token,origin,otp}),204);
   assert.equal((await json('/v1/otp/verify',{token:session.token,origin,otp})).status,401);
   const before=await (await ok(await json('/v1/fields',{token:session.token}))).json() as {artifactId:string;artifactHash:string};
   const name=i===0?'Ana':'Marcus', field=roles[i];
   const preview=await ok(await json('/v1/preview',{token:session.token,fieldId:field,text:name}));
   const previewHash=preview.headers.get('x-signature-preview'); assert.ok(previewHash);
   const validSign={token:session.token,artifactId:before.artifactId,artifactHash:before.artifactHash,consent:true,idempotencyKey:`sign_req_${i}`,values:{[field]:name},signaturePreviews:{[field]:previewHash}};
   const signCount=async()=> (await db.prepare('SELECT count(*) n FROM signature_records').first<{n:number}>())!.n;
   assert.equal(await signCount(),i);
   const wrongField=roles[1-i];
   assert.equal((await json('/v1/preview',{token:session.token,fieldId:wrongField,text:name})).status,503);
   // The other task cannot preview until its turn. Compute the exact preview binding
   // for this artifact and template, first cross-checking it against the authorized preview.
   const templateData=await db.prepare('SELECT roles_json,fields_json FROM templates WHERE id=?').bind(template.id).first<{roles_json:string;fields_json:string}>(); assert.ok(templateData);
   const artifactObject=await bucket.get(i===0?(await db.prepare('SELECT object_key FROM artifacts WHERE envelope_id=?').bind(envelope.id).first<{object_key:string}>())!.object_key:firstOutput!.object_key); assert.ok(artifactObject);
   const inputPdf=await PDFDocument.load(await artifactObject.arrayBuffer());
   const image=await renderTypedSignature(name), imageHash=Buffer.from(await crypto.subtle.digest('SHA-256',Uint8Array.from(image))).toString('hex');
   const binding=(index:number)=>signaturePreviewHash(before.artifactHash,templateData.roles_json,templateData.fields_json,roles[index],name,imageHash,signatureGeometry(inputPdf.getPage(0),fields[index],image));
   assert.equal(await binding(i),previewHash);
   const wrongPreview=await binding(1-i);
   const countsBeforeWrong=await Promise.all(['signature_records','signature_jobs','signature_outputs'].map(async table=>(await db.prepare(`SELECT count(*) n FROM ${table}`).first<{n:number}>())!.n));
   assert.equal((await json('/v1/sign',{...validSign,idempotencyKey:`wrong_role_${i}`,values:{...validSign.values,[wrongField]:name},signaturePreviews:{...validSign.signaturePreviews,[wrongField]:wrongPreview}})).status,400);
   assert.deepEqual(await Promise.all(['signature_records','signature_jobs','signature_outputs'].map(async table=>(await db.prepare(`SELECT count(*) n FROM ${table}`).first<{n:number}>())!.n)),countsBeforeWrong);
   assert.equal(await signCount(),i);
   // Verification for this session does not authorize another session for the task.
   if(!staged){
   const otherCode=await (await ok(await post(`/v1/envelopes/${envelope.id}/tasks/${tasks[i].id}/recipient-view`,{origin}))).json() as {code:string};
   const other=await (await ok(await json('/v1/page-sessions/exchange',otherCode))).json() as {token:string};
   assert.equal((await json('/v1/document',{token:other.token})).status,401);
   assert.equal((await json('/v1/sign',{...validSign,token:other.token})).status,401);
   assert.equal(await signCount(),i);
   }
   assert.equal((await db.prepare('SELECT session_hash FROM recipient_otp_verifications WHERE task_id=?').bind(tasks[i].id).first<{session_hash:string}>())!.session_hash,sessionHash);
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
   const signed=await (await ok(await json('/v1/sign',validSign),202)).json() as {status:string};
   assert.equal(signed.status,'PROCESSED_UNSEALED'); previous=current.artifactHash;
   const outputRow=await db.prepare('SELECT o.artifact_id,o.object_key,o.sha256 FROM signature_outputs o JOIN signature_jobs j ON j.id=o.job_id JOIN signature_records r ON r.id=j.signature_id WHERE r.task_id=?').bind(tasks[i].id).first<{artifact_id:string;object_key:string;sha256:string}>();
   assert.ok(outputRow); const beforeReplayObject=await bucket.get(outputRow.object_key); assert.ok(beforeReplayObject);
   const beforeReplayBytes=Buffer.from(await beforeReplayObject.arrayBuffer());
   const countsBefore=await Promise.all(['signature_records','signature_jobs','signature_outputs'].map(async table=>(await db.prepare(`SELECT count(*) n FROM ${table}`).first<{n:number}>())!.n));
   const replay=await (await ok(await json('/v1/sign',validSign),202)).json(); assert.deepEqual(replay,signed);
   assert.deepEqual(await Promise.all(['signature_records','signature_jobs','signature_outputs'].map(async table=>(await db.prepare(`SELECT count(*) n FROM ${table}`).first<{n:number}>())!.n)),countsBefore);
   assert.deepEqual(await db.prepare('SELECT o.artifact_id,o.object_key,o.sha256 FROM signature_outputs o JOIN signature_jobs j ON j.id=o.job_id JOIN signature_records r ON r.id=j.signature_id WHERE r.task_id=?').bind(tasks[i].id).first(),outputRow);
   const object=await bucket.get(outputRow.object_key); assert.ok(object);
   const outputBytes=Buffer.from(await object.arrayBuffer()); assert.deepEqual(outputBytes,beforeReplayBytes);
   assert.equal(Buffer.from(await crypto.subtle.digest('SHA-256',outputBytes)).toString('hex'),outputRow.sha256);
   assert.equal(outputBytes.subarray(0,5).toString(),'%PDF-');
   const signedPdf=await PDFDocument.load(outputBytes); assert.equal(signedPdf.getPageCount(),1);
   const images=signedPdf.context.enumerateIndirectObjects().filter(([,obj])=>obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype'))===PDFName.of('Image'));
   assert.ok(images.length>=i+1,'each signing step embeds a signature image');
   assert.notDeepEqual(outputBytes,document);
   if(i===0)firstOutput=outputRow; else assert.notEqual(outputRow.sha256,firstOutput!.sha256);
  }
  if(staged){
   assert.deepEqual((await db.prepare('SELECT scope_kind,send_count,send_limit FROM isolated_otp_send_budgets ORDER BY scope_kind').all()).results,[{scope_kind:'account',send_count:2,send_limit:2},{scope_kind:'tenant',send_count:2,send_limit:2}]);
   const nextEnvelope=await (await ok(await post('/v1/envelopes',{templateId:template.id,recipients:[{role:'one',name:'Dana',email:'quota-one@example.test'},{role:'two',name:'Lee',email:'quota-two@example.test'}]},{'idempotency-key':'headroom_envelope'}))).json() as {id:string};
   await ok(await management(`/v1/envelopes/${nextEnvelope.id}/prepare`,{method:'POST'}));
   const nextTask=((await (await ok(await management(`/v1/envelopes/${nextEnvelope.id}/tasks`))).json() as {tasks:{id:string}[]}).tasks)[0];
   const nextCode=await (await ok(await post(`/v1/envelopes/${nextEnvelope.id}/tasks/${nextTask.id}/recipient-view`,{origin}))).json() as {code:string};
   const nextSession=await (await ok(await json('/v1/page-sessions/exchange',nextCode))).json() as {token:string};
   assert.equal((await json('/v1/otp/send',{token:nextSession.token,origin})).status,503);
   assert.equal(((await (await run('/__test/mail')).json()) as unknown[]).length,2);
   assert.equal((await db.prepare('SELECT count(*) n FROM isolated_otp_quota_reservations').first<{n:number}>())!.n,2);
   return;
  }
  // Each case has a fresh Worker and database; the two lifecycle sends count toward the global limit.
  const newQuotaTask=async(index:number)=>{
   const env=await (await ok(await post('/v1/envelopes',{templateId:template.id,recipients:[{role:'one',name:'Dana',email:'quota-one@example.test'},{role:'two',name:'Lee',email:'quota-two@example.test'}]},{'idempotency-key':`quota_envelope_${index}`}))).json() as {id:string};
   await ok(await management(`/v1/envelopes/${env.id}/prepare`,{method:'POST'}));
   return ((await (await ok(await management(`/v1/envelopes/${env.id}/tasks`))).json() as {tasks:{id:string}[]}).tasks)[0].id;
  };
  const quotaSend=async(task:string)=>{
   const code=await (await ok(await post(`/v1/envelopes/${(await db.prepare('SELECT envelope_id FROM tasks WHERE id=?').bind(task).first<{envelope_id:string}>())!.envelope_id}/tasks/${task}/recipient-view`,{origin}))).json() as {code:string};
   const session=await (await ok(await json('/v1/page-sessions/exchange',code))).json() as {token:string};
   return json('/v1/otp/send',{token:session.token,origin});
  };
  const quotaCounts=async()=>({mail:((await (await run('/__test/mail')).json()) as unknown[]).length,reservations:(await db.prepare('SELECT count(*) n FROM isolated_otp_quota_reservations').first<{n:number}>())!.n});
  assert.deepEqual(await quotaCounts(),{mail:2,reservations:2});
  if(quotaCase==='per-task'){
  const task=await newQuotaTask(0), taskMail=(await quotaCounts()).mail;
  for(let i=0;i<3;i++){
   await ok(await quotaSend(task),204); assert.deepEqual(await quotaCounts(),{mail:taskMail+i+1,reservations:i+3});
   // Expire the separate challenge cooldown/window, not the lifetime reservations.
   await db.prepare('UPDATE recipient_otp_challenges SET window_started_at=0,next_send_at=0 WHERE task_id=?').bind(task).run();
  }
  const taskBefore=await quotaCounts(); assert.equal((await quotaSend(task)).status,503); assert.deepEqual(await quotaCounts(),taskBefore);
  assert.equal((await db.prepare('SELECT count(*) n FROM isolated_otp_quota_reservations WHERE task_id=?').bind(task).first<{n:number}>())!.n,3);
  assert.deepEqual((await db.prepare('SELECT scope_kind,send_count,send_limit FROM isolated_otp_send_budgets ORDER BY scope_kind').all()).results,[{scope_kind:'account',send_count:5,send_limit:100},{scope_kind:'tenant',send_count:5,send_limit:100}]);
  } else {
  const globalTasks=[]; for(let i=1;i<=9;i++) globalTasks.push(await newQuotaTask(i));
  for(let i=0;i<8;i++){await ok(await quotaSend(globalTasks[i]),204); assert.deepEqual(await quotaCounts(),{mail:i+3,reservations:i+3});}
  const globalBefore=await quotaCounts(); assert.equal((await quotaSend(globalTasks[8])).status,503); assert.deepEqual(await quotaCounts(),globalBefore);
  assert.equal((await db.prepare('SELECT count(*) n FROM isolated_otp_quota_reservations WHERE task_id=?').bind(globalTasks[8]).first<{n:number}>())!.n,0);
  assert.deepEqual((await db.prepare('SELECT scope_kind,send_count,send_limit FROM isolated_otp_send_budgets ORDER BY scope_kind').all()).results,[{scope_kind:'account',send_count:10,send_limit:100},{scope_kind:'tenant',send_count:10,send_limit:100}]);
  }
 }finally{await mf?.dispose();await mockAgent.close();await rm(dir,{recursive:true,force:true});}
});
