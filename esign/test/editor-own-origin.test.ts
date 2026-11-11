// The app's own Templates page hosts the field editor, so the app's origin may start an editing
// session and frame the editor whatever ESIGN_FRAME_ANCESTORS lists; other origins still need to be
// listed there. Before, only the listed hosts could, and the Templates page's Place fields failed with
// 403 origin_not_allowed, which the page showed as a missing role.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {blobStore,MIGRATIONS_DIR,splitSql} from './helpers/platform.ts';
import app from './helpers/gateway.ts';
import {editorOrigins} from '../src/app/server/esign/editor-routes.ts';
import {describeError,RequestError} from '../src/app/member/api.ts';

const OWN='https://esign.example.com';
const HOST='https://host.example.com';

test('the app\'s own origin may host the editor when ESIGN_FRAME_ANCESTORS lists only hosts',async()=>{
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
  const env={DB:db,ARTIFACTS:await blobStore(mf,'artifacts'),SIGNING_PAGE_FRAME_ANCESTORS:HOST};
  const req=(path:string,options:RequestInit={})=>app.fetch(new Request(OWN+path,options),env);
  const start=(allowedParentOrigin:string)=>req('/api/template-editing-sessions',{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify({allowedParentOrigin,roles:['Partner']})});

  // The Templates page: the app's own origin starts the session and frames the editor.
  const own=await start(OWN);
  assert.equal(own.status,201,await own.clone().text());
  const session=await own.json() as {sessionId:string;url:string};
  const exchanged=await req('/api/public/editor/exchange',{method:'POST',headers:{'content-type':'application/json',origin:OWN},body:JSON.stringify({pageId:session.sessionId,code:new URL(session.url).hash.slice(1),embedded:true,embedder:OWN})});
  assert.equal(exchanged.status,200,await exchanged.clone().text());
  assert.match((await exchanged.json() as {token:string}).token,/^[a-f0-9]{64}$/);

  // A listed host still may; anyone else still may not.
  assert.equal((await start(HOST)).status,201);
  const other=await start('https://evil.example.com');
  assert.equal(other.status,403);
  assert.deepEqual(await other.json(),{error:'origin_not_allowed'});
 } finally {
  await mf.dispose();
 }
});

test('the editor origins are the app\'s own first, then ESIGN_FRAME_ANCESTORS, without repeats',()=>{
 assert.deepEqual(editorOrigins(OWN,`${HOST} ${OWN}`,true),[OWN,HOST]);
 assert.deepEqual(editorOrigins(OWN,undefined,true),[OWN]);
 // prod keeps only https hosts, as for the signing page.
 assert.deepEqual(editorOrigins(OWN,'http://127.0.0.1:3000',true),[OWN]);
});

test('a refused origin is not reported as a missing role',()=>{
 assert.match(describeError(new RequestError(403,'origin_not_allowed')),/ESIGN_FRAME_ANCESTORS/);
 assert.equal(describeError(new RequestError(403,'forbidden')),'Your role in Esign doesn\'t allow that.');
});
