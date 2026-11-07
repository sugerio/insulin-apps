import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {unstable_splitSqlQuery} from 'wrangler';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {PDFDocument} from 'pdf-lib';

test('gateway provisions, discovers tenant tasks and issues a view through the named binding',async()=>{
 const bundle=async(path:string)=>(await build({entryPoints:[path],bundle:true,platform:'browser',format:'esm',write:false,external:['cloudflare:workers']})).outputFiles[0].text;
 const mf=new Miniflare({workers:[
  {name:'gateway',modules:true,script:await bundle('src/management-gateway.ts'),bindings:{MANAGEMENT_GATEWAY_ENABLED:'true'},ratelimits:{LOCATION_RATE_LIMITER:{namespace_id:'11010',simple:{limit:1000,period:60}},RATE_LIMITER:{namespace_id:'1010',simple:{limit:100,period:60}}},serviceBindings:{PRIVATE_MANAGEMENT:{name:'candidate',entrypoint:'PrivateManagement'}}},
  {name:'candidate',modules:true,script:await bundle('src/candidate-worker.ts'),d1Databases:['DB'],r2Buckets:['ARTIFACTS'],bindings:{ISOLATED_OTP_RECIPIENTS:'["ana@example.com","marcus@example.com"]',CANDIDATE_PROVISION_WINDOW_MS:'60000',CANDIDATE_PROVISION_TENANT_LIMIT:'100',CANDIDATE_PROVISION_DATABASE_LIMIT:'100',CANDIDATE_PROVISION_RETAINED_LIMIT:'100',TEST_ISSUANCE_WINDOW_MS:'60000',TEST_ISSUANCE_TENANT_LIMIT:'50',TEST_ISSUANCE_DATABASE_LIMIT:'50',TEST_OUTSTANDING_TENANT_LIMIT:'50',TEST_OUTSTANDING_DATABASE_LIMIT:'50'}}
 ]});
 try{
  const db=await mf.getD1Database('DB','candidate'),bucket=await mf.getR2Bucket('ARTIFACTS','candidate');
  for(const n of (await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort())await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${n}`,'utf8')).map(s=>db.prepare(s)));
  const hash=async(s:string)=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))).toString('hex');
  const key='a'.repeat(32),other='b'.repeat(32),origin='https://host.example.com';
  for(const [tenant,token] of [['a',key],['b',other]]){await db.prepare('INSERT INTO tenants VALUES (?)').bind(tenant).run();await db.prepare('INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,?)').bind(await hash(token),tenant).run();}
  await db.prepare('INSERT INTO tenant_page_origins VALUES (?,?)').bind('a',origin).run();
  const pdf=await PDFDocument.create();pdf.addPage([600,800]);await bucket.put('source',await pdf.save());
  const roles=JSON.stringify(['one','two']),fields=JSON.stringify(['one','two'].map((role,i)=>({id:role,type:'Signature',role,page:1,required:true,rect:{x:.1,y:.1+i*.3,width:.5,height:.1}})));
  await db.prepare('INSERT INTO templates VALUES (?,?,?,?,?,?)').bind('tpl','a','source',roles,1,fields).run();
  const call=(path:string,method='GET',body?:unknown,token=key)=>mf.dispatchFetch('https://gateway.example.test'+path,{method,headers:{authorization:`Bearer ${token}`,'cf-connecting-ip':'192.0.2.1',...(body!==undefined?{'content-type':'application/json'}:{}),...(path==='/v1/envelopes'?{'idempotency-key':'create1'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const input={templateId:'tpl',recipients:[{role:'one',name:'Ana',email:'ana@example.com'},{role:'two',name:'Marcus',email:'marcus@example.com'}]};
  assert.equal((await call('/v1/envelopes','POST',{...input,recipients:[{...input.recipients[0],name:'Ana 😀'},input.recipients[1]]})).status,400);
  const created=await call('/v1/envelopes','POST',input);assert.equal(created.status,200);const envelope=await created.json() as {id:string;status:string};
  assert.deepEqual(await (await call('/v1/envelopes','POST',input)).json(),envelope);
  assert.equal((await call(`/v1/envelopes/${envelope.id}/prepare`,'POST')).status,200);
  const path=`/v1/envelopes/${envelope.id}/tasks`;
  const discovery=await call(path);assert.equal(discovery.status,200);const data=await discovery.json() as {tasks:{id:string;role:string;routingOrder:number}[]};
  assert.deepEqual(data.tasks.map(({role,routingOrder})=>({role,routingOrder})),[{role:'one',routingOrder:1},{role:'two',routingOrder:2}]);assert.notEqual(data.tasks[0].id,data.tasks[1].id);
  assert.equal((await call(`/v1/envelopes/${envelope.id}/tasks/${data.tasks[0].id}/recipient-view`,'POST',{origin})).status,200);
  assert.equal((await call(path,'GET',undefined,other)).status,404);
  assert.equal((await call('/v1/envelopes/missing/tasks')).status,404);
  assert.equal((await call(path+'?x=1')).status,404);
  await db.prepare('UPDATE api_keys SET revoked_at=1 WHERE key_hash=?').bind(await hash(key)).run();assert.equal((await call(path)).status,401);
  await db.prepare('UPDATE api_keys SET revoked_at=NULL WHERE key_hash=?').bind(await hash(key)).run();
  await db.prepare('INSERT INTO editor_codes(code_hash,tenant_id,origin,expires_at) VALUES (?,?,?,?)').bind(await hash(key),'a',origin,Date.now()+60000).run();assert.equal((await call(path)).status,401);
  await db.prepare('DELETE FROM editor_codes WHERE code_hash=?').bind(await hash(key)).run();
  await db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?)').bind('extra',envelope.id,'extra','Extra','extra@example.com',3,'PENDING').run();
  assert.equal((await call(path)).status,503);
 }finally{await mf.dispose();}
});
