import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare} from 'miniflare';

test('workerd named service binding receives a paused upload before its body ends', async () => {
  const mf = new Miniflare({workers:[
    {name:'gateway',modules:true,script:`export default {fetch(request, env) { return env.PRIVATE.fetch(new Request('https://candidate.example.test/', {method:'POST', body:request.body})); }}`,serviceBindings:{PRIVATE:{name:'candidate',entrypoint:'PrivateUpload'}}},
    {name:'candidate',modules:true,script:`import {WorkerEntrypoint} from 'cloudflare:workers'; export class PrivateUpload extends WorkerEntrypoint { async fetch(request) { await this.env.DB.prepare('INSERT INTO admissions VALUES (1)').run(); const reader=request.body.getReader(); while (!(await reader.read()).done) {} return new Response('ok'); } } export default {fetch(){return new Response('not found',{status:404})}}`,d1Databases:['DB']}
  ]});
  let finish!:()=>void;
  try {
    const db=await mf.getD1Database('DB','candidate'); await db.exec('CREATE TABLE admissions (id INTEGER)');
    const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array([1]));finish=()=>{try { controller.close(); } catch {} };}});
    const response=mf.dispatchFetch('https://gateway.example.test/',{method:'POST',body,duplex:'half'} as RequestInit);
    let admitted=false;
    for(let i=0;i<50;i++){await new Promise(resolve=>setTimeout(resolve,20)); if((await db.prepare('SELECT COUNT(*) AS n FROM admissions').first<{n:number}>())?.n===1){admitted=true;break;}}
    finish();
    assert.equal(admitted,true,'the named binding must run before the upload stream ends');
    assert.equal((await response).status,200);
  } finally {finish?.(); await mf.dispose();}
});

test('actual gateway and candidate admit before reading a paused template upload and deny without parsing', async () => {
  const {build}=await import('esbuild'); const {readFile,readdir}=await import('node:fs/promises'); const {unstable_splitSqlQuery}=await import('wrangler');
  const bundle=async(path:string)=>(await build({entryPoints:[path],bundle:true,platform:'browser',format:'esm',write:false,external:['cloudflare:workers']})).outputFiles[0].text;
  const gatewayScript=(await build({stdin:{contents:`import gateway,{fetchManagementGateway} from './src/management-gateway.ts';
    export default {async fetch(request,env){if(new URL(request.url).pathname!=='/probe')return gateway.fetch(request,env);
      let pulls=0,cancels=0;const body=new ReadableStream({pull(){pulls++},cancel(){cancels++}},{highWaterMark:0});
      const forwarded=new Request('https://gateway.example.test/v1/templates',{method:'POST',headers:request.headers,body});
      const result=await fetchManagementGateway(forwarded,env,'192.0.2.1');return Response.json({status:result.status,pulls,cancels,locked:body.locked});}}`,resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'browser',format:'esm',write:false})).outputFiles[0].text;
  const mf=new Miniflare({workers:[
    {name:'gateway',modules:true,compatibilityFlags:['streams_enable_constructors'],script:gatewayScript,bindings:{MANAGEMENT_GATEWAY_ENABLED:'true'},ratelimits:{LOCATION_RATE_LIMITER:{namespace_id:'11002',simple:{limit:1000,period:60}},RATE_LIMITER:{namespace_id:'1002',simple:{limit:100,period:60}}},serviceBindings:{PRIVATE_MANAGEMENT:{name:'candidate',entrypoint:'PrivateManagement'}}},
    {name:'candidate',modules:true,compatibilityFlags:['formdata_parser_supports_files'],script:await bundle('src/candidate-worker.ts'),d1Databases:['DB'],r2Buckets:['ARTIFACTS'],bindings:{CANDIDATE_TEMPLATE_ADMISSION_WINDOW_MS:'60000',CANDIDATE_TEMPLATE_ADMISSION_TENANT_LIMIT:'1',CANDIDATE_TEMPLATE_ADMISSION_DATABASE_LIMIT:'1',CANDIDATE_TEMPLATE_WINDOW_MS:'60000',CANDIDATE_TEMPLATE_TENANT_LIMIT:'5',CANDIDATE_TEMPLATE_DATABASE_LIMIT:'5',CANDIDATE_TEMPLATE_RETAINED_LIMIT:'5',CANDIDATE_TEMPLATE_TENANT_RETAINED_LIMIT:'5'}}
  ]});
  let finish=()=>{};
  try {
    const db=await mf.getD1Database('DB','candidate'); for(const n of (await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort()) await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${n}`,'utf8')).map(s=>db.prepare(s)));
    const token='a'.repeat(32),hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))).toString('hex');
    await db.prepare('INSERT INTO tenants VALUES (?)').bind('test-tenant').run(); await db.prepare('INSERT INTO api_keys(key_hash,tenant_id) VALUES (?,?)').bind(hash,'test-tenant').run();
    const headers={authorization:`Bearer ${token}`,'idempotency-key':'upload1','content-type':'multipart/form-data; boundary=synthetic','cf-connecting-ip':'192.0.2.1'};
    const probe=async(credential:string)=>await (await mf.dispatchFetch('https://gateway.example.test/probe',{headers:{authorization:`Bearer ${credential}`,'idempotency-key':'upload1','content-type':'multipart/form-data; boundary=synthetic'}})).json();
    const assertDenied=(result:any,status:number)=>{assert.equal(result.status,status);assert.equal(result.cancels,1);assert.equal(result.locked,false);assert.ok(result.pulls<=1,'workerd may prefetch at the service binding');};
    assertDenied(await probe('b'.repeat(32)),401);
    await db.prepare('UPDATE api_keys SET revoked_at=1 WHERE key_hash=?').bind(hash).run();
    assertDenied(await probe(token),401);
    await db.prepare('UPDATE api_keys SET revoked_at=NULL WHERE key_hash=?').bind(hash).run();
    const paused=()=>new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode('--synthetic\r\n'));finish=()=>{try{c.close()}catch{}}}});
    const firstBody=paused(); const finishFirst=finish;
    const first=mf.dispatchFetch('https://gateway.example.test/v1/templates',{method:'POST',headers,body:firstBody,duplex:'half'} as RequestInit);
    let count=0; for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,20));count=(await db.prepare("SELECT COALESCE(sum(issue_count),0) n FROM candidate_template_admission_budgets WHERE scope='tenant'").first<{n:number}>())!.n;if(count)break;}
    assert.equal(count,1,'admission must commit while the stream is paused');
    assertDenied(await probe(token),503);
    const second=await Promise.race([mf.dispatchFetch('https://gateway.example.test/v1/templates',{method:'POST',headers,body:paused(),duplex:'half'} as RequestInit),new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('denial waited for body')),2000))]);
    assert.equal(second.status,503); assert.equal((await db.prepare('SELECT count(*) n FROM candidate_template_reservations').first<{n:number}>())!.n,0);
    finish();
    const expired=await Promise.race([first,new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('upload deadline did not fire')),15000))]);
    assert.equal(expired.status,400); finishFirst();
    const {PDFDocument}=await import('pdf-lib'); const pdf=await PDFDocument.create();pdf.addPage([600,800]);const pdfBytes=await pdf.save();
    const roles=['one','two'],fields=roles.map((role,i)=>({id:role,type:'Signature',role,page:1,required:true,rect:{x:.1,y:.1+i*.3,width:.5,height:.1}}));
    const reset=()=>db.prepare('UPDATE candidate_template_admission_budgets SET started_at=0').run();
    const upload=async(duplicate=false)=>{const form=new FormData();form.set('file',new File([pdfBytes],'synthetic.pdf',{type:'application/pdf'}));form.set('roles',JSON.stringify(roles));form.set('fields',JSON.stringify(fields));if(duplicate)form.append('roles','[]');const req=new Request('https://example.test/',{method:'POST',body:form});return mf.dispatchFetch('https://gateway.example.test/v1/templates',{method:'POST',headers:{authorization:`Bearer ${token}`,'idempotency-key':'valid','cf-connecting-ip':'192.0.2.1','content-type':req.headers.get('content-type')!},body:await req.arrayBuffer()});};
    await reset(); const created=await upload();assert.equal(created.status,200);const result=await created.json();
    await reset(); const replay=await upload();assert.equal(replay.status,200);assert.deepEqual(await replay.json(),result);
    await reset(); assert.equal((await upload(true)).status,400);
    assert.equal((await db.prepare('SELECT count(*) n FROM candidate_template_reservations').first<{n:number}>())!.n,1);
    await reset();
    let sent=0; const oversized=new ReadableStream<Uint8Array>({pull(c){if(sent++<100)c.enqueue(new Uint8Array(65536));else c.close();}});
    const tooLarge=await mf.dispatchFetch('https://gateway.example.test/v1/templates',{method:'POST',headers,body:oversized,duplex:'half'} as RequestInit);
    assert.ok([413,503].includes(tooLarge.status),`unexpected ${tooLarge.status} ${await tooLarge.text()}`);
    assert.equal((await db.prepare('SELECT count(*) n FROM candidate_template_reservations').first<{n:number}>())!.n,1);

  } finally {finish();await mf.dispose();}
});

test('workerd upload reader expires a paused stream and cancels it',async()=>{
  const {build}=await import('esbuild');
  const script=(await build({stdin:{contents:`import {readCandidateUpload} from './src/candidate-upload-body.ts';
    export default {async fetch(){let cancelled=0,pulls=0;const body=new ReadableStream({pull(c){if(++pulls===1)c.enqueue(new Uint8Array([1]));},cancel(){cancelled++;}},{highWaterMark:0});
    let message='';try{await readCandidateUpload(body,30)}catch(e){message=e.message}return Response.json({message,cancelled,locked:body.locked,pulls});}}`,resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'browser',format:'esm',write:false})).outputFiles[0].text;
  const mf=new Miniflare({modules:true,compatibilityFlags:['streams_enable_constructors'],script});
  try {const response=await mf.dispatchFetch('https://example.test/');assert.deepEqual(await response.json(),{message:'Upload deadline',cancelled:1,locked:false,pulls:2});} finally {await mf.dispose();}
});

test('workerd upload reader bounds fragmented streams and preserves bytes',async()=>{
 const {build}=await import('esbuild');
 const script=(await build({stdin:{contents:`import {readCandidateUpload} from './src/candidate-upload-body.ts';
 export default {async fetch(){let count=0,cancelled=0;const valid=new ReadableStream({pull(c){if(count===10000)c.close();else c.enqueue(new Uint8Array([count++%251]));}},{highWaterMark:0});
 const bytes=await readCandidateUpload(valid);let exact=bytes.length===10000&&bytes.every((b,i)=>b===i%251);
 let pulls=0;const empty=new ReadableStream({pull(c){pulls++;c.enqueue(new Uint8Array());},cancel(){cancelled++;}},{highWaterMark:0});
 let message='';try{await readCandidateUpload(empty)}catch(e){message=e.message}return Response.json({exact,pulls,cancelled,locked:empty.locked,message});}}`,resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'browser',format:'esm',write:false})).outputFiles[0].text;
 const mf=new Miniflare({modules:true,compatibilityFlags:['streams_enable_constructors'],script});
 try {const response=await mf.dispatchFetch('https://example.test/');assert.deepEqual(await response.json(),{exact:true,pulls:65537,cancelled:1,locked:false,message:'Too many upload chunks'});} finally {await mf.dispose();}
});
