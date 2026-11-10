// One-time codes through the send_email binding. dev with a sink (MAIL_SINK): any recipient
// address is accepted, every code is emailed to the sink, saying whom it was meant for. dev without
// a sink: emailed to the signer, as in prod. Without mail at all, only synthetic test addresses.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {PDFDocument} from 'pdf-lib';
import {unstable_splitSqlQuery} from 'wrangler';
import app from '../src/worker.ts';

const ORIGIN='https://esign.example.test';
const KEY='k'.repeat(64);
const SINK='inbox@sink.example.test';
const FROM='esign-dev@sender.example.test';
type Mail={from:string;to:string;subject:string;text:string};

async function setup(extra:Record<string,unknown>){
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB'],r2Buckets:['ARTIFACTS','TEST_MAIL']});
 const db=await mf.getD1Database('DB');
 for(const name of (await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort()) await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${name}`,'utf8')).map(s=>db.prepare(s)));
 const hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(KEY))).toString('hex');
 await db.prepare("INSERT INTO tenants(id) VALUES ('tenant')").run();
 await db.prepare("INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,'tenant')").bind(hash).run();
 const env={DB:db,ARTIFACTS:await mf.getR2Bucket('ARTIFACTS'),TEST_MAIL:await mf.getR2Bucket('TEST_MAIL'),OTP_KEY:'otp-sink-pepper-at-least-32-bytes-long',TEST_SEAL_KEY:'otp-sink-seal-key-at-least-32-bytes-long',...extra};
 const auth={authorization:`Bearer ${KEY}`};
 const req=(path:string,init:RequestInit={})=>app.fetch(new Request(ORIGIN+path,init),env);
 const json=(body:unknown,headers:Record<string,string>={})=>({method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)});
 /** A recipient page session for the first signer, whose address is `email`. */
 async function session(email:string){return (await sessions(email,1))[0];}
 /** `n` recipient page sessions for the first signer of one envelope (the signer opening the page `n` times). */
 async function sessions(email:string,n:number){
  const pdf=await PDFDocument.create();pdf.addPage();
  const form=new FormData();form.set('file',new File([await pdf.save()],'synthetic.pdf',{type:'application/pdf'}));form.set('roles','["partner"]');
  const template=await (await req('/v1/templates',{method:'POST',headers:auth,body:form})).json() as {id:string};
  const created=await req('/v1/envelopes',json({templateId:template.id,recipients:[{role:'partner',name:'Ana Partner',email}]},{...auth,'idempotency-key':crypto.randomUUID()}));
  assert.equal(created.status,201,await created.clone().text());
  const {id}=await created.json() as {id:string};
  assert.equal((await req(`/v1/envelopes/${id}/prepare`,{method:'POST',headers:auth})).status,204);
  const task=(await (await req(`/v1/envelopes/${id}`,{headers:auth})).json() as {tasks:{id:string}[]}).tasks[0];
  const out:{origin:string;authorization:string}[]=[];
  for(let i=0;i<n;i++){
   const {code}=await (await req(`/v1/envelopes/${id}/tasks/${task.id}/recipient-view`,json({origin:ORIGIN},auth))).json() as {code:string};
   const {token}=await (await req('/v1/page-sessions/exchange',json({code},{origin:ORIGIN}))).json() as {token:string};
   out.push({origin:ORIGIN,authorization:`Bearer ${token}`});
  }
  return out;
 }
 /** A recipient-view request for the first signer of a new envelope, for a page on `origin`. */
 async function recipientView(origin:string){
  const pdf=await PDFDocument.create();pdf.addPage();
  const form=new FormData();form.set('file',new File([await pdf.save()],'synthetic.pdf',{type:'application/pdf'}));form.set('roles','["partner"]');
  const template=await (await req('/v1/templates',{method:'POST',headers:auth,body:form})).json() as {id:string};
  const {id}=await (await req('/v1/envelopes',json({templateId:template.id,recipients:[{role:'partner',name:'Ana Partner',email:'ana@partner.example'}]},{...auth,'idempotency-key':crypto.randomUUID()}))).json() as {id:string};
  const task=(await (await req(`/v1/envelopes/${id}`,{headers:auth})).json() as {tasks:{id:string}[]}).tasks[0];
  return req(`/v1/envelopes/${id}/tasks/${task.id}/recipient-view`,json({origin},auth));
 }
 return {mf,env,db,req,auth,json,session,sessions,recipientView};
}

test('with a sink, a code for any address is emailed to the sink, says whom it is for, and stays readable for tests', async()=>{
 const sent:Mail[]=[];
 const w=await setup({SEND_EMAIL:{send:async(m:Mail)=>{sent.push(m);return {messageId:'x'};}},MAIL_FROM:FROM,MAIL_SINK:SINK});
 try {
  const headers=await w.session('ana.partner@partner.example');
  const response=await w.req('/v1/signing/otp',w.json({},headers));
  assert.equal(response.status,202,await response.clone().text());
  const {messageId,emailed}=await response.json() as {messageId:string;emailed?:boolean};
  assert.equal(emailed,true,'the page can say the code was emailed');
  assert.equal(sent.length,1);
  const [mail]=sent;
  assert.equal(mail.from,FROM);
  assert.equal(mail.to,SINK,'never the recipient');
  assert.match(mail.subject,/ana\.partner@partner\.example/);
  const {otp}=await (await w.req(`/v1/test-mail/${messageId}`,{headers:w.auth})).json() as {otp:string};
  assert.match(mail.text,new RegExp(`\\b${otp}\\b`));
  assert.match(mail.text,/ana\.partner@partner\.example/);
  assert.match(mail.text,/10 minutes/);
  assert.equal((await w.req('/v1/signing/otp/verify',w.json({otp},headers))).status,204);
 } finally {await w.mf.dispose();}
});

test('a code that cannot be emailed is reported as unavailable', async()=>{
 const w=await setup({SEND_EMAIL:{send:async()=>{throw new Error('E_SENDER_NOT_VERIFIED');}},MAIL_FROM:FROM,MAIL_SINK:SINK});
 try {
  const headers=await w.session('ana.partner@partner.example');
  assert.equal((await w.req('/v1/signing/otp',w.json({},headers))).status,429);
 } finally {await w.mf.dispose();}
});

test('without a usable sink, only synthetic test addresses get a code, and nothing is emailed', async()=>{
 for(const extra of [{},{SEND_EMAIL:{send:async()=>assert.fail('must not send')},MAIL_FROM:FROM,MAIL_SINK:'not an address'},{MAIL_FROM:FROM,MAIL_SINK:SINK}]) {
  const w=await setup(extra);
  try {
   assert.equal((await w.req('/v1/signing/otp',w.json({},await w.session('ana.partner@partner.example')))).status,429,JSON.stringify(Object.keys(extra)));
   const synthetic=await w.req('/v1/signing/otp',w.json({},await w.session('ana@partner.test')));
   assert.equal(synthetic.status,202);
   assert.deepEqual(Object.keys(await synthetic.json() as object),['messageId','testMailbox']);
  } finally {await w.mf.dispose();}
 }
});

test('dev without a sink emails the code to the signer, says so, and still keeps it for tests', async()=>{
 const sent:Mail[]=[];
 const w=await setup({SEND_EMAIL:{send:async(m:Mail)=>{sent.push(m);}},MAIL_FROM:FROM});
 try {
  const res=await w.req('/v1/signing/otp',w.json({},await w.session('ana@c01.e2e.example.test')));
  assert.equal(res.status,202);
  const body=await res.json() as {messageId:string;emailed?:boolean;testMailbox?:boolean};
  assert.equal(body.emailed,true);
  assert.equal(body.testMailbox,undefined,'the signer gets it, so the page does not point to the test mailbox');
  assert.equal(sent.length,1);
  assert.equal(sent[0].to,'ana@c01.e2e.example.test');
  assert.equal(sent[0].subject,'Your verification code');
  const otp=/Verification code: (\d{6})/.exec(sent[0].text)?.[1];
  assert.ok(otp);
  const kept=await (await w.req(`/v1/test-mail/${body.messageId}`,{headers:w.auth})).json() as {otp:string};
  assert.equal(kept.otp,otp,'dev keeps every code for tests');
 } finally {await w.mf.dispose();}
});

// prod (ESIGN_ENV=prod): codes go to the recipient and are kept nowhere.
const PROD={ESIGN_ENV:'prod',TEST_MAIL:undefined,MAIL_FROM:FROM,KMS_KEY_ARN:'arn:aws:kms:us-west-2:123456789012:key/00000000-0000-4000-8000-000000000000'};

test('in prod a code is emailed to its recipient, without the dev markings, and no test mailbox keeps it', async()=>{
 const sent:Mail[]=[];
 const w=await setup({...PROD,SEND_EMAIL:{send:async(m:Mail)=>{sent.push(m);return {messageId:'x'};}}});
 try {
  const headers=await w.session('ana.partner@partner.example');
  const response=await w.req('/v1/signing/otp',w.json({},headers));
  assert.equal(response.status,202,await response.clone().text());
  const {messageId,emailed}=await response.json() as {messageId:string;emailed?:boolean};
  assert.equal(emailed,true);
  assert.equal(sent.length,1);
  const [mail]=sent;
  assert.equal(mail.to,'ana.partner@partner.example');
  assert.equal(mail.from,FROM);
  assert.doesNotMatch(mail.subject+mail.text,/E-sign dev|Intended recipient|Synthetic/);
  const otp=/Verification code: (\d{6})/.exec(mail.text)?.[1];
  assert.ok(otp,'the code is in the email');
  assert.equal((await w.req(`/v1/test-mail/${messageId}`,{headers:w.auth})).status,404,'prod has no test mailbox');
  assert.equal((await w.req('/v1/signing/otp/verify',w.json({otp},headers))).status,204);
 } finally {await w.mf.dispose();}
});

test('prod signs nothing until it is fully configured, and never with a sink or a test mailbox', async()=>{
 const send={send:async()=>assert.fail('must not send')};
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',r2Buckets:['TEST_MAIL']});
 try {
  const bucket=await mf.getR2Bucket('TEST_MAIL');
  for(const extra of [{SEND_EMAIL:send,MAIL_SINK:SINK},{SEND_EMAIL:send,TEST_MAIL:bucket},{SEND_EMAIL:send,KMS_KEY_ARN:''},{}]){
   const w=await setup({...PROD,...extra});
   try {
    const otp=await w.req('/v1/signing/otp',w.json({},{origin:ORIGIN,authorization:`Bearer ${'a'.repeat(64)}`}));
    assert.equal(otp.status,404,JSON.stringify(Object.keys(extra)));
    assert.deepEqual(await otp.json(),{error:'signing_disabled'});
    assert.equal((await w.req('/sign')).status,404);
   } finally {await w.mf.dispose();}
  }
 } finally {await mf.dispose();}
});

test('only dev lets SIGNING_PAGE_ORIGINS host the signing page; prod keeps it on the Worker', async()=>{
 const local='http://127.0.0.1:5173';
 const dev=await setup({SIGNING_PAGE_ORIGINS:local});
 try {assert.equal((await dev.recipientView(local)).status,201);} finally {await dev.mf.dispose();}
 const prod=await setup({...PROD,SEND_EMAIL:{send:async()=>({})},SIGNING_PAGE_ORIGINS:local});
 try {
  assert.equal((await prod.recipientView(local)).status,400);
  assert.equal((await prod.recipientView(ORIGIN)).status,201);
 } finally {await prod.mf.dispose();}
});

test('a refused send or code says why: wait for the next send, a wrong code with the tries left, a replaced, expired or used-up code', async()=>{
 const w=await setup({SEND_EMAIL:{send:async()=>({messageId:'x'})},MAIL_FROM:FROM,MAIL_SINK:SINK});
 try {
  const [first,second]=await w.sessions('ana.partner@partner.example',2);
  const codeOf=async(response:Response)=>{const {messageId}=await response.json() as {messageId:string};return (await (await w.req(`/v1/test-mail/${messageId}`,{headers:w.auth})).json() as {otp:string}).otp;};
  const send=(headers:Record<string,string>)=>w.req('/v1/signing/otp',w.json({},headers));
  const verify=(headers:Record<string,string>,otp:string)=>w.req('/v1/signing/otp/verify',w.json({otp},headers));
  const backdate=()=>w.db.prepare('UPDATE otp_challenges SET last_sent_at=last_sent_at-61000').run();
  const sent=await send(first);
  assert.equal(sent.status,202);
  const firstCode=await codeOf(sent);
  // A second send within the minute: refused, with when the next is allowed.
  const again=await send(first);
  assert.equal(again.status,429);
  const limited=await again.json() as {error:string;retryAfterSeconds:number};
  assert.equal(limited.error,'otp_rate_limited');
  assert.ok(limited.retryAfterSeconds>0&&limited.retryAfterSeconds<=60,String(limited.retryAfterSeconds));
  assert.equal(again.headers.get('retry-after'),String(limited.retryAfterSeconds));
  // A wrong code: how many tries are left.
  const wrongCode=firstCode==='000000'?'111111':'000000';
  const wrong=await verify(first,wrongCode);
  assert.equal(wrong.status,401);
  assert.deepEqual(await wrong.json(),{error:'invalid_otp',attemptsLeft:4});
  // The signer opens the page again and gets a new code: the first window's code no longer works.
  await backdate();
  const secondSend=await send(second);
  assert.equal(secondSend.status,202);
  const secondCode=await codeOf(secondSend);
  const replaced=await verify(first,firstCode);
  assert.equal(replaced.status,409);
  assert.deepEqual(await replaced.json(),{error:'otp_superseded'});
  // An expired code, then a used-up window (5 entries).
  await w.db.prepare('UPDATE otp_challenges SET expires_at=0').run();
  const expired=await verify(second,secondCode);
  assert.equal(expired.status,401);
  assert.deepEqual(await expired.json(),{error:'otp_expired'});
  await w.db.prepare('UPDATE otp_challenges SET expires_at=?, attempts=5').bind(Date.now()+60000).run();
  const locked=await verify(second,secondCode);
  assert.equal(locked.status,429);
  const lockedBody=await locked.json() as {error:string;retryAfterSeconds:number};
  assert.equal(lockedBody.error,'otp_attempts_exhausted');
  assert.ok(lockedBody.retryAfterSeconds>0&&lockedBody.retryAfterSeconds<=15*60,String(lockedBody.retryAfterSeconds));
  // A send refused for the used-up window waits for that window to end, not the minute.
  await backdate();
  const windowLimited=await (await send(second)).json() as {error:string;retryAfterSeconds:number};
  assert.equal(windowLimited.error,'otp_rate_limited');
  assert.ok(windowLimited.retryAfterSeconds>60,String(windowLimited.retryAfterSeconds));
 } finally {await w.mf.dispose();}
});
