import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fetchManagementGateway} from '../src/management-gateway.ts';

const key='a'.repeat(32);
const limiter={limit:async (_: {key:string})=>({success:true})};
const gateway=(r:Request,e:Parameters<typeof fetchManagementGateway>[1])=>fetchManagementGateway(r,e,'192.0.2.1');
const url='https://gateway.example.test';
const request=(path:string,method='GET',body?:string)=>new Request(url+path,{method,headers:{authorization:`Bearer ${key}`,'idempotency-key':'provision1',...(path==='/v1/envelopes'?{'content-type':'application/json'}:{}),...(body ? {'content-type':'application/json'} : {})},body});
test('management gateway is opt-in and only forwards exact management routes with bearer authentication',async()=>{
 let calls:Request[]=[];
 const binding={fetch:async(r:Request)=>{calls.push(r); return Response.json({ok:true},{headers:{'set-cookie':'secret=1'}})}};
 const env={MANAGEMENT_GATEWAY_ENABLED:'true',LOCATION_RATE_LIMITER:limiter,RATE_LIMITER:limiter,PRIVATE_MANAGEMENT:binding};
 assert.equal((await gateway(request('/v1/me'),{})).status,503);
 assert.equal((await gateway(request('/v1/me'),{MANAGEMENT_GATEWAY_ENABLED:'true'})).status,503);
 for(const [path,method] of [['/v1/me','GET'],['/v1/envelopes','POST'],['/v1/envelopes/e/prepare','POST'],['/v1/envelopes/e/tasks','GET'],['/v1/envelopes/e/tasks/t/recipient-view','POST'],['/v1/envelopes/e/tasks/t/recipient-revoke','POST'],['/v1/envelopes/e/tasks/t/job','GET'],['/v1/envelopes/e/tasks/t/jobs/j/recover','POST']]) assert.equal((await gateway(request(path,method),env)).status,200);
 for(const [path,method] of [['/v1/sign','POST'],['/v1/otp/send','POST'],['/v1/me','POST'],['/v1/me?x=1','GET'],['/v1/envelopes/e/tasks/t/recipient-view/','POST'],['/health','GET']]) assert.equal((await gateway(request(path,method),env)).status,404);
 assert.equal((await gateway(new Request(url+'/v1/me'),env)).status,401);
 assert.equal(calls.length,8);
 assert.equal(calls[0].headers.get('authorization'),`Bearer ${key}`);
 assert.equal((await gateway(request('/v1/me'),env)).headers.get('set-cookie'),null);
});
test('management gateway bounds bodies and rejects browser and insecure requests without forwarding',async()=>{
 let calls=0; const env={MANAGEMENT_GATEWAY_ENABLED:'true',LOCATION_RATE_LIMITER:limiter,RATE_LIMITER:limiter,PRIVATE_MANAGEMENT:{fetch:async()=>{calls++;return new Response(null,{status:204})}}};
 const path='/v1/envelopes/e/tasks/t/recipient-view';
 assert.equal((await gateway(request(path,'POST','x'.repeat(4097)),env)).status,413);
 assert.equal((await gateway(request('/v1/envelopes','POST','x'.repeat(4097)),env)).status,413);
 assert.equal((await gateway(request('/v1/envelopes/e/prepare','POST','x'),env)).status,413);
 assert.equal((await gateway(new Request(url+'/v1/envelopes',{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:'{}'}),env)).status,400);
 assert.equal((await gateway(request('/v1/envelopes/e/tasks/t/recipient-revoke','POST','x'),env)).status,413);
 assert.equal((await gateway(new Request(url+'/v1/me',{headers:{authorization:`Bearer ${key}`,origin:'https://example.test'}}),env)).status,403);
 assert.equal((await gateway(new Request('http://gateway.example.test/v1/me',{headers:{authorization:`Bearer ${key}`}}),env)).status,400);
 assert.equal(calls,0);
});
test('gateway forwards only minimal headers and bounded bytes and fails closed on binding errors',async()=>{
 let seen:Request | undefined;
 const env={MANAGEMENT_GATEWAY_ENABLED:'true',LOCATION_RATE_LIMITER:limiter,RATE_LIMITER:limiter,PRIVATE_MANAGEMENT:{fetch:async(r:Request)=>{seen=r;return new Response('{"code":"synthetic"}',{headers:{'content-type':'application/json','cache-control':'public','location':'https://example.test/'}})}}};
 const input=new Request(url+'/v1/envelopes/e/tasks/t/recipient-view',{method:'POST',headers:{authorization:`Bearer ${key}`,'x-extra':'ignored','content-type':'application/json'},body:'{"origin":"https://example.test"}'});
 const result=await gateway(input,env);
 assert.equal(await seen!.text(),'{"origin":"https://example.test"}');
 assert.equal(seen!.headers.get('x-extra'),null);
 assert.equal(result.headers.get('cache-control'),'no-store');
 assert.equal(result.headers.get('location'),null);
 assert.equal(await result.text(),'{"code":"synthetic"}');
 const failed=await gateway(request('/v1/me'),{...env,PRIVATE_MANAGEMENT:{fetch:async()=>{throw Error('secret detail')}}});
 assert.equal(failed.status,503); assert.doesNotMatch(await failed.text(),/secret detail/);
});

test('workerd gateway calls the actual named candidate binding and preserves key revocation',async()=>{
 const {build}=await import('esbuild'); const {Miniflare}=await import('miniflare');
 const bundle=async(path:string)=>(await build({entryPoints:[path],bundle:true,platform:'browser',format:'esm',write:false,external:['cloudflare:workers']})).outputFiles[0].text;
 const mf=new Miniflare({workers:[
  {name:'gateway',modules:true,script:await bundle('src/management-gateway.ts'),bindings:{MANAGEMENT_GATEWAY_ENABLED:'true'},ratelimits:{LOCATION_RATE_LIMITER:{namespace_id:'11001',simple:{limit:1000,period:60}},RATE_LIMITER:{namespace_id:'1001',simple:{limit:100,period:60}}},serviceBindings:{PRIVATE_MANAGEMENT:{name:'candidate',entrypoint:'PrivateManagement'}}},
  {name:'candidate',modules:true,script:await bundle('src/candidate-worker.ts'),d1Databases:['DB']}
 ]});
 try {
  const db=await mf.getD1Database('DB','candidate');
  await db.exec('CREATE TABLE api_keys (key_hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, revoked_at INTEGER); CREATE TABLE recipient_page_sessions (token_hash TEXT PRIMARY KEY); CREATE TABLE editor_sessions (token_hash TEXT PRIMARY KEY); CREATE TABLE editor_page_tokens (token_hash TEXT PRIMARY KEY); CREATE TABLE recipient_page_codes (code_hash TEXT PRIMARY KEY); CREATE TABLE editor_codes (code_hash TEXT PRIMARY KEY); CREATE TABLE editor_page_entries (code_hash TEXT PRIMARY KEY)');
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key))),n=>n.toString(16).padStart(2,'0')).join('');
  await db.prepare('INSERT INTO api_keys VALUES (?, ?, NULL)').bind(hash,'synthetic-tenant').run();
  const get=()=>mf.dispatchFetch('https://gateway.example.test/v1/me',{headers:{authorization:`Bearer ${key}`,'cf-connecting-ip':'192.0.2.1'}});
  const ok=await get(); assert.equal(ok.status,200); assert.deepEqual(await ok.json(),{tenantId:'synthetic-tenant'});
  await db.prepare('UPDATE api_keys SET revoked_at=1').run(); assert.equal((await get()).status,401);
  assert.equal((await mf.dispatchFetch('https://gateway.example.test/v1/sign',{method:'POST',headers:{authorization:`Bearer ${key}`,'cf-connecting-ip':'192.0.2.1'}})).status,404);
 } finally {await mf.dispose();}
});

test('mandatory limiter fails closed and uses only sanitized trusted client IP',async()=>{
 let forwards=0; const keys:string[]=[];
 const env={MANAGEMENT_GATEWAY_ENABLED:'true',PRIVATE_MANAGEMENT:{fetch:async()=>{forwards++;return new Response('ok')}},LOCATION_RATE_LIMITER:limiter,RATE_LIMITER:{limit:async ({key}: {key:string})=>{keys.push(key);return {success:true}}}};
 assert.equal((await fetchManagementGateway(request('/v1/me'),{...env,RATE_LIMITER:undefined},'192.0.2.1')).status,503);
 assert.equal((await fetchManagementGateway(request('/v1/me'),{...env,RATE_LIMITER:{limit:async()=>{throw Error('secret')}}},'192.0.2.1')).status,503);
 assert.equal((await fetchManagementGateway(request('/v1/me'),{...env,RATE_LIMITER:{limit:async()=>({success:false})}},'192.0.2.1')).status,429);
 const bad=await fetchManagementGateway(request('/v1/me'),{...env,RATE_LIMITER:{limit:async()=>({success:undefined} as unknown as {success:boolean})}},'192.0.2.1');
 assert.equal(bad.status,503); assert.doesNotMatch(await bad.text(),new RegExp(key));
 for(const ip of ['', '192.0.2.1, 192.0.2.2', '999.1.1.1', '::1%zone', ' attacker ']) assert.equal((await fetchManagementGateway(request('/v1/me'),env,ip)).status,503);
 assert.equal(forwards,0);
 const spoof=new Request(url+'/v1/me',{headers:{authorization:`Bearer ${key}`,'x-forwarded-for':'198.51.100.1','cf-connecting-ip':'198.51.100.2'}});
 assert.equal((await fetchManagementGateway(spoof,env,'2001:0db8::1')).status,200);
 assert.deepEqual(keys,['2001:db8::1']); assert.ok(!keys.join().includes(key));
});

test('template upload forwards at most the limit plus one byte and cancels its source',async()=>{
 let sent=0,cancelled=false,received=0;
 const source=new ReadableStream<Uint8Array>({pull(c){sent++;c.enqueue(new Uint8Array(65536));},cancel(){cancelled=true;}});
 const env={MANAGEMENT_GATEWAY_ENABLED:'true',LOCATION_RATE_LIMITER:limiter,RATE_LIMITER:limiter,PRIVATE_MANAGEMENT:{fetch:async(r:Request)=>{const reader=r.body!.getReader();for(;;){const part=await reader.read();if(part.done)break;received+=part.value.length;}return new Response(null,{status:204});}}};
 const input=new Request(url+'/v1/templates',{method:'POST',headers:{authorization:`Bearer ${key}`},body:source,duplex:'half'} as RequestInit);
 assert.equal((await gateway(input,env)).status,204);assert.equal(received,5*1024*1024+65537);assert.equal(cancelled,true);assert.ok(sent<100);
});

test('template early denial cancels without pulling and binding failures release the source',async()=>{
 for(const fail of [false,true]) {
  let pulls=0,cancels=0;
  const source=new ReadableStream<Uint8Array>({pull(){pulls++;},cancel(){cancels++;}},{highWaterMark:0});
  const env={MANAGEMENT_GATEWAY_ENABLED:'true',LOCATION_RATE_LIMITER:limiter,RATE_LIMITER:limiter,PRIVATE_MANAGEMENT:{fetch:async()=>{if(fail)throw Error('failure');return new Response(null,{status:401});}}};
  const input=new Request(url+'/v1/templates',{method:'POST',headers:{authorization:`Bearer ${key}`},body:source,duplex:'half'} as RequestInit);
  assert.equal((await gateway(input,env)).status,fail?503:401);
  assert.equal(pulls,0); assert.equal(cancels,1); assert.equal(source.locked,false);
 }
});
