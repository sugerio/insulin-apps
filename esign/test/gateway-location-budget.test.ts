import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fetchManagementGateway} from '../src/management-gateway.ts';
import {fetchEditorGateway} from '../src/editor-gateway.ts';
import {fetchRecipientGateway} from '../src/recipient-gateway.ts';

for (const kind of ['management','editor','recipient'] as const) test(`${kind} fixed location budget fails closed and includes preflights`, async () => {
 let forwards=0; const keys:string[]=[];
 const budget={limit:async ({key}:{key:string})=>{keys.push(key);return {success:keys.length<3};}};
 const env:any={RATE_LIMITER:{limit:async()=>({success:true})},LOCATION_RATE_LIMITER:budget,[`${kind.toUpperCase()}_GATEWAY_ENABLED`]:'true',[`PRIVATE_${kind.toUpperCase()}`]:{fetch:async()=>{forwards++;return new Response(null,{status:204});}},TRUSTED_EDITOR_ORIGINS:'https://page.example.test',TRUSTED_RECIPIENT_ORIGINS:'https://page.example.test'};
 const fetcher=kind==='management'?fetchManagementGateway:kind==='editor'?fetchEditorGateway:fetchRecipientGateway;
 const request=()=>kind==='management'?new Request('https://gateway.example.test/v1/me',{headers:{authorization:`Bearer ${'a'.repeat(32)}`}}):new Request(`https://gateway.example.test${kind==='editor'?'/v1/editor-sessions/exchange':'/v1/page-sessions/exchange'}`,{method:'OPTIONS',headers:{origin:'https://page.example.test','access-control-request-method':'POST'}});
 assert.equal((await fetcher(request(),env,'192.0.2.1')).status,204);
 assert.equal((await fetcher(request(),env,'192.0.2.2')).status,204);
 assert.equal((await fetcher(request(),env,'192.0.2.3')).status,429);
 assert.equal(new Set(keys).size,1); assert.equal(forwards,kind==='management'?2:0);
 for(const bad of [undefined,{limit:async()=>{throw Error('failure');}},{limit:async()=>({})}]) assert.equal((await fetcher(request(),{...env,LOCATION_RATE_LIMITER:bad},'192.0.2.4')).status,503);
 assert.equal((await fetcher(request(),{...env,[`${kind.toUpperCase()}_GATEWAY_ENABLED`]:'false'},'192.0.2.4')).status,503);
 assert.equal(forwards,kind==='management'?2:0);
});

test('workerd fixed-key limiter shares its bucket across changing supplied IPs', async () => {
 const {build}=await import('esbuild'); const {Miniflare}=await import('miniflare');
 const script=(await build({entryPoints:['src/recipient-gateway.ts'],bundle:true,platform:'browser',format:'esm',write:false})).outputFiles[0].text;
 const mf=new Miniflare({workers:[{name:'gateway',modules:true,script,bindings:{RECIPIENT_GATEWAY_ENABLED:'true',TRUSTED_RECIPIENT_ORIGINS:'https://page.example.test'},ratelimits:{RATE_LIMITER:{namespace_id:'8001',simple:{limit:100,period:60}},LOCATION_RATE_LIMITER:{namespace_id:'8002',simple:{limit:2,period:60}}},serviceBindings:{PRIVATE_RECIPIENT:'private'}},{name:'private',modules:true,script:'export default {fetch(){return new Response(null,{status:204})}}'}]});
 try {
  for(let i=1;i<=3;i++) {const response=await mf.dispatchFetch('https://gateway.example.test/v1/page-sessions/exchange',{method:'OPTIONS',headers:{origin:'https://page.example.test','access-control-request-method':'POST','cf-connecting-ip':`192.0.2.${i}`}});assert.equal(response.status,i===3?429:204);}
 } finally {await mf.dispose();}
});
