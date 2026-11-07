import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const module=await import('../src/worker-tsa-transport.ts').catch(()=>({}));

test('unmounted TSA adapter transmits only explicitly authorized synthetic digest and never asserts trust',async()=>{
 assert.equal(typeof module.requestAuthorizedSyntheticTimestamp,'function');
 const digest=new Uint8Array(createHash('sha256').update('synthetic fixture one').digest());let sent=0,observed:Uint8Array|undefined;
 const config={endpoint:'https://tsa.example.test/rfc3161',allowedEndpoints:['https://tsa.example.test/rfc3161'],timeoutMs:100,
  authorizeSynthetic:async (endpoint:string,imprint:Uint8Array)=>endpoint==='https://tsa.example.test/rfc3161'&&Buffer.from(imprint).equals(Buffer.from(digest)),
  fetch:async(request:Request)=>{sent++;assert.equal(request.url,'https://tsa.example.test/rfc3161');assert.equal(request.redirect,'manual');assert.equal(request.headers.get('content-type'),'application/timestamp-query');observed=new Uint8Array(await request.arrayBuffer());return new Response(new Uint8Array([0x30,0]),{headers:{'content-type':'application/timestamp-reply'}});}};
 const result=await module.requestAuthorizedSyntheticTimestamp!(digest,config);
 assert.equal(result.status,'UNVERIFIED');assert.deepEqual(result.imprint,digest);assert.equal(result.nonce.length,16);assert.ok(Buffer.from(observed!).includes(Buffer.from(digest)));assert.equal(sent,1);
 const other=new Uint8Array(createHash('sha256').update('synthetic fixture two').digest());await assert.rejects(()=>module.requestAuthorizedSyntheticTimestamp!(other,config));
 await assert.rejects(()=>module.requestAuthorizedSyntheticTimestamp!(digest,{...config,allowedEndpoints:[]}));
 await assert.rejects(()=>module.requestAuthorizedSyntheticTimestamp!(digest,{...config,endpoint:'http://tsa.example.test/rfc3161',allowedEndpoints:['http://tsa.example.test/rfc3161']}));
 await assert.rejects(()=>module.requestAuthorizedSyntheticTimestamp!(digest,{...config,authorizeSynthetic:async()=>false}));
 class ForgedBuffer extends Uint8Array {override get buffer():ArrayBuffer{return new ArrayBuffer(32);}}
 await assert.rejects(()=>module.requestAuthorizedSyntheticTimestamp!(new ForgedBuffer(new SharedArrayBuffer(32)),config));
 assert.equal(sent,1);
 await assert.rejects(()=>module.requestAuthorizedSyntheticTimestamp!(digest,{...config,fetch:async()=>new Response(null,{status:302,headers:{location:'https://other.example.test'}})}));
 await assert.rejects(()=>module.requestAuthorizedSyntheticTimestamp!(digest,{...config,fetch:async()=>new Response(new Uint8Array(65537),{headers:{'content-type':'application/timestamp-reply'}})}));
 await assert.rejects(()=>module.requestAuthorizedSyntheticTimestamp!(digest,{...config,timeoutMs:5,fetch:async()=>new Promise<Response>(()=>{})}),/timeout/i);
});

test('synthetic request is parseable by OpenSSL and binds the returned imprint and nonce',async()=>{
 const {execFileSync}=await import('node:child_process');
 const digest=new Uint8Array(32).fill(0x2a);let query:Uint8Array|undefined;
 const config={endpoint:'https://tsa.example.test/rfc3161',allowedEndpoints:['https://tsa.example.test/rfc3161'],timeoutMs:1000,authorizeSynthetic:async(_endpoint:string,value:Uint8Array)=>{value.fill(0);return true;},fetch:async(request:Request)=>{query=new Uint8Array(await request.arrayBuffer());return new Response('synthetic',{headers:{'content-type':'application/timestamp-reply'}});}};
 const pending=module.requestAuthorizedSyntheticTimestamp!(digest,config);digest.fill(0);
 const result=await pending,output=execFileSync('openssl',['ts','-query','-text','-in','/dev/stdin'],{input:query,stdio:['pipe','pipe','pipe']}).toString();
 assert.match(output,/Hash Algorithm: sha256/);assert.match(output,/Certificate required: yes/);assert.ok(output.includes(Buffer.from(result.nonce).toString('hex').toUpperCase()));assert.ok(Buffer.from(query!).includes(Buffer.alloc(32,0x2a)));assert.deepEqual(result.imprint,new Uint8Array(32).fill(0x2a));
});

test('timed-out authorization cannot send a late request',async()=>{
 let approve!:(v:boolean)=>void,sent=0;const approval=new Promise<boolean>(r=>approve=r);
 const config={endpoint:'https://tsa.example.test/rfc3161',allowedEndpoints:['https://tsa.example.test/rfc3161'],timeoutMs:5,authorizeSynthetic:async()=>approval,fetch:async()=>{sent++;return new Response('x');}};
 await assert.rejects(()=>module.requestAuthorizedSyntheticTimestamp!(new Uint8Array(32),config),/timeout/i);approve(true);await new Promise(r=>setTimeout(r,10));assert.equal(sent,0);
});

test('TSA synthetic transport runs in workerd with injected fetch only',async()=>{
 const {build}=await import('esbuild');const {Miniflare}=await import('miniflare');
 const source=`import {requestAuthorizedSyntheticTimestamp} from './src/worker-tsa-transport.ts'; export default {async fetch(){const result=await requestAuthorizedSyntheticTimestamp(new Uint8Array(32).fill(7),{endpoint:'https://tsa.example.test/rfc3161',allowedEndpoints:['https://tsa.example.test/rfc3161'],timeoutMs:1000,authorizeSynthetic:async()=>true,fetch:async r=>new Response(new Uint8Array([48,0]),{headers:{'content-type':'application/timestamp-reply'}})});return Response.json({status:result.status,length:result.response.length,nonce:result.nonce.length});}}`;
 const built=await build({stdin:{contents:source,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser'});
 const mf=new Miniflare({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-01-01'});
 try{const response=await mf.dispatchFetch('https://local.test/');assert.equal(response.status,200);assert.deepEqual(await response.json(),{status:'UNVERIFIED',length:2,nonce:16});}finally{await mf.dispose();}
});
