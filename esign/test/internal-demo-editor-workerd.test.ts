import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {PDFDocument} from 'pdf-lib';
import {unstable_splitSqlQuery} from 'wrangler';

test('Access-gated original editor demo stages a synthetic PDF and saves through original iframe routes', {timeout:120000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'editor-access-'));let mf:Miniflare|undefined;
 try{
  const output=join(dir,'client');const built=spawnSync(process.execPath,['node_modules/vite/bin/vite.js','build','--outDir',output],{encoding:'utf8'});assert.equal(built.status,0,built.stderr);
  const bundle=await build({entryPoints:['src/internal-demo-worker.ts'],bundle:true,format:'esm',platform:'browser',write:false});
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});const jwk={...publicKey.export({format:'jwk'}),kid:'key',alg:'RS256',use:'sig'};
  const now=Math.floor(Date.now()/1000),origin='https://demo.example.test',key='a'.repeat(64);
  const enc=(x:unknown)=>Buffer.from(JSON.stringify(x)).toString('base64url');const payload={iss:'https://access.example.test',aud:'aud',iat:now,exp:now+120,sub:'test-user',email:'fictional@'+'internal.example'};const prefix=`${enc({alg:'RS256',kid:'key'})}.${enc(payload)}`,jwt=`${prefix}.${sign('RSA-SHA256',Buffer.from(prefix),privateKey).toString('base64url')}`;
  mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-01-01',d1Databases:['DB'],r2Buckets:['ARTIFACTS','TEST_MAIL'],assets:{directory:output,binding:'ASSETS',routerConfig:{invoke_user_worker_ahead_of_assets:true,has_user_worker:true}},ratelimits:{EDITOR_RATE_LIMITER:{namespace_id:'9100',simple:{limit:100,period:60}},PREAUTH_RATE_LIMITER:{namespace_id:'9101',simple:{limit:100,period:60}}},bindings:{INTERNAL_DEMO_READINESS_ENABLED:'true',INTERNAL_DEMO_EDITOR_ENABLED:'true',LOCAL_TEST_MODE:'true',LOCAL_TEST_OTP_KEY:'x'.repeat(32),LOCAL_TEST_SEAL_KEY:'x'.repeat(32),INTERNAL_DEMO_ORIGIN:origin,INTERNAL_DEMO_MANAGEMENT_KEY:key,INTERNAL_DEMO_MANAGER_SUBJECTS:'["test-user"]',INTERNAL_DEMO_EMAIL_DOMAIN:'internal.example',ACCESS_ISSUER:payload.iss,ACCESS_AUDIENCE:'aud',ACCESS_JWKS:JSON.stringify({keys:[jwk]})}});
  const db=await mf.getD1Database('DB');for(const name of (await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort())await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${name}`,'utf8')).map(s=>db.prepare(s)));
  await db.prepare("INSERT INTO tenants VALUES ('tenant')").run();await db.prepare('INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,?)').bind(createHash('sha256').update(key).digest('hex'),'tenant').run();await db.prepare('INSERT INTO editor_allowed_origins VALUES (?,?)').bind('tenant',origin).run();
  const req=async(path:string,init:RequestInit={})=>{const r=new Request(origin+path,{...init,headers:{'cf-connecting-ip':'192.0.2.1',...init.headers}});return mf!.dispatchFetch(r.url,{method:r.method,headers:Object.fromEntries(r.headers),...(r.body?{body:await r.arrayBuffer()}:{})} as any);};const browser={'cf-access-jwt-assertion':jwt,origin,'x-local-esign':'1','x-esign-synthetic-confirmed':'true'};
  assert.equal((await req('/editor-host.html')).status,401);const host=await req('/editor-host.html',{headers:browser});assert.equal(host.status,200,await host.clone().text());assert.match(await host.text(),/synthetic-confirmation/);
  const altPrefix=`${enc({alg:'RS256',kid:'key'})}.${enc({...payload,sub:'different-user'})}`;const otherJwt=`${altPrefix}.${sign('RSA-SHA256',Buffer.from(altPrefix),privateKey).toString('base64url')}`;
  const pdf=await PDFDocument.create();pdf.addPage();const bytes=await pdf.save();const form=()=>{const f=new FormData();f.set('file',new File([bytes],'synthetic.pdf',{type:'application/pdf'}));f.set('roles','["Signer"]');return f;};
  assert.equal((await req('/host/editor-demo-session',{method:'POST',headers:{...browser,'cf-access-jwt-assertion':otherJwt},body:form()})).status,403);
  assert.equal((await req('/host/editor-demo-session',{method:'POST',headers:{...browser,'x-esign-synthetic-confirmed':'false'},body:form()})).status,403);
  assert.equal((await req('/host/editor-demo-session',{method:'POST',headers:{...browser,origin:'https://evil.example.test'},body:form()})).status,403);
  const multipart=new Request(origin+'/host/editor-demo-session',{method:'POST',body:form()});assert.match(multipart.headers.get('content-type')??'',/^multipart\/form-data; boundary=/);
  const created=await req('/host/editor-demo-session',{method:'POST',headers:browser,body:form()});assert.equal(created.status,201,await created.clone().text());const session=await created.json() as {sessionId:string;url:string};const page=new URL(session.url);assert.equal(page.origin,origin);
  assert.equal((await req(page.pathname)).status,401);const editorPage=await req(page.pathname,{headers:browser});assert.equal(editorPage.status,200);assert.match(await editorPage.text(),/assets\//);
  const exchange=await req('/v1/editor/exchange',{method:'POST',headers:{...browser,'cf-access-jwt-assertion':otherJwt,'content-type':'application/json'},body:JSON.stringify({pageId:session.sessionId,code:page.hash.slice(1)})});assert.equal(exchange.status,200);const {token}=await exchange.json() as {token:string};
  const eh={...browser,authorization:`Bearer ${token}`};const data=await req('/v1/editor/pdf',{headers:eh});assert.equal(data.status,200);assert.deepEqual(new Uint8Array(await data.arrayBuffer()),bytes);assert.equal((await req('/v1/editor/pdf',{headers:{authorization:`Bearer ${token}`}})).status,401);
  const saved=new FormData();saved.set('roles','["Signer"]');saved.set('fields',JSON.stringify([{id:'x',type:'Signature',role:'Signer',page:1,required:true,rect:{x:.1,y:.1,width:.3,height:.1}}]));const result=await req('/v1/editor/save',{method:'POST',headers:eh,body:saved});assert.equal(result.status,201,await result.clone().text());const {id}=await result.json() as {id:string};
  const confirmed=await req(`/host/template-editing-sessions/${session.sessionId}`,{headers:browser});assert.deepEqual(await confirmed.json(),{templateId:id});
  const server=await req(`/v1/template-editing-sessions/${session.sessionId}`,{headers:{authorization:`Bearer ${key}`}});assert.equal(server.status,200);assert.deepEqual(await server.json(),{templateId:id});
  const serverHeaders={authorization:`Bearer ${key}`,'content-type':'application/json'};
  assert.equal((await req('/v1/template-editing-sessions',{method:'POST',headers:{...serverHeaders,origin},body:'{}'})).status,403);
  assert.equal((await req('/v1/template-editing-sessions',{method:'POST',headers:{...serverHeaders,authorization:`Bearer ${'b'.repeat(64)}`},body:'{}'})).status,401);
  const serverCreate=await req('/v1/template-editing-sessions',{method:'POST',headers:serverHeaders,body:JSON.stringify({allowedParentOrigin:origin,roles:['Signer']})});assert.equal(serverCreate.status,201);const managed=await serverCreate.json() as {sessionId:string};
  const staged=await req(`/v1/template-editing-sessions/${managed.sessionId}/source`,{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/pdf'},body:bytes});assert.equal(staged.status,201);
  assert.equal((await req('/v1/editor/exchange',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
  const mail=await mf.getR2Bucket('TEST_MAIL');assert.equal((await mail.list()).objects.length,0);
  for(const path of ['/v1/signing/otp','/v1/envelopes/e/finalize'])assert.equal((await req(path,{method:'POST',headers:browser})).status,404);
 }finally{await mf?.dispose();await rm(dir,{recursive:true,force:true});}
});
