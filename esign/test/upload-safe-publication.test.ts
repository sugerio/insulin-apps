import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {PDFDocument} from 'pdf-lib';
import {initializeUploadCompletion,lockUploadInvestigation,runUploadPreflight,uploadCompletionState} from '../scripts/upload-completion-state.ts';

for(const boundary of ['directory-sync','winner-validation'] as const) test(`safe check marker can be visible after ${boundary} and failed investigation write`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'esign-safe-marker-double-fault-'));
 try {
  await initializeUploadCompletion(dir);
  const fail=()=>{mkdirSync(join(dir,'upload-investigate'));throw new Error('injected publication failure');};
  const fault=boundary==='directory-sync'?{afterSafeLink:fail}:{beforeSafeWinnerValidation:fail};
  await assert.rejects(runUploadPreflight(dir,async()=> 'UNSIGNED',fault));await assert.rejects(lockUploadInvestigation(dir));
  await rm(join(dir,'upload-investigate'),{recursive:true});
  // A safe marker reflects the checked bytes, not proof that publication returned durably.
  assert.equal(await uploadCompletionState(dir,undefined,true),'FRESH');
  assert.equal(await uploadCompletionState(dir),'INVESTIGATE');
 } finally {await rm(dir,{recursive:true,force:true});}
});

for(const boundary of ['directory-sync','winner-validation'] as const) test(`host restart blocks writes after ${boundary} plus investigation failure`,async()=>{
 process.env.ESIGN_LOCAL_HOST='true';process.env.ESIGN_UPLOAD_SEAL='YES';delete process.env.ESIGN_SYNTHETIC_ALTERNATE_PORTS;
 const {startLocalHost}=await import('../scripts/local-host.ts');let instance='',server:ReturnType<typeof startLocalHost>|undefined;let restarted:ReturnType<typeof spawn>|undefined;
 const log=console.log;console.log=(...args:unknown[])=>{const line=args.join(' ');if(line.startsWith('Uploaded instance (retain for restart): '))instance=line.slice(line.indexOf(': ')+2);};
 try {
  const fail=()=>{mkdirSync(join(instance,'upload-investigate'));throw new Error('injected publication failure');};
  const fault=boundary==='directory-sync'?{afterSafeLink:fail}:{beforeSafeWinnerValidation:fail};
  server=startLocalHost('local-test-key-0123456789-abcdefghijklmnopqrstuvwxyz',{port:0,onUploadCompletionSafeMarker:fault});await once(server,'listening');
  const req=(path:string,init:RequestInit={})=>fetch(`http://127.0.0.1:${(server!.address() as import('node:net').AddressInfo).port}/host/upload`+path,{...init,headers:{'x-local-esign':'1',origin:'http://127.0.0.1:5173',...init.headers}});
  const pdf=await PDFDocument.create();pdf.addPage();const made=await (await req('/create',{method:'POST',headers:{'content-type':'application/pdf'},body:await pdf.save()})).json() as {id:string};
  const complete={method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({authorizeDisclosure:true})};
  const failed=await req(`/envelopes/${made.id}/complete`,complete);assert.equal(failed.status,503);
  // Only remove our test-owned obstruction, not the start/safe evidence under investigation.
  await rm(join(instance,'upload-investigate'),{recursive:true});
  const markerNames=(await readdir(instance)).filter(name=>/^upload-(?:inspect|check)-/.test(name)).sort();
  assert.ok(markerNames.some(name=>name.startsWith('upload-inspect-ok-')));
  const markerContents=await Promise.all(markerNames.map(name=>readFile(join(instance,name))));
  assert.equal(((await (await req(`/envelopes/${made.id}`)).json()) as {sealStatus:string}).sealStatus,'INVESTIGATE');
  assert.equal((await req(`/envelopes/${made.id}/process`,{method:'POST'})).status,503);
  process.env.ESIGN_UPLOAD_INSTANCE=instance;await new Promise<void>(r=>server!.close(()=>r()));server=undefined;await new Promise(r=>setTimeout(r,300));
  restarted=spawn(process.execPath,[fileURLToPath(new URL('./helpers/upload-readonly-resume-child.ts',import.meta.url))],{stdio:['ignore','pipe','pipe'],env:{...process.env,ESIGN_UPLOAD_INSTANCE:instance}});
  const output=await Promise.race([once(restarted.stdout!,'data').then(v=>v[0].toString()),once(restarted,'exit').then(()=>{throw new Error('restart child exited');})]);
  const port=/PORT (\d+)/.exec(output)?.[1];assert.ok(port);
  const restartedReq=(path:string,init:RequestInit={})=>fetch(`http://127.0.0.1:${port}/host/upload`+path,{...init,headers:{'x-local-esign':'1',origin:'http://127.0.0.1:5173',...init.headers}});
  const resumed=await restartedReq('/resume',{method:'POST'});assert.equal(resumed.status,200);
  const resumedBody=await resumed.json() as {sealStatus:string;readOnly:boolean};assert.equal(resumedBody.sealStatus,'INVESTIGATE');assert.equal(resumedBody.readOnly,true);
  assert.equal(((await (await restartedReq(`/envelopes/${made.id}`)).json()) as {sealStatus:string}).sealStatus,'INVESTIGATE');
  assert.equal((await restartedReq(`/envelopes/${made.id}/process`,{method:'POST'})).status,503);
  assert.equal((await restartedReq(`/envelopes/${made.id}/complete`,complete)).status,503);
  assert.equal((await restartedReq(`/envelopes/${made.id}/final-pdf`)).status,404);
  assert.deepEqual((await readdir(instance)).filter(name=>/^upload-(?:inspect|check)-/.test(name)).sort(),markerNames);
  assert.deepEqual(await Promise.all(markerNames.map(name=>readFile(join(instance,name)))),markerContents);
 } finally {if(restarted && restarted.exitCode===null && restarted.signalCode===null){const exited=once(restarted,'exit');restarted.kill('SIGTERM');await exited;}if(server){await new Promise<void>(r=>server!.close(()=>r()));await new Promise(r=>setTimeout(r,300));}console.log=log;if(instance)await rm(instance,{recursive:true,force:true});delete process.env.ESIGN_LOCAL_HOST;delete process.env.ESIGN_UPLOAD_SEAL;delete process.env.ESIGN_UPLOAD_INSTANCE;}
});


test('even an untouched unsigned upload becomes read-only after resume',async()=>{
 process.env.ESIGN_LOCAL_HOST='true';process.env.ESIGN_UPLOAD_SEAL='YES';delete process.env.ESIGN_SYNTHETIC_ALTERNATE_PORTS;
 const {startLocalHost}=await import('../scripts/local-host.ts');let instance='',server:ReturnType<typeof startLocalHost>|undefined;
 const log=console.log;console.log=(...args:unknown[])=>{const line=args.join(' ');if(line.startsWith('Uploaded instance (retain for restart): '))instance=line.slice(line.indexOf(': ')+2);};
 try {
  server=startLocalHost('local-test-key-0123456789-abcdefghijklmnopqrstuvwxyz',{port:0});await once(server,'listening');
  const req=(path:string,init:RequestInit={})=>fetch(`http://127.0.0.1:${(server!.address() as import('node:net').AddressInfo).port}/host/upload`+path,{...init,headers:{'x-local-esign':'1',origin:'http://127.0.0.1:5173',...init.headers}});
  const pdf=await PDFDocument.create();pdf.addPage();const made=await (await req('/create',{method:'POST',headers:{'content-type':'application/pdf'},body:await pdf.save()})).json() as {id:string};
  assert.equal(((await (await req(`/envelopes/${made.id}`)).json()) as {sealStatus:string}).sealStatus,'NOT_SEALED');
  process.env.ESIGN_UPLOAD_INSTANCE=instance;await new Promise<void>(r=>server!.close(()=>r()));server=undefined;await new Promise(r=>setTimeout(r,300));
  server=startLocalHost('local-test-key-0123456789-abcdefghijklmnopqrstuvwxyz',{port:0});await once(server,'listening');
  assert.equal((await req('/resume',{method:'POST'})).status,200);
  assert.equal(((await (await req(`/envelopes/${made.id}`)).json()) as {sealStatus:string}).sealStatus,'INVESTIGATE');
  for(const suffix of ['/process','/finalize','/v1/page-sessions/exchange','/v1/signing/otp','/v1/signing/otp/verify','/v1/signing/sign'])assert.equal((await req(`/envelopes/${made.id}`+suffix,{method:'POST'})).status,503,suffix);
 } finally {if(server){await new Promise<void>(r=>server!.close(()=>r()));await new Promise(r=>setTimeout(r,300));}console.log=log;if(instance)await rm(instance,{recursive:true,force:true});delete process.env.ESIGN_LOCAL_HOST;delete process.env.ESIGN_UPLOAD_SEAL;delete process.env.ESIGN_UPLOAD_INSTANCE;}
});
