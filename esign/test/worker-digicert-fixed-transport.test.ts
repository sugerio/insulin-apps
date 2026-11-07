import {test} from 'node:test';
import assert from 'node:assert/strict';
import {requestFixedDigiCertTimestamp} from '../src/worker-digicert-fixed-transport.ts';

test('fixed DigiCert transport sends only its synthetic fixture and returns unverified bytes', async()=>{
 let calls=0; let query:Uint8Array|undefined;
 const fetcher=async(request:Request)=>{calls++; assert.equal(request.url,'http://timestamp.digicert.com/'); assert.equal(request.method,'POST'); assert.equal(request.redirect,'manual'); assert.equal(request.headers.get('content-type'),'application/timestamp-query'); query=new Uint8Array(await request.arrayBuffer()); return new Response(new Uint8Array([1,2]),{headers:{'content-type':'application/timestamp-reply'}});};
 await assert.rejects(()=>requestFixedDigiCertTimestamp({fetch:fetcher})); assert.equal(calls,0);
 const result=await requestFixedDigiCertTimestamp({enabled:true,fetch:fetcher});
 assert.equal(result.status,'UNVERIFIED'); assert.deepEqual(result.response,new Uint8Array([1,2])); assert.deepEqual(result.query,query);
 const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('esign fixed synthetic DigiCert connectivity test v1\n')));
 assert.deepEqual(query!.slice(24,56),digest);
});

test('substitute endpoint, fixture, digest and fetch omissions cannot influence the request',async()=>{
 let calls=0; const fetcher=async(request:Request)=>{calls++; const bytes=new Uint8Array(await request.arrayBuffer()); assert.notDeepEqual(bytes.slice(24,56),new Uint8Array(32).fill(7)); return new Response(new Uint8Array([1]),{headers:{'content-type':'application/timestamp-reply'}});};
 for(const extra of [{endpoint:'http://example.test/'},{digest:new Uint8Array(32).fill(7)},{fixture:'arbitrary'},{timeoutMs:1}]) await assert.rejects(()=>requestFixedDigiCertTimestamp({enabled:true,fetch:fetcher,...extra}));
 await assert.rejects(()=>requestFixedDigiCertTimestamp({enabled:true} as never)); assert.equal(calls,0);
});

test('redirect, bad response, oversized and lost responses fail closed',async()=>{
 for(const response of [new Response(null,{status:302,headers:{location:'http://example.test/'}}),new Response('bad',{headers:{'content-type':'text/plain'}}),new Response(new Uint8Array(65537),{headers:{'content-type':'application/timestamp-reply'}})]) await assert.rejects(()=>requestFixedDigiCertTimestamp({enabled:true,fetch:async()=>response}));
 await assert.rejects(()=>requestFixedDigiCertTimestamp({enabled:true,fetch:async()=>{throw new Error('lost response');}}));
});

test('deadline aborts a lost response and cancels a late response body',async()=>{
 let resolve!:(response:Response)=>void; let signal:AbortSignal|undefined; let cancelled=false;
 const pending=requestFixedDigiCertTimestamp({enabled:true,fetch:async request=>{signal=request.signal; return new Promise<Response>(r=>{resolve=r;});}});
 await assert.rejects(pending,/timeout/i); assert.equal(signal?.aborted,true);
 resolve(new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'application/timestamp-reply'}}));
 await new Promise(r=>setTimeout(r,20)); assert.equal(cancelled,true);
});

test('fixed transport runs in local workerd with injected fetch only',async()=>{
 const {build}=await import('esbuild'); const {Miniflare}=await import('miniflare');
 const bundle=await build({stdin:{contents:`import {requestFixedDigiCertTimestamp} from './src/worker-digicert-fixed-transport.ts'; export default {async fetch(){let called=0;const result=await requestFixedDigiCertTimestamp({enabled:true,fetch:async request=>{called++;if(request.url!=='http://timestamp.digicert.com/'||request.redirect!=='manual')throw Error('request');return new Response(new Uint8Array([1]),{headers:{'content-type':'application/timestamp-reply'}})}});return Response.json({status:result.status,called});}}`,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser'});
 const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2025-01-01'});
 try {const response=await mf.dispatchFetch('http://worker.test/'); const body=await response.text(); assert.equal(response.status,200,body); assert.deepEqual(JSON.parse(body),{status:'UNVERIFIED',called:1});} finally {await mf.dispose();}
});
