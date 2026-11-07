import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('local Wrangler migrations apply once and stop on invalid SQL', {timeout:120000}, async () => {
 const dir=await mkdtemp(join(tmpdir(),'esign-migrations-'));
 try {
  await cp('migrations',join(dir,'migrations'),{recursive:true});
  await writeFile(join(dir,'worker.js'),'export default { fetch() { return new Response("ok") } }');
  await writeFile(join(dir,'wrangler.json'),JSON.stringify({name:'esign-ci-local',main:'worker.js',compatibility_date:'2026-01-01',d1_databases:[{binding:'DB',database_name:'local',database_id:'local-only',migrations_dir:'migrations'}]}));
  const run=()=>spawnSync(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'d1','migrations','apply','local','--local','--config',join(dir,'wrangler.json'),'--persist-to',join(dir,'state')],{cwd:dir,encoding:'utf8',env:{...process.env,CI:'true',WRANGLER_SEND_METRICS:'false'}});
  let result=run(); assert.equal(result.status,0,result.stdout+result.stderr);
  result=run(); assert.equal(result.status,0,result.stdout+result.stderr); assert.match(result.stdout,/No migrations to apply/i);
  await writeFile(join(dir,'migrations','9999_invalid.sql'),'THIS IS NOT SQL;');
  result=run(); assert.equal(result.error,undefined); assert.ok(typeof result.status==='number' && result.status!==0,'invalid migration must fail');
  result=run(); assert.equal(result.error,undefined); assert.ok(typeof result.status==='number' && result.status!==0,'failed migration must not be marked applied');
 } finally {await rm(dir,{recursive:true,force:true});}
});
