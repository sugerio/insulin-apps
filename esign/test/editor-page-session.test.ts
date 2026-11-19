import {applyMigrations} from './helpers/platform.ts';
import {blobStore} from './helpers/platform.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {MIGRATIONS_DIR,splitSql as unstable_splitSqlQuery} from './helpers/platform.ts';
import {PDFDocument} from 'pdf-lib';
import {Miniflare} from 'miniflare';
import * as editor from '../src/app/server/esign/editor-session.ts';
import app from './helpers/gateway.ts';

test('page identifier is not a credential; code is bound to page, tenant and the parent the host named, and consumed once', async () => {
  const mf = new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB']});
  try {
    const db = await mf.getD1Database('DB');
    await applyMigrations(db);
    await db.prepare("INSERT INTO tenants(id) VALUES ('a'),('b')").run();
    const first = await editor.issueEditorPage(db,'a','https://host.example.com',100);
    const other = await editor.issueEditorPage(db,'b','https://other.example.com',100);
    assert.notEqual(first.pageId,first.code);
    assert.equal(await editor.editorPageParent(db,first.pageId,101),'https://host.example.com');
    assert.equal(await editor.editorPageParent(db,first.pageId,120100),null);
    await assert.rejects(()=>editor.exchangeEditorPage(db,first.pageId,first.pageId,101));
    await assert.rejects(()=>editor.exchangeEditorPage(db,other.pageId,first.code,101));
    const race = await Promise.allSettled([editor.exchangeEditorPage(db,first.pageId,first.code,101),editor.exchangeEditorPage(db,first.pageId,first.code,101)]);
    assert.equal(race.filter(r=>r.status==='fulfilled').length,1);
    const token = (race.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<string>).value;
    const context = await editor.editorPageContext(db,token,102);
    assert.deepEqual({tenantId:context.tenantId,parentOrigin:context.parentOrigin,pageId:context.pageId},{tenantId:'a',parentOrigin:'https://host.example.com',pageId:first.pageId});
    await assert.rejects(()=>editor.editorPageContext(db,first.pageId,102));
    await assert.rejects(()=>editor.editorPageContext(db,token,900101));
    await assert.rejects(()=>editor.issueEditorPage(db,'a','http://host.example.com',100),/Invalid origin/);
    await assert.rejects(()=>editor.issueEditorPage(db,'a','https://host.example.com/page',100),/Invalid origin/);
  } finally { await mf.dispose(); }
});

test('the host names the editor\'s parent origin per session: no list, and only that origin frames the page', async () => {
  const mf = new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB']});
  try {
    const db = await mf.getD1Database('DB');
    for (const name of (await readdir(MIGRATIONS_DIR)).filter(n=>n.endsWith('.sql')).sort())
      await db.batch(unstable_splitSqlQuery(await readFile(new URL(name,MIGRATIONS_DIR),'utf8')).map(s=>db.prepare(s)));
    const key = 'local-test-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const keyHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key))),n=>n.toString(16).padStart(2,'0')).join('');
    await db.prepare("INSERT INTO tenants (id) VALUES ('a')").run();
    await db.prepare("INSERT INTO api_keys (key_hash,tenant_id) VALUES (?,'a')").bind(keyHash).run();
    const host = 'https://host.example.com', other = 'https://other.example.com', self = 'https://esign.example.com';
    const env = {DB:db,ARTIFACTS:await blobStore(mf,'artifacts'),ASSETS:{fetch:async()=>new Response('<html>editor</html>',{headers:{'content-type':'text/html'}})}};
    const req = (path:string,init:RequestInit={})=>app.fetch(new Request(self+path,init),env);
    const post = (path:string,body:unknown,headers:Record<string,string>)=>req(path,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)});
    const start = async(origin:string)=>{const r=await post('/api/template-editing-sessions',{allowedParentOrigin:origin,roles:['Signer']},{authorization:`Bearer ${key}`});assert.equal(r.status,201);const s=await r.json() as {sessionId:string;url:string};return {id:s.sessionId,code:new URL(s.url).hash.slice(1)};};
    const exchange = (s:{id:string;code:string},embedder?:string)=>post('/api/public/editor/exchange',{pageId:s.id,code:s.code,...(embedder?{embedded:true,embedder,embedders:[embedder]}:{})},{origin:self});

    // Any https origin, named by the host and listed nowhere, gets a session bound to it.
    const forHost = await start(host), forOther = await start(other);
    assert.equal(await editor.editorPageParent(db,forHost.id,Date.now()),host);
    assert.equal(await editor.editorPageParent(db,forOther.id,Date.now()),other);
    // Framed by another origin, the page gets no session, and its code stays unused for its own parent.
    assert.equal((await exchange(forHost,other)).status,403);
    assert.equal((await exchange(forHost,host)).status,200);
    assert.equal((await exchange(forOther)).status,200,'the page opened on its own, unframed');

    // What is not a bare https origin (http only on a loopback host) is refused before a session exists.
    for (const bad of ['http://host.example.com','https://host.example.com/page','https://host.example.com?x=1','https://Host.example.com','null'])
      assert.equal((await post('/api/template-editing-sessions',{allowedParentOrigin:bad,roles:['Signer']},{authorization:`Bearer ${key}`})).status,422,bad);
    assert.equal((await start('http://localhost:3000')).id.length,64);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM editor_sessions WHERE parent_origin NOT IN (?,?,'http://localhost:3000')").bind(host,other).first<{n:number}>())!.n,0);
  } finally { await mf.dispose(); }
});
