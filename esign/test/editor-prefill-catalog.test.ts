// The pre-filled fields a host fills in (editor-routes.ts `prefill`): given when it opens an editing session, kept with
// the session, and handed to the editor page, which offers those to place and no others. Synthetic data, in-process.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {blobStore,MIGRATIONS_DIR,splitSql} from './helpers/platform.ts';
import app from './helpers/gateway.ts';

const HOST='https://host.example.com',ORIGIN='https://esign.example.com';
const CATALOG=[{name:'partner.name',label:'Partner name'},{name:'agreement.sentDate',label:'Sent date'}];

test('a host\'s pre-filled fields reach its editor page; malformed ones are refused, and none means the author names their own',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB']});
 try{
  const db=await mf.getD1Database('DB');
  for(const name of (await readdir(MIGRATIONS_DIR)).filter(n=>n.endsWith('.sql')).sort())await db.batch(splitSql(await readFile(new URL(name,MIGRATIONS_DIR),'utf8')).map(s=>db.prepare(s)));
  const key='local-test-key-cccccccccccccccccccccccccccccccc';
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key))),n=>n.toString(16).padStart(2,'0')).join('');
  await db.prepare("INSERT INTO tenants(id) VALUES ('t')").run();
  await db.prepare("INSERT INTO api_keys(key_hash,tenant_id) VALUES (?, 't')").bind(digest).run();
  const env={DB:db,ARTIFACTS:await blobStore(mf,'artifacts'),ASSETS:{fetch:async()=>new Response('<html>editor</html>',{headers:{'content-type':'text/html'}})}};
  const req=(path:string,init:RequestInit={})=>app.fetch(new Request(ORIGIN+path,init),env);
  const open=(body:Record<string,unknown>)=>req('/api/template-editing-sessions',{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify({allowedParentOrigin:HOST,roles:['Partner'],...body})});
  const current=async(created:Response)=>{
   const {sessionId,url}=await created.json() as {sessionId:string;url:string};
   const exchanged=await req('/api/public/editor/exchange',{method:'POST',headers:{'content-type':'application/json',origin:ORIGIN},body:JSON.stringify({pageId:sessionId,code:new URL(url).hash.slice(1),embedded:true,embedder:HOST})});
   const {token}=await exchanged.json() as {token:string};
   return await (await req('/api/public/editor/current',{headers:{'x-esign-session':token,origin:ORIGIN}})).json() as {prefillCatalog?:unknown};
  };
  const given=await open({prefill:CATALOG});
  assert.equal(given.status,201,await given.clone().text());
  assert.deepEqual((await current(given)).prefillCatalog,CATALOG);
  const none=await open({});
  assert.equal(none.status,201);
  assert.equal((await current(none)).prefillCatalog,undefined);
  for(const prefill of [[],[{name:'partner.name'}],[{name:'1bad',label:'Bad'}],[{name:'a',label:'A',extra:1}],[CATALOG[0],CATALOG[0]],Array.from({length:31},(_,i)=>({name:`f${i}`,label:`F${i}`})),'partner.name'])
   assert.equal((await open({prefill})).status,422,JSON.stringify(prefill).slice(0,60));
 }finally{await mf.dispose();}
});
