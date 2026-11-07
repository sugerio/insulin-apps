import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';

test('internal demo readiness verifies Access assertions before the original management route', {timeout:120000}, async()=>{
 const bundle=await build({entryPoints:['src/internal-demo-worker.ts'],bundle:true,format:'esm',platform:'browser',write:false});
 const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
 const jwk={...publicKey.export({format:'jwk'}),kid:'synthetic-key',alg:'RS256',use:'sig'};
 const issuer='https://access.example.test',audience='synthetic-audience',now=Math.floor(Date.now()/1000);
 const mint=(overrides:Record<string,unknown>={},header:Record<string,unknown>={})=>{const b=(x:unknown)=>Buffer.from(JSON.stringify(x)).toString('base64url');const input=`${b({alg:'RS256',kid:'synthetic-key',typ:'JWT',...header})}.${b({iss:issuer,aud:[audience],iat:now,nbf:now-1,exp:now+120,sub:'synthetic-subject',email:'fictional@' + 'internal.example',...overrides})}`;return `${input}.${sign('RSA-SHA256',Buffer.from(input),privateKey).toString('base64url')}`;};
 const base={modules:true as const,script:bundle.outputFiles[0].text,compatibilityDate:'2026-01-01',d1Databases:['DB'],ratelimits:{PREAUTH_RATE_LIMITER:{namespace_id:'9102',simple:{limit:100,period:60 as const}}}};
 const instances:Miniflare[]=[];
 const start=(bindings:Record<string,string>)=>{const mf=new Miniflare({...base,bindings});instances.push(mf);return mf;};
 const config={INTERNAL_DEMO_READINESS_ENABLED:'true',INTERNAL_DEMO_EMAIL_DOMAIN:'internal.example',ACCESS_ISSUER:issuer,ACCESS_AUDIENCE:audience,ACCESS_JWKS:JSON.stringify({keys:[jwk]})};
 try {
  const mf=start(config),db=await mf.getD1Database('DB');await db.exec('CREATE TABLE api_keys (key_hash TEXT, tenant_id TEXT, revoked_at INTEGER);');
  const key='a'.repeat(64);await db.prepare('INSERT INTO api_keys VALUES (?,?,NULL)').bind(createHash('sha256').update(key).digest('hex'),'tenant').run();
  const req=(token:string,path='/v1/me',method='GET')=>mf.dispatchFetch('https://worker.example.test'+path,{method,headers:{'cf-connecting-ip':'192.0.2.1','cf-access-jwt-assertion':token,authorization:`Bearer ${key}`}});
  const ok=await req(mint());assert.equal(ok.status,200);assert.deepEqual(await ok.json(),{tenantId:'tenant'});
  for(const bad of ['',mint({email:'fictional@example.test'}),mint({iss:'https://wrong.example.test'}),mint({aud:'wrong'}),mint({exp:now-1}),mint({nbf:now+60}),mint({iat:now+60}),mint({sub:''}),mint({email:'fictional@sub.'+'internal.example'}),mint({}, {kid:'wrong'}),mint({}, {alg:'HS256'})]) assert.equal((await req(bad)).status,401);
  const parts=mint().split('.');parts[2]=(parts[2][0]==='A'?'B':'A')+parts[2].slice(1);assert.equal((await req(parts.join('.'))).status,401);
  assert.equal((await mf.dispatchFetch('https://worker.example.test/v1/me',{headers:{'cf-connecting-ip':'192.0.2.1','cf-access-authenticated-user-email':'fictional@'+'internal.example',authorization:`Bearer ${key}`}})).status,401);
  assert.equal((await mf.dispatchFetch('https://worker.example.test/v1/me',{headers:{'cf-connecting-ip':'192.0.2.1','cf-access-jwt-assertion':mint(),authorization:`Bearer ${'b'.repeat(64)}`}})).status,401);
  assert.equal((await req(mint(),'/v1/me?x=1')).status,404);
  for(const path of ['/health','/v1/templates','/v1/signing/otp','/v1/envelopes/e/finalize','/editor/page/x','/assets/x']) assert.equal((await req(mint(),path)).status,404,path);
  assert.equal((await req(mint(),'/v1/me','POST')).status,404);
  const missing=start({...config,ACCESS_JWKS:''});assert.equal((await missing.dispatchFetch('https://worker.example.test/v1/me',{headers:{'cf-connecting-ip':'192.0.2.1','cf-access-jwt-assertion':mint()}})).status,503);
  const duplicate=start({...config,ACCESS_JWKS:JSON.stringify({keys:[jwk,jwk]})});assert.equal((await duplicate.dispatchFetch('https://worker.example.test/v1/me',{headers:{'cf-connecting-ip':'192.0.2.1','cf-access-jwt-assertion':mint()}})).status,503);
  const disabled=start({...config,INTERNAL_DEMO_READINESS_ENABLED:'false'});assert.equal((await disabled.dispatchFetch('https://worker.example.test/v1/me',{headers:{'cf-connecting-ip':'192.0.2.1','cf-access-jwt-assertion':mint()}})).status,503);
 } finally {for(const mf of instances) await mf.dispose();}
});
