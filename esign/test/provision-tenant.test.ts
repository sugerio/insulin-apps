import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import {parseProvisionArgs,provisioningSql} from '../scripts/provision-tenant.ts';

const plan={tenantId:'org_Ab-1',keyHash:'a'.repeat(64),consoleOrigins:['https://console.example.test','http://localhost:3000']};

test('provisioning registers the tenant, its key hash and its origins, and can be repeated', async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB']});
 try {
  const db=await mf.getD1Database('DB');
  for(const name of (await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort()) await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${name}`,'utf8')).map(s=>db.prepare(s)));
  const run=async(sql:string)=>db.batch(unstable_splitSqlQuery(sql).map(s=>db.prepare(s)));
  await run(provisioningSql(plan));
  // A second key for the same tenant (rotation) keeps the first until it is revoked.
  await run(provisioningSql({...plan,keyHash:'b'.repeat(64)}));
  assert.deepEqual((await db.prepare('SELECT id FROM tenants').all()).results,[{id:'org_Ab-1'}]);
  assert.deepEqual((await db.prepare('SELECT key_hash,tenant_id,revoked_at FROM api_keys ORDER BY key_hash').all()).results,[
   {key_hash:'a'.repeat(64),tenant_id:'org_Ab-1',revoked_at:null},{key_hash:'b'.repeat(64),tenant_id:'org_Ab-1',revoked_at:null}]);
  const origins=async(id='org_Ab-1')=>JSON.parse((await db.prepare('SELECT editor_origins_json FROM tenants WHERE id=?').bind(id).first<{editor_origins_json:string}>())!.editor_origins_json);
  assert.deepEqual(await origins(),['https://console.example.test','http://localhost:3000']);
  // A later run merges: existing entries keep their place, new ones are appended once.
  await run(provisioningSql({...plan,keyHash:'c'.repeat(64),consoleOrigins:['https://second.example.test','https://console.example.test','https://second.example.test']}));
  assert.deepEqual(await origins(),['https://console.example.test','http://localhost:3000','https://second.example.test']);
 } finally {await mf.dispose();}
});

test('provisioning keeps entries it did not write, and the column holds only a JSON array', async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB']});
 try {
  const db=await mf.getD1Database('DB');
  for(const name of (await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort()) await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${name}`,'utf8')).map(s=>db.prepare(s)));
  const run=async(sql:string)=>db.batch(unstable_splitSqlQuery(sql).map(s=>db.prepare(s)));
  const list=async()=>(await db.prepare("SELECT editor_origins_json FROM tenants WHERE id='org_Ab-1'").first<{editor_origins_json:string}>())!.editor_origins_json;
  await db.prepare("INSERT INTO tenants (id,editor_origins_json) VALUES ('org_Ab-1','[\"https://existing.example.test\",7]')").run();
  await run(provisioningSql(plan));
  assert.deepEqual(JSON.parse(await list()),['https://existing.example.test',7,'https://console.example.test','http://localhost:3000']);
  // The column holds a JSON array only.
  for(const bad of ['{"origin":"https://existing.example.test"}','"https://existing.example.test"','7','null','not json'])
   await assert.rejects(db.prepare("UPDATE tenants SET editor_origins_json=? WHERE id='org_Ab-1'").bind(bad).run(),/CHECK/,bad);
  await assert.rejects(db.prepare("INSERT INTO tenants (id,editor_origins_json) VALUES ('org_Cd-2','{}')").run(),/CHECK/);
  assert.deepEqual(JSON.parse(await list()),['https://existing.example.test',7,'https://console.example.test','http://localhost:3000']);
 } finally {await mf.dispose();}
});

test('provisioning refuses values that are not a tenant id, a key hash or a bare origin', ()=>{
 for(const bad of [
  {tenantId:"x'); DROP TABLE tenants;--"},{tenantId:''},{keyHash:'abc'},
  {consoleOrigins:['https://console.example.test/path']},{consoleOrigins:['http://console.example.test']},{consoleOrigins:[]},
  // URL parsing accepts these as origins; the editor origin rule refuses them.
  {consoleOrigins:["https://console'example.test"]},{consoleOrigins:["https://a');DELETE FROM api_keys--.example.test"]},
  {consoleOrigins:['https://a"b.example.test']},{consoleOrigins:['https://a;b.example.test']},{consoleOrigins:['http://[::1]:3000']},
 ]) assert.throws(()=>provisioningSql({...plan,...bad} as typeof plan),JSON.stringify(bad));
});

test('provisioning arguments name the target database explicitly', ()=>{
 const base=['--tenant','org1','--console-origin','https://console.example.test','--key-file','/tmp/key'];
 assert.deepEqual(parseProvisionArgs([...base,'--local']),{tenantId:'org1',consoleOrigins:['https://console.example.test'],keyFile:'/tmp/key',target:'--local',config:undefined,dryRun:false});
 assert.equal(parseProvisionArgs([...base,'--remote','--config','.deploy/wrangler.dev.json']).config,'.deploy/wrangler.dev.json');
 assert.throws(()=>parseProvisionArgs([...base,'--remote']),/--config is required/);
 assert.throws(()=>parseProvisionArgs(base),/--local or --remote/);
 assert.throws(()=>parseProvisionArgs([...base,'--local','--remote']),/--local or --remote/);
 assert.equal(parseProvisionArgs([...base,'--local','--persist-to','/tmp/state']).persistTo,'/tmp/state');
 assert.throws(()=>parseProvisionArgs([...base,'--remote','--persist-to','/tmp/state']),/--local only/);
 assert.throws(()=>parseProvisionArgs([...base,'--local','--surprise']),/unknown/);
});
