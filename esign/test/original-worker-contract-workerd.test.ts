import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {PDFDocument} from 'pdf-lib';
import {unstable_splitSqlQuery} from 'wrangler';
import {setEditorOrigins} from './helpers/editor-origins.ts';

test('original Worker editor preload and management contract in workerd with local signing disabled', {timeout:120000}, async()=>{
 const dir=await mkdtemp(join(tmpdir(),'esign-original-contract-'));
 let mf:Miniflare|undefined;
 try {
  await writeFile(join(dir,'editor.html'),'<html>synthetic editor</html>');
  const bundle=await build({entryPoints:['src/worker.ts'],bundle:true,format:'esm',platform:'browser',write:false});
  mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-01-01',d1Databases:['DB'],r2Buckets:['ARTIFACTS'],assets:{directory:dir,binding:'ASSETS',routerConfig:{invoke_user_worker_ahead_of_assets:true,has_user_worker:true}}});
  const db=await mf.getD1Database('DB');
  for(const name of (await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort()) await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${name}`,'utf8')).map(s=>db.prepare(s)));
  const key='a'.repeat(64),hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key))).toString('hex');
  await db.prepare("INSERT INTO tenants(id) VALUES ('tenant')").run();
  await db.prepare("INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,'tenant')").bind(hash).run();
  await setEditorOrigins(db,'tenant',['https://host.example.test']);
  const request=(path:string,init:RequestInit={})=>mf!.dispatchFetch('https://esign.example.test'+path,init as any);
  const auth={authorization:`Bearer ${key}`};
  assert.deepEqual(await (await request('/v1/me',{headers:auth})).json(),{tenantId:'tenant'});
  const created=await request('/v1/template-editing-sessions',{method:'POST',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({allowedParentOrigin:'https://host.example.test',roles:['Signer']})});
  assert.equal(created.status,201); const session=await created.json() as {sessionId:string;url:string}; const url=new URL(session.url);
  const pdf=await PDFDocument.create();pdf.addPage();const bytes=await pdf.save();
  const staged=await request(`/v1/template-editing-sessions/${session.sessionId}/source`,{method:'POST',headers:{...auth,'content-type':'application/pdf'},body:bytes});assert.equal(staged.status,201);
  const page=await request(url.pathname);assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy')??'',/frame-ancestors https:\/\/host\.example\.test/);
  const exchange=()=>request('/v1/editor/exchange',{method:'POST',headers:{origin:'https://esign.example.test','content-type':'application/json'},body:JSON.stringify({pageId:session.sessionId,code:url.hash.slice(1)})});
  const tokenResponse=await exchange();assert.equal(tokenResponse.status,200);const {token}=await tokenResponse.json() as {token:string};assert.equal((await exchange()).status,401);
  const headers={authorization:`Bearer ${token}`,origin:'https://esign.example.test'};
  const context=await request('/v1/editor/current',{headers});assert.equal(context.status,200);assert.deepEqual(await context.json(),{roles:['Signer'],fields:[],sourceTemplateId:null,hasStagedSource:true,parentOrigin:'https://host.example.test'});
  const source=await request('/v1/editor/pdf',{headers});assert.equal(source.status,200);assert.deepEqual(new Uint8Array(await source.arrayBuffer()),bytes);
  for(const path of ['/v1/page-sessions/exchange','/v1/signing/otp','/v1/signing/sign']) assert.equal((await request(path,{method:'POST',headers:{...auth,'content-type':'application/json'},body:'{}'})).status,404,path);
 } finally {await mf?.dispose();await rm(dir,{recursive:true,force:true});}
});
