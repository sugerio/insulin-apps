import {createLocalJWKSet, jwtVerify, type JSONWebKeySet} from 'jose';
import originalWorker from './worker.ts';
import {readCandidateUpload} from './candidate-upload-body.ts';
import {PDFDocument} from 'pdf-lib';
import {editorPageContext,editorPageParent} from './editor-session.ts';
import {issueInternalDemoRecipientView} from './internal-demo-recipient-issue.ts';
import {managementCredential} from './candidate-recovery-authorization.ts';
import {internalDemoOtpSession,sendInternalDemoOtp,verifyInternalDemoOtp,type InternalDemoOtpEnv} from './internal-demo-otp.ts';
import {internalDemoSinkPolicy,internalDemoStrictRecipientAllowed,isInternalAddress} from './internal-demo-sink-policy.ts';
import {initialDemoDocument,initialDemoSignaturePreview,internalDemoDocumentSnapshot} from './internal-demo-document.ts';

type Env = InternalDemoOtpEnv & {
  DB: D1Database;
  ARTIFACTS?: R2Bucket;
  ASSETS?: Fetcher;
  INTERNAL_DEMO_EDITOR_ENABLED?: string;
  INTERNAL_DEMO_RECIPIENT_ENABLED?: string;
  TEST_ISSUANCE_WINDOW_MS?:string;
  TEST_ISSUANCE_TENANT_LIMIT?:string;
  TEST_ISSUANCE_DATABASE_LIMIT?:string;
  TEST_OUTSTANDING_TENANT_LIMIT?:string;
  TEST_OUTSTANDING_DATABASE_LIMIT?:string;
  RECIPIENT_RATE_LIMITER?: {limit(options:{key:string}):Promise<{success:boolean}>};
  INTERNAL_DEMO_ORIGIN?: string;
  INTERNAL_DEMO_MANAGEMENT_KEY?: string;
  INTERNAL_DEMO_MANAGER_SUBJECTS?: string;
  PREAUTH_RATE_LIMITER?: {limit(options:{key:string}):Promise<{success:boolean}>};
  EDITOR_RATE_LIMITER?: {limit(options:{key:string}):Promise<{success:boolean}>};
  INTERNAL_DEMO_READINESS_ENABLED?: string;
  ACCESS_ISSUER?: string;
  ACCESS_AUDIENCE?: string;
  ACCESS_JWKS?: string;
};

function policy(env:Env): {issuer:string;audience:string;keys:JSONWebKeySet}|null {
  if(env.INTERNAL_DEMO_READINESS_ENABLED!=='true' || !env.ACCESS_ISSUER || !env.ACCESS_AUDIENCE || !env.ACCESS_JWKS || env.ACCESS_AUDIENCE.length>256 || env.ACCESS_JWKS.length>16384) return null;
  try {
    const issuer=new URL(env.ACCESS_ISSUER);
    if(issuer.protocol!=='https:' || issuer.origin!==env.ACCESS_ISSUER || issuer.username || issuer.password || issuer.port || !/^[A-Za-z0-9_-]{1,256}$/.test(env.ACCESS_AUDIENCE)) return null;
    const data:unknown=JSON.parse(env.ACCESS_JWKS);
    if(!data || typeof data!=='object' || Array.isArray(data)) return null;
    const keys=(data as {keys?:unknown}).keys;
    if(!Array.isArray(keys) || keys.length<1 || keys.length>8) return null;
    const ids=new Set<string>();
    for(const key of keys) {
      if(!key || typeof key!=='object' || Array.isArray(key) || key.kty!=='RSA' || key.alg!=='RS256' || key.use!=='sig' || typeof key.kid!=='string' || !/^[A-Za-z0-9_-]{1,128}$/.test(key.kid) || ids.has(key.kid) || typeof key.n!=='string' || !/^[A-Za-z0-9_-]{342,1024}$/.test(key.n) || typeof key.e!=='string' || !/^[A-Za-z0-9_-]{1,16}$/.test(key.e) || ['d','p','q','dp','dq','qi','oth'].some(name=>name in key)) return null;
      ids.add(key.kid);
    }
    return {issuer:env.ACCESS_ISSUER,audience:env.ACCESS_AUDIENCE,keys:{keys}};
  } catch {return null;}
}

const response=(status:number)=>Response.json({error:status===401?'unauthorized':status===404?'not_found':'unavailable'},{status,headers:{'cache-control':'no-store'}});

const editorSession=/^\/v1\/template-editing-sessions\/[a-f0-9]{64}$/;
const editorSource=/^\/v1\/template-editing-sessions\/[a-f0-9]{64}\/source$/;
const editorPage=/^\/editor\/page\/[a-f0-9]{64}$/;
const hostResult=/^\/host\/template-editing-sessions\/[a-f0-9]{64}$/;
const editorManagement=(method:string,path:string)=>method==='POST'&&(path==='/v1/template-editing-sessions'||editorSource.test(path)) || method==='GET'&&editorSession.test(path);
const editorRoute=(method:string,path:string)=>method==='GET'&&(path==='/editor-host.html'||editorPage.test(path)||path.startsWith('/assets/')||path==='/v1/editor/current'||path==='/v1/editor/pdf'||hostResult.test(path)) || method==='POST'&&(path==='/host/editor-demo-session'||path==='/host/template-editing-sessions'||path==='/v1/editor/exchange'||path==='/v1/editor/save');

function managers(env:Env):string[]|null {
  try {const value:unknown=JSON.parse(env.INTERNAL_DEMO_MANAGER_SUBJECTS??'');if(!Array.isArray(value)||value.length<1||value.length>32||value.some(x=>typeof x!=='string'||x.length<1||x.length>256)||new Set(value).size!==value.length)return null;return value;}catch{return null;}
}
function editorConfigured(env:Env,url:URL):boolean {
  try {return env.INTERNAL_DEMO_EDITOR_ENABLED==='true' && !!env.DB && !!env.ARTIFACTS && !!env.ASSETS && !!env.EDITOR_RATE_LIMITER && !!env.PREAUTH_RATE_LIMITER && !!managers(env) && typeof env.INTERNAL_DEMO_MANAGEMENT_KEY==='string' && /^[A-Za-z0-9_-]{32,256}$/.test(env.INTERNAL_DEMO_MANAGEMENT_KEY) && !!env.INTERNAL_DEMO_ORIGIN && new URL(env.INTERNAL_DEMO_ORIGIN).origin===env.INTERNAL_DEMO_ORIGIN && env.INTERNAL_DEMO_ORIGIN.startsWith('https://') && url.origin===env.INTERNAL_DEMO_ORIGIN; } catch{return false;}
}
async function original(request:Request,env:Env):Promise<Response> {
  const result=await originalWorker.fetch(request,{DB:env.DB,ARTIFACTS:env.ARTIFACTS,ASSETS:env.ASSETS} as never);
  const headers=new Headers(result.headers);headers.set('cache-control','no-store');
  return new Response(result.body,{status:result.status,headers});
}
async function forward(request:Request,env:Env,path:string,authorization:string,body?:Uint8Array):Promise<Response> {
  const headers=new Headers({authorization});
  for(const name of ['content-type','origin']) {const v=request.headers.get(name);if(v)headers.set(name,v);}
  const init:RequestInit={method:request.method,headers};if(body) init.body=Uint8Array.from(body).buffer;
  return original(new Request(new URL(path,request.url),init),env);
}
function clientIp(value:string|null):string|null {
  if(!value || value.length>45)return null;
  if(/^[0-9.]+$/.test(value)){const parts=value.split('.');return parts.length===4&&parts.every(part=>/^(0|[1-9][0-9]{0,2})$/.test(part)&&Number(part)<=255)?value:null;}
  if(!/^[0-9a-fA-F:]+$/.test(value)||!value.includes(':'))return null;
  try{return new URL(`http://[${value}]/`).hostname.slice(1,-1);}catch{return null;}
}
async function limit(binding:{limit(options:{key:string}):Promise<{success:boolean}>},key:string):Promise<number> {
  try{const decision=await binding.limit({key});return decision?.success===true?200:decision?.success===false?429:503;}catch{return 503;}
}
async function preauth(request:Request,env:Env):Promise<number> {
  const ip=clientIp(request.headers.get('cf-connecting-ip'));if(!ip||!env.PREAUTH_RATE_LIMITER)return 503;
  return limit(env.PREAUTH_RATE_LIMITER,ip);
}
async function hash(value:string):Promise<string>{return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),v=>v.toString(16).padStart(2,'0')).join('');}
async function editor(request:Request,env:Env,url:URL):Promise<Response> {
  if(!editorConfigured(env,url)) return response(503);
  const path=url.pathname,method=request.method,managementRoute=editorManagement(method,path);
  if(!managementRoute&&!editorRoute(method,path))return response(404);
  // CF-Connecting-IP is trustworthy only at a separately enforced Cloudflare edge ingress.
  const pre=await preauth(request,env);if(pre!==200)return response(pre);
  let authorization='',body:Uint8Array|undefined;
  if(managementRoute) {
    if(request.headers.has('origin'))return response(403);
    authorization=request.headers.get('authorization')??'';
    const match=/^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(authorization);if(!match)return response(401);
    const row=await env.DB.prepare('SELECT tenant_id FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL').bind(await hash(match[1])).first();
    if(!row)return response(401);
  } else {
    const identity=await access(request,env);if(!identity)return response(401);
    const subject=identity.subject;
    const isHost=path.startsWith('/host/');
    if(isHost && !managers(env)!.includes(subject))return response(403);
    if(isHost && (request.headers.get('x-local-esign')!=='1' || request.headers.has('authorization')))return response(403);
    if(isHost && method==='POST' && (request.headers.get('origin')!==env.INTERNAL_DEMO_ORIGIN || request.headers.get('x-esign-synthetic-confirmed')!=='true'))return response(403);
    if(path.startsWith('/v1/editor/')) {
      const origin=request.headers.get('origin');if(origin && origin!==url.origin)return response(403);
      if(path==='/v1/editor/exchange') {
        body=await readCandidateUpload(request.body,10000,1024);let input:{pageId?:unknown;code?:unknown};
        try{input=JSON.parse(new TextDecoder().decode(body));}catch{return response(400);}
        if(!input||typeof input.pageId!=='string'||typeof input.code!=='string'||!/^[a-f0-9]{64}$/.test(input.pageId)||!/^[a-f0-9]{64}$/.test(input.code))return response(401);
        const row=await env.DB.prepare(`SELECT 1 FROM editor_page_entries e JOIN editor_allowed_origins o ON o.tenant_id=e.tenant_id AND o.origin=e.parent_origin WHERE NOT EXISTS (SELECT 1 FROM candidate_editor_bindings b WHERE b.page_id=e.page_id) AND e.page_id=? AND e.code_hash=? AND e.used_at IS NULL AND e.expires_at>?`).bind(input.pageId,await hash(input.code),Date.now()).first();
        if(!row)return response(401);
      } else {
        const token=/^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('authorization')??'')?.[1];if(!token)return response(401);
        try{await editorPageContext(env.DB,token,Date.now());}catch{return response(401);}
      }
    }
    if(editorPage.test(path) && !await editorPageParent(env.DB,path.slice('/editor/page/'.length),Date.now()))return response(404);
  }
  const admitted=await limit(env.EDITOR_RATE_LIMITER!,'internal-demo-editor');if(admitted!==200)return response(admitted);
  if(managementRoute) {
    body=method==='POST'?await readCandidateUpload(request.body,10000,editorSource.test(path)?5*1024*1024:8192):undefined;
    return forward(request,env,path,authorization,body);
  }
  if(path==='/editor-host.html' || path.startsWith('/assets/')) {
    const asset=await env.ASSETS!.fetch(new Request(new URL(path==='/editor-host.html'?'/editor-host':path,request.url)));const headers=new Headers(asset.headers);headers.set('cache-control','no-store');headers.set('x-content-type-options','nosniff');
    if(path==='/editor-host.html')headers.set('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
    return new Response(asset.body,{status:asset.status,headers});
  }
  const management=`Bearer ${env.INTERNAL_DEMO_MANAGEMENT_KEY}`;
  if(hostResult.test(path))return forward(request,env,path.replace('/host/','/v1/'),management);
  if(path==='/host/template-editing-sessions') {
    const bytes=await readCandidateUpload(request.body,10000,8192);let input:{allowedParentOrigin?:unknown};try{input=JSON.parse(new TextDecoder().decode(bytes));}catch{return response(400);}
    if(!input||input.allowedParentOrigin!==env.INTERNAL_DEMO_ORIGIN)return response(403);
    return forward(request,env,'/v1/template-editing-sessions',management,bytes);
  }
  if(path==='/host/editor-demo-session') {
    const bytes=await readCandidateUpload(request.body,10000,5*1024*1024+65536);
    const form=await new Request(request.url,{method:'POST',headers:{'content-type':request.headers.get('content-type')??''},body:Uint8Array.from(bytes).buffer}).formData();
    if([...form.keys()].length!==2 || form.getAll('file').length!==1 || form.getAll('roles').length!==1)return response(400);
    const file=form.get('file'),rawRoles=form.get('roles');if(!(file instanceof File)||file.size<5||file.size>5*1024*1024||typeof rawRoles!=='string')return response(400);
    let roles:unknown;try{roles=JSON.parse(rawRoles);const pdf=await PDFDocument.load(await file.arrayBuffer(),{throwOnInvalidObject:true});if(!pdf.getPageCount()||pdf.getPageCount()>100)throw new Error();}catch{return response(400);}
    const create=new Request(new URL('/v1/template-editing-sessions',request.url),{method:'POST',headers:{authorization:management,'content-type':'application/json'},body:JSON.stringify({allowedParentOrigin:env.INTERNAL_DEMO_ORIGIN,roles})});
    const issued=await original(create,env);if(issued.status!==201)return issued;
    const body=await issued.clone().json() as {sessionId?:unknown};if(typeof body.sessionId!=='string'||!/^[a-f0-9]{64}$/.test(body.sessionId))return response(503);
    const stage=new Request(new URL(`/v1/template-editing-sessions/${body.sessionId}/source`,request.url),{method:'POST',headers:{authorization:management,'content-type':'application/pdf'},body:await file.arrayBuffer()});
    if((await original(stage,env)).status!==201)return response(503);
    return issued;
  }
  if(method==='POST'&&!body)body=await readCandidateUpload(request.body,10000,path==='/v1/editor/save'?5*1024*1024+65536:1024);
  return forward(request,env,path,request.headers.get('authorization')??'',body);
}
async function access(request:Request,env:Env):Promise<{subject:string;email:string}|null> {
  const settings=policy(env),token=request.headers.get('cf-access-jwt-assertion');if(!settings||!token||token.length>8192)return null;
  try {const {payload}=await jwtVerify(token,createLocalJWKSet(settings.keys),{issuer:settings.issuer,audience:settings.audience,algorithms:['RS256'],requiredClaims:['iss','aud','exp','iat','sub','email']});
    return typeof payload.sub==='string' && !!payload.sub && payload.sub.length<=256 && typeof payload.iat==='number' && payload.iat<=Math.floor(Date.now()/1000) && isInternalAddress(env,payload.email) ? {subject:payload.sub,email:payload.email} : null;
  } catch{return null;}
}

async function recipientView(request:Request,env:Env,url:URL,envelope:string,task:string):Promise<Response> {
  if(env.INTERNAL_DEMO_RECIPIENT_ENABLED!=='true'||!env.DB||!env.PREAUTH_RATE_LIMITER||!env.RECIPIENT_RATE_LIMITER||!env.INTERNAL_DEMO_ORIGIN||env.INTERNAL_DEMO_ORIGIN!==url.origin||url.protocol!=='https:')return response(503);
  internalDemoSinkPolicy(env);
  const pre=await preauth(request,env);if(pre!==200)return response(pre);
  if(request.headers.has('origin'))return response(403);
  const match=/^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(request.headers.get('authorization')??'');if(!match)return response(401);
  const keyHash=await hash(match[1]);const row=await env.DB.prepare(`SELECT k.tenant_id FROM api_keys k WHERE ${managementCredential}`).bind(keyHash).first<{tenant_id:string}>();if(!row)return response(401);
  let body:{origin?:unknown};try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readCandidateUpload(request.body,10000,4096)));}catch{return response(400);}
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==1||body.origin!==env.INTERNAL_DEMO_ORIGIN)return response(400);
  const eligible=await env.DB.prepare(`SELECT 1 FROM api_keys k JOIN envelopes e ON e.tenant_id=k.tenant_id JOIN tasks t ON t.envelope_id=e.id JOIN tenant_page_origins o ON o.tenant_id=e.tenant_id AND o.origin=? WHERE ${managementCredential} AND e.id=? AND t.id=? AND e.status='IN_PROGRESS' AND t.status='ACTIVE'`).bind(body.origin,keyHash,envelope,task).first();
  if(!eligible)return response(404);
  const admitted=await limit(env.RECIPIENT_RATE_LIMITER,'internal-demo-recipient');if(admitted!==200)return response(admitted);
  try {const code=await issueInternalDemoRecipientView(env,keyHash,row.tenant_id,envelope,task,body.origin as string);return Response.json({code},{status:201,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});}catch{return response(503);}
}

async function recipientExchange(request:Request,env:Env,url:URL):Promise<Response> {
  if(env.INTERNAL_DEMO_RECIPIENT_ENABLED!=='true' || !env.DB || !env.PREAUTH_RATE_LIMITER || !env.RECIPIENT_RATE_LIMITER || !env.INTERNAL_DEMO_ORIGIN || env.INTERNAL_DEMO_ORIGIN!==url.origin || url.protocol!=='https:')return response(503);
  const sink=internalDemoSinkPolicy(env);
  const admitted=await preauth(request,env);if(admitted!==200)return response(admitted);
  const identity=await access(request,env);if(!identity||(sink?(sink.subject!==identity.subject||sink.address!==identity.email):!internalDemoStrictRecipientAllowed(env,identity.email)))return response(401);
  const origin=request.headers.get('origin');if(origin!==env.INTERNAL_DEMO_ORIGIN)return response(403);
  let input:{code?:unknown};try {input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readCandidateUpload(request.body,10000,4096)));}catch{return response(400);}
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1||typeof input.code!=='string'||!/^[a-f0-9]{64}$/.test(input.code))return response(400);
  const codeHash=await hash(input.code),db=env.DB;
  const eligibleBase=`SELECT t.recipient_email FROM recipient_page_codes c JOIN envelopes e ON e.id=c.envelope_id AND e.tenant_id=c.tenant_id JOIN tasks t ON t.id=c.task_id AND t.envelope_id=e.id JOIN tenant_page_origins o ON o.tenant_id=c.tenant_id AND o.origin=c.origin WHERE c.code_hash=? AND c.origin=? AND c.used_at IS NULL AND c.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER) AND NOT EXISTS (SELECT 1 FROM recipient_code_revocations r WHERE r.code_hash=c.code_hash) AND NOT EXISTS (SELECT 1 FROM api_keys k WHERE k.key_hash=c.code_hash) AND e.status='IN_PROGRESS' AND t.status='ACTIVE'`;
  const task=await db.prepare(eligibleBase).bind(codeHash,origin).first<{recipient_email:string}>();
  if(!task||typeof task.recipient_email!=='string'||task.recipient_email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(task.recipient_email)||!sink&&task.recipient_email!==identity.email)return response(401);
  const eligible=eligibleBase+' AND t.recipient_email=? COLLATE BINARY';
  const limitResult=await limit(env.RECIPIENT_RATE_LIMITER,'internal-demo-recipient');if(limitResult!==200)return response(limitResult);
  const token=Array.from(crypto.getRandomValues(new Uint8Array(32)),n=>n.toString(16).padStart(2,'0')).join(''),tokenHash=await hash(token);
  try {
    await db.batch([
      db.prepare(`INSERT INTO recipient_auth_assertions SELECT CASE WHEN EXISTS (${eligible}) THEN 1 ELSE 0 END`).bind(codeHash,origin,task.recipient_email),
      db.prepare(`INSERT INTO recipient_page_sessions(token_hash,tenant_id,envelope_id,task_id,origin,expires_at) SELECT ?,c.tenant_id,c.envelope_id,c.task_id,c.origin,CAST(unixepoch('subsec')*1000 AS INTEGER)+900000 FROM recipient_page_codes c WHERE c.code_hash=? AND NOT EXISTS (SELECT 1 FROM api_keys WHERE key_hash IN (?,?)) AND NOT EXISTS (SELECT 1 FROM recipient_page_codes WHERE code_hash=?) AND NOT EXISTS (SELECT 1 FROM recipient_page_sessions WHERE token_hash IN (?,?)) AND NOT EXISTS (SELECT 1 FROM editor_sessions WHERE token_hash IN (?,?)) AND NOT EXISTS (SELECT 1 FROM editor_page_tokens WHERE token_hash IN (?,?)) AND NOT EXISTS (SELECT 1 FROM editor_codes WHERE code_hash IN (?,?)) AND NOT EXISTS (SELECT 1 FROM editor_page_entries WHERE code_hash IN (?,?)) AND NOT EXISTS (SELECT 1 FROM recipient_session_revocations WHERE token_hash=?)`).bind(tokenHash,codeHash,tokenHash,codeHash,tokenHash,tokenHash,codeHash,tokenHash,codeHash,tokenHash,codeHash,tokenHash,codeHash,tokenHash,codeHash,tokenHash),
      db.prepare('INSERT INTO recipient_auth_assertions SELECT CASE WHEN changes()=1 THEN 1 ELSE 0 END'),
      db.prepare('INSERT INTO internal_demo_recipient_bindings(token_hash,subject,email,mode,task_label) VALUES (?,?,?,?,?)').bind(tokenHash,identity.subject,identity.email,sink?'SINK_TEST':'STRICT',sink?task.recipient_email:null),
      db.prepare("UPDATE recipient_page_codes SET used_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE code_hash=? AND used_at IS NULL AND expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER) AND NOT EXISTS (SELECT 1 FROM recipient_code_revocations WHERE code_hash=?)").bind(codeHash,codeHash),
      db.prepare('INSERT INTO recipient_auth_assertions SELECT CASE WHEN changes()=1 THEN 1 ELSE 0 END'),
      db.prepare('DELETE FROM recipient_auth_assertions')
    ]);
    return Response.json({token},{headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
  } catch {return response(401);}
}

async function recipientOtp(request:Request,env:Env,url:URL):Promise<Response> {
  if(env.INTERNAL_DEMO_RECIPIENT_ENABLED!=='true'||env.INTERNAL_DEMO_OTP_ENABLED!=='true'||!env.DB||!env.PREAUTH_RATE_LIMITER||!env.RECIPIENT_RATE_LIMITER||!env.INTERNAL_DEMO_ORIGIN||env.INTERNAL_DEMO_ORIGIN!==url.origin||url.protocol!=='https:')return response(503);
  const sink=internalDemoSinkPolicy(env);
  const pre=await preauth(request,env);if(pre!==200)return response(pre);
  const identity=await access(request,env);if(!identity||(sink?(sink.subject!==identity.subject||sink.address!==identity.email):!internalDemoStrictRecipientAllowed(env,identity.email)))return response(401);
  const origin=request.headers.get('origin');if(origin!==env.INTERNAL_DEMO_ORIGIN)return response(403);
  const token=/^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('authorization')??'')?.[1];if(!token)return response(401);
  if(!await internalDemoOtpSession(env,token,origin,identity))return response(401);
  const admitted=await limit(env.RECIPIENT_RATE_LIMITER,'internal-demo-recipient');if(admitted!==200)return response(admitted);
  if(url.pathname==='/v1/signing/otp') {
    try {await readCandidateUpload(request.body,10000,4096);}catch{return response(400);}
    try {const messageId=await sendInternalDemoOtp(env,token,origin,identity);return Response.json({messageId},{status:202,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});}catch{return response(429);}
  }
  let body:{otp?:unknown};try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readCandidateUpload(request.body,10000,4096)));}catch{return response(400);}
  if(!body||typeof body!=='object'||Array.isArray(body)||typeof body.otp!=='string')return response(400);
  try{return await verifyInternalDemoOtp(env,token,origin,identity,body.otp)?new Response(null,{status:204,headers:{'cache-control':'no-store'}}):response(401);}catch{return response(503);}
}

async function recipientDocument(request:Request,env:Env,url:URL):Promise<Response>{
 if(env.INTERNAL_DEMO_RECIPIENT_ENABLED!=='true'||env.INTERNAL_DEMO_OTP_ENABLED!=='true'||!env.DB||!env.ARTIFACTS||!env.PREAUTH_RATE_LIMITER||!env.RECIPIENT_RATE_LIMITER||!env.INTERNAL_DEMO_ORIGIN||env.INTERNAL_DEMO_ORIGIN!==url.origin||url.protocol!=='https:')return response(503);
 const pre=await preauth(request,env);if(pre!==200)return response(pre);
 const identity=await access(request,env);if(!identity)return response(401);
 const requestOrigin=request.headers.get('origin');if(requestOrigin&&requestOrigin!==env.INTERNAL_DEMO_ORIGIN)return response(403);
 const token=/^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('authorization')??'')?.[1];if(!token)return response(401);
 try{await internalDemoDocumentSnapshot(env,token,env.INTERNAL_DEMO_ORIGIN,identity);}catch{return response(401);}
 const admitted=await limit(env.RECIPIENT_RATE_LIMITER,'internal-demo-recipient');if(admitted!==200)return response(admitted);
 let input:{fieldId?:unknown;text?:unknown}|undefined;if(url.pathname==='/v1/signing/signature-preview'){try{input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readCandidateUpload(request.body,10000,4096)));}catch{return response(400);}}
 let doc:Awaited<ReturnType<typeof initialDemoDocument>>;try{doc=await initialDemoDocument(env,token,env.INTERNAL_DEMO_ORIGIN,identity);}catch{return response(401);}
 const headers={'cache-control':'no-store','x-content-type-options':'nosniff'};
 if(url.pathname==='/v1/signing/signature-preview') {try{const preview=await initialDemoSignaturePreview(doc,input?.fieldId,input?.text);const current=await access(request,env);if(!current||current.subject!==identity.subject||current.email!==identity.email)return response(401);return new Response(Uint8Array.from(preview.image).buffer,{headers:{...headers,'content-type':'image/png','x-signature-width':String(preview.width),'x-signature-height':String(preview.height),'x-signature-preview':preview.receipt}});}catch{return Response.json({error:'signature_does_not_fit'},{status:422,headers});}}
 const current=await access(request,env);if(!current||current.subject!==identity.subject||current.email!==identity.email)return response(401);
 if(url.pathname==='/v1/signing/current')return Response.json({id:doc.facts.artifact_id,sha256:doc.facts.sha256,...(doc.fields.length?{fields:doc.fields,role:doc.facts.role,recipientName:doc.facts.recipient_name,...(doc.v3?{v3:true}:{})}:{})},{headers});
 return new Response(Uint8Array.from(doc.bytes).buffer,{headers:{...headers,'content-type':'application/pdf'}});
}

/** Disabled-by-default internal test entrypoint; signing remains closed. */
export default {
  async fetch(request:Request,env:Env):Promise<Response> {
    if(!policy(env))return response(503);
    const url=new URL(request.url);if(url.search||request.url.includes('?'))return response(404);
    if(request.method==='GET'&&url.pathname==='/v1/me') {
      const pre=await preauth(request,env);if(pre!==200)return response(pre);
      if(!await access(request,env))return response(401);
      try{return await original(request,env);}catch{return response(503);}
    }
    const recipientViewMatch=request.method==='POST'?/^\/v1\/envelopes\/([A-Za-z0-9_-]{1,128})\/tasks\/([A-Za-z0-9_-]{1,128})\/recipient-view$/.exec(url.pathname):null;
    if(recipientViewMatch&&env.INTERNAL_DEMO_RECIPIENT_ENABLED==='true'){try{return await recipientView(request,env,url,recipientViewMatch[1],recipientViewMatch[2]);}catch{return response(503);}}
    if(request.method==='POST'&&url.pathname==='/v1/page-sessions/exchange'&&env.INTERNAL_DEMO_RECIPIENT_ENABLED==='true'){try{return await recipientExchange(request,env,url);}catch{return response(503);}}
    if(request.method==='POST'&&(url.pathname==='/v1/signing/otp'||url.pathname==='/v1/signing/otp/verify')&&env.INTERNAL_DEMO_RECIPIENT_ENABLED==='true'&&env.INTERNAL_DEMO_OTP_ENABLED==='true'){try{return await recipientOtp(request,env,url);}catch{return response(503);}}
    if((request.method==='GET'&&(url.pathname==='/v1/signing/current'||url.pathname==='/v1/signing/pdf')||request.method==='POST'&&url.pathname==='/v1/signing/signature-preview')&&env.INTERNAL_DEMO_RECIPIENT_ENABLED==='true'){try{return await recipientDocument(request,env,url);}catch{return response(503);}}
    if(env.INTERNAL_DEMO_EDITOR_ENABLED!=='true')return response(404);
    try{return await editor(request,env,url);}catch{return response(503);}
  }
};
