import {unstable_splitSqlQuery} from 'wrangler';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {PDFDocument} from 'pdf-lib';
import app from '../src/worker.ts';
import {setEditorOrigins} from './helpers/editor-origins.ts';

test('template source is fixed at session issue for preview and save',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB'],r2Buckets:['ARTIFACTS']});
 try{
  const db=await mf.getD1Database('DB');for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort()){const sql=await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8');await db.batch(unstable_splitSqlQuery(sql).map(s=>db.prepare(s)));}
  const key='local-test-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',other='local-test-key-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';const hash=async(s:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),n=>n.toString(16).padStart(2,'0')).join('');
  await db.prepare("INSERT INTO tenants(id) VALUES ('a'),('b')").run();await db.prepare("INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,'a'),(?,'b')").bind(await hash(key),await hash(other)).run();await setEditorOrigins(db,'a',['https://host.example.com']);await setEditorOrigins(db,'b',['https://host.example.com']);
  const bucket=await mf.getR2Bucket('ARTIFACTS'),env={DB:db,ARTIFACTS:bucket};const req=(path:string,init:RequestInit={},custom=env)=>app.fetch(new Request('https://esign.example.com'+path,init),custom);
  const p=await PDFDocument.create();p.addPage();const bytes=await p.save();const replacement=await PDFDocument.create();replacement.addPage([400,400]);const changed=await replacement.save();
  const createForm=new FormData();createForm.set('file',new File([bytes],'synthetic.pdf'));createForm.set('roles','["Signer"]');const template=await req('/v1/templates',{method:'POST',headers:{authorization:`Bearer ${key}`},body:createForm});assert.equal(template.status,201);const id=(await template.json() as any).id;const row=await db.prepare('SELECT object_key FROM templates WHERE id=?').bind(id).first<{object_key:string}>();
  const issue=(k:string,custom=env)=>req('/v1/template-editing-sessions',{method:'POST',headers:{authorization:`Bearer ${k}`,'content-type':'application/json'},body:JSON.stringify({allowedParentOrigin:'https://host.example.com',sourceTemplateId:id})},custom);
  assert.equal((await issue(other)).status,404);
  const badBucket=new Proxy(bucket,{get(target,prop){if(prop==='get')return async()=>{throw new Error('read failure');};const v=Reflect.get(target,prop,target);return typeof v==='function'?v.bind(target):v;}});
  const create=await issue(key);assert.equal(create.status,201);const session=await create.json() as any;const exchange=await req('/v1/editor/exchange',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pageId:session.sessionId,code:new URL(session.url).hash.slice(1)})});const token=(await exchange.json() as any).token;const headers={authorization:`Bearer ${token}`};
  assert.deepEqual(new Uint8Array(await (await req('/v1/editor/pdf',{headers})).arrayBuffer()),bytes);
  const stored=await db.prepare('SELECT source_sha256 FROM editor_sessions WHERE id=?').bind(session.sessionId).first<{source_sha256:string}>();assert.match(stored!.source_sha256,/^[a-f0-9]{64}$/);
  await db.prepare('UPDATE editor_sessions SET source_sha256=NULL WHERE id=?').bind(session.sessionId).run();assert.equal((await req('/v1/editor/pdf',{headers})).status,409,'historical unpinned session fails closed');
  const missingHashForm=new FormData();missingHashForm.set('roles','[\"Signer\"]');missingHashForm.set('fields','[]');assert.equal((await req('/v1/editor/save',{method:'POST',headers,body:missingHashForm})).status,409);
  await db.prepare('UPDATE editor_sessions SET source_sha256=? WHERE id=?').bind(stored!.source_sha256,session.sessionId).run();
  assert.equal((await req('/v1/editor/pdf',{headers},{...env,ARTIFACTS:badBucket})).status,409,'source read failure fails closed');
  await bucket.put(row!.object_key,changed);assert.equal((await req('/v1/editor/pdf',{headers})).status,409);
  const form=new FormData();form.set('roles','["Signer"]');form.set('fields',JSON.stringify([{id:'x',type:'Signature',role:'Signer',page:1,required:true,rect:{x:.1,y:.1,width:.3,height:.1}}]));
  assert.equal((await req('/v1/editor/save',{method:'POST',headers,body:form})).status,409);
  assert.equal((await req('/v1/editor/save',{method:'POST',headers,body:form},{...env,ARTIFACTS:badBucket})).status,409,'save read failure fails closed');
  assert.equal((await issue(key,{...env,ARTIFACTS:badBucket})).status,503);
  await bucket.put(row!.object_key,bytes);const saves=await Promise.all([req('/v1/editor/save',{method:'POST',headers,body:form}),req('/v1/editor/save',{method:'POST',headers,body:form})]);assert.deepEqual(saves.map(r=>r.status).sort(),[201,409]);
  const next=await issue(key);const nextSession=await next.json() as any;const nextExchange=await req('/v1/editor/exchange',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pageId:nextSession.sessionId,code:new URL(nextSession.url).hash.slice(1)})});const nextToken=(await nextExchange.json() as any).token;
  let resume!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>resume=r),readStarted=new Promise<void>(r=>started=r);
  const delayedBucket=new Proxy(bucket,{get(target,prop){if(prop==='get')return async(k:string)=>{const object=await target.get(k);if(k===row!.object_key){started();await gate;}return object;};const v=Reflect.get(target,prop,target);return typeof v==='function'?v.bind(target):v;}});
  const pendingSave=req('/v1/editor/save',{method:'POST',headers:{authorization:`Bearer ${nextToken}`},body:form},{...env,ARTIFACTS:delayedBucket});
  try{await readStarted;await bucket.put(row!.object_key,changed);}finally{resume();}
  const concurrent=await pendingSave;assert.ok([201,409].includes(concurrent.status));if(concurrent.status===201){const savedId=(await concurrent.json() as any).id;const savedRow=await db.prepare('SELECT object_key FROM templates WHERE id=?').bind(savedId).first<{object_key:string}>();const object=await bucket.get(savedRow!.object_key);assert.deepEqual(new Uint8Array(await object!.arrayBuffer()),bytes,'in-flight source swap cannot change saved bytes');}

 }finally{await mf.dispose();}
});
