import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument} from 'pdf-lib';
const mod=await import('../scripts/editor-local-demo-source.ts').catch(()=>null);

test('local demo source is opt-in, short-lived, one-use and bound to its generated URL',async()=>{
 assert.ok(mod);assert.throws(()=>mod.createEditorDemoSources(false));
 let now=1000;const sources=mod.createEditorDemoSources(true,()=>now);const pdf=await PDFDocument.create();pdf.addPage();const bytes=await pdf.save();
 assert.throws(()=>sources.issue(new Uint8Array(5*1024*1024+1)));const url=sources.issue(bytes);assert.match(url,/^https:\/\/editor-source\.invalid\/[a-f0-9]{64}$/);
 await assert.rejects(sources.download(url.replace('editor-source.invalid','evil.example.com'),new AbortController().signal));
 assert.deepEqual(await sources.download(url,new AbortController().signal),bytes);await assert.rejects(sources.download(url,new AbortController().signal));
 const expired=sources.issue(bytes);now+=30001;await assert.rejects(sources.download(expired,new AbortController().signal));
 const aborted=sources.issue(bytes),c=new AbortController();c.abort();await assert.rejects(sources.download(aborted,c.signal));
});

test('isolated demo server stages a local file via its private URL and confirms saving',{timeout:30000},async()=>{
 const {createServer}=await import('node:net');const {spawn}=await import('node:child_process');const {once}=await import('node:events');const {mkdtemp}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const state=await mkdtemp(join(tmpdir(),'esign-editor-persist-test-'));
 const free=async()=>{const s=createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const port=(s.address() as import('node:net').AddressInfo).port;await new Promise<void>(r=>s.close(()=>r()));return port;};
 const worker=await free();let host=await free();while(host===worker)host=await free();
 const start=()=>spawn(process.execPath,['scripts/editor-local-demo.ts'],{cwd:new URL('..',import.meta.url),env:{...process.env,ESIGN_EDITOR_URL_DEMO:'YES',ESIGN_EDITOR_DEMO_STATE:state,ESIGN_EDITOR_DEMO_WORKER_PORT:String(worker),ESIGN_EDITOR_DEMO_HOST_PORT:String(host)},stdio:['ignore','pipe','pipe']});
 let child=start();
 let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
 const h=`http://127.0.0.1:${host}`;const w=`http://127.0.0.1:${worker}`;
 try{
  for(let i=0;i<200;i++){try{await fetch(h+'/');break;}catch{await new Promise(r=>setTimeout(r,50));}}
  const pdf=await PDFDocument.create();pdf.addPage();const bytes=await pdf.save();const form=new FormData();form.set('file',new File([bytes],'synthetic.pdf'));form.set('roles','["Signer"]');
  const created=await fetch(h+'/host/editor-demo-session',{method:'POST',headers:{origin:'http://127.0.0.1:5173','x-local-esign':'1'},body:form});assert.equal(created.status,201,output);const session=await created.json() as any;
  assert.equal(output.includes('editor-source.invalid'),false,'private URL must not be logged');
  assert.equal((await fetch(w+'/v1/editor/pdf',{headers:{authorization:`Bearer ${'0'.repeat(64)}`}})).status,401);
  assert.equal((await fetch(h+'/host/editor-demo-session',{method:'POST',headers:{origin:'http://127.0.0.1:5173'},body:form})).status,403);
  const oversize=new FormData();oversize.set('file',new File([new Uint8Array(5*1024*1024+1)],'too-large.pdf'));oversize.set('roles','[\"Signer\"]');assert.notEqual((await fetch(h+'/host/editor-demo-session',{method:'POST',headers:{origin:'http://127.0.0.1:5173','x-local-esign':'1'},body:oversize})).status,201);
  const exchange=await fetch(w+'/v1/editor/exchange',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pageId:session.sessionId,code:new URL(session.url).hash.slice(1)})});const token=(await exchange.json() as any).token;const headers={authorization:`Bearer ${token}`};
  assert.deepEqual(new Uint8Array(await (await fetch(w+'/v1/editor/pdf',{headers})).arrayBuffer()),bytes);
  const fields=new FormData();fields.set('roles','["Signer"]');fields.set('fields',JSON.stringify([{id:'one',type:'Signature',role:'Signer',page:1,required:true,rect:{x:.1,y:.1,width:.3,height:.1}}]));
  const save=await fetch(w+'/v1/editor/save',{method:'POST',headers,body:fields});assert.equal(save.status,201);const id=(await save.json() as any).id;
  const check=await fetch(h+'/host/template-editing-sessions/'+session.sessionId,{headers:{'x-local-esign':'1'}});assert.equal(((await check.json()) as any).templateId,id);
  const loaded=await fetch(h+'/host/templates/'+id,{headers:{'x-local-esign':'1'}});assert.equal(loaded.status,200,'signing host must load editor-created template');assert.equal(((await loaded.json()) as any).id,id);
  const envelope=await fetch(h+'/host/envelopes',{method:'POST',headers:{origin:'http://127.0.0.1:5173','x-local-esign':'1','content-type':'application/json','idempotency-key':'local-demo-test'},body:JSON.stringify({templateId:id,recipients:[{role:'Signer',name:'Ana',email:'ana@example.com'}]})});
  assert.equal(envelope.status,201,await envelope.clone().text());const envId=((await envelope.json()) as any).id;
  const auth={'x-local-esign':'1',origin:'http://127.0.0.1:5173'};
  assert.equal((await fetch(`${h}/host/envelopes/${envId}/prepare`,{method:'POST',headers:auth})).status,204);
  const envelopeInfo=await (await fetch(`${h}/host/envelopes/${envId}`,{headers:{'x-local-esign':'1'}})).json() as any;
  const recipientView=await fetch(`${h}/host/envelopes/${envId}/tasks/${envelopeInfo.tasks[0].id}/recipient-view`,{method:'POST',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({origin:'http://127.0.0.1:5173'})});assert.equal(recipientView.status,201);
  const code=((await recipientView.json()) as any).code;
  const recipientExchange=await fetch(w+'/v1/page-sessions/exchange',{method:'POST',headers:{origin:'http://127.0.0.1:5173','content-type':'application/json'},body:JSON.stringify({code})});assert.equal(recipientExchange.status,200);const recipientToken=((await recipientExchange.json()) as any).token;
  const recipientHeaders={origin:'http://127.0.0.1:5173',authorization:`Bearer ${recipientToken}`};
  const sent=await fetch(w+'/v1/signing/otp',{method:'POST',headers:recipientHeaders});assert.equal(sent.status,202);assert.equal(sent.headers.get('cache-control'),'no-store');assert.equal(sent.headers.get('access-control-allow-origin'),'http://127.0.0.1:5173');const otp=((await sent.json()) as any).testOtp;assert.ok(/^\d{6}$/.test(otp));
  assert.equal(output.includes(otp),false,'OTP must not be logged');assert.equal((await fetch(w+'/v1/signing/otp/verify',{method:'POST',headers:{...recipientHeaders,'content-type':'application/json'},body:JSON.stringify({otp})})).status,204);
  assert.equal((await fetch(h+'/host/editor-demo-session',{method:'POST',headers:{origin:'https://evil.example.com','x-local-esign':'1'},body:form})).status,403);
  child.kill('SIGTERM');await once(child,'exit');child=start();
  let restarted=false;for(let i=0;i<200;i++){try{const r=await fetch(h+'/host/templates/'+id,{headers:{'x-local-esign':'1'}});if(r.ok){assert.equal(((await r.json()) as any).id,id);restarted=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}
  assert.ok(restarted,'template must survive a server restart');
 }finally{child.kill('SIGTERM');await Promise.race([once(child,'exit'),new Promise(r=>setTimeout(r,3000))]);}
});
