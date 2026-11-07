import {test} from 'node:test';
import assert from 'node:assert/strict';
import {withLocalTestOtp} from '../scripts/local-otp-display.ts';

const id='12345678-1234-4123-8123-123456789abc';
test('Node local mailbox display only decorates a successful matching OTP response',async()=>{
 const reads:string[]=[];
 const mailbox={get:async(key:string)=>{reads.push(key);return {json:async()=>({to:'ana@example.com',otp:'012345'})};}};
 const result=await withLocalTestOtp(new Response(JSON.stringify({messageId:id}),{status:202,headers:{'access-control-allow-origin':'http://127.0.0.1:5173'}}),mailbox);
 assert.deepEqual(await result.json(),{messageId:id,testOtp:'012345'});assert.equal(result.headers.get('cache-control'),'no-store');assert.equal(result.headers.get('access-control-allow-origin'),'http://127.0.0.1:5173');assert.deepEqual(reads,[`test-mail/${id}.json`]);
 const denied=await withLocalTestOtp(new Response('{"error":"otp_unavailable"}',{status:429}),mailbox);assert.equal(denied.status,429);assert.equal(reads.length,1);
 for(const body of [{messageId:'../secret'},{messageId:id,testOtp:'bad'},{}]) {const response=await withLocalTestOtp(Response.json(body,{status:202}),mailbox);assert.equal(response.status,503);}
 const bad=await withLocalTestOtp(Response.json({messageId:id},{status:202}),{get:async()=>({json:async()=>({otp:'bad'})})});assert.equal(bad.status,503);
});
