import {unstable_splitSqlQuery} from 'wrangler';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {PDFDocument} from 'pdf-lib';
import {Hono} from 'hono';
import {mountEditorRoutes} from '../src/editor-routes.ts';

test('management URL source is staged once and only fixed bytes reach the editor',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB'],r2Buckets:['ARTIFACTS']});
 try{
  const db=await mf.getD1Database('DB');for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort()){const sql=await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8');await db.batch(unstable_splitSqlQuery(sql).map(s=>db.prepare(s)));}
  await db.prepare("INSERT INTO tenants(id) VALUES ('a'),('b')").run();await db.prepare("INSERT INTO editor_allowed_origins VALUES ('a','https://host.example.com')").run();
  const pdf=await PDFDocument.create();pdf.addPage();const bytes=await pdf.save();const bucket=await mf.getR2Bucket('ARTIFACTS');const env={DB:db,ARTIFACTS:bucket};
  const app=new Hono<any>();let calls=0,mode='ok';mountEditorRoutes(app,async(c,next)=>{c.set('tenantId',c.req.header('x-tenant')??'a');await next();},{downloadSource:async(url:string)=>{calls++;if(!url.startsWith('https://files.example.com/'))throw new Error('untrusted');if(mode==='expired')throw new Error('secret synthetic-token');if(mode==='oversize')return new Uint8Array(5*1024*1024+1);return bytes;}});
  const req=(path:string,init:RequestInit={})=>app.fetch(new Request('https://esign.example.com'+path,init),env);const make=(sourceUrl:string,tenant='a')=>req('/v1/template-editing-sessions',{method:'POST',headers:{'content-type':'application/json','x-tenant':tenant},body:JSON.stringify({allowedParentOrigin:'https://host.example.com',roles:['Signer'],sourceUrl})});
  assert.equal((await make('https://files.example.com/test.pdf?token=private','b')).status,403);assert.equal(calls,0);
  assert.equal((await make('http://127.0.0.1/private')).status,422);assert.equal(calls,0);
  const created=await make('https://files.example.com/test.pdf?token=private');assert.equal(created.status,201);const session=await created.json() as any;assert.equal(calls,1);
  const row=await db.prepare('SELECT * FROM editor_page_entries WHERE page_id=?').bind(session.sessionId).first() as any;assert.ok(row.staged_object_key);assert.match(row.staged_sha256,/^[a-f0-9]{64}$/);assert.ok(!JSON.stringify(row).includes('token=private'));
  const exchange=await req('/v1/editor/exchange',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pageId:session.sessionId,code:new URL(session.url).hash.slice(1)})});const token=(await exchange.json() as any).token;const headers={authorization:`Bearer ${token}`};assert.deepEqual(new Uint8Array(await (await req('/v1/editor/pdf',{headers})).arrayBuffer()),bytes);
  const form=new FormData();form.set('roles','["Signer"]');form.set('fields',JSON.stringify([{id:'x',type:'Signature',role:'Signer',page:1,required:true,rect:{x:.1,y:.1,width:.3,height:.1}}]));const saved=await req('/v1/editor/save',{method:'POST',headers,body:form});assert.equal(saved.status,201);assert.equal(calls,1);
  const objectsBefore=(await bucket.list()).objects.length;mode='expired';const failed=await make('https://files.example.com/expired?secret=synthetic-token');assert.equal(failed.status,503);assert.ok(!(await failed.text()).includes('synthetic-token'));mode='oversize';assert.equal((await make('https://files.example.com/large.pdf')).status,503);assert.equal((await bucket.list()).objects.length,objectsBefore);
  assert.equal((await make('https://127.0.0.1/private')).status,503,'test downloader refuses untrusted hosts');
  const a=new Hono<any>();mountEditorRoutes(a,async(c,next)=>{c.set('tenantId','a');await next();});const denied=await a.fetch(new Request('https://esign.example.com/v1/template-editing-sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({allowedParentOrigin:'https://host.example.com',sourceUrl:'https://files.example.com/test.pdf'})}),env);assert.equal(denied.status,503);
 }finally{await mf.dispose();}
});
