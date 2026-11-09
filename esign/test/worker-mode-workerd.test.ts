// Worker mode: the same src/worker.ts that the local harness runs, bundled and served by
// workerd with real D1/R2/static-asset bindings. Covers what the local harness used to do
// outside the Worker: hosting the recipient signing page, reading the test mailbox, and
// finishing envelopes (process, then finalize) after each signature. Synthetic data only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {PDFDocument} from 'pdf-lib';
import {unstable_splitSqlQuery} from 'wrangler';

const WORKER='https://esign.example.test';
const CONSOLE='https://console.example.test';
const KEY='w'.repeat(64);
const OTHER_KEY='o'.repeat(64);

async function hashHex(value:string){return Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))).toString('hex');}

async function startWorker({autoComplete=true,testMode=true}:{autoComplete?:boolean;testMode?:boolean}={}){
 const dir=await mkdtemp(join(tmpdir(),'esign-worker-mode-'));
 await mkdir(join(dir,'assets'));
 await writeFile(join(dir,'index.html'),'<!doctype html><html><head><title>E-sign</title></head><body><div id="root"></div><script type="module" src="/assets/recipient.js"></script></body></html>');
 await writeFile(join(dir,'assets','recipient.js'),'export {};');
 await writeFile(join(dir,'demo.html'),'<!doctype html><html><head><title>E-sign demo</title></head><body><div id="root"></div></body></html>');
 const bundle=await build({entryPoints:['src/worker.ts'],bundle:true,format:'esm',platform:'browser',write:false});
 const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-01-01',unsafeTriggerHandlers:true,
  d1Databases:['DB'],r2Buckets:['ARTIFACTS','TEST_MAIL'],
  assets:{directory:dir,binding:'ASSETS',routerConfig:{invoke_user_worker_ahead_of_assets:true,has_user_worker:true}},
  bindings:{LOCAL_TEST_MODE:testMode?'true':'false',LOCAL_TEST_OTP_KEY:'worker-mode-otp-pepper-at-least-32-bytes',LOCAL_TEST_SEAL_KEY:'worker-mode-seal-key-at-least-32-bytes',
   COMPLETE_AFTER_SIGN:autoComplete?'true':'false',SIGNING_PAGE_FRAME_ANCESTORS:`${CONSOLE} not-an-origin https://evil.example.test/path`}});
 const db=await mf.getD1Database('DB');
 for(const name of (await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort()) await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${name}`,'utf8')).map(s=>db.prepare(s)));
 for(const [tenant,key] of [['tenant',KEY],['other',OTHER_KEY]] as const){
  await db.prepare('INSERT INTO tenants(id) VALUES (?)').bind(tenant).run();
  await db.prepare('INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,?)').bind(await hashHex(key),tenant).run();
 }
 const request=(path:string,init:RequestInit={})=>mf.dispatchFetch(WORKER+path,init as any) as unknown as Promise<Response>;
 const auth={authorization:`Bearer ${KEY}`};
 const json=(body:unknown,headers:Record<string,string>={})=>({method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)});
 const envelopeOf=async(id:string)=>await (await request(`/v1/envelopes/${id}`,{headers:auth})).json() as {status:string;tasks:{id:string;status:string;recipientEmail:string}[]};
 async function createEnvelope(){
  const pdf=await PDFDocument.create();pdf.addPage();
  const form=new FormData();form.set('file',new File([await pdf.save()],'synthetic.pdf',{type:'application/pdf'}));form.set('roles','["partner","isv"]');
  // Serialize the multipart body here: Node's FormData does not cross dispatchFetch.
  const multipart=new Response(form);
  const uploaded=await request('/v1/templates',{method:'POST',headers:{...auth,'content-type':multipart.headers.get('content-type')!},body:await multipart.arrayBuffer()});
  assert.equal(uploaded.status,201,await uploaded.clone().text());
  const template=await uploaded.json() as {id:string};
  const created=await request('/v1/envelopes',json({templateId:template.id,recipients:[{role:'partner',name:'Ana Partner',email:'ana@partner.test'},{role:'isv',name:'Marcus Seller',email:'marcus@seller.test'}]},{...auth,'idempotency-key':crypto.randomUUID()}));
  assert.equal(created.status,201,await created.clone().text());const {id}=await created.json() as {id:string};
  assert.equal((await request(`/v1/envelopes/${id}/prepare`,{method:'POST',headers:auth})).status,204);
  return id;
 }
 /** One recipient's whole visit: open the page link, verify the emailed code, sign. */
 async function sign(envelopeId:string,taskId:string){
  const view=await request(`/v1/envelopes/${envelopeId}/tasks/${taskId}/recipient-view`,json({origin:WORKER},auth));assert.equal(view.status,201);
  const {code}=await view.json() as {code:string};
  const exchange=await request('/v1/page-sessions/exchange',json({code},{origin:WORKER}));assert.equal(exchange.status,200);
  const {token}=await exchange.json() as {token:string};const headers={origin:WORKER,authorization:`Bearer ${token}`};
  const sent=await request('/v1/signing/otp',json({},headers));assert.equal(sent.status,202);
  const {messageId}=await sent.json() as {messageId:string};
  assert.equal((await request(`/v1/test-mail/${messageId}`)).status,401,'the test mailbox needs the management key');
  assert.equal((await request(`/v1/test-mail/${messageId}`,{headers:{authorization:`Bearer ${OTHER_KEY}`}})).status,404,'another tenant cannot read it');
  const mail=await request(`/v1/test-mail/${messageId}`,{headers:auth});assert.equal(mail.status,200);
  const {to,otp}=await mail.json() as {to:string;otp:string};
  assert.equal((await request('/v1/signing/otp/verify',json({otp},headers))).status,204);
  // The page is served from the API's own origin, and browsers send no Origin on same-origin
  // GETs; Sec-Fetch-Site, set only by the browser, identifies them instead.
  const bearer={authorization:headers.authorization};
  assert.equal((await request('/v1/signing/current',{headers:{...bearer,'sec-fetch-site':'cross-site'}})).status,403);
  assert.equal((await request('/v1/signing/current',{headers:bearer})).status,403);
  const pdfResponse=await request('/v1/signing/pdf',{headers:{...bearer,'sec-fetch-site':'same-origin'}});
  assert.equal(pdfResponse.status,200);await pdfResponse.arrayBuffer();
  const currentResponse=await request('/v1/signing/current',{headers:{...bearer,'sec-fetch-site':'same-origin'}});
  assert.equal(currentResponse.status,200);
  const current=await currentResponse.json() as {id:string;sha256:string};
  const signed=await request('/v1/signing/sign',json({artifactId:current.id,artifactHash:current.sha256,consent:true},headers));assert.equal(signed.status,202);
  return to;
 }
 async function waitFor<T>(what:string,read:()=>Promise<T>,done:(value:T)=>boolean,ms=15000){
  const until=Date.now()+ms;let last:T=await read();
  while(!done(last)){if(Date.now()>until)assert.fail(`timed out waiting for ${what}: ${JSON.stringify(last)}`);await new Promise(r=>setTimeout(r,100));last=await read();}
  return last;
 }
 return {mf,db,request,auth,envelopeOf,createEnvelope,sign,waitFor,cleanup:async()=>{await mf.dispose();await rm(dir,{recursive:true,force:true});}};
}

test('Worker mode serves the recipient signing page for embedding in the configured console only', {timeout:120000}, async()=>{
 const w=await startWorker();
 try {
  const page=await w.request('/sign');
  assert.equal(page.status,200);
  assert.match(page.headers.get('content-type')??'',/text\/html/);
  const csp=page.headers.get('content-security-policy')??'';
  assert.match(csp,new RegExp(`frame-ancestors 'self' ${CONSOLE}(;|$)`),'only valid configured origins may frame the page');
  assert.doesNotMatch(csp,/evil|not-an-origin/);
  assert.equal(page.headers.get('cross-origin-embedder-policy'),'require-corp');
  assert.equal(page.headers.get('cross-origin-resource-policy'),'cross-origin');
  assert.equal(page.headers.get('cache-control'),'no-store');
  const html=await page.text();
  assert.ok(html.includes(`<meta name="esign-api" content="${WORKER}">`),'the page learns that its own origin is the signing API');
  const asset=await w.request('/assets/recipient.js');
  assert.equal(asset.status,200);
  assert.equal(asset.headers.get('cross-origin-resource-policy'),'cross-origin');
  // A COEP require-corp page can only start a Web Worker (pdf.js) whose script has COEP too.
  assert.equal(asset.headers.get('cross-origin-embedder-policy'),'require-corp');
 } finally {await w.cleanup();}
});

test('Worker mode serves the demo page on its own origin, never framed by another site', {timeout:120000}, async()=>{
 const w=await startWorker();
 try {
  const page=await w.request('/demo');
  assert.equal(page.status,200);
  assert.match(page.headers.get('content-type')??'',/text\/html/);
  const csp=page.headers.get('content-security-policy')??'';
  assert.match(csp,/frame-ancestors 'none'/);
  assert.match(csp,/connect-src 'self'/);
  assert.match(csp,/frame-src 'self' blob:/,'it embeds /sign, the editor and PDFs');
  assert.equal(page.headers.get('cache-control'),'no-store');
  assert.match(await page.text(),/E-sign demo/);
 } finally {await w.cleanup();}
});

test('Worker mode finishes each signature and the envelope on its own, without process or finalize calls', {timeout:180000}, async()=>{
 const w=await startWorker();
 try {
  const id=await w.createEnvelope();
  const start=await w.envelopeOf(id);
  assert.equal(await w.sign(id,start.tasks[0].id),'ana@partner.test');
  // Processing the partner's signature activates the countersigner.
  const second=await w.waitFor('the countersigner to become active',()=>w.envelopeOf(id),e=>e.tasks[1].status==='ACTIVE');
  assert.equal(await w.sign(id,second.tasks[1].id),'marcus@seller.test');
  await w.waitFor('the envelope to complete',()=>w.envelopeOf(id),e=>e.status==='COMPLETED');
  const delivery=await w.request(`/v1/envelopes/${id}/delivery-pdf`,{headers:w.auth});
  assert.equal(delivery.status,200);
  assert.ok((await PDFDocument.load(await delivery.arrayBuffer())).getPageCount()>2,'the two signed pages and the certificate');
  assert.equal((await w.request(`/v1/envelopes/${id}/certificate`,{headers:w.auth})).status,200);
 } finally {await w.cleanup();}
});

test('Worker mode cron finishes envelopes whose after-sign work did not run', {timeout:180000}, async()=>{
 const w=await startWorker({autoComplete:false});
 try {
  const id=await w.createEnvelope();
  const start=await w.envelopeOf(id);
  await w.sign(id,start.tasks[0].id);
  await new Promise(r=>setTimeout(r,500));
  assert.equal((await w.envelopeOf(id)).tasks[1].status,'PENDING','nothing is processed after the signature without COMPLETE_AFTER_SIGN');
  const cron=()=>w.request('/cdn-cgi/handler/scheduled?cron=*/5+*+*+*+*');
  assert.equal((await cron()).status,200);
  const second=await w.waitFor('the cron to process the partner signature',()=>w.envelopeOf(id),e=>e.tasks[1].status==='ACTIVE');
  await w.sign(id,second.tasks[1].id);
  assert.equal((await cron()).status,200);
  await w.waitFor('the cron to complete the envelope',()=>w.envelopeOf(id),e=>e.status==='COMPLETED');
 } finally {await w.cleanup();}
});

test('Worker mode keeps the signing page and test mailbox closed while local test signing is disabled', {timeout:120000}, async()=>{
 const w=await startWorker({testMode:false});
 try {
  assert.equal((await w.request('/sign')).status,404);
  assert.equal((await w.request('/demo')).status,404);
  assert.equal((await w.request('/v1/test-mail/00000000-0000-4000-8000-000000000000',{headers:w.auth})).status,404);
 } finally {await w.cleanup();}
});
