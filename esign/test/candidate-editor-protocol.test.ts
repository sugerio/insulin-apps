import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {PDFDocument} from 'pdf-lib';
import {unstable_splitSqlQuery} from 'wrangler';

test('private editor JSON protocol through named bindings',async()=>{
 const bundle=async(path:string)=>(await build({entryPoints:[path],bundle:true,platform:'browser',format:'esm',write:false,external:['cloudflare:workers']})).outputFiles[0].text;
 const candidate=await bundle('src/candidate-worker.ts'), management=await bundle('src/management-gateway.ts'), editor=await bundle('src/editor-gateway.ts');
 const mf=new Miniflare({workers:[
  {name:'editor',modules:true,script:editor,compatibilityFlags:['streams_enable_constructors'],bindings:{EDITOR_GATEWAY_ENABLED:'true',TRUSTED_EDITOR_ORIGINS:'https://host.example.test'},ratelimits:{LOCATION_RATE_LIMITER:{namespace_id:'11002',simple:{limit:1000,period:60}},RATE_LIMITER:{namespace_id:'1002',simple:{limit:100,period:60}}},serviceBindings:{PRIVATE_EDITOR:{name:'candidate',entrypoint:'PrivateEditor'}}},
  {name:'management',modules:true,script:management,bindings:{MANAGEMENT_GATEWAY_ENABLED:'true'},ratelimits:{LOCATION_RATE_LIMITER:{namespace_id:'11001',simple:{limit:1000,period:60}},RATE_LIMITER:{namespace_id:'1001',simple:{limit:100,period:60}}},serviceBindings:{PRIVATE_MANAGEMENT:{name:'candidate',entrypoint:'PrivateManagement'}}},
  {name:'candidate',modules:true,script:candidate,d1Databases:['DB'],r2Buckets:['ARTIFACTS'],compatibilityFlags:['formdata_parser_supports_files'],bindings:{CANDIDATE_TEMPLATE_ADMISSION_WINDOW_MS:'60000',CANDIDATE_TEMPLATE_ADMISSION_TENANT_LIMIT:'100',CANDIDATE_TEMPLATE_ADMISSION_DATABASE_LIMIT:'100',CANDIDATE_TEMPLATE_WINDOW_MS:'60000',CANDIDATE_TEMPLATE_TENANT_LIMIT:'100',CANDIDATE_TEMPLATE_DATABASE_LIMIT:'100',CANDIDATE_TEMPLATE_RETAINED_LIMIT:'100',CANDIDATE_TEMPLATE_TENANT_RETAINED_LIMIT:'100',TEST_EDITOR_WINDOW_MS:'60000',TEST_EDITOR_TENANT_ISSUANCE:'2',TEST_EDITOR_DATABASE_ISSUANCE:'3',TEST_EDITOR_TENANT_OUTSTANDING:'2',TEST_EDITOR_DATABASE_OUTSTANDING:'3',TEST_EDITOR_TENANT_RETAINED:'2',TEST_EDITOR_DATABASE_RETAINED:'3'}}
 ]});
 try {
  const db=await mf.getD1Database('DB','candidate');
  for(const n of (await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort()) await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${n}`,'utf8')).map(s=>db.prepare(s)));
  const key='a'.repeat(32), hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key))).toString('hex');
  await db.prepare("INSERT INTO tenants VALUES ('tenant')").run(); await db.prepare("INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,'tenant')").bind(hash).run(); await db.prepare("INSERT INTO editor_allowed_origins VALUES ('tenant','https://host.example.test')").run();
  const mg=await mf.getWorker('management'), pub=await mf.getWorker('candidate');
  const issue=()=>mg.fetch('https://management.example.test/v1/editor-sessions',{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json','cf-connecting-ip':'192.0.2.1'},body:JSON.stringify({origin:'https://host.example.test',roles:['Buyer','Seller']})});
  const send=(path:string,body:unknown,origin='https://host.example.test')=>mf.dispatchFetch('https://editor.example.test'+path,{method:'POST',headers:{origin,'content-type':'application/json','cf-connecting-ip':'192.0.2.1'},body:JSON.stringify(body)});
  assert.equal((await pub.fetch('https://candidate.example.test/v1/editor-sessions',{method:'POST'})).status,404);
  const issued=await issue();assert.equal(issued.status,200);const entry=await issued.json() as {pageId:string;code:string};
  assert.equal((await send('/v1/editor-sessions/exchange',entry,'https://evil.example.test')).status,403);
  const exchange=await send('/v1/editor-sessions/exchange',entry);assert.equal(exchange.status,200,await exchange.clone().text());const {token}=await exchange.json() as {token:string};
  assert.notEqual(token,key);assert.equal((await send('/v1/editor-sessions/exchange',entry)).status,401);
  const context=await send('/v1/editor-sessions/context',{token});assert.equal(context.status,200);assert.deepEqual(await context.json(),{tenantId:'tenant',roles:['Buyer','Seller']});
  const pdf=await PDFDocument.create();pdf.addPage([600,800]);const bytes=await pdf.save();
  const fields=['Buyer','Seller'].map((role,i)=>({id:role,type:'Signature',role,page:1,required:true,rect:{x:.1,y:.1+i*.3,width:.5,height:.1}}));
  const save=async(key='save1',f=fields,t=token,origin='https://host.example.test')=>{const form=new FormData();form.set('file',new Blob([bytes],{type:'application/pdf'}),'source.pdf');form.set('fields',JSON.stringify(f));const encoded=new Request('https://editor.example.test/',{method:'POST',body:form});return mf.dispatchFetch('https://editor.example.test/v1/editor-sessions/save',{method:'POST',headers:{origin,'content-type':encoded.headers.get('content-type')!,'x-editor-token':t,'idempotency-key':key,'cf-connecting-ip':'192.0.2.1'},body:await encoded.arrayBuffer()});};
  let finish!:()=>void;const paused=new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode('--test\r\n'));finish=()=>c.close();}});
  const pending=mf.dispatchFetch('https://editor.example.test/v1/editor-sessions/save',{method:'POST',headers:{origin:'https://host.example.test','content-type':'multipart/form-data; boundary=test','x-editor-token':token,'idempotency-key':'paused','cf-connecting-ip':'192.0.2.1'},body:paused,duplex:'half'} as RequestInit);
  let count=0;for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,20));count=(await db.prepare("SELECT COALESCE(sum(issue_count),0) n FROM candidate_template_admission_budgets WHERE scope='tenant'").first<{n:number}>())!.n;if(count)break;}assert.equal(count,1,'admission commits before paused upload completes');finish();assert.equal((await pending).status,400);
  const injected=new FormData();injected.set('file',new Blob([bytes]),'source.pdf');injected.set('fields',JSON.stringify(fields));injected.set('roles',JSON.stringify(['Other','Roles']));const encoded=new Request('https://editor.example.test/',{method:'POST',body:injected});assert.equal((await mf.dispatchFetch('https://editor.example.test/v1/editor-sessions/save',{method:'POST',headers:{origin:'https://host.example.test','content-type':encoded.headers.get('content-type')!,'x-editor-token':token,'idempotency-key':'injected','cf-connecting-ip':'192.0.2.1'},body:await encoded.arrayBuffer()})).status,400);
  const [saved,retry]=await Promise.all([save(),save()]);assert.equal(saved.status,200,await saved.clone().text());assert.equal(retry.status,200,await retry.clone().text());assert.deepEqual(await saved.json(),await retry.json());
  const lost=await save();assert.equal(lost.status,200);await lost.arrayBuffer();const recovered=await save();assert.equal(recovered.status,200);
  assert.equal((await save('other')).status,503);const changed=await save('save1',[{...fields[0],id:'changed'},fields[1]]);assert.equal(changed.status,409);assert.deepEqual(await changed.json(),{error:'conflict'});
  const secondIssue=await issue();assert.equal(secondIssue.status,200);const secondEntry=await secondIssue.json() as {pageId:string;code:string};const secondExchange=await send('/v1/editor-sessions/exchange',secondEntry);const secondToken=(await secondExchange.json() as {token:string}).token;const crossSession=await save('save1',fields,secondToken);assert.equal(crossSession.status,503);assert.deepEqual(await crossSession.json(),{error:'unavailable'});assert.equal((await save('save1',fields,'x'.repeat(32))).status,401);assert.equal((await save('save1',fields,token,'https://evil.example.test')).status,403);
  const otherKey='b'.repeat(32),otherHash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(otherKey))).toString('hex');await db.prepare("INSERT INTO tenants VALUES ('other')").run();await db.prepare("INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,'other')").bind(otherHash).run();await db.prepare("INSERT INTO editor_allowed_origins VALUES ('other','https://host.example.test')").run();
  const otherIssue=await mg.fetch('https://management.example.test/v1/editor-sessions',{method:'POST',headers:{authorization:`Bearer ${otherKey}`,'content-type':'application/json','cf-connecting-ip':'192.0.2.1'},body:JSON.stringify({origin:'https://host.example.test',roles:['Buyer','Seller']})});assert.equal(otherIssue.status,200);const otherEntry=await otherIssue.json() as {pageId:string;code:string};const otherExchange=await send('/v1/editor-sessions/exchange',otherEntry);const otherToken=(await otherExchange.json() as {token:string}).token;const otherSave=await save('save1',fields,otherToken);assert.equal(otherSave.status,200);assert.notDeepEqual(await otherSave.json(),await recovered.json());
  assert.equal((await pub.fetch('https://candidate.example.test/v1/editor-sessions/save',{method:'POST'})).status,404);
  await db.prepare('UPDATE editor_page_tokens SET expires_at=0 WHERE page_id=?').bind(entry.pageId).run();
  assert.equal((await send('/v1/editor-sessions/context',{token})).status,401);assert.equal((await save()).status,401);
  await db.prepare('UPDATE editor_page_tokens SET expires_at=? WHERE page_id=?').bind(Date.now()+60000,entry.pageId).run();
  await db.prepare('UPDATE api_keys SET revoked_at=1 WHERE key_hash=?').bind(hash).run();assert.equal((await send('/v1/editor-sessions/context',{token})).status,401);assert.equal((await save()).status,401);assert.equal((await issue()).status,401);
  await db.prepare('UPDATE api_keys SET revoked_at=NULL WHERE key_hash=?').bind(hash).run(); const expiring=secondEntry;
  await db.prepare('UPDATE editor_page_entries SET expires_at=0 WHERE page_id=?').bind(expiring.pageId).run();
  assert.equal((await send('/v1/editor-sessions/exchange',expiring)).status,401);
  assert.equal((await issue()).status,503);
  assert.equal((await pub.fetch('https://candidate.example.test/v1/editor-sessions/exchange',{method:'POST'})).status,404);
 }finally{await mf.dispose();}
});

test('editor gateway requires opt-in, admission, exact origins and rejects bearer credentials',async()=>{
 const {fetchEditorGateway}=await import('../src/editor-gateway.ts');
 let calls=0;const env={EDITOR_GATEWAY_ENABLED:'true',TRUSTED_EDITOR_ORIGINS:'https://host.example.test',LOCATION_RATE_LIMITER:{limit:async()=>({success:true})},RATE_LIMITER:{limit:async()=>({success:true})},PRIVATE_EDITOR:{fetch:async()=>{calls++;return Response.json({ok:true});}}};
 const request=(headers:Record<string,string>={})=>new Request('https://editor.example.test/v1/editor-sessions/context',{method:'POST',headers:{origin:'https://host.example.test','content-type':'application/json',...headers},body:'{"token":"x"}'});
 assert.equal((await fetchEditorGateway(request(),{},'192.0.2.1')).status,503);
 assert.equal((await fetchEditorGateway(request(),{...env,RATE_LIMITER:undefined},'192.0.2.1')).status,503);
 assert.equal((await fetchEditorGateway(request(),{...env,RATE_LIMITER:{limit:async()=>({success:false})}},'192.0.2.1')).status,429);
 assert.equal((await fetchEditorGateway(request({origin:'https://host.example.test.evil.example.test'}),env,'192.0.2.1')).status,403);
 assert.equal((await fetchEditorGateway(request({authorization:'Bearer '+ 'a'.repeat(32)}),env,'192.0.2.1')).status,403);
 const preflight=await fetchEditorGateway(new Request('https://editor.example.test/v1/editor-sessions/save',{method:'OPTIONS',headers:{origin:'https://host.example.test','access-control-request-method':'POST','access-control-request-headers':'content-type,x-editor-token,idempotency-key'}}),env,'192.0.2.1');assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-headers'),'content-type, x-editor-token, idempotency-key');
 assert.equal((await fetchEditorGateway(new Request('https://editor.example.test/v1/editor-sessions/save',{method:'OPTIONS',headers:{origin:'https://host.example.test','access-control-request-method':'POST','access-control-request-headers':'authorization'}}),env,'192.0.2.1')).status,403);
 assert.equal(calls,0);
 assert.equal((await fetchEditorGateway(request(),env,'192.0.2.1')).status,200);assert.equal(calls,1);
});

test('private management fails closed without editor quota configuration in workerd',async()=>{
 const bundle=async(path:string)=>(await build({entryPoints:[path],bundle:true,platform:'browser',format:'esm',write:false,external:['cloudflare:workers']})).outputFiles[0].text;
 const mf=new Miniflare({workers:[
  {name:'management',modules:true,script:await bundle('src/management-gateway.ts'),bindings:{MANAGEMENT_GATEWAY_ENABLED:'true'},ratelimits:{LOCATION_RATE_LIMITER:{namespace_id:'11003',simple:{limit:1000,period:60}},RATE_LIMITER:{namespace_id:'1003',simple:{limit:10,period:60}}},serviceBindings:{PRIVATE_MANAGEMENT:{name:'candidate',entrypoint:'PrivateManagement'}}},
  {name:'candidate',modules:true,script:await bundle('src/candidate-worker.ts'),d1Databases:['DB']}
 ]});
 try {
  const db=await mf.getD1Database('DB','candidate');
  for(const n of (await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort()) await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${n}`,'utf8')).map(s=>db.prepare(s)));
  const key='b'.repeat(32),hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key))).toString('hex');
  await db.prepare("INSERT INTO tenants VALUES ('tenant')").run();await db.prepare("INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,'tenant')").bind(hash).run();await db.prepare("INSERT INTO editor_allowed_origins VALUES ('tenant','https://host.example.test')").run();
  const response=await mf.dispatchFetch('https://management.example.test/v1/editor-sessions',{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json','cf-connecting-ip':'192.0.2.1'},body:JSON.stringify({origin:'https://host.example.test',roles:['Buyer','Seller']})});
  assert.equal(response.status,503);assert.equal((await db.prepare('SELECT count(*) AS count FROM candidate_editor_bindings').first<{count:number}>())!.count,0);
 }finally{await mf.dispose();}
});

test('checked-in editor gateway is inert and enables bounded stream constructors',async()=>{
 const config=JSON.parse(await readFile('wrangler.editor-gateway.jsonc','utf8'));
 assert.deepEqual(Object.keys(config).sort(),['$schema','name','main','compatibility_date','compatibility_flags','workers_dev','preview_urls'].sort());
 assert.deepEqual(config.compatibility_flags,['streams_enable_constructors']);assert.equal(config.main,'src/editor-gateway.ts');assert.equal(config.workers_dev,false);assert.equal(config.preview_urls,false);
});
