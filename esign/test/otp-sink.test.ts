// One-time codes delivered to a single fixed mailbox (OTP_MAIL_SINK) through the send_email
// binding: any recipient address is accepted, every code is really emailed, and the email says
// whom it was meant for. Without the sink, only synthetic test addresses are accepted, as before.
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
 await db.prepare("INSERT INTO tenant_page_origins(tenant_id,origin) VALUES ('tenant',?)").bind(ORIGIN).run();
 const env={DB:db,ARTIFACTS:await mf.getR2Bucket('ARTIFACTS'),TEST_MAIL:await mf.getR2Bucket('TEST_MAIL'),LOCAL_TEST_MODE:'true',LOCAL_TEST_OTP_KEY:'otp-sink-pepper-at-least-32-bytes-long',LOCAL_TEST_SEAL_KEY:'otp-sink-seal-key-at-least-32-bytes-long',...extra};
 const auth={authorization:`Bearer ${KEY}`};
 const req=(path:string,init:RequestInit={})=>app.fetch(new Request(ORIGIN+path,init),env);
 const json=(body:unknown,headers:Record<string,string>={})=>({method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)});
 /** A recipient page session for the first signer, whose address is `email`. */
 async function session(email:string){
  const pdf=await PDFDocument.create();pdf.addPage();
  const form=new FormData();form.set('file',new File([await pdf.save()],'synthetic.pdf',{type:'application/pdf'}));form.set('roles','["partner"]');
  const template=await (await req('/v1/templates',{method:'POST',headers:auth,body:form})).json() as {id:string};
  const created=await req('/v1/envelopes',json({templateId:template.id,recipients:[{role:'partner',name:'Ana Partner',email}]},{...auth,'idempotency-key':crypto.randomUUID()}));
  assert.equal(created.status,201,await created.clone().text());
  const {id}=await created.json() as {id:string};
  assert.equal((await req(`/v1/envelopes/${id}/prepare`,{method:'POST',headers:auth})).status,204);
  const task=(await (await req(`/v1/envelopes/${id}`,{headers:auth})).json() as {tasks:{id:string}[]}).tasks[0];
  const {code}=await (await req(`/v1/envelopes/${id}/tasks/${task.id}/recipient-view`,json({origin:ORIGIN},auth))).json() as {code:string};
  const {token}=await (await req('/v1/page-sessions/exchange',json({code},{origin:ORIGIN}))).json() as {token:string};
  return {origin:ORIGIN,authorization:`Bearer ${token}`};
 }
 return {mf,env,req,auth,json,session};
}

test('with a sink, a code for any address is emailed to the sink, says whom it is for, and stays readable for tests', async()=>{
 const sent:Mail[]=[];
 const w=await setup({SEND_EMAIL:{send:async(m:Mail)=>{sent.push(m);return {messageId:'x'};}},OTP_MAIL_FROM:FROM,OTP_MAIL_SINK:SINK});
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
  assert.match(mail.text,/5 minutes/);
  assert.equal((await w.req('/v1/signing/otp/verify',w.json({otp},headers))).status,204);
 } finally {await w.mf.dispose();}
});

test('a code that cannot be emailed is reported as unavailable', async()=>{
 const w=await setup({SEND_EMAIL:{send:async()=>{throw new Error('E_SENDER_NOT_VERIFIED');}},OTP_MAIL_FROM:FROM,OTP_MAIL_SINK:SINK});
 try {
  const headers=await w.session('ana.partner@partner.example');
  assert.equal((await w.req('/v1/signing/otp',w.json({},headers))).status,429);
 } finally {await w.mf.dispose();}
});

test('without a usable sink, only synthetic test addresses get a code, and nothing is emailed', async()=>{
 for(const extra of [{},{SEND_EMAIL:{send:async()=>assert.fail('must not send')},OTP_MAIL_FROM:FROM,OTP_MAIL_SINK:'not an address'},{OTP_MAIL_FROM:FROM,OTP_MAIL_SINK:SINK}]) {
  const w=await setup(extra);
  try {
   assert.equal((await w.req('/v1/signing/otp',w.json({},await w.session('ana.partner@partner.example')))).status,429,JSON.stringify(Object.keys(extra)));
   const synthetic=await w.req('/v1/signing/otp',w.json({},await w.session('ana@partner.test')));
   assert.equal(synthetic.status,202);
   assert.deepEqual(Object.keys(await synthetic.json() as object),['messageId']);
  } finally {await w.mf.dispose();}
 }
});
