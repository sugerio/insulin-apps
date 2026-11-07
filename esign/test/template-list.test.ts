import {unstable_splitSqlQuery} from 'wrangler';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import app from '../src/worker.ts';

test('template listing is tenant-scoped, ordered and paginated',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB'],r2Buckets:['ARTIFACTS']});
 try{const db=await mf.getD1Database('DB');for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort()){const sql=await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8');await db.batch(unstable_splitSqlQuery(sql).map(s=>db.prepare(s)));}
 const key='test-key-0123456789-abcdefghijklmnopqrstuvwxyz',hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key))),n=>n.toString(16).padStart(2,'0')).join('');await db.prepare("INSERT INTO tenants VALUES ('a'),('b')").run();await db.prepare("INSERT INTO api_keys (key_hash,tenant_id) VALUES (?,'a')").bind(hash).run();
 for(let i=0;i<23;i++)await db.prepare("INSERT INTO templates (id,tenant_id,object_key,roles_json,created_at) VALUES (?,'a',?,'[]',?)").bind(`a-${i}`,`a-${i}`,i).run();await db.prepare("INSERT INTO templates (id,tenant_id,object_key,roles_json,created_at) VALUES ('private','b','b','[]',99)").run();
 const env={DB:db,ARTIFACTS:await mf.getR2Bucket('ARTIFACTS')},get=(path:string,keyValue=key)=>app.fetch(new Request('http://localhost'+path,{headers:{authorization:`Bearer ${keyValue}`}}),env);
 assert.equal((await get('/v1/templates','bad')).status,401);const first=await get('/v1/templates');assert.equal(first.status,200);const a=await first.json() as any;assert.equal(a.templates.length,20);assert.ok(a.nextCursor);assert.equal(a.templates.some((x:any)=>x.id==='private'),false);
 const second=await get(`/v1/templates?cursor=${a.nextCursor}`);assert.equal(second.status,200);const b=await second.json() as any;assert.equal(b.templates.length,3);assert.equal(b.nextCursor,null);assert.equal(new Set([...a.templates,...b.templates].map((x:any)=>x.id)).size,23);assert.equal((await get('/v1/templates?cursor=private')).status,400);assert.equal((await get('/v1/templates?cursor=invalid')).status,400);
 }finally{await mf.dispose();}
});
