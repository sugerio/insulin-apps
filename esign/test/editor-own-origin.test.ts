// The host names the origin of the page that frames the editor each time it starts an editing session, and the
// session is bound to it: the app's own Templates page names the app's origin, a host product its own. There is no
// list of allowed origins; what isn't a bare https origin (http only on a loopback host) is refused.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {blobStore,MIGRATIONS_DIR,splitSql} from './helpers/platform.ts';
import app from './helpers/gateway.ts';
import {describeError,RequestError} from '../src/app/member/api.ts';

const OWN='https://esign.example.com';
const HOST='https://host.example.com';

test('the app\'s own origin and a host\'s each start a session bound to them, with no list',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB']});
 try {
  const db=await mf.getD1Database('DB');
  for(const name of (await readdir(MIGRATIONS_DIR)).filter(n=>n.endsWith('.sql')).sort()){
   const sql=await readFile(new URL(name,MIGRATIONS_DIR),'utf8');await db.batch(splitSql(sql).map(s=>db.prepare(s)));
  }
  const key='local-test-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const digest=async(s:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),n=>n.toString(16).padStart(2,'0')).join('');
  await db.prepare("INSERT INTO tenants(id) VALUES ('a')").run();
  await db.prepare("INSERT INTO api_keys(key_hash,tenant_id) VALUES (?, 'a')").bind(await digest(key)).run();
  const env={DB:db,ARTIFACTS:await blobStore(mf,'artifacts')};
  const req=(path:string,options:RequestInit={})=>app.fetch(new Request(OWN+path,options),env);
  const start=(allowedParentOrigin:string)=>req('/api/template-editing-sessions',{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify({allowedParentOrigin,roles:['Partner']})});

  // The Templates page: the app's own origin starts the session and frames the editor.
  const own=await start(OWN);
  assert.equal(own.status,201,await own.clone().text());
  const session=await own.json() as {sessionId:string;url:string};
  const exchanged=await req('/api/public/editor/exchange',{method:'POST',headers:{'content-type':'application/json',origin:OWN},body:JSON.stringify({pageId:session.sessionId,code:new URL(session.url).hash.slice(1),embedded:true,embedder:OWN})});
  assert.equal(exchanged.status,200,await exchanged.clone().text());
  assert.match((await exchanged.json() as {token:string}).token,/^[a-f0-9]{64}$/);

  // A host product's origin, listed nowhere, may too; only it frames that session's page.
  const host=await start(HOST);
  assert.equal(host.status,201);
  const hosted=await host.json() as {sessionId:string;url:string};
  const exchange=(embedder:string)=>req('/api/public/editor/exchange',{method:'POST',headers:{'content-type':'application/json',origin:OWN},body:JSON.stringify({pageId:hosted.sessionId,code:new URL(hosted.url).hash.slice(1),embedded:true,embedder})});
  assert.equal((await exchange('https://evil.example.com')).status,403);
  assert.equal((await exchange(HOST)).status,200);
  // Not an origin: refused before a session exists.
  const bad=await start('https://host.example.com/page');
  assert.equal(bad.status,422);
  assert.deepEqual(await bad.json(),{error:'invalid_origin'});
 } finally {
  await mf.dispose();
 }
});

test('a refused request is reported as a missing role only when it is one',()=>{
 assert.equal(describeError(new RequestError(403,'forbidden')),'Your role in Esign doesn\'t allow that.');
});
