import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';

test('original recipient exchange binds one-use code to verified Access identity and task', {timeout:120000},async()=>{
 const bundle=await build({entryPoints:['src/internal-demo-worker.ts'],bundle:true,format:'esm',platform:'browser',write:false});
 const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});const jwk={...publicKey.export({format:'jwk'}),kid:'key',alg:'RS256',use:'sig'};
 const now=Math.floor(Date.now()/1000),origin='https://demo.example.test',domain='internal.example',email=`fictional@${domain}`;
 const enc=(x:unknown)=>Buffer.from(JSON.stringify(x)).toString('base64url');const mint=(address:string,sub='subject')=>{const input=`${enc({alg:'RS256',kid:'key'})}.${enc({iss:'https://access.example.test',aud:'aud',iat:now,exp:now+120,sub,email:address})}`;return `${input}.${sign('RSA-SHA256',Buffer.from(input),privateKey).toString('base64url')}`;};
 const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-01-01',d1Databases:['DB'],ratelimits:{PREAUTH_RATE_LIMITER:{namespace_id:'9111',simple:{limit:100,period:60}},RECIPIENT_RATE_LIMITER:{namespace_id:'9112',simple:{limit:100,period:60}}},bindings:{INTERNAL_DEMO_READINESS_ENABLED:'true',INTERNAL_DEMO_RECIPIENT_ENABLED:'true',INTERNAL_DEMO_ORIGIN:origin,TEST_ISSUANCE_WINDOW_MS:'60000',TEST_ISSUANCE_TENANT_LIMIT:'5',TEST_ISSUANCE_DATABASE_LIMIT:'10',TEST_OUTSTANDING_TENANT_LIMIT:'5',TEST_OUTSTANDING_DATABASE_LIMIT:'10',INTERNAL_DEMO_EMAIL_DOMAIN:'internal.example',ACCESS_ISSUER:'https://access.example.test',ACCESS_AUDIENCE:'aud',ACCESS_JWKS:JSON.stringify({keys:[jwk]})}});
 try{
  const db=await mf.getD1Database('DB');for(const name of (await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort())await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${name}`,'utf8')).map(s=>db.prepare(s)));
  await db.exec("INSERT INTO tenants VALUES ('tenant'); INSERT INTO templates(id,tenant_id,object_key,roles_json,created_at) VALUES ('template','tenant','key','[\"Signer\"]',1); INSERT INTO envelopes VALUES ('envelope','tenant','template','IN_PROGRESS',1); INSERT INTO tenant_page_origins VALUES ('tenant','https://demo.example.test');");
  await db.prepare("INSERT INTO tasks (id,envelope_id,role,recipient_name,recipient_email,routing_order,status) VALUES ('task','envelope','Signer','Fictional',?,1,'ACTIVE')").bind(email).run();
  const key='m'.repeat(64);await db.prepare('INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,?)').bind(createHash('sha256').update(key).digest('hex'),'tenant').run();
  const issue=(bearer:string,body:unknown)=>mf.dispatchFetch(origin+'/v1/envelopes/envelope/tasks/task/recipient-view',{method:'POST',headers:{'cf-connecting-ip':'192.0.2.1',authorization:`Bearer ${bearer}`,'content-type':'application/json'},body:JSON.stringify(body)});
  const otherKey='z'.repeat(64);await db.prepare("INSERT INTO tenants VALUES ('other')").run();await db.prepare('INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,?)').bind(createHash('sha256').update(otherKey).digest('hex'),'other').run();assert.equal((await issue(otherKey,{origin})).status,404);
  assert.equal((await issue('x'.repeat(64),{origin})).status,401);assert.equal((await issue(key,{origin:'https://evil.example.test'})).status,400);assert.equal((await mf.dispatchFetch(origin+'/v1/envelopes/envelope/tasks/task/recipient-view',{method:'POST',headers:{'cf-connecting-ip':'192.0.2.1',origin,authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify({origin})})).status,403);const issued=await issue(key,{origin});assert.equal(issued.status,201);const issuedCode=(await issued.json() as {code:string}).code;assert.match(issuedCode,/^[a-f0-9]{64}$/);
  const h=(value:string)=>createHash('sha256').update(value).digest('hex');const code=issuedCode;
  const call=(jwt:string,body:unknown,source=origin)=>mf.dispatchFetch(origin+'/v1/page-sessions/exchange',{method:'POST',headers:{'cf-connecting-ip':'192.0.2.1','cf-access-jwt-assertion':jwt,origin:source,'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await call('',{code})).status,401);assert.equal((await call(mint(`other@${domain}`),{code})).status,401);assert.equal((await call(mint(email),{code},'https://evil.example.test')).status,403);
  const expired='c'.repeat(64),revoked='d'.repeat(64);await db.prepare('INSERT INTO recipient_page_codes VALUES (?,?,?,?,?,?,NULL)').bind(h(expired),'tenant','envelope','task',origin,Date.now()-1).run();await db.prepare('INSERT INTO recipient_page_codes VALUES (?,?,?,?,?,?,NULL)').bind(h(revoked),'tenant','envelope','task',origin,Date.now()+120000).run();await db.prepare('INSERT INTO recipient_code_revocations VALUES (?,?)').bind(h(revoked),Date.now()).run();
  assert.equal((await call(mint(email),{code:expired})).status,401);assert.equal((await call(mint(email),{code:revoked})).status,401);
  const spoof=await mf.dispatchFetch(origin+'/v1/page-sessions/exchange',{method:'POST',headers:{'cf-connecting-ip':'192.0.2.1','cf-access-authenticated-user-email':email,origin,'content-type':'application/json'},body:JSON.stringify({code})});assert.equal(spoof.status,401);
  assert.equal((await db.prepare('SELECT used_at FROM recipient_page_codes WHERE code_hash=?').bind(h(code)).first<any>()).used_at,null);
  const deadline='e'.repeat(64),deadlineHash=h(deadline);await db.prepare('INSERT INTO recipient_page_codes VALUES (?,?,?,?,?,?,NULL)').bind(deadlineHash,'tenant','envelope','task',origin,Date.now()+120000).run();
  await db.exec(`CREATE TRIGGER expire_after_binding AFTER INSERT ON internal_demo_recipient_bindings BEGIN UPDATE recipient_page_codes SET expires_at=0 WHERE code_hash='${deadlineHash}'; END;`);
  assert.equal((await call(mint(email),{code:deadline})).status,401);
  const deadlineRow=await db.prepare('SELECT used_at,expires_at FROM recipient_page_codes WHERE code_hash=?').bind(deadlineHash).first<any>();assert.equal(deadlineRow.used_at,null);assert.ok(deadlineRow.expires_at>Date.now());
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM recipient_page_sessions').first<any>()).n,0);assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM internal_demo_recipient_bindings').first<any>()).n,0);
  await db.exec('DROP TRIGGER expire_after_binding');
  const responses=await Promise.all([call(mint(email),{code}),call(mint(email),{code})]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,401]);
  const data=await responses.find(r=>r.status===200)!.json() as {token:string};assert.match(data.token,/^[a-f0-9]{64}$/);
  const binding=await db.prepare('SELECT subject,email FROM internal_demo_recipient_bindings WHERE token_hash=?').bind(h(data.token)).first<any>();assert.deepEqual(binding,{subject:'subject',email});
  assert.equal((await call(mint(email),{code})).status,401);
  for(let i=0;i<4;i++)assert.equal((await issue(key,{origin})).status,201);assert.equal((await issue(key,{origin})).status,503);
  assert.equal((await mf.dispatchFetch(origin+'/v1/signing/otp',{method:'POST',headers:{'cf-connecting-ip':'192.0.2.1','cf-access-jwt-assertion':mint(email),origin}})).status,404);
 }finally{await mf.dispose();}
});

test('recipient issuance refuses missing binding migration without spending issuance budget', {timeout:120000},async()=>{
 const bundle=await build({entryPoints:['src/internal-demo-worker.ts'],bundle:true,format:'esm',platform:'browser',write:false});
 const {publicKey}=generateKeyPairSync('rsa',{modulusLength:2048}),jwk={...publicKey.export({format:'jwk'}),kid:'key',alg:'RS256',use:'sig'},origin='https://demo.example.test',key='m'.repeat(64);
 const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-01-01',d1Databases:['DB'],ratelimits:{PREAUTH_RATE_LIMITER:{namespace_id:'9121',simple:{limit:100,period:60}},RECIPIENT_RATE_LIMITER:{namespace_id:'9122',simple:{limit:100,period:60}}},bindings:{INTERNAL_DEMO_READINESS_ENABLED:'true',INTERNAL_DEMO_RECIPIENT_ENABLED:'true',INTERNAL_DEMO_ORIGIN:origin,TEST_ISSUANCE_WINDOW_MS:'60000',TEST_ISSUANCE_TENANT_LIMIT:'5',TEST_ISSUANCE_DATABASE_LIMIT:'10',TEST_OUTSTANDING_TENANT_LIMIT:'5',TEST_OUTSTANDING_DATABASE_LIMIT:'10',INTERNAL_DEMO_EMAIL_DOMAIN:'internal.example',ACCESS_ISSUER:'https://access.example.test',ACCESS_AUDIENCE:'aud',ACCESS_JWKS:JSON.stringify({keys:[jwk]})}});
 try{
  const db=await mf.getD1Database('DB');for(const name of (await readdir('migrations')).filter(n=>n.endsWith('.sql')&&!n.startsWith('0046_')&&!n.startsWith('0047_')).sort())await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${name}`,'utf8')).map(s=>db.prepare(s)));
  await db.exec("INSERT INTO tenants VALUES ('tenant'); INSERT INTO templates(id,tenant_id,object_key,roles_json,created_at) VALUES ('template','tenant','key','[\"Signer\"]',1); INSERT INTO envelopes VALUES ('envelope','tenant','template','IN_PROGRESS',1); INSERT INTO tenant_page_origins VALUES ('tenant','https://demo.example.test'); INSERT INTO tasks (id,envelope_id,role,recipient_name,recipient_email,routing_order,status) VALUES ('task','envelope','Signer','Fictional','fictional@example.test',1,'ACTIVE');");
  await db.prepare('INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,?)').bind(createHash('sha256').update(key).digest('hex'),'tenant').run();
  const issue=()=>mf.dispatchFetch(origin+'/v1/envelopes/envelope/tasks/task/recipient-view',{method:'POST',headers:{'cf-connecting-ip':'192.0.2.1',authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify({origin})});
  assert.equal((await issue()).status,503);assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM recipient_page_codes').first<any>()).n,0);assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM candidate_issuance_budgets').first<any>()).n,0);
  await db.prepare("INSERT INTO candidate_issuance_budgets VALUES ('database','shared',?,60000,10,10,1,'existing')").bind(Date.now()).run();
  const before=(await db.prepare('SELECT * FROM candidate_issuance_budgets').all()).results;assert.equal((await issue()).status,503);assert.deepEqual((await db.prepare('SELECT * FROM candidate_issuance_budgets').all()).results,before);assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM recipient_page_codes').first<any>()).n,0);
  await db.exec('CREATE TABLE internal_demo_recipient_bindings(token_hash TEXT PRIMARY KEY, subject TEXT)');assert.equal((await issue()).status,503);assert.deepEqual((await db.prepare('SELECT * FROM candidate_issuance_budgets').all()).results,before);assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM recipient_page_codes').first<any>()).n,0);await db.exec('DROP TABLE internal_demo_recipient_bindings');
  const sql=await readFile('migrations/0046_internal_demo_recipient_bindings.sql','utf8');await db.batch(unstable_splitSqlQuery(sql).map(s=>db.prepare(s)));assert.equal((await issue()).status,503);assert.deepEqual((await db.prepare('SELECT * FROM candidate_issuance_budgets').all()).results,before);const next=await readFile('migrations/0047_internal_demo_sink_binding.sql','utf8');await db.batch(unstable_splitSqlQuery(next).map(s=>db.prepare(s)));assert.equal((await issue()).status,201);
 }finally{await mf.dispose();}
});
