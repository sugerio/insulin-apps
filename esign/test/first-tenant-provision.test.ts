import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, rmSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {Miniflare} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import {createFirstSyntheticTenant, SYNTHETIC_TENANT} from './first-tenant-provision.ts';

const schema=readFileSync(new URL('../migrations/0001_tenants.sql',import.meta.url),'utf8');
const script=new URL('../scripts/prepare_management_key.py',import.meta.url).pathname;

test('local first synthetic tenant guard, race and partial recovery',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response()}}',d1Databases:['DB']});
 const dir=mkdtempSync(join(homedir(),'esign-tenant-test-'));
 try {
  const db=await mf.getD1Database('DB');
  await db.batch(unstable_splitSqlQuery(schema).map(s=>db.prepare(s)));
  const counts=async()=>({tenants:(await db.prepare('SELECT count(*) n FROM tenants').first<{n:number}>())!.n,keys:(await db.prepare('SELECT count(*) n FROM api_keys').first<{n:number}>())!.n});
  const race=await Promise.allSettled([createFirstSyntheticTenant(db),createFirstSyntheticTenant(db)]);
  assert.equal(race.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(race.filter(r=>r.status==='rejected').length,1);
  assert.deepEqual(await counts(),{tenants:1,keys:0});
  assert.equal((await db.prepare('SELECT id FROM tenants').first<{id:string}>())!.id,SYNTHETIC_TENANT);
  await assert.rejects(createFirstSyntheticTenant(db));
  // An ambiguous response after the write is resolved by reading, not repeating it.
  const state=await db.prepare('SELECT id FROM tenants').all<{id:string}>();
  assert.deepEqual(state.results,[{id:SYNTHETIC_TENANT}]);
  assert.deepEqual(await counts(),{tenants:1,keys:0});
  const generated=spawnSync('python3',[script,dir,SYNTHETIC_TENANT],{encoding:'utf8'});
  assert.equal(generated.status,0,generated.stderr);
  const sql=readFileSync(join(dir,'management-key.sql'),'utf8');
  await db.exec(sql);
  assert.deepEqual(await counts(),{tenants:1,keys:1});
  await assert.rejects(db.exec(sql));
  await assert.rejects(createFirstSyntheticTenant(db));
  await db.prepare('UPDATE api_keys SET revoked_at=1').run();
  await assert.rejects(createFirstSyntheticTenant(db));
  assert.deepEqual(await counts(),{tenants:1,keys:1});
 } finally {await mf.dispose();rmSync(dir,{recursive:true,force:true});}
});

test('local first synthetic tenant rejects an existing different tenant',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response()}}',d1Databases:['DB']});
 try {
  const db=await mf.getD1Database('DB');await db.batch(unstable_splitSqlQuery(schema).map(s=>db.prepare(s)));
  await db.prepare('INSERT INTO tenants VALUES (?)').bind('other_test').run();
  await assert.rejects(createFirstSyntheticTenant(db));
  assert.deepEqual((await db.prepare('SELECT id FROM tenants').all()).results,[{id:'other_test'}]);
 } finally {await mf.dispose();}
});

test('lost local write responses require inspection before continuing',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response()}}',d1Databases:['DB']});
 const dir=mkdtempSync(join(homedir(),'esign-tenant-test-'));
 try {
  const db=await mf.getD1Database('DB');
  await db.batch(unstable_splitSqlQuery(schema).map(s=>db.prepare(s)));
  let writes=0;
  const ambiguous={prepare(sql:string){
   const statement=db.prepare(sql);
   return {bind(...args:unknown[]){
    const bound=statement.bind(...args);
    return {async run(){writes++;await bound.run();throw new Error('lost response');}};
   }};
  }} as unknown as Pick<D1Database,'prepare'>;
  await assert.rejects(createFirstSyntheticTenant(ambiguous),/lost response/);
  assert.equal(writes,1);
  assert.deepEqual((await db.prepare('SELECT id FROM tenants').all()).results,[{id:SYNTHETIC_TENANT}]);
  assert.equal((await db.prepare('SELECT count(*) n FROM api_keys').first<{n:number}>())!.n,0);
  assert.equal(spawnSync('python3',[script,dir,SYNTHETIC_TENANT],{encoding:'utf8'}).status,0);
  const sql=readFileSync(join(dir,'management-key.sql'),'utf8');
  await assert.rejects((async()=>{await db.exec(sql);throw new Error('lost response');})(),/lost response/);
  assert.equal((await db.prepare('SELECT count(*) n FROM api_keys WHERE tenant_id=? AND revoked_at IS NULL').bind(SYNTHETIC_TENANT).first<{n:number}>())!.n,1);
 } finally {await mf.dispose();rmSync(dir,{recursive:true,force:true});}
});

test('generated first-key SQL guards the complete tenant and key state at insertion',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response()}}',d1Databases:['DB']});
 const dir=mkdtempSync(join(homedir(),'esign-key-guard-test-'));
 const dir2=mkdtempSync(join(homedir(),'esign-key-guard-test-'));
 try {
  const db=await mf.getD1Database('DB');
  await db.batch(unstable_splitSqlQuery(schema).map(s=>db.prepare(s)));
  for(const path of [dir,dir2]) assert.equal(spawnSync('python3',[script,path,SYNTHETIC_TENANT],{encoding:'utf8'}).status,0);
  const sql=readFileSync(join(dir,'management-key.sql'),'utf8');
  const otherSql=readFileSync(join(dir2,'management-key.sql'),'utf8');
  const keys=async()=> (await db.prepare('SELECT key_hash,tenant_id,revoked_at FROM api_keys').all()).results;
  const reset=async()=>{await db.exec('DELETE FROM api_keys; DELETE FROM tenants;');};
  const tenant=async(id:string)=>{await db.prepare('INSERT INTO tenants VALUES (?)').bind(id).run();};
  await assert.rejects(db.exec(sql),'zero tenants');
  assert.deepEqual(await keys(),[]);
  await tenant('other_test');
  await assert.rejects(db.exec(sql),'wrong tenant');
  assert.deepEqual(await keys(),[]);
  await tenant(SYNTHETIC_TENANT);
  await assert.rejects(db.exec(sql),'unexpected second tenant');
  assert.deepEqual(await keys(),[]);
  await reset(); await tenant(SYNTHETIC_TENANT);
  await db.prepare('INSERT INTO api_keys VALUES (?,?,?)').bind('revoked',SYNTHETIC_TENANT,1).run();
  const before=await keys();
  await assert.rejects(db.exec(sql),'revoked key');
  assert.deepEqual(await keys(),before);
  await reset(); await tenant(SYNTHETIC_TENANT);
  const race=await Promise.allSettled([db.exec(sql),db.exec(otherSql)]);
  assert.equal(race.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(race.filter(r=>r.status==='rejected').length,1);
  assert.equal((await keys()).length,1);
  await reset(); await tenant(SYNTHETIC_TENANT);
  await assert.rejects((async()=>{await db.exec(sql);throw new Error('lost response');})(),/lost response/);
  const committed=await keys();
  assert.equal(committed.length,1);
  await assert.rejects(db.exec(sql),'ambiguous response retry');
  await assert.rejects(db.exec(otherSql),'ambiguous response replacement');
  assert.deepEqual(await keys(),committed);
 } finally {await mf.dispose();rmSync(dir,{recursive:true,force:true});rmSync(dir2,{recursive:true,force:true});}
});
