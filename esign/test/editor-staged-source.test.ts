import {unstable_splitSqlQuery} from 'wrangler';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {PDFDocument} from 'pdf-lib';
import app from '../src/worker.ts';

test('staged PDF is tenant and session bound, immutable and verified at save',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB'],r2Buckets:['ARTIFACTS']});
 try{
  const db=await mf.getD1Database('DB');for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort()){const sql=await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8');await db.batch(unstable_splitSqlQuery(sql).map(s=>db.prepare(s)));}
  const keys=['local-test-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','local-test-key-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'];
  const hash=async(s:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),n=>n.toString(16).padStart(2,'0')).join('');
  await db.prepare("INSERT INTO tenants(id) VALUES ('a'),('b')").run();for(let i=0;i<2;i++)await db.prepare('INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,?)').bind(await hash(keys[i]),i?'b':'a').run();
  await db.prepare("INSERT INTO editor_allowed_origins VALUES ('a','https://host.example.com')").run();
  const bucket=await mf.getR2Bucket('ARTIFACTS');const env={DB:db,ARTIFACTS:bucket};const req=(path:string,init:RequestInit={})=>app.fetch(new Request('https://esign.example.com'+path,init),env);
  const created=await req('/v1/template-editing-sessions',{method:'POST',headers:{authorization:`Bearer ${keys[0]}`,'content-type':'application/json'},body:JSON.stringify({allowedParentOrigin:'https://host.example.com',roles:['Signer']})});const session=await created.json() as any;
  const pdf=await PDFDocument.create();pdf.addPage();const bytes=await pdf.save();const upload=(key:string,data:Uint8Array=bytes)=>req(`/v1/template-editing-sessions/${session.sessionId}/source`,{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/pdf'},body:data as BodyInit});
  const other=await req('/v1/template-editing-sessions',{method:'POST',headers:{authorization:`Bearer ${keys[0]}`,'content-type':'application/json'},body:JSON.stringify({allowedParentOrigin:'https://host.example.com',roles:['Signer']})});const otherSession=await other.json() as any;
  assert.equal((await req(`/v1/template-editing-sessions/${otherSession.sessionId}/source`,{method:'POST',headers:{authorization:`Bearer ${keys[0]}`,'content-type':'application/pdf'},body:new Uint8Array(5*1024*1024+1)})).status,413);
  await db.prepare('UPDATE editor_page_entries SET expires_at=? WHERE page_id=?').bind(Date.now()-1,otherSession.sessionId).run();
  assert.equal((await req(`/v1/template-editing-sessions/${otherSession.sessionId}/source`,{method:'POST',headers:{authorization:`Bearer ${keys[0]}`,'content-type':'application/pdf'},body:bytes as BodyInit})).status,409);
  assert.equal((await upload(keys[1])).status,404);assert.equal((await upload(keys[0],new Uint8Array([1,2,3]))).status,422);const attempts=await Promise.all([upload(keys[0]),upload(keys[0])]);assert.deepEqual(attempts.map(r=>r.status).sort(),[201,409]);assert.equal((await upload(keys[0])).status,409);assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM templates').first<{n:number}>())!.n,0);
  const exchange=await req('/v1/editor/exchange',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pageId:session.sessionId,code:new URL(session.url).hash.slice(1)})});const token=(await exchange.json() as any).token;const headers={authorization:`Bearer ${token}`};
  assert.deepEqual(new Uint8Array(await (await req('/v1/editor/pdf',{headers})).arrayBuffer()),bytes);
  const row=await db.prepare('SELECT staged_object_key FROM editor_page_entries WHERE page_id=?').bind(session.sessionId).first<{staged_object_key:string}>();
  await bucket.put(row!.staged_object_key,new Uint8Array([1,2,3]));assert.equal((await req('/v1/editor/pdf',{headers})).status,409);
  const tampered=new FormData();tampered.set('roles','["Signer"]');tampered.set('fields','[]');assert.equal((await req('/v1/editor/save',{method:'POST',headers,body:tampered})).status,409);
  await bucket.put(row!.staged_object_key,bytes);
  const form=new FormData();form.set('file',new File([bytes],'replacement.pdf'));form.set('roles','["Signer"]');form.set('fields',JSON.stringify([{id:'x',type:'Signature',role:'Signer',page:1,required:true,rect:{x:.1,y:.1,width:.3,height:.1}}]));
  assert.equal((await req('/v1/editor/save',{method:'POST',headers,body:form})).status,422);form.delete('file');const saved=await req('/v1/editor/save',{method:'POST',headers,body:form});assert.equal(saved.status,201);const id=(await saved.json() as any).id;assert.equal(((await (await req(`/v1/template-editing-sessions/${session.sessionId}`,{headers:{authorization:`Bearer ${keys[0]}`}})).json()) as any).templateId,id);
 }finally{await mf.dispose();}
});
