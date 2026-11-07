import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fetchRecipientGateway} from '../src/recipient-gateway.ts';

const origin='https://sign.example.test';
const paths=['/v1/page-sessions/exchange','/v1/otp/send','/v1/otp/verify','/v1/document','/v1/fields','/v1/preview','/v1/sign'];
const request=(path:string, body='{"token":"synthetic"}', extra:Record<string,string>={})=>new Request('https://api.example.test'+path,{method:'POST',headers:{origin,'content-type':'application/json',...extra},body});
const limiter={limit:async()=>({success:true})};
test('recipient gateway is disabled by default and forwards only exact candidate routes with trusted origin injected',async()=>{
 const calls:Request[]=[]; const env={RECIPIENT_GATEWAY_ENABLED:'true',TRUSTED_RECIPIENT_ORIGINS:origin,LOCATION_RATE_LIMITER:limiter,RATE_LIMITER:limiter,PRIVATE_RECIPIENT:{fetch:async(r:Request)=>{calls.push(r);return new Response('ok',{headers:{'set-cookie':'secret=1','x-signature-preview':'receipt','location':'https://example.test'}})}}};
 const go=(r:Request)=>fetchRecipientGateway(r,env,'192.0.2.1');
 assert.equal((await fetchRecipientGateway(request(paths[0]),{},'192.0.2.1')).status,503);
 for(const path of paths) {const res=await go(request(path));assert.equal(res.status,200);assert.equal(res.headers.get('set-cookie'),null);assert.equal(res.headers.get('location'),null);assert.equal(res.headers.get('x-signature-preview'),'receipt');}
 assert.equal(calls.length,7);assert.deepEqual(await calls[0].json(),{token:'synthetic',origin});
 for(const path of ['/v1/me','/v1/sign?x=1','/v1/sign/','/v1/envelopes/e/tasks/t/recipient-view']) assert.equal((await go(request(path))).status,404);
 assert.equal((await go(new Request('https://api.example.test/v1/sign',{method:'GET',headers:{origin}}))).status,404);
 assert.equal((await go(request('/v1/sign','{}',{origin:'https://evil.example.test'}))).status,403);
 assert.equal((await go(request('/v1/sign','{"origin":"https://evil.example.test"}'))).status,400);
 assert.equal((await go(request('/v1/sign','{}',{authorization:'Bearer management-secret'}))).status,403);
 assert.equal(calls.length,7);
});
test('preflight, body bounds, stripping, HTTPS and limiter fail closed',async()=>{
 let calls=0;const env={RECIPIENT_GATEWAY_ENABLED:'true',TRUSTED_RECIPIENT_ORIGINS:origin,LOCATION_RATE_LIMITER:limiter,RATE_LIMITER:limiter,PRIVATE_RECIPIENT:{fetch:async(r:Request)=>{calls++;assert.equal(r.headers.get('cookie'),null);assert.equal(r.headers.get('x-extra'),null);return new Response(null,{status:204})}}};
 const go=(r:Request)=>fetchRecipientGateway(r,env,'192.0.2.1');
 const pre=await go(new Request('https://api.example.test/v1/sign',{method:'OPTIONS',headers:{origin,'access-control-request-method':'POST','access-control-request-headers':'content-type'}}));assert.equal(pre.status,204);assert.equal(pre.headers.get('access-control-allow-origin'),origin);assert.equal(pre.headers.get('access-control-allow-credentials'),null);
 assert.equal((await go(request('/v1/sign','x'.repeat(4097)))).status,413);
 assert.equal((await go(request('/v1/sign','{}',{'content-type':'text/plain'}))).status,415);
 assert.equal((await go(request('/v1/sign','{}',{cookie:'s=secret','x-extra':'secret'}))).status,204);
 assert.equal((await fetchRecipientGateway(request('/v1/sign'),{...env,RATE_LIMITER:undefined},'192.0.2.1')).status,503);
 assert.equal((await fetchRecipientGateway(request('/v1/sign'),{...env,RATE_LIMITER:{limit:async()=>({success:false})}},'192.0.2.1')).status,429);
 assert.equal((await fetchRecipientGateway(request('/v1/sign'),env,null)).status,503);
 assert.equal((await go(new Request('http://api.example.test/v1/sign',{method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'}))).status,400);
 assert.equal(calls,1);
});
test('serialized forwarded body is bounded after origin injection in UTF-8 bytes',async()=>{
 const sizes:number[]=[]; const env={RECIPIENT_GATEWAY_ENABLED:'true',TRUSTED_RECIPIENT_ORIGINS:origin,LOCATION_RATE_LIMITER:limiter,RATE_LIMITER:limiter,PRIVATE_RECIPIENT:{fetch:async(r:Request)=>{sizes.push((await r.arrayBuffer()).byteLength);return new Response(null,{status:204});}}};
 const prefix=JSON.stringify({value:'',origin}); const padding=4096-Buffer.byteLength(prefix);
 assert.equal((await fetchRecipientGateway(request('/v1/sign',JSON.stringify({value:'a'.repeat(padding)})),env,'192.0.2.1')).status,204);
 assert.equal((await fetchRecipientGateway(request('/v1/sign',JSON.stringify({value:'a'.repeat(padding-1)+'é'})),env,'192.0.2.1')).status,413);
 assert.deepEqual(sizes,[4096]);
});
test('local workerd routes to the actual named PrivateRecipient entrypoint',async()=>{
 const {build}=await import('esbuild');const {Miniflare}=await import('miniflare');
 const bundle=async(path:string)=>(await build({entryPoints:[path],bundle:true,platform:'browser',format:'esm',write:false,external:['cloudflare:workers']})).outputFiles[0].text;
 const mf=new Miniflare({workers:[{name:'gateway',modules:true,script:await bundle('src/recipient-gateway.ts'),bindings:{RECIPIENT_GATEWAY_ENABLED:'true',TRUSTED_RECIPIENT_ORIGINS:origin},ratelimits:{LOCATION_RATE_LIMITER:{namespace_id:'11002',simple:{limit:1000,period:60}},RATE_LIMITER:{namespace_id:'1002',simple:{limit:100,period:60}}},serviceBindings:{PRIVATE_RECIPIENT:{name:'candidate',entrypoint:'PrivateRecipient'}}},{name:'candidate',modules:true,script:await bundle('src/candidate-worker.ts')}]});
 try {const res=await mf.dispatchFetch('https://api.example.test/v1/page-sessions/exchange',{method:'POST',headers:{origin,'content-type':'application/json','cf-connecting-ip':'192.0.2.1'},body:'{"code":"invalid"}'});assert.equal(res.status,400);assert.deepEqual(await res.json(),{error:'invalid_request'});assert.equal(res.headers.get('access-control-allow-origin'),origin);} finally {await mf.dispose();}
});
