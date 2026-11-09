import {unstable_splitSqlQuery} from 'wrangler';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {PDFDocument} from 'pdf-lib';
import app from '../src/worker.ts';
import {authorizeAccess,exchangeAccessCode,issueAccessCode} from '../src/access.ts';
import {authorizeRecipientSession,exchangeRecipientCode,issueRecipientCode,sendRecipientOtp,verifyRecipientOtp} from '../src/otp.ts';
import {editorPageContext,exchangeEditorPage} from '../src/editor-session.ts';
import {setEditorOrigins} from './helpers/editor-origins.ts';

async function database(mf:Miniflare){
 const db=await mf.getD1Database('DB');
 for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())
  await db.batch(unstable_splitSqlQuery(await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8')).map(s=>db.prepare(s)));
 return db;
}

test('a code or token of one scope is refused by the other even when tenant, subject id and origin coincide',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB']});
 try{
  const db=await database(mf);
  // The same id names an ACTIVE task and an editor session of the same tenant, and the signing page
  // origin is also the editor's allowed parent: only the scope tells the two credentials apart.
  const id='c'.repeat(64),origin='https://host.example.com',now=1000;
  await db.exec(`INSERT INTO tenants (id) VALUES ('a');
INSERT INTO templates (id,tenant_id,object_key,roles_json,created_at) VALUES ('template','a','source','["ana"]',1);
INSERT INTO envelopes (id,tenant_id,template_id,status,created_at,request_sha256) VALUES ('env','a','template','IN_PROGRESS',1,'hash');
INSERT INTO tasks (id,envelope_id,role,recipient_name,recipient_email,routing_order,status) VALUES ('${id}','env','ana','Ana','ana@example.com',1,'ACTIVE');
INSERT INTO editor_sessions (id,tenant_id,parent_origin) VALUES ('${id}','a','${origin}');
`);
  await setEditorOrigins(db,'a',[origin]);
  const recipientCode=await issueRecipientCode(db,{tenantId:'a',envelopeId:'env',taskId:id,origin,now});
  const editorCode=await issueAccessCode(db,{scope:'editor',tenantId:'a',subjectId:id,origin,now});
  const scopes=async()=>(await db.prepare('SELECT scope,used_at FROM access_codes ORDER BY scope').all()).results;
  assert.deepEqual(await scopes(),[{scope:'editor',used_at:null},{scope:'recipient',used_at:null}]);

  // Codes: neither is accepted at the other's exchange, and a refused attempt does not use it up.
  await assert.rejects(()=>exchangeRecipientCode(db,editorCode,origin,now+1));
  await assert.rejects(()=>exchangeAccessCode(db,{scope:'recipient',code:editorCode,origin,subjectId:id,now:now+1}));
  await assert.rejects(()=>exchangeEditorPage(db,id,recipientCode,now+1));
  await assert.rejects(()=>exchangeAccessCode(db,{scope:'editor',code:recipientCode,origin,subjectId:id,now:now+1}));
  assert.deepEqual(await scopes(),[{scope:'editor',used_at:null},{scope:'recipient',used_at:null}]);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM access_sessions').first<{n:number}>())!.n,0);

  const recipientToken=await exchangeRecipientCode(db,recipientCode,origin,now+1);
  const editorToken=await exchangeEditorPage(db,id,editorCode,now+1);
  assert.deepEqual((await db.prepare('SELECT scope,subject_id,origin FROM access_sessions ORDER BY scope').all()).results,
   [{scope:'editor',subject_id:id,origin},{scope:'recipient',subject_id:id,origin}]);

  // Tokens: each authorizes only its own scope.
  assert.equal(await authorizeRecipientSession(db,recipientToken,origin,now+2),id);
  const editorContext=await editorPageContext(db,editorToken,now+2);
  assert.deepEqual({tenantId:editorContext.tenantId,parentOrigin:editorContext.parentOrigin},{tenantId:'a',parentOrigin:origin});
  await assert.rejects(()=>authorizeRecipientSession(db,editorToken,origin,now+2));
  await assert.rejects(()=>authorizeAccess(db,{scope:'recipient',token:editorToken,now:now+2}));
  await assert.rejects(()=>editorPageContext(db,recipientToken,now+2));
  await assert.rejects(()=>authorizeAccess(db,{scope:'editor',token:recipientToken,origin,now:now+2}));
  const pepper=new TextEncoder().encode('local-test-pepper-at-least-32-bytes');
  await assert.rejects(()=>sendRecipientOtp(db,editorToken,origin,now+2,pepper,async()=>{throw new Error('must not send');}));
  await assert.rejects(()=>verifyRecipientOtp(db,editorToken,origin,now+2,pepper,'123456'));
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM otp_challenges').first<{n:number}>())!.n,0);
  // Only a recipient session can be marked as having entered the emailed code.
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM access_sessions WHERE otp_verified_at IS NOT NULL").first<{n:number}>())!.n,0);
  await assert.rejects(()=>db.prepare("UPDATE access_sessions SET otp_verified_at=? WHERE scope='editor'").bind(now).run(),/CHECK/);
  assert.equal((await db.prepare("UPDATE access_sessions SET otp_verified_at=? WHERE scope='recipient'").bind(now).run()).meta.changes,1);
  await db.prepare("UPDATE access_sessions SET otp_verified_at=NULL WHERE scope='recipient'").run();

  // The scope is required, and only the two known scopes exist.
  await assert.rejects(()=>issueAccessCode(db,{scope:'admin' as never,tenantId:'a',subjectId:id,origin,now}));
  await assert.rejects(()=>authorizeAccess(db,{scope:undefined as never,token:recipientToken,now:now+2}));
  await assert.rejects(()=>db.prepare("INSERT INTO access_codes (code_hash,scope,tenant_id,subject_id,origin,expires_at) VALUES ('x','admin','a','s','https://host.example.com',1)").run());
 }finally{await mf.dispose();}
});

test('signing APIs refuse editor codes and tokens, editor APIs refuse recipient codes and tokens',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB'],r2Buckets:['ARTIFACTS','TEST_MAIL']});
 try{
  const db=await database(mf),bucket=await mf.getR2Bucket('ARTIFACTS'),mail=await mf.getR2Bucket('TEST_MAIL');
  const key='local-test-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const keyHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key))),n=>n.toString(16).padStart(2,'0')).join('');
  await db.prepare("INSERT INTO tenants (id) VALUES ('a')").run();
  await db.prepare("INSERT INTO api_keys (key_hash,tenant_id) VALUES (?,'a')").bind(keyHash).run();
  // One origin is both the signing page origin and the editor's allowed parent.
  const host='https://host.example.com',self='https://esign.example.com';
  await setEditorOrigins(db,'a',[host]);
  const env={DB:db,ARTIFACTS:bucket,TEST_MAIL:mail,SIGNING_PAGE_ORIGINS:host,OTP_KEY:'local-test-pepper-at-least-32-bytes',TEST_SEAL_KEY:'local-test-seal-key-at-least-32-bytes',
   ASSETS:{fetch:async()=>new Response('<html>editor</html>',{headers:{'content-type':'text/html'}})}};
  const req=(path:string,init:RequestInit={})=>app.fetch(new Request(self+path,init),env);
  const management={authorization:`Bearer ${key}`};
  const json=(body:unknown,headers:Record<string,string>={})=>({method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)});

  const pdf=await PDFDocument.create();pdf.addPage();const form=new FormData();form.set('file',new File([await pdf.save()],'sample.pdf',{type:'application/pdf'}));form.set('roles','["ana"]');
  const template=await (await req('/v1/templates',{method:'POST',headers:management,body:form})).json() as {id:string};
  const created=await req('/v1/envelopes',json({templateId:template.id,recipients:[{role:'ana',name:'Ana',email:'ana@example.com'}]},{...management,'idempotency-key':'scope-1'}));
  assert.equal(created.status,201,await created.clone().text());const envelope=await created.json() as {id:string};
  const task=((await (await req(`/v1/envelopes/${envelope.id}`,{headers:management})).json()) as {tasks:{id:string}[]}).tasks[0].id;
  const view=await req(`/v1/envelopes/${envelope.id}/tasks/${task}/recipient-view`,json({origin:host},management));assert.equal(view.status,201);
  const recipientCode=((await view.json()) as {code:string}).code;
  const session=await req('/v1/template-editing-sessions',json({allowedParentOrigin:host,roles:['Signer']},management));assert.equal(session.status,201);
  const editor=await session.json() as {sessionId:string;url:string};const editorCode=new URL(editor.url).hash.slice(1);

  // Codes at the wrong exchange.
  assert.equal((await req('/v1/page-sessions/exchange',json({code:editorCode},{origin:host}))).status,401);
  assert.equal((await req('/v1/editor/exchange',json({pageId:editor.sessionId,code:recipientCode},{origin:self}))).status,401);
  // Both codes are still unused: each is exchanged at its own endpoint.
  const recipientExchange=await req('/v1/page-sessions/exchange',json({code:recipientCode},{origin:host}));assert.equal(recipientExchange.status,200);
  const recipientToken=((await recipientExchange.json()) as {token:string}).token;
  const editorExchange=await req('/v1/editor/exchange',json({pageId:editor.sessionId,code:editorCode},{origin:self}));assert.equal(editorExchange.status,200);
  const editorToken=((await editorExchange.json()) as {token:string}).token;

  // Tokens at the wrong APIs.
  const asRecipient=(token:string)=>({origin:host,authorization:`Bearer ${token}`});
  const asEditor=(token:string)=>({origin:self,authorization:`Bearer ${token}`});
  assert.equal((await req('/v1/signing/current',{headers:asRecipient(recipientToken)})).status,200);
  assert.equal((await req('/v1/editor/current',{headers:asEditor(editorToken)})).status,200);
  assert.equal((await req('/v1/signing/current',{headers:asRecipient(editorToken)})).status,401);
  assert.equal((await req('/v1/signing/pdf',{headers:asRecipient(editorToken)})).status,401);
  assert.notEqual((await req('/v1/signing/otp',json({},asRecipient(editorToken)))).status,202);
  assert.equal((await mail.list()).objects.length,0,'no code is sent for an editor token');
  assert.equal((await req('/v1/signing/otp/verify',json({otp:'123456'},asRecipient(editorToken)))).status,401);
  assert.equal((await req('/v1/editor/current',{headers:asEditor(recipientToken)})).status,401);
  assert.equal((await req('/v1/editor/pdf',{headers:asEditor(recipientToken)})).status,401);
  const save=new FormData();save.set('roles','["Signer"]');save.set('fields','[]');
  assert.equal((await req('/v1/editor/save',{method:'POST',headers:asEditor(recipientToken),body:save})).status,401);
  assert.equal(((await (await req(`/v1/template-editing-sessions/${editor.sessionId}`,{headers:management})).json()) as {templateId:string|null}).templateId,null);
 }finally{await mf.dispose();}
});
