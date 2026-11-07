import { test } from 'node:test';
import assert from 'node:assert/strict';
const candidate=await import('../src/worker-tsa-synthetic-transport.ts').catch(()=>({}));

test('synthetic TSA transport requires explicit HTTPS endpoint and returns unverified bytes only', async()=>{
  assert.equal(typeof candidate.requestSyntheticTimestamp,'function');
  let count=0;
  const fetcher=async (request:Request)=>{count++;assert.equal(request.url,'https://tsa.example.test/rfc3161');assert.equal(request.method,'POST');assert.equal(request.redirect,'manual');assert.equal(request.headers.get('content-type'),'application/timestamp-query');assert.ok((await request.arrayBuffer()).byteLength>40);return new Response(new Uint8Array([0x30,0]),{headers:{'content-type':'application/timestamp-reply'}});};
  const options={endpoint:'https://tsa.example.test/rfc3161',allowedEndpoints:['https://tsa.example.test/rfc3161'],fetch:fetcher,timeoutMs:1000};
  const result=await candidate.requestSyntheticTimestamp!(options);
  assert.equal(result.status,'UNVERIFIED_SYNTHETIC_RESPONSE');assert.equal(result.response.length,2);assert.equal(result.imprint.length,32);assert.equal(count,1);
  await assert.rejects(()=>candidate.requestSyntheticTimestamp!({...options,allowedEndpoints:[]}));
  await assert.rejects(()=>candidate.requestSyntheticTimestamp!({...options,endpoint:'http://tsa.example.test/rfc3161',allowedEndpoints:['http://tsa.example.test/rfc3161']}));
  assert.equal(count,1);
  await assert.rejects(()=>candidate.requestSyntheticTimestamp!({...options,fetch:async()=>new Response(null,{status:302,headers:{location:'https://other.example.test'}})}));
  await assert.rejects(()=>candidate.requestSyntheticTimestamp!({...options,fetch:async()=>new Response(new Uint8Array(65537),{headers:{'content-type':'application/timestamp-reply'}})}));
  await assert.rejects(()=>candidate.requestSyntheticTimestamp!({...options,timeoutMs:5,fetch:async()=>new Promise<Response>(()=>{})}),/timeout/i);
});
