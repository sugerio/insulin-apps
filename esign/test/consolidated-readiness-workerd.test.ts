import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,readdir,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Miniflare} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';

test('consolidated readiness exposes only authenticated me with both management limiters', {timeout:120000}, async()=>{
 const dir=await mkdtemp(join(await realpath(tmpdir()),'readiness-')); const instances:Miniflare[]=[];
 const origin='https://page.example.test', key='a'.repeat(64), revoked='b'.repeat(64);
 try {
  const output=join(dir,'build'); const build=spawnSync(process.execPath,['scripts/build-candidate-assets.ts',output],{encoding:'utf8',env:{...process.env,VITE_CANDIDATE_GATEWAY_ORIGIN:origin,VITE_CANDIDATE_EDITOR_GATEWAY_ORIGIN:origin}}); assert.equal(build.status,0,build.stderr);
  const script=await readFile(join(output,'consolidated-worker.mjs'),'utf8');
  const base={modules:true as const,script,compatibilityDate:'2026-01-01',d1Databases:['DB'],r2Buckets:['ARTIFACTS'],assets:{directory:join(output,'client'),binding:'ASSETS',routerConfig:{invoke_user_worker_ahead_of_assets:true,has_user_worker:true}}};
  const limits={MANAGEMENT_RATE_LIMITER:{namespace_id:'9800',simple:{limit:100,period:60 as const}},MANAGEMENT_LOCATION_RATE_LIMITER:{namespace_id:'9801',simple:{limit:100,period:60 as const}}};
  const bindings={RECIPIENT_GATEWAY_ORIGIN:origin,EDITOR_GATEWAY_ORIGIN:origin,MANAGEMENT_READINESS_ENABLED:'true',RECIPIENT_GATEWAY_ENABLED:'true',EDITOR_GATEWAY_ENABLED:'true',TRUSTED_RECIPIENT_ORIGINS:origin,TRUSTED_EDITOR_ORIGINS:origin};
  Object.assign(limits,Object.fromEntries(['RECIPIENT','EDITOR'].flatMap((name,i)=>[[name+'_RATE_LIMITER',{namespace_id:String(9810+i*2),simple:{limit:100,period:60 as const}}],[name+'_LOCATION_RATE_LIMITER',{namespace_id:String(9811+i*2),simple:{limit:100,period:60 as const}}]])));
  const start=(extra:Record<string,string>={},ratelimits:Record<string,any>=limits)=>{const mf=new Miniflare({...base,bindings:{...bindings,...extra},ratelimits});instances.push(mf);return mf;};
  const mf=start(), db=await mf.getD1Database('DB'), bucket=await mf.getR2Bucket('ARTIFACTS');
  for(const n of (await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort()) await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${n}`,'utf8')).map(s=>db.prepare(s)));
  const digest=async(s:string)=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))).toString('hex');
  await db.prepare('INSERT INTO tenants VALUES (?)').bind('tenant').run();
  await db.prepare('INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,?)').bind(await digest(key),'tenant').run();
  await db.prepare('INSERT INTO api_keys(key_hash,tenant_id,revoked_at) VALUES (?,?,?)').bind(await digest(revoked),'tenant',1).run();
  await db.prepare('INSERT INTO tenants VALUES (?)').bind('other').run();
  await db.prepare('INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,?)').bind(await digest('d'.repeat(64)),'other').run();
  const initialTenants=await db.prepare('SELECT * FROM tenants ORDER BY id').all();
  const initialKeys=await db.prepare('SELECT * FROM api_keys ORDER BY key_hash').all();
  const run=(instance:Miniflare,path:string,init:RequestInit={})=>instance.dispatchFetch(origin+path,{...init,headers:{'cf-connecting-ip':'192.0.2.1',authorization:`Bearer ${key}`,...init.headers}} as any);
  const response=await run(mf,'/v1/me'); assert.equal(response.status,200); assert.deepEqual(await response.json(),{tenantId:'tenant'});
  for(const value of ['c'.repeat(64),revoked]) assert.equal((await run(mf,'/v1/me',{headers:{authorization:`Bearer ${value}`}})).status,401);
  assert.equal((await run(mf,'/v1/me',{headers:{authorization:''}})).status,401);
  const other=await run(mf,'/v1/me',{headers:{authorization:`Bearer ${'d'.repeat(64)}`}}); assert.equal(other.status,200); assert.deepEqual(await other.json(),{tenantId:'other'});
  assert.equal((await run(mf,'/v1/me',{headers:{origin}})).status,403);
  for(const [method,path] of [['POST','/v1/me'],['GET','/v1/me?x=1'],['POST','/v1/editor-sessions'],['POST','/v1/templates'],['POST','/v1/envelopes'],['POST','/v1/envelopes/e/prepare'],['POST','/v1/envelopes/e/tasks/t/recipient-view'],['POST','/v1/envelopes/e/tasks/t/recipient-revoke'],['GET','/v1/envelopes/e/tasks'],['GET','/v1/editor-sessions/'+ 'a'.repeat(64)+'/result'],...['/v1/editor-sessions/exchange','/v1/editor-sessions/context','/v1/editor-sessions/save','/v1/page-sessions/exchange','/v1/otp/send','/v1/otp/verify','/v1/document','/v1/fields','/v1/preview','/v1/sign'].map(p=>['POST',p])]) {
   const r=await run(mf,path,{method,...(method==='POST'?{body:'{}',headers:{'content-type':'application/json'}}:{})}); assert.equal(r.status,404,`${method} ${path}`);
  }
  for(const path of ['/v1/editor-sessions/exchange','/v1/editor-sessions/context','/v1/editor-sessions/save','/v1/page-sessions/exchange','/v1/otp/send','/v1/otp/verify','/v1/document','/v1/fields','/v1/preview','/v1/sign']) for(const method of ['GET','OPTIONS']) assert.equal((await run(mf,path,{method,headers:{origin,'access-control-request-method':'POST'}})).status,404,`${method} ${path}`);
  assert.equal((await run(mf,'/v1/me?')).status,404);
  for(const path of ['/v1/x/../editor-sessions','/v1/x/../otp/send','/v1/me/../templates']) assert.equal((await run(mf,path,{method:'POST',body:'{}'})).status,404,path);
  for(const path of ['/v1/x/../me','/v1/%2e%2e/v1/me']) {const r=await run(mf,path);assert.equal(r.status,200,path);assert.deepEqual(await r.json(),{tenantId:'tenant'});}
  const tables=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").all<{name:string}>();
  for(const {name} of tables.results) {if(name==='tenants'||name==='api_keys'||name==='d1_migrations') continue; const row=await db.prepare(`SELECT count(*) n FROM "${name.replaceAll('"','""')}"`).first<{n:number}>(); assert.equal(row?.n,0,name);}
  assert.deepEqual((await db.prepare('SELECT * FROM tenants ORDER BY id').all()).results,initialTenants.results);
  assert.deepEqual((await db.prepare('SELECT * FROM api_keys ORDER BY key_hash').all()).results,initialKeys.results);
  assert.equal((await bucket.list()).objects.length,0);
  for(const missing of ['MANAGEMENT_RATE_LIMITER','MANAGEMENT_LOCATION_RATE_LIMITER']) {const partial={...limits};delete partial[missing as keyof typeof partial];assert.equal((await run(start({},partial),'/v1/me')).status,503);}
  assert.equal((await run(start({MANAGEMENT_READINESS_ENABLED:'false'}),'/v1/me')).status,503);
 } finally {for(const mf of instances) await mf.dispose();await rm(dir,{recursive:true,force:true});}
});
