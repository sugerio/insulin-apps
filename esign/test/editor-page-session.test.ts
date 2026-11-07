import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import * as editor from '../src/editor-session.ts';

test('page identifier is not a credential; code is bound to page, tenant and allowed parent and consumed once', async () => {
  const mf = new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB']});
  try {
    const db = await mf.getD1Database('DB');
    for (const name of ['0001_tenants.sql','0013_editor_sessions.sql','0015_editor_page_sessions.sql','0041_candidate_editor_sessions.sql']) {
      const sql = await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8');
      await db.batch(sql.split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
    }
    await db.prepare("INSERT INTO tenants(id) VALUES ('a'),('b')").run();
    await db.prepare("INSERT INTO editor_allowed_origins VALUES ('a','https://host.example.com'),('b','https://other.example.com')").run();
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
    assert.deepEqual(await editor.authorizeEditorPage(db,token,102),{tenantId:'a',parentOrigin:'https://host.example.com'});
    await assert.rejects(()=>editor.authorizeEditorPage(db,first.pageId,102));
    await assert.rejects(()=>editor.authorizeEditorPage(db,token,900101));
    await db.prepare("DELETE FROM editor_allowed_origins WHERE tenant_id='a'").run();
    await assert.rejects(()=>editor.authorizeEditorPage(db,token,103));
  } finally { await mf.dispose(); }
});
