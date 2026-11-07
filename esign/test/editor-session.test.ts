import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
const editor=await import('../src/editor-session.ts').catch(()=>({issueEditorCode:undefined,exchangeEditorCode:undefined,authorizeEditor:undefined}));

test('editor code is tenant and origin bound, short lived, one use and not a recipient session',async()=>{
  assert.equal(typeof editor.issueEditorCode,'function','editor session is missing');
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB']});
  try {
    const db=await mf.getD1Database('DB');
    for(const name of ['0001_tenants.sql','0013_editor_sessions.sql']){
      const sql=await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8');
      await db.batch(sql.split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
    }
    await db.prepare("INSERT INTO tenants(id) VALUES ('a'),('b')").run();
    await db.prepare("INSERT INTO editor_allowed_origins VALUES ('a','https://host.example.com')").run();
    await assert.rejects(()=>editor.issueEditorCode!(db,'a','https://evil.example.com',100));
    const code=await editor.issueEditorCode!(db,'a','https://host.example.com',100);
    await assert.rejects(()=>editor.exchangeEditorCode!(db,code,'https://evil.example.com',101));
    const race=await Promise.allSettled([editor.exchangeEditorCode!(db,code,'https://host.example.com',101),editor.exchangeEditorCode!(db,code,'https://host.example.com',101)]);
    assert.equal(race.filter(r=>r.status==='fulfilled').length,1);
    const token=(race.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<string>).value;
    assert.equal(await editor.authorizeEditor!(db,token,'https://host.example.com',102),'a');
    await assert.rejects(()=>editor.authorizeEditor!(db,token,'https://evil.example.com',102));
    await assert.rejects(()=>editor.authorizeEditor!(db,token,'https://host.example.com',900101));
  } finally {await mf.dispose();}
});
