import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

test('SIGKILL during upload preflight keeps the real host fail-closed on restart',async()=>{
 const child=spawn(process.execPath,[fileURLToPath(new URL('./helpers/upload-host-preflight-crash-child.ts',import.meta.url))],{stdio:['ignore','pipe','pipe']});
 let instance='',id='';let server:ReturnType<typeof import('../scripts/local-host.ts').startLocalHost>|undefined;
 try {
  const lines=createInterface({input:child.stdout});
  for await(const line of lines){if(line.startsWith('INSTANCE '))instance=line.slice(9);if(line.startsWith('ENVELOPE '))id=line.slice(9);if(line==='CHECKING')break;}
  assert.ok(instance);assert.ok(id);child.kill('SIGKILL');assert.equal((await once(child,'exit'))[1],'SIGKILL');
  process.env.ESIGN_LOCAL_HOST='true';process.env.ESIGN_UPLOAD_SEAL='YES';process.env.ESIGN_UPLOAD_INSTANCE=instance;delete process.env.ESIGN_SYNTHETIC_ALTERNATE_PORTS;
  const {startLocalHost}=await import('../scripts/local-host.ts');server=startLocalHost('local-test-key-0123456789-abcdefghijklmnopqrstuvwxyz',{port:0});await once(server,'listening');
  const url=`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/host/upload`;
  const headers={'x-local-esign':'1',origin:'http://127.0.0.1:5173'};
  assert.equal((await fetch(url+'/resume',{method:'POST',headers})).status,200);
  const status=await (await fetch(url+`/envelopes/${id}`,{headers})).json() as {sealStatus:string};assert.equal(status.sealStatus,'INVESTIGATE');
  assert.equal((await fetch(url+`/envelopes/${id}/process`,{method:'POST',headers})).status,503);
  assert.equal((await fetch(url+`/envelopes/${id}/complete`,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({authorizeDisclosure:true})})).status,503);
 } finally {if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');if(server){await new Promise<void>(r=>server!.close(()=>r()));await new Promise(r=>setTimeout(r,300));}if(instance)await rm(instance,{recursive:true,force:true});delete process.env.ESIGN_LOCAL_HOST;delete process.env.ESIGN_UPLOAD_SEAL;delete process.env.ESIGN_UPLOAD_INSTANCE;}
});

test('investigation marker write failure preserves preflight lock through host restart',async()=>{
 const {PDFDocument}=await import('pdf-lib');const {mkdir}=await import('node:fs/promises');const {join}=await import('node:path');
 process.env.ESIGN_LOCAL_HOST='true';process.env.ESIGN_UPLOAD_SEAL='YES';delete process.env.ESIGN_SYNTHETIC_ALTERNATE_PORTS;
 const {startLocalHost}=await import('../scripts/local-host.ts');let instance='',server:ReturnType<typeof startLocalHost>|undefined;
 const log=console.log;console.log=(...args:unknown[])=>{const line=args.join(' ');if(line.startsWith('Uploaded instance (retain for restart): '))instance=line.slice(line.indexOf(': ')+2);};
 try {
  server=startLocalHost('local-test-key-0123456789-abcdefghijklmnopqrstuvwxyz',{port:0,onUploadPreflight:async()=>{await mkdir(join(instance,'upload-investigate'));throw new Error('synthetic integrity failure');}});await once(server,'listening');
  const req=(path:string,init:RequestInit={})=>fetch(`http://127.0.0.1:${(server!.address() as import('node:net').AddressInfo).port}/host/upload`+path,{...init,headers:{'x-local-esign':'1',origin:'http://127.0.0.1:5173',...init.headers}});
  const pdf=await PDFDocument.create();pdf.addPage();const made=await (await req('/create',{method:'POST',headers:{'content-type':'application/pdf'},body:await pdf.save()})).json() as {id:string};
  const complete={method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({authorizeDisclosure:true})};
  assert.equal((await req(`/envelopes/${made.id}/complete`,complete)).status,503);
  // Remove only the deliberately inserted test obstruction; the durable preflight evidence remains untouched.
  await rm(join(instance,'upload-investigate'),{recursive:true});
  assert.equal(((await (await req(`/envelopes/${made.id}`)).json()) as {sealStatus:string}).sealStatus,'INVESTIGATE');
  process.env.ESIGN_UPLOAD_INSTANCE=instance;await new Promise<void>(r=>server!.close(()=>r()));server=undefined;await new Promise(r=>setTimeout(r,300));
  server=startLocalHost('local-test-key-0123456789-abcdefghijklmnopqrstuvwxyz',{port:0});await once(server,'listening');
  assert.equal((await req('/resume',{method:'POST'})).status,200);
  assert.equal(((await (await req(`/envelopes/${made.id}`)).json()) as {sealStatus:string}).sealStatus,'INVESTIGATE');
  assert.equal((await req(`/envelopes/${made.id}/process`,{method:'POST'})).status,503);
 } finally {if(server){await new Promise<void>(r=>server!.close(()=>r()));await new Promise(r=>setTimeout(r,300));}console.log=log;if(instance)await rm(instance,{recursive:true,force:true});delete process.env.ESIGN_LOCAL_HOST;delete process.env.ESIGN_UPLOAD_SEAL;delete process.env.ESIGN_UPLOAD_INSTANCE;}
});
