import {unstable_splitSqlQuery} from 'wrangler';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Miniflare} from 'miniflare';
import {PDFDocument} from 'pdf-lib';

const origin='http://127.0.0.1:5173';
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const freePort=async()=>{const s=createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const port=(s.address() as import('node:net').AddressInfo).port;await new Promise<void>(resolve=>s.close(()=>resolve()));return port;};

test('spawned loopback OTP adapter isolates concurrent tenants, tasks and sessions and fails closed on mailbox read',{timeout:120000},async()=>{
 const state=await mkdtemp(join(tmpdir(),'esign-otp-bff-')),workerPort=await freePort();let hostPort=await freePort();while(hostPort===workerPort)hostPort=await freePort();
 const otherKey='test-tenant-b-key-0123456789-abcdefghijklmnopqrstuvwxyz';
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB'],r2Buckets:['ARTIFACTS','TEST_MAIL'],d1Persist:join(state,'d1'),r2Persist:join(state,'r2')});
 try{
  const db=await mf.getD1Database('DB');await db.prepare('CREATE TABLE IF NOT EXISTS local_demo_migrations (name TEXT PRIMARY KEY NOT NULL)').run();
  for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort()) {const sql=await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8');await db.batch([...unstable_splitSqlQuery(sql).map(s=>db.prepare(s)),db.prepare('INSERT INTO local_demo_migrations(name) VALUES (?)').bind(name)]);}
  await db.batch([db.prepare("INSERT INTO tenants VALUES ('tenant-b')"),db.prepare("INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,'tenant-b')").bind(createHash('sha256').update(otherKey).digest('hex')),db.prepare("INSERT INTO tenant_page_origins VALUES ('tenant-b',?)").bind(origin)]);
 }finally{await mf.dispose();}
 // The preload faults only the Node mailbox reader, after the real Worker stores its message.
 const marker=join(state,'fail-mailbox'),hit=join(state,'failure-observed'),failedMessage=join(state,'failed-message.json'),preload=join(state,'fault-preload.mjs');
 await writeFile(preload,`import {Miniflare} from ${JSON.stringify(import.meta.resolve('miniflare'))};\nimport {existsSync,writeFileSync} from 'node:fs';\nconst original=Miniflare.prototype.getR2Bucket;\nMiniflare.prototype.getR2Bucket=async function(name,...args){const bucket=await original.call(this,name,...args);if(name!=='TEST_MAIL')return bucket;return new Proxy(bucket,{get(target,prop){if(prop==='put')return async (...values)=>{if(existsSync(${JSON.stringify(marker)}))writeFileSync(${JSON.stringify(failedMessage)},String(values[1]));return target.put(...values);};if(prop==='get')return async (...values)=>{if(existsSync(${JSON.stringify(marker)})){writeFileSync(${JSON.stringify(hit)},'hit');throw new Error('injected mailbox read failure');}return target.get(...values);};const value=Reflect.get(target,prop);return typeof value==='function'?value.bind(target):value;}});};\n`);
 const child=spawn(process.execPath,['--import',preload,'scripts/editor-local-demo.ts'],{cwd:new URL('..',import.meta.url),env:{...process.env,ESIGN_EDITOR_URL_DEMO:'YES',ESIGN_EDITOR_DEMO_STATE:state,ESIGN_EDITOR_DEMO_WORKER_PORT:String(workerPort),ESIGN_EDITOR_DEMO_HOST_PORT:String(hostPort)},stdio:['ignore','pipe','pipe']});
 let logs='';child.stdout.on('data',data=>logs+=data);child.stderr.on('data',data=>logs+=data);
 const host=`http://127.0.0.1:${hostPort}`,worker=`http://127.0.0.1:${workerPort}`,hostHeaders={'x-local-esign':'1',origin},otherHeaders={authorization:`Bearer ${otherKey}`};
 const post=(body:unknown,headers:Record<string,string>)=>({method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)});
 const expectStatus=async(response:Response,status:number,label:string)=>assert.equal(response.status,status,label);
 const codes:string[]=[];
 try{
  let ready=false;for(let i=0;i<200;i++){try{await fetch(host+'/');ready=true;break;}catch{if(child.exitCode!==null)throw new Error('isolated demo exited');await sleep(50);}}assert.ok(ready,'isolated demo did not start');
  const pdf=await PDFDocument.create();pdf.addPage();const pdfBytes=await pdf.save();
  async function makeSession(tenant:'a'|'b',index:number){
   const base=tenant==='a'?host:worker,prefix=tenant==='a'?'/host':'/v1',auth=tenant==='a'?hostHeaders:otherHeaders;
   const form=new FormData();form.set('file',new File([pdfBytes],'synthetic.pdf'));form.set('roles','["Signer"]');
   const t=await fetch(base+prefix+'/templates',{method:'POST',headers:auth,body:form});await expectStatus(t,201,'template');const template=await t.json() as {id:string};
   const e=await fetch(base+prefix+'/envelopes',post({templateId:template.id,recipients:[{role:'Signer',name:'Ana',email:`signer${index}@example.com`}]},{...auth,'idempotency-key':`otp-isolation-${index}`}));await expectStatus(e,201,'envelope');const envelope=await e.json() as {id:string};
   await expectStatus(await fetch(`${base}${prefix}/envelopes/${envelope.id}/prepare`,{method:'POST',headers:auth}),204,'prepare');
   const info=await (await fetch(`${base}${prefix}/envelopes/${envelope.id}`,{headers:auth})).json() as {tasks:{id:string}[]};
   async function session(){const view=await fetch(`${base}${prefix}/envelopes/${envelope.id}/tasks/${info.tasks[0].id}/recipient-view`,post({origin},auth));await expectStatus(view,201,'recipient view');const {code}=await view.json() as {code:string};const exchange=await fetch(worker+'/v1/page-sessions/exchange',post({code},{origin}));await expectStatus(exchange,200,'session exchange');return (await exchange.json() as {token:string}).token;}
   return {token:await session(),session,tenant,task:info.tasks[0].id};
  }
  // Different tasks in one tenant plus a task in another tenant; retry a rare random OTP collision using fresh tasks.
  let sessions:Awaited<ReturnType<typeof makeSession>>[]=[];let results:{messageId:string;testOtp:string}[]=[];
  for(let round=0;round<3;round++){
   sessions=await Promise.all([makeSession('a',round*3),makeSession('a',round*3+1),makeSession('b',round*3+2)]);
   assert.notEqual(sessions[0].task,sessions[1].task);assert.notEqual(sessions[1].task,sessions[2].task);
   const sends=await Promise.all(sessions.map(s=>fetch(worker+'/v1/signing/otp',{method:'POST',headers:{origin,authorization:`Bearer ${s.token}`}})));
   for(const response of sends){await expectStatus(response,202,'concurrent OTP send');assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('access-control-allow-origin'),origin);}
   results=await Promise.all(sends.map(async r=>await r.json() as {messageId:string;testOtp:string}));
   for(const result of results){assert.deepEqual(Object.keys(result).sort(),['messageId','testOtp']);assert.ok(/^\d{6}$/.test(result.testOtp));codes.push(result.testOtp);}
   assert.equal(new Set(results.map(r=>r.messageId)).size,3,'distinct mailbox messages');
   if(new Set(results.map(r=>r.testOtp)).size===3)break;
  }
  assert.equal(new Set(results.map(r=>r.testOtp)).size,3,'fresh random codes must differ');
  const otherSession=await sessions[0].session();assert.notEqual(otherSession,sessions[0].token);
  const verify=(token:string,otp:string)=>fetch(worker+'/v1/signing/otp/verify',post({otp},{origin,authorization:`Bearer ${token}`}));
  // Cross-code checks occur before successes so they cannot be explained by consumption.
  await expectStatus(await verify(otherSession,results[0].testOtp),401,'other session on same task cannot use OTP');
  const cross=await Promise.all(sessions.flatMap((session,i)=>results.flatMap((result,j)=>i===j?[]:[verify(session.token,result.testOtp)])));
  for(const response of cross)await expectStatus(response,401,'cross-task/tenant OTP rejection');
  const verified=await Promise.all(sessions.map((session,i)=>verify(session.token,results[i].testOtp)));for(const response of verified)await expectStatus(response,204,'own OTP verifies');
  const failureSession=await makeSession('b',99);await writeFile(marker,'fail');
  const failed=await fetch(worker+'/v1/signing/otp',{method:'POST',headers:{origin,authorization:`Bearer ${failureSession.token}`}});await expectStatus(failed,503,'mailbox read failure');const failedBody=await failed.json() as Record<string,unknown>;assert.equal(Object.keys(failedBody).length===1&&failedBody.error==='local_mailbox_unavailable',true,'failure response contains only a generic error');assert.equal(failed.headers.get('cache-control'),'no-store');assert.equal(await readFile(hit,'utf8'),'hit');const failedOtp=(JSON.parse(await readFile(failedMessage,'utf8')) as {otp:string}).otp;assert.ok(/^\d{6}$/.test(failedOtp));codes.push(failedOtp);
  child.kill('SIGTERM');await Promise.race([once(child,'exit'),sleep(3000)]);await sleep(50);for(const code of codes)assert.equal(logs.includes(code),false,'process output must not contain an issued OTP');
 }finally{
  if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([once(child,'exit'),sleep(3000)]);if(child.exitCode===null)child.kill('SIGKILL');}
  await rm(state,{recursive:true,force:true});
 }
});
