import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Miniflare} from 'miniflare';

test('code revocation migration retains historical usage and unused rows without backfill',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB']});
 try {
  const db=await mf.getD1Database('DB');
  await db.exec("CREATE TABLE recipient_page_codes (code_hash TEXT PRIMARY KEY,used_at INTEGER); INSERT INTO recipient_page_codes VALUES ('used',123),('unused',NULL);");
  const before=await db.prepare('SELECT * FROM recipient_page_codes ORDER BY code_hash').all();
  await db.prepare(await readFile(new URL('../migrations/0030_recipient_code_revocations.sql',import.meta.url),'utf8')).run();
  assert.deepEqual((await db.prepare('SELECT * FROM recipient_page_codes ORDER BY code_hash').all()).results,before.results);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM recipient_code_revocations').first<{n:number}>())!.n,0);
 } finally {await mf.dispose();}
});
