import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createConsolidatedRouter} from '../src/consolidated-router.ts';

const origin='https://page.example.test';
test('consolidated router preserves gateway boundaries and distinct budgets', async()=>{
 const calls:string[]=[]; const keys:string[]=[];
 const limiter=(name:string)=>({limit:async ({key}:{key:string})=>{keys.push(`${name}:${key}`);return {success:true};}});
 const handlers={management:async()=>{calls.push('management');return new Response('management');},recipient:async()=>{calls.push('recipient');return new Response('recipient');},editor:async()=>{calls.push('editor');return new Response('editor');},page:async()=>new Response('page')};
 const env:any={MANAGEMENT_GATEWAY_ENABLED:'true',RECIPIENT_GATEWAY_ENABLED:'true',EDITOR_GATEWAY_ENABLED:'true',TRUSTED_RECIPIENT_ORIGINS:origin,TRUSTED_EDITOR_ORIGINS:origin};
 for(const family of ['MANAGEMENT','RECIPIENT','EDITOR']) {env[`${family}_RATE_LIMITER`]=limiter(family);env[`${family}_LOCATION_RATE_LIMITER`]=limiter(family+'-location');}
 const router=createConsolidatedRouter(handlers);
 const run=(path:string,init:RequestInit={})=>router(new Request(origin+path,init),env,'192.0.2.1');
 assert.equal((await run('/v1/me',{headers:{authorization:'Bearer '+ 'a'.repeat(32)}})).status,200);
 assert.equal((await run('/v1/me',{headers:{origin,authorization:'Bearer '+ 'a'.repeat(32)}})).status,403);
 for(const path of ['/v1/page-sessions/exchange','/v1/editor-sessions/exchange']) {
  assert.equal((await run(path,{method:'POST',headers:{origin,'content-type':'application/json',authorization:'Bearer '+ 'a'.repeat(32)},body:'{}'})).status,403);
  assert.equal((await run(path,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({origin:'https://evil.example.test'})})).status,400);
  assert.equal((await run(path,{method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'})).status,200);
 }
 assert.deepEqual(calls,['management','recipient','editor']);
 assert.equal((await run('/v1/unknown')).status,404);
 assert.equal(await (await run('/candidate.html')).text(),'page');
 assert.ok(['MANAGEMENT','RECIPIENT','EDITOR'].every(f=>keys.includes(f+':192.0.2.1') && keys.includes(f+'-location:gateway-location-budget')));
});

test('consolidated worker serves only verified assets worker-first and reaches candidate handlers', {timeout:60000}, async()=>{
 const {spawnSync}=await import('node:child_process');
 const {mkdtemp,readFile,writeFile,rm,realpath}=await import('node:fs/promises');
 const {join}=await import('node:path'); const {tmpdir}=await import('node:os'); const {Miniflare}=await import('miniflare');
 const dir=await mkdtemp(join(await realpath(tmpdir()),'consolidated-')); let mf:InstanceType<typeof Miniflare>|undefined;
 try {
  const output=join(dir,'build'); const build=spawnSync(process.execPath,['scripts/build-candidate-assets.ts',output],{encoding:'utf8',env:{...process.env,VITE_CANDIDATE_GATEWAY_ORIGIN:origin,VITE_CANDIDATE_EDITOR_GATEWAY_ORIGIN:origin}}); assert.equal(build.status,0,build.stderr);
  await writeFile(join(output,'client','unlisted.html'),'unlisted');
  const opts={modules:true,script:await readFile(join(output,'consolidated-worker.mjs'),'utf8'),compatibilityDate:'2026-01-01',assets:{directory:join(output,'client'),binding:'ASSETS',routerConfig:{invoke_user_worker_ahead_of_assets:true,has_user_worker:true}},bindings:{HOST_ENABLED:'true',RECIPIENT_GATEWAY_ORIGIN:origin,EDITOR_GATEWAY_ORIGIN:origin,MANAGEMENT_GATEWAY_ENABLED:'true',RECIPIENT_GATEWAY_ENABLED:'true',EDITOR_GATEWAY_ENABLED:'true',TRUSTED_RECIPIENT_ORIGINS:origin,TRUSTED_EDITOR_ORIGINS:origin},ratelimits:Object.fromEntries(['MANAGEMENT','RECIPIENT','EDITOR'].flatMap((name,i)=>[[name+'_RATE_LIMITER',{namespace_id:String(9000+i*2),simple:{limit:100,period:60 as const}}],[name+'_LOCATION_RATE_LIMITER',{namespace_id:String(9001+i*2),simple:{limit:100,period:60 as const}}]]))};
  mf=new Miniflare(opts);
  const fetch=(path:string,init:RequestInit={})=>mf!.dispatchFetch(origin+path,{...init,headers:{'cf-connecting-ip':'192.0.2.1',...init.headers}} as any);
  const page=await fetch('/candidate.html'); assert.equal(page.status,200); assert.match(page.headers.get('content-security-policy')!,/frame-ancestors 'none'/); assert.equal(page.headers.get('cache-control'),'no-store');
  assert.equal((await fetch('/unlisted.html')).status,404); assert.equal((await fetch('/candidate.html?x=1')).status,404);
  assert.equal((await fetch('/v1/me',{headers:{authorization:'Bearer '+ 'a'.repeat(32)}})).status,503); // candidate handler has no DB
  assert.equal((await fetch('/v1/editor-sessions/exchange',{method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'})).status,503);
  assert.equal((await fetch('/v1/page-sessions/exchange',{method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'})).status,400);
  assert.equal((await mf.dispatchFetch('https://alternate.example.test/candidate.html')).status,503);
  await mf.dispose(); mf=undefined;
  await writeFile(join(output,'client','candidate.html'),'changed');
  mf=new Miniflare(opts); assert.equal((await mf.dispatchFetch(origin+'/candidate.html')).status,503);
 } finally {await mf?.dispose();await rm(dir,{recursive:true,force:true});}
});

test('consolidated preflights and limiter failures never dispatch',async()=>{
 let dispatched=0; const handler=async()=>{dispatched++;return new Response();};
 const router=createConsolidatedRouter({management:handler,recipient:handler,editor:handler,page:handler});
 const ok={limit:async()=>({success:true})};
 const env:any={RECIPIENT_GATEWAY_ENABLED:'true',TRUSTED_RECIPIENT_ORIGINS:origin,RECIPIENT_RATE_LIMITER:ok,RECIPIENT_LOCATION_RATE_LIMITER:ok};
 const request=(headers:Record<string,string>)=>new Request(origin+'/v1/otp/send',{method:'OPTIONS',headers:{origin,'access-control-request-method':'POST',...headers}});
 assert.equal((await router(request({'access-control-request-headers':'authorization'}),env,'192.0.2.1')).status,403);
 assert.equal((await router(request({origin:'https://evil.example.test'}),env,'192.0.2.1')).status,403);
 assert.equal((await router(request({}),{...env,RECIPIENT_LOCATION_RATE_LIMITER:{limit:async()=>({success:false})}},'192.0.2.1')).status,429);
 assert.equal((await router(request({}),{...env,RECIPIENT_RATE_LIMITER:{limit:async()=>{throw Error();}}},'192.0.2.1')).status,503);
 assert.equal((await router(request({}),{...env,TRUSTED_RECIPIENT_ORIGINS:origin+'/'},'192.0.2.1')).status,503);
 assert.equal((await router(request({}),env,null)).status,503);
 assert.equal(dispatched,0);
});

test('readiness is default closed, suppresses other gateways, and leaves explicitly enabled management unchanged',async()=>{
 const calls:string[]=[]; const keys:string[]=[];
 const handler=(name:string)=>async()=>{calls.push(name);return new Response(name);};
 const router=createConsolidatedRouter({management:handler('management'),recipient:handler('recipient'),editor:handler('editor'),page:handler('page')});
 const limiter=(name:string)=>({limit:async()=>{keys.push(name);return {success:true};}});
 const env={MANAGEMENT_RATE_LIMITER:limiter('ip'),MANAGEMENT_LOCATION_RATE_LIMITER:limiter('location'),RECIPIENT_GATEWAY_ENABLED:'true',EDITOR_GATEWAY_ENABLED:'true'};
 const request=(path:string,method='GET')=>new Request(origin+path,{method,headers:{authorization:'Bearer '+ 'a'.repeat(32)}});
 assert.equal((await router(request('/v1/me'),env,'192.0.2.1')).status,503);
 const ready={...env,MANAGEMENT_READINESS_ENABLED:'true'};
 assert.equal((await router(request('/v1/me'),ready,'192.0.2.1')).status,200);
 assert.deepEqual(keys,['location','ip']);
 for(const path of ['/v1/editor-sessions','/v1/page-sessions/exchange','/v1/otp/send','/v1/editor-sessions/exchange','/v1/templates']) assert.equal((await router(request(path,'POST'),ready,'192.0.2.1')).status,404);
 assert.equal((await router(request('/v1/me'),ready,null)).status,503);
 assert.equal((await router(request('/v1/me'),{...ready,MANAGEMENT_RATE_LIMITER:{limit:async()=>({success:false})}},'192.0.2.1')).status,429);
 assert.equal((await router(request('/v1/me'),{...ready,MANAGEMENT_LOCATION_RATE_LIMITER:{limit:async()=>{throw Error();}}},'192.0.2.1')).status,503);
 assert.equal((await router(request('/v1/editor-sessions','POST'),{...ready,MANAGEMENT_GATEWAY_ENABLED:'true'},'192.0.2.1')).status,415);
 assert.deepEqual(calls,['management']);
});

 test('readiness handles observable queries and normalized path aliases',async()=>{
 const calls:string[]=[]; const handler=(name:string)=>async(request:Request)=>{calls.push(name+':'+new URL(request.url).pathname);return new Response(name);};
 const router=createConsolidatedRouter({management:handler('management'),recipient:handler('recipient'),editor:handler('editor'),page:handler('page')});
 const ok={limit:async()=>({success:true})};
 const env={MANAGEMENT_READINESS_ENABLED:'true',MANAGEMENT_RATE_LIMITER:ok,MANAGEMENT_LOCATION_RATE_LIMITER:ok,RECIPIENT_GATEWAY_ENABLED:'true',EDITOR_GATEWAY_ENABLED:'true'};
 const run=(path:string,method='GET')=>router(new Request(origin+path,{method,headers:{authorization:'Bearer '+ 'a'.repeat(32)}}),env,'192.0.2.1');
 assert.equal((await run('/v1/me?')).status,404);
 assert.equal((await run('/v1/me?x=1')).status,404);
 for(const path of ['/v1/x/../me','/v1/%2e%2e/v1/me']) assert.equal((await run(path)).status,200);
 for(const path of ['/v1/x/../editor-sessions','/v1/x/../otp/send','/v1/me/../templates']) assert.equal((await run(path,'POST')).status,404);
 assert.deepEqual(calls,['management:/v1/me','management:/v1/me']);
 });
