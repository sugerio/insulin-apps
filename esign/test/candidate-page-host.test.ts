import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCandidatePageHost} from '../src/candidate-page-host.ts';

test('candidate page host is disabled by default, exact, and verifies every asset',async()=>{
 const html=new TextEncoder().encode('<html>safe</html>');
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',html)),x=>x.toString(16).padStart(2,'0')).join('');
 const host=createCandidatePageHost({recipientOrigin:'https://recipient.example.test',editorOrigin:'https://editor.example.test',files:{'/candidate.html':{sha256:hash,length:html.length,type:'text/html; charset=utf-8'},'/assets/app-123.js':{sha256:hash,length:html.length,type:'text/javascript; charset=utf-8'}}});
 let bytes=html;let calls=0;
 const assets={fetch:async()=>{calls++;return new Response(bytes)}};
 const env={ASSETS:assets,HOST_ENABLED:'true',RECIPIENT_GATEWAY_ORIGIN:'https://recipient.example.test',EDITOR_GATEWAY_ORIGIN:'https://editor.example.test'};
 const req=(path:string,method='GET')=>new Request('https://pages.example.test'+path,{method});
 assert.equal((await host.fetch(req('/candidate.html'),{...env,HOST_ENABLED:''})).status,404);
 for(const path of ['/','/index.html','/demo.html','/assets/other.js','/candidate.html/','/%63andidate.html']) assert.equal((await host.fetch(req(path),env)).status,404,path);
 assert.equal(calls,0);
 assert.equal((await host.fetch(req('/candidate.html'),{...env,RECIPIENT_GATEWAY_ORIGIN:'https://evil.example.test'})).status,503);
 const page=await host.fetch(req('/candidate.html'),env);assert.equal(page.status,200);assert.equal(page.headers.get('cache-control'),'no-store');assert.equal(page.headers.get('referrer-policy'),'no-referrer');assert.equal(page.headers.get('x-content-type-options'),'nosniff');assert.match(page.headers.get('content-security-policy')!,/frame-ancestors 'none'/);assert.match(page.headers.get('content-security-policy')!,/connect-src https:\/\/recipient\.example\.test https:\/\/editor\.example\.test/);
 assert.equal((await host.fetch(req('/assets/app-123.js'),env)).headers.get('cache-control'),'public, max-age=31536000, immutable');
 bytes=new TextEncoder().encode('tampered');assert.equal((await host.fetch(req('/candidate.html'),env)).status,503);assert.equal((await host.fetch(req('/assets/app-123.js'),env)).status,503);
 assert.equal((await host.fetch(req('/candidate.html','POST'),env)).status,404);
});

test('candidate page host bounds streamed assets and rejects length and hash mismatches',async()=>{
 const bytes=new TextEncoder().encode('valid');
 const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
 const host=createCandidatePageHost({recipientOrigin:'https://recipient.example.test',editorOrigin:'https://editor.example.test',files:{'/candidate.html':{sha256,length:bytes.length,type:'text/html'}}});
 const request=new Request('https://pages.example.test/candidate.html');
 let cancelled=false;let pulls=0;
 const env={HOST_ENABLED:'true',RECIPIENT_GATEWAY_ORIGIN:'https://recipient.example.test',EDITOR_GATEWAY_ORIGIN:'https://editor.example.test',ASSETS:{fetch:async()=>new Response(new ReadableStream({pull(c){pulls++;c.enqueue(new Uint8Array(6));},cancel(){cancelled=true;}},{highWaterMark:0}))}};
 assert.equal((await host.fetch(request,env)).status,503);assert.equal(cancelled,true);assert.equal(pulls,1);
 for(const body of ['tiny','wrong','valid!']) assert.equal((await host.fetch(request,{...env,ASSETS:{fetch:async()=>new Response(body)}})).status,503,body);
 assert.equal((await host.fetch(request,{...env,ASSETS:{fetch:async()=>new Response(bytes)}})).status,200);
});

test('candidate page host rejects excessive fragmented asset streams',async()=>{
 const bytes=new TextEncoder().encode('valid');
 const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
 const host=createCandidatePageHost({recipientOrigin:'https://recipient.example.test',editorOrigin:'https://editor.example.test',files:{'/candidate.html':{sha256,length:bytes.length,type:'text/html'}}});
 let cancelled=false;let count=0;
 const env={HOST_ENABLED:'true',RECIPIENT_GATEWAY_ORIGIN:'https://recipient.example.test',EDITOR_GATEWAY_ORIGIN:'https://editor.example.test',ASSETS:{fetch:async()=>new Response(new ReadableStream({pull(c){if(++count<=66000)c.enqueue(new Uint8Array());else {c.enqueue(bytes);c.close();}},cancel(){cancelled=true;}},{highWaterMark:0}))}};
 assert.equal((await host.fetch(new Request('https://pages.example.test/candidate.html'),env)).status,503);assert.equal(cancelled,true);
});

test('candidate asset binding receives no request credentials or query',async()=>{
 const bytes=new TextEncoder().encode('valid');
 const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
 const host=createCandidatePageHost({recipientOrigin:'https://recipient.example.test',editorOrigin:'https://editor.example.test',files:{'/candidate.html':{sha256,length:bytes.length,type:'text/html'}}});
 let forwarded:Request|undefined;
 const env={HOST_ENABLED:'true',RECIPIENT_GATEWAY_ORIGIN:'https://recipient.example.test',EDITOR_GATEWAY_ORIGIN:'https://editor.example.test',ASSETS:{fetch:async(request:Request)=>{forwarded=request;return new Response(bytes);}}};
 const response=await host.fetch(new Request('https://pages.example.test/candidate.html',{headers:{cookie:'session=secret',authorization:'Bearer secret',referer:'https://example.test/?code=secret'}}),env);
 assert.equal(response.status,200);assert.equal(forwarded!.url,'https://pages.example.test/candidate.html');assert.deepEqual([...forwarded!.headers],[]);
});

test('candidate page host cancels stalled asset reader at its deadline',{timeout:15000},async()=>{
 const host=createCandidatePageHost({recipientOrigin:'https://recipient.example.test',editorOrigin:'https://editor.example.test',files:{'/candidate.html':{sha256:'',length:1,type:'text/html'}}});
 let cancelled=false;
 const env={HOST_ENABLED:'true',RECIPIENT_GATEWAY_ORIGIN:'https://recipient.example.test',EDITOR_GATEWAY_ORIGIN:'https://editor.example.test',ASSETS:{fetch:async()=>new Response(new ReadableStream({pull(){return new Promise<void>(()=>{});},cancel(){cancelled=true;}}))}};
 assert.equal((await host.fetch(new Request('https://pages.example.test/candidate.html'),env)).status,503);assert.equal(cancelled,true);
});

test('candidate page host times out a stalled binding and cancels a late response without awaiting cancellation',{timeout:15000},async()=>{
 const host=createCandidatePageHost({recipientOrigin:'https://recipient.example.test',editorOrigin:'https://editor.example.test',files:{'/candidate.html':{sha256:'',length:1,type:'text/html'}}});
 let resolveFetch!:(response:Response)=>void;let cancelled=false;
 const env={HOST_ENABLED:'true',RECIPIENT_GATEWAY_ORIGIN:'https://recipient.example.test',EDITOR_GATEWAY_ORIGIN:'https://editor.example.test',ASSETS:{fetch:()=>new Promise<Response>(resolve=>{resolveFetch=resolve;})}};
 assert.equal((await host.fetch(new Request('https://pages.example.test/candidate.html'),env)).status,503);
 resolveFetch(new Response(new ReadableStream({cancel(){cancelled=true;return Promise.reject(Error('cancel failed'));}})));
 await new Promise(resolve=>setTimeout(resolve,20));assert.equal(cancelled,true);
});

test('candidate page host cancels rejected asset response bodies',async()=>{
 const host=createCandidatePageHost({recipientOrigin:'https://recipient.example.test',editorOrigin:'https://editor.example.test',files:{'/candidate.html':{sha256:'',length:1,type:'text/html'}}});
 let cancelled=false;
 const env={HOST_ENABLED:'true',RECIPIENT_GATEWAY_ORIGIN:'https://recipient.example.test',EDITOR_GATEWAY_ORIGIN:'https://editor.example.test',ASSETS:{fetch:async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{status:404})}};
 assert.equal((await host.fetch(new Request('https://pages.example.test/candidate.html'),env)).status,503);assert.equal(cancelled,true);
});

test('candidate page host uses one deadline across binding fetch and body',{timeout:15000},async()=>{
 const host=createCandidatePageHost({recipientOrigin:'https://recipient.example.test',editorOrigin:'https://editor.example.test',files:{'/candidate.html':{sha256:'',length:1,type:'text/html'}}});
 let cancelled=false;const start=Date.now();
 const env={HOST_ENABLED:'true',RECIPIENT_GATEWAY_ORIGIN:'https://recipient.example.test',EDITOR_GATEWAY_ORIGIN:'https://editor.example.test',ASSETS:{fetch:async()=>{await new Promise(resolve=>setTimeout(resolve,6000));return new Response(new ReadableStream({pull(){return new Promise<void>(()=>{});},cancel(){cancelled=true;}}));}}};
 assert.equal((await host.fetch(new Request('https://pages.example.test/candidate.html'),env)).status,503);assert.equal(cancelled,true);assert.ok(Date.now()-start<14000);
});

test('candidate page host handles a binding rejection after its deadline',{timeout:15000},async()=>{
 const host=createCandidatePageHost({recipientOrigin:'https://recipient.example.test',editorOrigin:'https://editor.example.test',files:{'/candidate.html':{sha256:'',length:1,type:'text/html'}}});
 let rejectFetch!:(error:Error)=>void;
 const env={HOST_ENABLED:'true',RECIPIENT_GATEWAY_ORIGIN:'https://recipient.example.test',EDITOR_GATEWAY_ORIGIN:'https://editor.example.test',ASSETS:{fetch:()=>new Promise<Response>((_,reject)=>{rejectFetch=reject;})}};
 assert.equal((await host.fetch(new Request('https://pages.example.test/candidate.html'),env)).status,503);
 rejectFetch(Error('late binding failure'));await new Promise(resolve=>setTimeout(resolve,20));
});
