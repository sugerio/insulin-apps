import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CandidateBrowserClient, takeCandidateCode} from '../ui/candidate-client.ts';

test('candidate fragment is removed and only a single code is accepted',()=>{
 let replaced=''; const loc={origin:'https://page.example.test',pathname:'/candidate.html',search:'',hash:'#code='+ 'a'.repeat(64)};
 assert.equal(takeCandidateCode(loc, {replaceState:(_a:unknown,_b:string,url?:string|URL|null)=>{replaced=String(url);}}), 'a'.repeat(64));
 assert.equal(replaced,'/candidate.html');
 assert.equal(takeCandidateCode({...loc,hash:'#code=x&code=y'}, {replaceState(){}}),null);
 assert.equal(takeCandidateCode({...loc,search:'?code=x'}, {replaceState(){}}),null);
});

test('candidate client rejects unsafe origins and sends only JSON without credentials',async()=>{
 assert.throws(()=>new CandidateBrowserClient('http://gateway.example.test','https://page.example.test',fetch));
 assert.throws(()=>new CandidateBrowserClient('https://gateway.example.test/path','https://page.example.test',fetch));
 const calls:Request[]=[]; const client=new CandidateBrowserClient('https://gateway.example.test','https://page.example.test',async(input,init)=>{calls.push(new Request(input,init));return Response.json({token:'b'.repeat(64)});});
 await client.exchange('a'.repeat(64)); await client.request('/v1/fields',{});
 assert.equal(calls[1].credentials,'omit');assert.equal(calls[1].redirect,'error');assert.equal(calls[1].headers.has('authorization'),false);assert.deepEqual(await calls[1].json(),{token:'b'.repeat(64)});
});

test('candidate JSON client interoperates with synthetic recipient gateway routes',async()=>{
 const {fetchRecipientGateway}=await import('../src/recipient-gateway.ts');
 const calls:{path:string;body:any}[]=[];
 const env={RECIPIENT_GATEWAY_ENABLED:'true',TRUSTED_RECIPIENT_ORIGINS:'https://page.example.test',LOCATION_RATE_LIMITER:{async limit(){return {success:true};}},RATE_LIMITER:{async limit(){return {success:true};}},PRIVATE_RECIPIENT:{async fetch(request:Request){const path=new URL(request.url).pathname,body=await request.json();calls.push({path,body});if(path.endsWith('/exchange'))return Response.json({token:'b'.repeat(64)});if(path==='/v1/sign')return Response.json({status:'PENDING',signatureId:'synthetic'},{status:202});return Response.json({ok:true});}}};
 const client=new CandidateBrowserClient('https://gateway.example.test','https://page.example.test',async(input,init)=>{const headers=new Headers(init?.headers);headers.set('origin','https://page.example.test');return fetchRecipientGateway(new Request(input,{...init,headers}),env,'192.0.2.1');});
 await client.exchange('a'.repeat(64));
 for(const [path,body] of [['/v1/otp/send',{}],['/v1/otp/verify',{otp:'123456'}],['/v1/document',{}],['/v1/fields',{}],['/v1/preview',{fieldId:'sig',text:'Ana'}]] as const) await client.request(path,body);
 const signed=await client.request('/v1/sign',{artifactId:'d0',consent:true,idempotencyKey:'synthetic-123',values:{sig:'Ana'}});
 assert.equal(signed.status,202);assert.equal((await signed.json() as any).status,'PENDING');
 assert.ok(calls.every(call=>call.body.origin==='https://page.example.test'));assert.equal(calls.at(-1)?.body.token,'b'.repeat(64));
});
