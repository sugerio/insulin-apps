import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {unstable_splitSqlQuery} from 'wrangler';
import {PDFDocument} from 'pdf-lib';
import {Miniflare} from 'miniflare';
import * as editor from '../src/editor-session.ts';
import app from '../src/worker.ts';
import {setEditorOrigins} from './helpers/editor-origins.ts';

test('page identifier is not a credential; code is bound to page, tenant and allowed parent and consumed once', async () => {
  const mf = new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB']});
  try {
    const db = await mf.getD1Database('DB');
    for (const name of ['0001_tenants.sql','0002_templates.sql','0005_access.sql','0015_editor_sessions.sql']) {
      const sql = await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8');
      await db.batch(sql.split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
    }
    await db.prepare("INSERT INTO tenants(id) VALUES ('a'),('b')").run();
    await setEditorOrigins(db,'a',['https://host.example.com']);
    await setEditorOrigins(db,'b',['https://other.example.com']);
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
    await setEditorOrigins(db,'a',[]);
    await assert.rejects(()=>editor.editorPageContext(db,token,103));
  } finally { await mf.dispose(); }
});

test('removing an origin from the tenant list stops that origin\'s editor codes, pages and tokens at their next check', async () => {
  const mf = new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB'],r2Buckets:['ARTIFACTS']});
  try {
    const db = await mf.getD1Database('DB');
    for (const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())
      await db.batch(unstable_splitSqlQuery(await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8')).map(s=>db.prepare(s)));
    const key = 'local-test-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const keyHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key))),n=>n.toString(16).padStart(2,'0')).join('');
    await db.prepare("INSERT INTO tenants (id) VALUES ('a')").run();
    await db.prepare("INSERT INTO api_keys (key_hash,tenant_id) VALUES (?,'a')").bind(keyHash).run();
    const host = 'https://host.example.com', kept = 'https://kept.example.com', self = 'https://esign.example.com';
    await setEditorOrigins(db,'a',[host,kept]);
    const env = {DB:db,ARTIFACTS:await mf.getR2Bucket('ARTIFACTS'),ASSETS:{fetch:async()=>new Response('<html>editor</html>',{headers:{'content-type':'text/html'}})}};
    const req = (path:string,init:RequestInit={})=>app.fetch(new Request(self+path,init),env);
    const post = (path:string,body:unknown,headers:Record<string,string>)=>req(path,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)});
    const start = async(origin:string)=>{const r=await post('/v1/template-editing-sessions',{allowedParentOrigin:origin,roles:['Signer']},{authorization:`Bearer ${key}`});assert.equal(r.status,201);const s=await r.json() as {sessionId:string;url:string};return {id:s.sessionId,code:new URL(s.url).hash.slice(1)};};
    const exchange = (s:{id:string;code:string})=>post('/v1/editor/exchange',{pageId:s.id,code:s.code},{origin:self});
    const tokenOf = async(s:{id:string;code:string})=>{const r=await exchange(s);assert.equal(r.status,200);return ((await r.json()) as {token:string}).token;};
    const current = (token:string)=>req('/v1/editor/current',{headers:{authorization:`Bearer ${token}`,origin:self}});
    const unopened = await start(host), opened = await start(host), other = await start(kept);
    const openedToken = await tokenOf(opened), otherToken = await tokenOf(other);
    assert.equal((await req(`/editor/page/${unopened.id}`)).status,200);
    assert.equal((await current(openedToken)).status,200);

    // The host origin leaves the list; the other entry stays.
    await setEditorOrigins(db,'a',[kept]);
    assert.equal(await editor.editorPageParent(db,unopened.id,Date.now()),null);
    assert.equal((await req(`/editor/page/${unopened.id}`)).status,404,'the page is no longer served, so no frame-ancestors for a removed origin');
    const pdf = await PDFDocument.create();pdf.addPage();
    assert.equal((await req(`/v1/template-editing-sessions/${unopened.id}/source`,{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/pdf'},body:await pdf.save()})).status,404);
    assert.equal((await exchange(unopened)).status,401,'an unused code of the removed origin is refused');
    assert.equal((await current(openedToken)).status,401,'a live token of the removed origin is refused');
    const form = new FormData();form.set('roles','["Signer"]');form.set('fields','[]');form.set('file',new File([await pdf.save()],'a.pdf',{type:'application/pdf'}));
    assert.equal((await req('/v1/editor/save',{method:'POST',headers:{authorization:`Bearer ${openedToken}`,origin:self},body:form})).status,401);
    assert.equal((await post('/v1/template-editing-sessions',{allowedParentOrigin:host},{authorization:`Bearer ${key}`})).status,403);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM editor_sessions WHERE result_template_id IS NOT NULL').first<{n:number}>())!.n,0);
    // The origin still listed keeps working.
    assert.equal((await current(otherToken)).status,200);
    assert.equal((await req(`/editor/page/${(await start(kept)).id}`)).status,200);

    // Entries that are not strings equal to the origin never match; a list that is not an array is refused by the column's CHECK.
    await db.prepare(`UPDATE tenants SET editor_origins_json=? WHERE id='a'`).bind(JSON.stringify([[kept],{origin:kept},`${kept}/`,` ${kept}`,7,null])).run();
    assert.equal((await current(otherToken)).status,401);
    assert.equal((await post('/v1/template-editing-sessions',{allowedParentOrigin:kept},{authorization:`Bearer ${key}`})).status,403);
    await assert.rejects(db.prepare(`UPDATE tenants SET editor_origins_json=? WHERE id='a'`).bind(JSON.stringify({origin:kept})).run(),/CHECK/);
  } finally { await mf.dispose(); }
});
