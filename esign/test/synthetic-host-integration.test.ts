import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,readdir,rename,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';

test('isolated BFF enforces the route boundary and seals the envelope actually signed via HTTP',async()=>{
 process.env.ESIGN_SYNTHETIC_ALTERNATE_PORTS='YES';process.env.ESIGN_LOCAL_HOST='true';process.env.ESIGN_SYNTHETIC_SEAL='YES';
 const {startLocalHost}=await import('../scripts/local-host.ts');
 const temp=await mkdtemp(join(tmpdir(),'esign-bff-test-'));let workspace='',instanceDir='';
 const log=console.log;console.log=(...a:unknown[])=>{const s=a.join(' ');if(s.startsWith('Synthetic instance (retain for restart): '))instanceDir=s.slice(s.indexOf(': ')+2);};
 const run=(args:string[])=>execFileSync('openssl',args,{cwd:temp,stdio:'pipe'});
 let server:ReturnType<typeof startLocalHost>|undefined;
 try {
  run(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','root.key','-out','root.pem','-subj','/CN=Test Root','-days','2','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign']);
  run(['req','-newkey','rsa:2048','-nodes','-keyout','tsa.key','-out','tsa.csr','-subj','/CN=Test TSA']);
  await writeFile(join(temp,'ext'),'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,timeStamping\n');
  run(['x509','-req','-in','tsa.csr','-CA','root.pem','-CAkey','root.key','-set_serial','1','-days','1','-extfile','ext','-out','tsa.pem']);
  await writeFile(join(temp,'serial'),'01\n');await writeFile(join(temp,'tsa.cnf'),'[tsa]\ndefault_tsa=server\n[server]\nserial=serial\nsigner_cert=tsa.pem\nsigner_key=tsa.key\nsigner_digest=sha256\ndefault_policy=1.2.3.4\ndigests=sha256\n');
  const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),spki=pair.publicKey.export({type:'spki',format:'der'}),roots=await readFile(join(temp,'root.pem'));let signs=0;
  const deps={roots,aws:async(args:string[],message?:Buffer)=>args[0]==='get-public-key'?{KeyId:'local',KeySpec:'ECC_NIST_P256',KeyUsage:'SIGN_VERIFY',SigningAlgorithms:['ECDSA_SHA_256'],PublicKey:spki.toString('base64')}:(signs++,{KeyId:'local',SigningAlgorithm:'ECDSA_SHA_256',Signature:sign('sha256',message!,pair.privateKey).toString('base64')}),timestamp:async(request:Buffer)=>{await writeFile(join(temp,'request'),request);run(['ts','-reply','-config','tsa.cnf','-queryfile','request','-out','response']);return readFile(join(temp,'response'));}};
  delete process.env.ESIGN_SYNTHETIC_SEAL;
  server=startLocalHost('local-test-key-0123456789-abcdefghijklmnopqrstuvwxyz',{syntheticDependencies:async()=>deps,port:0});await once(server,'listening');
  const req=(path:string,init:RequestInit={})=>fetch(`http://127.0.0.1:${(server!.address() as import('node:net').AddressInfo).port}/host/synthetic`+path,{...init,headers:{origin:'http://127.0.0.1:5174','x-local-esign':'1',...init.headers}});
  assert.equal((await req('/create',{method:'POST'})).status,404);assert.equal(signs,0);
  await new Promise<void>(resolve=>server!.close(()=>resolve()));
  process.env.ESIGN_SYNTHETIC_SEAL='YES';
  server=startLocalHost('local-test-key-0123456789-abcdefghijklmnopqrstuvwxyz',{syntheticDependencies:async()=>deps,port:0});await once(server,'listening');
  assert.equal((await req('/create',{method:'POST',headers:{origin:'http://evil.test'}})).status,403);
  assert.equal((await req('/v1/templates',{method:'POST'})).status,403);
  const created=await (await req('/create',{method:'POST'})).json() as {id:string};const base=`/envelopes/${created.id}`;
  assert.equal((await req(base+'/seal',{method:'POST'})).status,502);assert.equal(signs,0);
  const info=await (await req(base)).json() as {tasks:{id:string}[]};
  const json=(value:unknown,headers:Record<string,string>={})=>({method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(value)});
  for(const task of info.tasks){
   const view=await (await req(`${base}/tasks/${task.id}/recipient-view`,json({origin:'http://127.0.0.1:5174'}))).json() as {code:string};
   const session=await (await req('/v1/page-sessions/exchange',json({code:view.code}))).json() as {token:string};const headers={authorization:`Bearer ${session.token}`};
   const otp=await (await req('/v1/signing/otp',{method:'POST',headers})).json() as {testOtp:string};
   assert.equal((await req('/v1/signing/otp/verify',json({otp:otp.testOtp},headers))).status,204);
   const artifact=await (await req('/v1/signing/current',{headers})).json() as {id:string;sha256:string};
   assert.equal((await req('/v1/signing/sign',json({artifactId:artifact.id,artifactHash:artifact.sha256,consent:true},headers))).status,202);
   assert.equal((await req(base+'/process',{method:'POST'})).status,204);
  }
  assert.equal((await req(base+'/finalize',{method:'POST'})).status,204);
  const sealed=await (await req(base+'/seal',{method:'POST'})).json() as {envelopeId:string;workspace:string};workspace=sealed.workspace;
  assert.equal(sealed.envelopeId,created.id);assert.equal(signs,1);
  const {verifyDynamicSyntheticSeal}=await import('../scripts/synthetic-seal-verify.ts');
  const result=await verifyDynamicSyntheticSeal(workspace,createHash('sha256').update(spki).digest('hex'),roots);assert.equal(result.envelopeId,created.id);
  const again=await (await req(base+'/seal',{method:'POST'})).json() as {workspace:string};assert.equal(again.workspace,workspace);assert.equal(signs,1);
 } finally {
  if(server){await new Promise<void>(resolve=>server!.close(()=>resolve()));await new Promise(resolve=>setTimeout(resolve,300));}
  console.log=log;await rm(temp,{recursive:true,force:true});if(workspace)await rm(workspace,{recursive:true,force:true});if(instanceDir)await rm(instanceDir,{recursive:true,force:true});
  delete process.env.ESIGN_SYNTHETIC_ALTERNATE_PORTS;delete process.env.ESIGN_LOCAL_HOST;delete process.env.ESIGN_SYNTHETIC_SEAL;
 }
});

test('uploaded BFF isolates the uploaded envelope and explicitly seals its evidence',async()=>{
 process.env.ESIGN_SYNTHETIC_ALTERNATE_PORTS='YES';process.env.ESIGN_LOCAL_HOST='true';process.env.ESIGN_SYNTHETIC_SEAL='YES';
 const {startLocalHost}=await import('../scripts/local-host.ts');
 const temp=await mkdtemp(join(tmpdir(),'esign-bff-test-'));let workspace='',failedWorkspace='';const instanceDirs:string[]=[];
 const log=console.log;console.log=(...a:unknown[])=>{const s=a.join(' ');if(s.startsWith('Uploaded instance (retain for restart): '))instanceDirs.push(s.slice(s.indexOf(': ')+2));};
 const run=(args:string[])=>execFileSync('openssl',args,{cwd:temp,stdio:'pipe'});
 let server:ReturnType<typeof startLocalHost>|undefined;
 try {
  run(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','root.key','-out','root.pem','-subj','/CN=Test Root','-days','2','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign']);
  run(['req','-newkey','rsa:2048','-nodes','-keyout','tsa.key','-out','tsa.csr','-subj','/CN=Test TSA']);
  await writeFile(join(temp,'ext'),'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,timeStamping\n');
  run(['x509','-req','-in','tsa.csr','-CA','root.pem','-CAkey','root.key','-set_serial','1','-days','1','-extfile','ext','-out','tsa.pem']);
  await writeFile(join(temp,'serial'),'01\n');await writeFile(join(temp,'tsa.cnf'),'[tsa]\ndefault_tsa=server\n[server]\nserial=serial\nsigner_cert=tsa.pem\nsigner_key=tsa.key\nsigner_digest=sha256\ndefault_policy=1.2.3.4\ndigests=sha256\n');
  const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),spki=pair.publicKey.export({type:'spki',format:'der'}),roots=await readFile(join(temp,'root.pem'));let signs=0,remoteCalls=0;let failKms=false,failTsa=false;let holdKms=false,holdStatus=false;let statusEntered!:()=>void,releaseStatus!:()=>void;const statusEnteredPromise=new Promise<void>(r=>{statusEntered=r;}),statusReleasePromise=new Promise<void>(r=>{releaseStatus=r;});const onUploadStatusProbe=async()=>{if(holdStatus){statusEntered();await statusReleasePromise;}};let entered!:()=>void,release!:()=>void;const enteredKms=new Promise<void>(r=>{entered=r;}),releaseKms=new Promise<void>(r=>{release=r;});
  const deps={roots,aws:async(args:string[],message?:Buffer)=>{remoteCalls++;if(holdKms){entered();await releaseKms;}if(failKms)throw new Error('KMS unavailable');if(args[0]==='get-public-key')return {KeyId:'local',KeySpec:'ECC_NIST_P256',KeyUsage:'SIGN_VERIFY',SigningAlgorithms:['ECDSA_SHA_256'],PublicKey:spki.toString('base64')};signs++;const payload=await readFile(args[args.indexOf('--message')+1].replace('fileb://',''));assert.equal(payload.length,32);assert.deepEqual(payload,createHash('sha256').update(message!).digest());return {KeyId:'local',SigningAlgorithm:'ECDSA_SHA_256',Signature:sign('sha256',message!,pair.privateKey).toString('base64')};},timestamp:async(request:Buffer)=>{remoteCalls++;if(failTsa)throw new Error('TSA unavailable');assert.ok(request.length<200);assert.equal(request.includes(Buffer.from('Ana')),false);assert.equal(request.includes(Buffer.from('%PDF')),false);await writeFile(join(temp,'request'),request);run(['ts','-reply','-config','tsa.cnf','-queryfile','request','-out','response']);return readFile(join(temp,'response'));}};
  delete process.env.ESIGN_UPLOAD_SEAL;
  server=startLocalHost('local-test-key-0123456789-abcdefghijklmnopqrstuvwxyz',{syntheticDependencies:async()=>deps,port:0,onUploadStatusProbe});await once(server,'listening');
  const req=(path:string,init:RequestInit={})=>fetch(`http://127.0.0.1:${(server!.address() as import('node:net').AddressInfo).port}/host/upload`+path,{...init,headers:{...(init.method==='POST'?{origin:'http://127.0.0.1:5174'}:{}),'x-local-esign':'1',...init.headers}});
  assert.equal((await req('/create',{method:'POST'})).status,404);assert.equal(signs,0);
  await new Promise<void>(resolve=>server!.close(()=>resolve()));
  process.env.ESIGN_UPLOAD_SEAL='YES';
  server=startLocalHost('local-test-key-0123456789-abcdefghijklmnopqrstuvwxyz',{syntheticDependencies:async()=>deps,port:0,onUploadStatusProbe});await once(server,'listening');
  assert.equal((await req('/create',{method:'POST',headers:{origin:'http://evil.test'}})).status,403);
  assert.equal((await req('/create',{method:'POST',headers:{origin:''}})).status,403);
  assert.equal((await req('/create',{method:'POST',headers:{'x-local-esign':''}})).status,403);
  assert.equal((await req('/v1/templates',{method:'POST'})).status,403);
  const {PDFDocument}=await import('pdf-lib');const pdf=await PDFDocument.create();pdf.addPage();const bytes=await pdf.save();
  assert.equal((await req('/create',{method:'POST',headers:{'content-type':'application/pdf'},body:new Uint8Array([1,2])})).status,400);
  const created=await (await req('/create',{method:'POST',headers:{'content-type':'application/pdf'},body:bytes})).json() as {id:string};const base=`/envelopes/${created.id}`;
  process.env.ESIGN_UPLOAD_INSTANCE=instanceDirs[0];
  assert.equal((await req('/resume',{method:'POST'})).status,409);
  assert.equal((await req('/envelopes/other')).status,404);
  const other=await (await req('/create',{method:'POST',headers:{'content-type':'application/pdf'},body:bytes})).json() as {id:string};assert.notEqual(created.id,other.id);
  assert.equal((await req(`/envelopes/${other.id}/seal`,{method:'POST'})).status,403);
  assert.equal((await req(base+'/seal',{method:'POST',body:'chosen digest'})).status,403);
  assert.equal((await req(base+'/seal',{method:'POST'})).status,403);assert.equal(signs,0);
  assert.equal((await req(base)).status,200);
  assert.equal((await req(base,{headers:{origin:'http://evil.test'}})).status,403);
  assert.equal((await req(base,{headers:{origin:''}})).status,403);
  assert.equal((await req(base,{headers:{origin:'null'}})).status,403);
  assert.equal((await req(base,{headers:{'sec-fetch-site':'cross-site'}})).status,403);
  assert.equal((await req(base,{headers:{'x-local-esign':''}})).status,403);
  assert.equal((await req(base+'/process',{method:'POST',headers:{origin:''}})).status,403);
  assert.equal((await fetch(`http://127.0.0.1:${(server!.address() as import('node:net').AddressInfo).port}/host/upload${base}/process`,{method:'POST',headers:{'x-local-esign':'1'}})).status,403);
  assert.equal((await req(base+'/process',{method:'POST',headers:{'sec-fetch-site':'cross-site'}})).status,403);
  const premature={method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({authorizeDisclosure:true})};
  const notReady=await req(base+'/complete',premature);assert.equal(notReady.status,409);assert.deepEqual(await notReady.json(),{sealStatus:'NOT_READY',retryable:true});assert.equal(remoteCalls,0);
  const info=await (await req(base)).json() as {tasks:{id:string}[]};
  const json=(value:unknown,headers:Record<string,string>={})=>({method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(value)});
  for(const task of info.tasks){
   const view=await (await req(`${base}/tasks/${task.id}/recipient-view`,json({origin:'http://127.0.0.1:5174'}))).json() as {code:string};
   const session=await (await req(`${base}/v1/page-sessions/exchange`,json({code:view.code}))).json() as {token:string};const headers={authorization:`Bearer ${session.token}`};
   assert.notEqual((await req(`/envelopes/${other.id}/v1/signing/current`,{headers})).status,200);
   const otp=await (await req(`${base}/v1/signing/otp`,{method:'POST',headers})).json() as {testOtp:string};
   assert.equal((await req(`${base}/v1/signing/otp/verify`,json({otp:otp.testOtp},headers))).status,204);
   const artifact=await (await req(`${base}/v1/signing/current`,{headers})).json() as {id:string;sha256:string};
   assert.equal((await req(`${base}/v1/signing/sign`,json({artifactId:artifact.id,artifactHash:artifact.sha256,consent:true},headers))).status,202);
   assert.equal((await req(base+'/process',{method:'POST'})).status,204);
  }
  assert.equal((await req(base+'/complete',{method:'POST'})).status,403);
  assert.equal(remoteCalls,0);
  const complete={method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({authorizeDisclosure:true})};
  assert.equal(((await (await req(base)).json()) as {sealStatus:string}).sealStatus,'NOT_SEALED');
  holdStatus=true;const pausedGet=req(base);await statusEnteredPromise;
  holdKms=true;const racedCompletion=req(base+'/complete',complete);
  const raced=await Promise.race([enteredKms.then(()=>true),new Promise<false>(r=>setTimeout(()=>r(false),300))]);
  holdStatus=false;releaseStatus();const statusBefore=await pausedGet;assert.equal(statusBefore.status,200);
  const statusBeforeJson=await statusBefore.json() as {sealStatus:string};
  if(raced) {holdKms=false;release();await racedCompletion;assert.fail('completion ran while status read was in progress');}
  assert.equal(statusBeforeJson.sealStatus,'NOT_SEALED');
  const rejected=await racedCompletion;assert.equal(rejected.status,409);
  holdKms=true;const firstPending=req(base+'/complete',complete);await enteredKms;
  assert.equal(((await (await req(base)).json()) as {sealStatus:string}).sealStatus,'IN_PROGRESS');
  const second=await req(base+'/complete',complete);assert.equal(second.status,409);
  for(const suffix of ['/process','/finalize',`/tasks/${info.tasks[0].id}/recipient-view`,'/v1/page-sessions/exchange','/v1/signing/otp','/v1/signing/otp/verify','/v1/signing/sign'])assert.equal((await req(base+suffix,{method:'POST'})).status,409,suffix);
  assert.equal((await req(base+'/delivery-pdf')).status,409);
  assert.equal((await req(base+'/existing-delivery-pdf')).status,409);
  holdKms=false;release();const first=await firstPending;assert.equal(first.status,200);
  const sealed=await first.json() as {envelopeId:string;workspace:string;sealStatus:string};workspace=sealed.workspace;
  assert.equal(sealed.envelopeId,created.id);assert.equal(sealed.sealStatus,'SEALED_LOCAL_TEST');assert.equal(signs,1);
  // Exercise the real first HTTP response against the actual upload page contract.
  const {default:React}=await import('react');const {default:Renderer,act}=await import('react-test-renderer');
  const {UploadedHostPage}=await import('../ui/UploadedHostPage.ts');
  const originalFetch=globalThis.fetch,originalWindow=(globalThis as any).window;const store=new Map<string,string>();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  try {
   (globalThis as any).window={location:{origin:'http://127.0.0.1:5174'},localStorage:{getItem:(k:string)=>store.get(k)??null,setItem:(k:string,v:string)=>store.set(k,v),removeItem:(k:string)=>store.delete(k)}};
   globalThis.fetch=async(input:any,init?:RequestInit)=>{const path=String(input);
    if(path==='/host/upload/resume')return Response.json({id:created.id});
    if(path===`/host/upload${base}/complete`)return Response.json(sealed);
    if(path===`/host/upload${base}`)return req(base);
    return originalFetch(input,init);
   };
   let renderer:any;await act(async()=>{renderer=Renderer.create(React.createElement(UploadedHostPage));});
   const button=(label:string)=>renderer.root.findAllByType('button').find((b:any)=>b.children.includes(label));
   await act(async()=>button('Resume configured instance').props.onClick());
   await act(async()=>renderer.root.findAllByType('input').find((node:any)=>node.props.type==='checkbox').props.onChange({target:{checked:true}}));
   await act(async()=>button('Complete local KMS/TSA test').props.onClick());
   assert.match(JSON.stringify(renderer.toJSON()),/Real KMS\/TSA local test evidence/);
   assert.equal(store.size,0);await act(async()=>renderer.unmount());
  } finally {globalThis.fetch=originalFetch;(globalThis as any).window=originalWindow;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;}

  assert.equal(((await (await req(base)).json()) as {sealStatus:string}).sealStatus,'SEALED_LOCAL_TEST');
  const {verifyUploadedSeal}=await import('../scripts/synthetic-seal-verify.ts');
  const result=await verifyUploadedSeal(workspace,createHash('sha256').update(spki).digest('hex'),roots);assert.equal(result.envelopeId,created.id);
  const again=await (await req(base+'/complete',complete)).json() as {workspace:string};assert.equal(again.workspace,workspace);assert.equal(signs,1);
  for(const name of ['d0','d1','d2','d3']) {
   const path=join(workspace,name),held=join(workspace,`${name}-test-held`);
   await rename(path,held);
   try {assert.equal((await req(base+'/existing-delivery-pdf')).status,503,`completed ${name} missing`);} finally {await rename(held,path);}
  }
  const completeMarker=join(workspace,'verified-complete'),markerBytes=await readFile(completeMarker);
  await writeFile(completeMarker,'invalid marker');
  try {assert.equal((await req(base+'/existing-delivery-pdf')).status,503,'invalid completion marker');} finally {await writeFile(completeMarker,markerBytes);}
  assert.equal((await req(base+'/existing-delivery-pdf')).status,200);
  const otherBase=`/envelopes/${other.id}`;
  const otherInfo=await (await req(otherBase)).json() as {tasks:{id:string}[]};
  for(const task of otherInfo.tasks){
   const view=await (await req(`${otherBase}/tasks/${task.id}/recipient-view`,json({origin:'http://127.0.0.1:5174'}))).json() as {code:string};
   const session=await (await req(`${otherBase}/v1/page-sessions/exchange`,json({code:view.code}))).json() as {token:string};const headers={authorization:`Bearer ${session.token}`};
   const otp=await (await req(`${otherBase}/v1/signing/otp`,{method:'POST',headers})).json() as {testOtp:string};
   assert.equal((await req(`${otherBase}/v1/signing/otp/verify`,json({otp:otp.testOtp},headers))).status,204);
   const artifact=await (await req(`${otherBase}/v1/signing/current`,{headers})).json() as {id:string;sha256:string};
   assert.equal((await req(`${otherBase}/v1/signing/sign`,json({artifactId:artifact.id,artifactHash:artifact.sha256,consent:true},headers))).status,202);
   assert.equal((await req(otherBase+'/process',{method:'POST'})).status,204);
  }
  failKms=true;const failed=await req(otherBase+'/complete',complete);failKms=false;assert.equal(failed.status,503);assert.deepEqual(await failed.json(),{sealStatus:'INVESTIGATE',retryable:false});
  failedWorkspace=(await readFile(join(instanceDirs[1],'seal-workspace'))).toString();
  const originalD3=await readFile(join(failedWorkspace,'d3'));const beforeViewCalls=remoteCalls;
  const workspaceSnapshot=async()=>Promise.all((await readdir(failedWorkspace)).sort().map(async name=>[name,createHash('sha256').update(await readFile(join(failedWorkspace,name))).digest('hex')]));
  const beforeView=await workspaceSnapshot();
  assert.equal((await req(otherBase+'/existing-delivery-pdf',{headers:{origin:'http://evil.test'}})).status,403);
  assert.equal((await req(otherBase+'/existing-delivery-pdf',{headers:{'sec-fetch-site':'cross-site'}})).status,403);
  assert.equal((await req('/envelopes/other/existing-delivery-pdf')).status,404);
  const existing=await req(otherBase+'/existing-delivery-pdf');assert.equal(existing.status,200);
  assert.equal(existing.headers.get('content-type'),'application/pdf');assert.equal(existing.headers.get('x-content-type-options'),'nosniff');assert.match(existing.headers.get('content-security-policy')!,/sandbox/);
  assert.deepEqual(Buffer.from(await existing.arrayBuffer()),originalD3);assert.equal(remoteCalls,beforeViewCalls);assert.deepEqual(await workspaceSnapshot(),beforeView);
  assert.equal(((await (await req(otherBase)).json()) as {sealStatus:string}).sealStatus,'INVESTIGATE');
  const fixturePath=join(failedWorkspace,'fixture');const originalFixture=await readFile(fixturePath);
  for(const field of ['source','signatures','d0','d1','d2']) {
   const altered=JSON.parse(originalFixture.toString());
   if(field==='source')altered.source.object_key='conflicting-source';
   else if(field==='signatures')altered.signatures[0].recipient_name='Conflicting';
   else altered.artifacts[Number(field.slice(1))]=Buffer.from('conflicting').toString('base64');
   await writeFile(fixturePath,JSON.stringify(altered));
   assert.equal((await req(otherBase+'/existing-delivery-pdf')).status,503,field);
  }
  await writeFile(fixturePath,originalFixture);
  for(const name of ['d0','d1','d2']) {
   const path=join(failedWorkspace,name),original=await readFile(path);
   await writeFile(path,'conflicting synthetic test artifact');
   assert.equal((await req(otherBase+'/existing-delivery-pdf')).status,503,name);
   await writeFile(path,original);
  }
  for(const name of ['d0','d1','d2','d3']) {
   const path=join(failedWorkspace,name),held=join(failedWorkspace,`${name}-test-held`);
   await rename(path,held);
   try {assert.equal((await req(otherBase+'/existing-delivery-pdf')).status,200,`partial ${name} missing`);} finally {await rename(held,path);}
  }
  await writeFile(join(failedWorkspace,'d3'),'corrupted synthetic partial evidence');
  assert.equal((await req(otherBase+'/existing-delivery-pdf')).status,503);
  assert.equal(((await (await req(otherBase)).json()) as {sealStatus:string}).sealStatus,'INVESTIGATE');
  for(const suffix of ['/process','/finalize',`/tasks/${otherInfo.tasks[0].id}/recipient-view`,'/v1/page-sessions/exchange','/v1/signing/otp','/v1/signing/otp/verify','/v1/signing/sign'])assert.equal((await req(otherBase+suffix,{method:'POST'})).status,409,suffix);
  assert.equal((await req(otherBase+'/delivery-pdf')).status,409);assert.equal((await req(otherBase+'/final-pdf')).status,200);
  const beforeRetry=remoteCalls;assert.equal((await req(otherBase+'/complete',complete)).status,503);assert.equal(remoteCalls,beforeRetry);
  const signature=await readFile(join(workspace,'signature'));
  await new Promise<void>(resolve=>server!.close(()=>resolve()));await new Promise(resolve=>setTimeout(resolve,300));
  server=startLocalHost('local-test-key-0123456789-abcdefghijklmnopqrstuvwxyz',{syntheticDependencies:async()=>deps,port:0});await once(server,'listening');
  process.env.ESIGN_UPLOAD_INSTANCE=instanceDirs[1];
  assert.equal(((await (await req('/resume',{method:'POST'})).json()) as {id:string}).id,other.id);
  assert.equal(((await (await req(otherBase)).json()) as {sealStatus:string}).sealStatus,'INVESTIGATE');
  assert.equal((await req(otherBase+'/complete',complete)).status,503);assert.equal(remoteCalls,beforeRetry);
  process.env.ESIGN_UPLOAD_INSTANCE=instanceDirs[0];
  const resumed=await (await req('/resume',{method:'POST'})).json() as {id:string};assert.equal(resumed.id,created.id);
  assert.equal(((await (await req(base)).json()) as {sealStatus:string}).sealStatus,'INVESTIGATE');
  assert.equal((await req(base+'/complete',complete)).status,503);assert.equal((await req(base+'/final-pdf')).status,200);
  const resumedPdf=await req(base+'/existing-delivery-pdf');assert.equal(resumedPdf.status,200);assert.deepEqual(Buffer.from(await resumedPdf.arrayBuffer()),await readFile(join(workspace,'d3')));
  assert.equal((await req(otherBase+'/existing-delivery-pdf')).status,503);
  assert.equal(signs,1);assert.deepEqual(await readFile(join(workspace,'signature')),signature);
  assert.equal((await verifyUploadedSeal(workspace,createHash('sha256').update(spki).digest('hex'),roots)).envelopeId,created.id);
  await new Promise<void>(resolve=>server!.close(()=>resolve()));server=undefined;await new Promise(resolve=>setTimeout(resolve,300));
  const {Miniflare}=await import('miniflare');
  const tamper=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB'],r2Buckets:['ARTIFACTS','TEST_MAIL'],d1Persist:join(instanceDirs[0],'d1'),r2Persist:join(instanceDirs[0],'r2')});
  try {
   const db=await tamper.getD1Database('DB');const row=await db.prepare('SELECT object_key FROM artifacts WHERE envelope_id=?').bind(created.id).first<{object_key:string}>();assert.ok(row);
   const bucket=await tamper.getR2Bucket('ARTIFACTS');await bucket.put(row.object_key,'tampered synthetic evidence');
  } finally {await tamper.dispose();}
  server=startLocalHost('local-test-key-0123456789-abcdefghijklmnopqrstuvwxyz',{syntheticDependencies:async()=>deps,port:0});await once(server,'listening');
  assert.equal(((await (await req('/resume',{method:'POST'})).json()) as {id:string}).id,created.id);
  const callsBeforeTampered=remoteCalls;
  const failure=await req(base+'/complete',complete);assert.equal(failure.status,503);
  assert.deepEqual(await failure.json(),{sealStatus:'INVESTIGATE',retryable:false});
  assert.equal(signs,1);

 } finally {
  if(server){await new Promise<void>(resolve=>server!.close(()=>resolve()));await new Promise(resolve=>setTimeout(resolve,300));}
  console.log=log;await rm(temp,{recursive:true,force:true});if(workspace)await rm(workspace,{recursive:true,force:true});if(failedWorkspace)await rm(failedWorkspace,{recursive:true,force:true});for(const directory of instanceDirs)await rm(directory,{recursive:true,force:true});
  delete process.env.ESIGN_UPLOAD_INSTANCE;delete process.env.ESIGN_UPLOAD_SEAL;delete process.env.ESIGN_SYNTHETIC_ALTERNATE_PORTS;delete process.env.ESIGN_LOCAL_HOST;delete process.env.ESIGN_SYNTHETIC_SEAL;
 }
});

test('corrupt unsigned upload is locked for investigation across restart',async()=>{
 process.env.ESIGN_SYNTHETIC_ALTERNATE_PORTS='YES';process.env.ESIGN_LOCAL_HOST='true';process.env.ESIGN_UPLOAD_SEAL='YES';
 const {startLocalHost}=await import('../scripts/local-host.ts');const {PDFDocument}=await import('pdf-lib');
 const dirs:string[]=[];const log=console.log;console.log=(...a:unknown[])=>{const s=a.join(' ');if(s.startsWith('Uploaded instance (retain for restart): '))dirs.push(s.slice(s.indexOf(': ')+2));};
 let server:ReturnType<typeof startLocalHost>|undefined;let calls=0;
 try {
  server=startLocalHost('local-test-key-0123456789-abcdefghijklmnopqrstuvwxyz',{port:0,syntheticDependencies:async()=>({roots:Buffer.alloc(0),aws:async()=>{calls++;throw Error();},timestamp:async()=>{calls++;throw Error();}})});await once(server,'listening');
  const req=(path:string,init:RequestInit={})=>fetch(`http://127.0.0.1:${(server!.address() as import('node:net').AddressInfo).port}/host/upload`+path,{...init,headers:{'x-local-esign':'1',...(init.method==='POST'?{origin:'http://127.0.0.1:5174'}:{}),...init.headers}});
  const pdf=await PDFDocument.create();pdf.addPage();const created=await (await req('/create',{method:'POST',headers:{'content-type':'application/pdf'},body:await pdf.save()})).json() as {id:string};
  process.env.ESIGN_UPLOAD_INSTANCE=dirs[0];await new Promise<void>(r=>server!.close(()=>r()));server=undefined;await new Promise(r=>setTimeout(r,300));
  const {Miniflare}=await import('miniflare');const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB'],r2Buckets:['ARTIFACTS','TEST_MAIL'],d1Persist:join(dirs[0],'d1'),r2Persist:join(dirs[0],'r2')});
  try {const bucket=await mf.getR2Bucket('ARTIFACTS');await bucket.put(`envelopes/${created.id}/d0.pdf`,'corrupted synthetic PDF');} finally {await mf.dispose();}
  server=startLocalHost('local-test-key-0123456789-abcdefghijklmnopqrstuvwxyz',{port:0,syntheticDependencies:async()=>({roots:Buffer.alloc(0),aws:async()=>{calls++;throw Error();},timestamp:async()=>{calls++;throw Error();}})});await once(server,'listening');
  assert.equal((await req('/resume',{method:'POST'})).status,200);
  const complete={method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({authorizeDisclosure:true})};
  const attempt=await req(`/envelopes/${created.id}/complete`,complete);assert.equal(attempt.status,503);assert.deepEqual(await attempt.json(),{sealStatus:'INVESTIGATE',retryable:false});
  const status=await req(`/envelopes/${created.id}`);assert.equal(((await status.json()) as {sealStatus:string}).sealStatus,'INVESTIGATE');
  assert.equal(calls,0);
  await new Promise<void>(r=>server!.close(()=>r()));server=undefined;await new Promise(r=>setTimeout(r,300));
  server=startLocalHost('local-test-key-0123456789-abcdefghijklmnopqrstuvwxyz',{port:0});await once(server,'listening');await req('/resume',{method:'POST'});
  const again=await req(`/envelopes/${created.id}/complete`,complete);assert.equal(again.status,503);assert.deepEqual(await again.json(),{sealStatus:'INVESTIGATE',retryable:false});
 } finally {if(server)await new Promise<void>(r=>server!.close(()=>r()));await new Promise(r=>setTimeout(r,300));console.log=log;for(const d of dirs)await rm(d,{recursive:true,force:true});delete process.env.ESIGN_UPLOAD_INSTANCE;delete process.env.ESIGN_UPLOAD_SEAL;delete process.env.ESIGN_SYNTHETIC_ALTERNATE_PORTS;delete process.env.ESIGN_LOCAL_HOST;}
});
