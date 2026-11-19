// Who may frame the signing page: the host names the origin of its page that frames it when it asks for the code
// (`allowedParentOrigin` on recipient-view), the code is bound to it, and there is no list of allowed origins
// (signing-page.ts). Synthetic data only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {PDFDocument} from 'pdf-lib';
import {blobStore,MIGRATIONS_DIR,splitSql} from './helpers/platform.ts';
import app from './helpers/gateway.ts';

const SELF='https://esign.example.test';
const CONSOLE='https://console.example.test';
const EVIL='https://evil.example.test';

async function setup(){
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB']});
 const db=await mf.getD1Database('DB');
 for(const name of (await readdir(MIGRATIONS_DIR)).filter(n=>n.endsWith('.sql')).sort())
  await db.batch(splitSql(await readFile(new URL(name,MIGRATIONS_DIR),'utf8')).map(s=>db.prepare(s)));
 const key='local-test-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
 const keyHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key))),n=>n.toString(16).padStart(2,'0')).join('');
 await db.prepare("INSERT INTO tenants (id) VALUES ('a')").run();
 await db.prepare("INSERT INTO api_keys (key_hash,tenant_id) VALUES (?,'a')").bind(keyHash).run();
 const env={DB:db,ARTIFACTS:await blobStore(mf,'artifacts'),TEST_MAIL:await blobStore(mf,'test-mail'),OTP_KEY:'local-test-pepper-at-least-32-bytes',TEST_SEAL_KEY:'local-test-seal-key-at-least-32-bytes'};
 const req=(path:string,init:RequestInit={})=>app.fetch(new Request(SELF+path,init),env);
 const management={authorization:`Bearer ${key}`};
 const json=(body:unknown,headers:Record<string,string>={})=>({method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)});
 const pdf=await PDFDocument.create();pdf.addPage();const form=new FormData();form.set('file',new File([await pdf.save()],'sample.pdf',{type:'application/pdf'}));form.set('roles','["ana"]');
 const template=await (await req('/api/templates',{method:'POST',headers:management,body:form})).json() as {id:string};
 const created=await req('/api/envelopes',json({templateId:template.id,recipients:[{role:'ana',name:'Ana',email:'ana@example.com'}]},{...management,'idempotency-key':'parent-1'}));
 assert.equal(created.status,201,await created.clone().text());
 const envelope=(await created.json() as {id:string}).id;
 const task=((await (await req(`/api/envelopes/${envelope}`,{headers:management})).json()) as {tasks:{id:string}[]}).tasks[0]!.id;
 const view=(body:Record<string,unknown>)=>req(`/api/envelopes/${envelope}/tasks/${task}/recipient-view`,json({signedInEmail:'ana@example.com',...body},management));
 const exchange=(code:string,frame:Record<string,unknown>={})=>req('/api/public/page-sessions/exchange',json({code,...frame},{origin:SELF}));
 const framedBy=(...ancestors:string[])=>({embedded:true,embedder:ancestors[0],embedders:ancestors});
 return {mf,db,req,management,envelope,view,exchange,framedBy};
}

test('the code is bound to the origin the host names: only it frames the page and hears from it', async()=>{
 const s=await setup();
 try{
  const issued=await s.view({allowedParentOrigin:CONSOLE});
  assert.equal(issued.status,201,await issued.clone().text());
  const {code,url}=await issued.json() as {code:string;url:string};
  // The page to frame: the framing origin in the query (its CSP names it), the code in the fragment.
  assert.equal(url,`${SELF}/sign?host=${encodeURIComponent(CONSOLE)}#code=${code}`);
  // Framed by another site, or by the console inside another site: no session, and the code stays unused.
  for(const frame of [s.framedBy(EVIL),s.framedBy(CONSOLE,EVIL),{embedded:true,embedder:''}]){
   const refused=await s.exchange(code,frame);
   assert.equal(refused.status,403,JSON.stringify(frame));
   assert.deepEqual(await refused.json(),{error:'embedder_not_allowed'});
  }
  // Framed by the console: a session, and the console is the host the page tells.
  const opened=await s.exchange(code,s.framedBy(CONSOLE));
  assert.equal(opened.status,200);
  const body=await opened.json() as {token:string;host?:string};
  assert.match(body.token,/^[a-f0-9]{64}$/);
  assert.equal(body.host,CONSOLE);
  // The audit trail records the origin the code was issued for (kept with the event, like the page's origin).
  const issuedEvent=await s.db.prepare("SELECT detail_json FROM audit_events WHERE envelope_id=? AND type='RECIPIENT_VIEW_ISSUED'").bind(s.envelope).first<{detail_json:string}>();
  assert.equal((JSON.parse(issuedEvent!.detail_json) as {parentOrigin?:string}).parentOrigin,CONSOLE);
 } finally {await s.mf.dispose();}
});

test('a code issued without a parent opens only on its own, never in a frame, and names no host', async()=>{
 const s=await setup();
 try{
  const issued=await s.view({});
  assert.equal(issued.status,201);
  const {code,url}=await issued.json() as {code:string;url:string};
  assert.equal(url,`${SELF}/sign#code=${code}`);
  assert.equal((await s.exchange(code,s.framedBy(CONSOLE))).status,403,'no origin was named, so none may frame it');
  const opened=await s.exchange(code,{embedded:false,embedder:''});
  assert.equal(opened.status,200);
  assert.equal((await opened.json() as {host?:string}).host,undefined);
 } finally {await s.mf.dispose();}
});

test('a parent that is not a bare https origin (http only on a loopback host) is refused before a code exists', async()=>{
 const s=await setup();
 try{
  for(const bad of ['http://console.example.test',`${CONSOLE}/deals`,`${CONSOLE}?x=1`,'https://Console.example.test','*','null']){
   const refused=await s.view({allowedParentOrigin:bad});
   assert.equal(refused.status,422,bad);
   assert.deepEqual(await refused.json(),{error:'invalid_parent_origin'});
  }
  assert.equal((await s.view({allowedParentOrigin:7})).status,400);
  assert.equal((await s.db.prepare("SELECT count(*) AS n FROM access_codes WHERE scope='recipient'").first<{n:number}>())!.n,0);
  // Outside prod, a developer's local console may frame it.
  assert.equal((await s.view({allowedParentOrigin:'http://localhost:3000'})).status,201);
 } finally {await s.mf.dispose();}
});
