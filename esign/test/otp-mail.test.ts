// One-time codes through the platform's mail relay (mail.ts). prod: emailed to the recipient, kept
// nowhere. The local preview (dev): kept in its test mailbox for tests to read; without a relay only
// synthetic test addresses get a code and nothing is emailed, with one it is emailed too.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {PDFDocument} from 'pdf-lib';
import {blobStore,MIGRATIONS_DIR,splitSql as unstable_splitSqlQuery} from './helpers/platform.ts';
import {mailRelay,RELAY_URL} from './helpers/mail-relay.ts';
import app from './helpers/gateway.ts';
import {identity} from './helpers/platform.ts';
import {makeSealKey} from './helpers/seal-key.ts';

const ORIGIN='https://esign.example.test';
const KEY='k'.repeat(64);

async function setup(extra:Record<string,unknown>){
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB']});
 const db=await mf.getD1Database('DB');
 for(const name of (await readdir(MIGRATIONS_DIR)).filter(n=>n.endsWith('.sql')).sort()) await db.batch(unstable_splitSqlQuery(await readFile(new URL(name,MIGRATIONS_DIR),'utf8')).map(s=>db.prepare(s)));
 const hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(KEY))).toString('hex');
 await db.prepare("INSERT INTO tenants(id) VALUES ('tenant')").run();
 await db.prepare("INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,'tenant')").bind(hash).run();
 const env={DB:db,ARTIFACTS:await blobStore(mf,'artifacts'),TEST_MAIL:await blobStore(mf,'test-mail'),OTP_KEY:'otp-sink-pepper-at-least-32-bytes-long',TEST_SEAL_KEY:'otp-sink-seal-key-at-least-32-bytes-long',...extra};
 const auth={authorization:`Bearer ${KEY}`};
 const req=(path:string,init:RequestInit={})=>app.fetch(new Request(ORIGIN+path,init),env);
 const json=(body:unknown,headers:Record<string,string>={})=>({method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)});
 /** A recipient page session for the first signer, whose address is `email`. */
 async function session(email:string){return (await sessions(email,1))[0];}
 /** `n` recipient page sessions for the first signer of one envelope (the signer opening the page `n` times). */
 async function sessions(email:string,n:number){
  const pdf=await PDFDocument.create();pdf.addPage();
  const form=new FormData();form.set('file',new File([await pdf.save()],'synthetic.pdf',{type:'application/pdf'}));form.set('roles','["partner"]');
  const template=await (await req('/api/templates',{method:'POST',headers:auth,body:form})).json() as {id:string};
  const created=await req('/api/envelopes',json({templateId:template.id,recipients:[{role:'partner',name:'Ana Partner',email}]},{...auth,'idempotency-key':crypto.randomUUID()}));
  assert.equal(created.status,201,await created.clone().text());
  const {id}=await created.json() as {id:string};
  assert.equal((await req(`/api/envelopes/${id}/prepare`,{method:'POST',headers:auth})).status,204);
  const task=(await (await req(`/api/envelopes/${id}`,{headers:auth})).json() as {tasks:{id:string}[]}).tasks[0];
  const out:{origin:string;authorization:string}[]=[];
  for(let i=0;i<n;i++){
   const {code}=await (await req(`/api/envelopes/${id}/tasks/${task.id}/recipient-view`,json({origin:ORIGIN},auth))).json() as {code:string};
   const {token}=await (await req('/api/public/page-sessions/exchange',json({code},{origin:ORIGIN}))).json() as {token:string};
   out.push({origin:ORIGIN,'x-esign-session':token});
  }
  return out;
 }
 /** A recipient-view request for the first signer of a new envelope, for a page on `origin`. */
 async function recipientView(origin:string){
  const pdf=await PDFDocument.create();pdf.addPage();
  const form=new FormData();form.set('file',new File([await pdf.save()],'synthetic.pdf',{type:'application/pdf'}));form.set('roles','["partner"]');
  const template=await (await req('/api/templates',{method:'POST',headers:auth,body:form})).json() as {id:string};
  const {id}=await (await req('/api/envelopes',json({templateId:template.id,recipients:[{role:'partner',name:'Ana Partner',email:'ana@partner.example'}]},{...auth,'idempotency-key':crypto.randomUUID()}))).json() as {id:string};
  const task=(await (await req(`/api/envelopes/${id}`,{headers:auth})).json() as {tasks:{id:string}[]}).tasks[0];
  return req(`/api/envelopes/${id}/tasks/${task.id}/recipient-view`,json({origin},auth));
 }
 return {mf,env,db,req,auth,json,session,sessions,recipientView};
}

test('without a relay, the preview keeps a code for a synthetic test address in its test mailbox, and emails nothing', async()=>{
 const w=await setup({});
 try {
  assert.equal((await w.req('/api/public/signing/otp',w.json({},await w.session('ana.partner@partner.example')))).status,429,'a real-looking address gets no code');
  const headers=await w.session('ana@partner.test');
  const synthetic=await w.req('/api/public/signing/otp',w.json({},headers));
  assert.equal(synthetic.status,202);
  const body=await synthetic.json() as {messageId:string;testMailbox?:boolean};
  assert.deepEqual(Object.keys(body),['messageId','testMailbox'],'the page points to the test mailbox');
  const kept=await w.req(`/api/test-mail/${body.messageId}`,{headers:w.auth});
  const {to,otp}=await kept.json() as {to:string;otp:string};
  assert.equal(to,'ana@partner.test');
  assert.equal((await w.req(`/api/test-mail/${body.messageId}`,{headers:identity('another-org')})).status,404,'another organization cannot read it');
  assert.equal((await w.req('/api/public/signing/otp/verify',w.json({otp},headers))).status,204);
 } finally {await w.mf.dispose();}
});

test('with a relay, the preview emails the code to the signer for the organization, marked as a test, and still keeps it', async()=>{
 const relay=mailRelay();
 const w=await setup(relay.env);
 try {
  const res=await w.req('/api/public/signing/otp',w.json({},await w.session('ana.partner@partner.example')));
  assert.equal(res.status,202,await res.clone().text());
  const body=await res.json() as {messageId:string;emailed?:boolean;testMailbox?:boolean};
  assert.equal(body.emailed,true,'the page can say the code was emailed');
  assert.equal(body.testMailbox,undefined,'the signer gets it, so the page does not point to the test mailbox');
  assert.equal(relay.sent.length,1);
  const [mail]=relay.sent;
  assert.equal(mail.url,RELAY_URL);
  assert.equal(mail.headers.get('authorization'),'Bearer synthetic-app-token');
  assert.equal(mail.headers.get('x-suger-organization-id'),'tenant','the relay knows which organization it is for');
  assert.equal(mail.body.to,'ana.partner@partner.example');
  assert.equal(mail.body.subject,'Your verification code');
  assert.match(mail.body.text,/10 minutes/);
  assert.match(mail.body.text,/Sent by an Esign test deployment/);
  const otp=/Verification code: (\d{6})/.exec(mail.body.text)?.[1];
  assert.ok(otp);
  const kept=await (await w.req(`/api/test-mail/${body.messageId}`,{headers:w.auth})).json() as {otp:string};
  assert.equal(kept.otp,otp,'the preview keeps every code for tests');
 } finally {await w.mf.dispose();}
});

test('a code the relay could not send (502 send_failed, 503, 429) is reported as unavailable', async()=>{
 for(const status of [502,503,429]){
  const relay=mailRelay(()=>status);
  const w=await setup({...PROD,...relay.env});
  try {
   const response=await w.req('/api/public/signing/otp',w.json({},await w.session('ana.partner@partner.example')));
   assert.equal(response.status,429,String(status));
   assert.deepEqual(await response.json(),{error:'otp_unavailable'});
   assert.equal(relay.sent.length,1);
  } finally {await w.mf.dispose();}
 }
});

// prod (ESIGN_ENV=prod): codes go to the recipient and are kept nowhere.
const sealKey=await makeSealKey();
const PROD={ESIGN_ENV:'prod',TEST_MAIL:undefined,TEST_SEAL_KEY:undefined,SEAL_KEY:sealKey.privateKey,SEAL_KEYS:[sealKey.entry]};

test('in prod a code is emailed to its recipient, without the test markings, and no test mailbox keeps it', async()=>{
 const relay=mailRelay();
 const w=await setup({...PROD,...relay.env});
 try {
  const headers=await w.session('ana.partner@partner.example');
  const response=await w.req('/api/public/signing/otp',w.json({},headers));
  assert.equal(response.status,202,await response.clone().text());
  const {messageId,emailed}=await response.json() as {messageId:string;emailed?:boolean};
  assert.equal(emailed,true);
  assert.equal(relay.sent.length,1);
  const [mail]=relay.sent;
  assert.equal(mail.body.to,'ana.partner@partner.example');
  assert.doesNotMatch(mail.body.subject+mail.body.text,/test deployment|Synthetic/);
  const otp=/Verification code: (\d{6})/.exec(mail.body.text)?.[1];
  assert.ok(otp,'the code is in the email');
  assert.equal((await w.req(`/api/test-mail/${messageId}`,{headers:w.auth})).status,404,'prod has no test mailbox');
  assert.equal((await w.req('/api/public/signing/otp/verify',w.json({otp},headers))).status,204);
 } finally {await w.mf.dispose();}
});

test('prod signs nothing until it is fully configured, and never with a test mailbox', async()=>{
 const relay=mailRelay(()=>assert.fail('must not send'));
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB']});
 try {
  const bucket=await blobStore(mf,'test-mail');
  for(const extra of [{...relay.env,TEST_MAIL:bucket},{...relay.env,SEAL_KEY:undefined},{...relay.env,SEAL_KEYS:[]},{...relay.env,SUGER_MAIL_URL:'http://mail.example.test/v1/send'},{...relay.env,OTP_KEY:''},{}]){
   const w=await setup({...PROD,...extra});
   try {
    const otp=await w.req('/api/public/signing/otp',w.json({},{origin:ORIGIN,'x-esign-session':'a'.repeat(64)}));
    assert.equal(otp.status,404,JSON.stringify(Object.entries(extra).map(([k,v])=>[k,typeof v==='string'?v:typeof v])));
    assert.deepEqual(await otp.json(),{error:'signing_disabled'});
    assert.deepEqual(await (await w.req('/api/public/signing-page')).json(),{hosts:[ORIGIN],signingEnabled:false});
   } finally {await w.mf.dispose();}
  }
 } finally {await mf.dispose();}
});

test('only dev lets SIGNING_PAGE_ORIGINS host the signing page; prod keeps it on the app', async()=>{
 const local='http://127.0.0.1:5173';
 const dev=await setup({SIGNING_PAGE_ORIGINS:local});
 try {assert.equal((await dev.recipientView(local)).status,201);} finally {await dev.mf.dispose();}
 const prod=await setup({...PROD,...mailRelay().env,SIGNING_PAGE_ORIGINS:local});
 try {
  assert.equal((await prod.recipientView(local)).status,400);
  assert.equal((await prod.recipientView(ORIGIN)).status,201);
 } finally {await prod.mf.dispose();}
});

test('a refused send or code says why: wait for the next send, a wrong code with the tries left, a replaced, expired or used-up code', async()=>{
 const w=await setup({});
 try {
  const [first,second]=await w.sessions('ana@partner.test',2);
  const codeOf=async(response:Response)=>{const {messageId}=await response.json() as {messageId:string};return (await (await w.req(`/api/test-mail/${messageId}`,{headers:w.auth})).json() as {otp:string}).otp;};
  const send=(headers:Record<string,string>)=>w.req('/api/public/signing/otp',w.json({},headers));
  const verify=(headers:Record<string,string>,otp:string)=>w.req('/api/public/signing/otp/verify',w.json({otp},headers));
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
