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
  assert.deepEqual((await db.prepare('SELECT origin FROM editor_allowed_origins ORDER BY origin').all()).results.map((r:any)=>r.origin),['http://localhost:3000','https://console.example.test']);
 } finally {await mf.dispose();}
});

test('provisioning refuses values that are not a tenant id, a key hash or a bare origin', ()=>{
 for(const bad of [
  {tenantId:"x'); DROP TABLE tenants;--"},{tenantId:''},{keyHash:'abc'},
  {consoleOrigins:['https://console.example.test/path']},{consoleOrigins:['http://console.example.test']},{consoleOrigins:[]},
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
