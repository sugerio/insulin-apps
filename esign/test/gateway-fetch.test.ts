// E-sign reaches the gateway's mail relay over the SUGER_GATEWAY service binding the deploy gives it: a Worker can't
// fetch another Worker of the same zone through its public URL. Nitro on Workers puts the env on the request.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gatewayFetchOf} from '../src/app/server/gateway-fetch.ts';
import {otpMailer} from '../src/app/server/esign/mail.ts';

const withEnv=(env:Record<string,unknown>|undefined)=>Object.assign(new Request('https://esign.example.com/api/public/signing/otp',{method:'POST'}),env===undefined?{}:{runtime:{name:'cloudflare',cloudflare:{env}}});

test('the gateway binding\'s fetch, called on the binding, when the runtime attached one',async()=>{
 const seen:{self:unknown;url:string;method:string;headers:Headers;body:string}[]=[];
 const binding={async fetch(this:unknown,input:RequestInfo|URL,init?:RequestInit){const request=new Request(input,init);seen.push({self:this,url:request.url,method:request.method,headers:request.headers,body:await request.text()});return new Response('{"status":"sent"}',{status:202});}};
 const viaGateway=gatewayFetchOf(withEnv({SUGER_GATEWAY:binding,DB:{}}));
 assert.equal(typeof viaGateway,'function');
 // The relay keeps its URL (the gateway routes by it); only the transport is the binding.
 const mailer=otpMailer({ESIGN_ENV:'prod',SUGER_MAIL_URL:'https://apps.example.com/__insulin/mail',SUGER_APP_TOKEN:'app-token',MAIL_FETCH:viaGateway},'org-1');
 assert.ok(mailer);
 await mailer.send('ana@example.com','123456');
 assert.equal(seen.length,1);
 assert.equal(seen[0]!.self,binding,'called as the binding\'s method');
 assert.equal(seen[0]!.url,'https://apps.example.com/__insulin/mail');
 assert.equal(seen[0]!.method,'POST');
 assert.equal(seen[0]!.headers.get('authorization'),'Bearer app-token');
 assert.equal(seen[0]!.headers.get('x-suger-organization-id'),'org-1');
 assert.equal(JSON.parse(seen[0]!.body).to,'ana@example.com');
});

test('no binding means the global fetch: the local preview and tests',()=>{
 assert.equal(gatewayFetchOf(withEnv(undefined)),undefined);
 assert.equal(gatewayFetchOf(withEnv({})),undefined);
 assert.equal(gatewayFetchOf(withEnv({SUGER_GATEWAY:'https://apps.example.com'})),undefined,'a variable is not a binding');
 assert.equal(gatewayFetchOf(withEnv({SUGER_GATEWAY:{}})),undefined);
});
