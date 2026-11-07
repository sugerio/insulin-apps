import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createIsolatedSyntheticEnvelope} from '../scripts/synthetic-seal-isolated.ts';
import {rm} from 'node:fs/promises';

test('isolated generated envelope binds the actual interactive signing facts and refuses arbitrary management input',async()=>{
 let instance=await createIsolatedSyntheticEnvelope();
 const directory=instance.directory;
 try {
  assert.equal((await instance.request('/v1/templates',{method:'POST'})).status,403);
  assert.equal((await instance.request('/v1/envelopes/other')).status,403);
  await assert.rejects(instance.evidence(),/incomplete/i);
  const details=await (await instance.request(`/v1/envelopes/${instance.envelopeId}`)).json() as {tasks:{id:string}[]};
  const json=(body:unknown)=>({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  for(const task of details.tasks){
   const view=await (await instance.request(`/v1/envelopes/${instance.envelopeId}/tasks/${task.id}/recipient-view`,json({origin:'http://127.0.0.1:5173'}))).json() as {code:string};
   const session=await (await instance.request('/v1/page-sessions/exchange',json({code:view.code}))).json() as {token:string};
   const headers={authorization:`Bearer ${session.token}`};
   const sent=await (await instance.request('/v1/signing/otp',{method:'POST',headers})).json() as {testOtp:string};
   assert.equal((await instance.request('/v1/signing/otp/verify',{...json({otp:sent.testOtp}),headers:{...headers,'content-type':'application/json'}})).status,204);
   const artifact=await (await instance.request('/v1/signing/current',{headers})).json() as {id:string;sha256:string};
   assert.equal((await instance.request('/v1/signing/sign',{...json({artifactId:artifact.id,artifactHash:artifact.sha256,consent:true}),headers:{...headers,'content-type':'application/json'}})).status,202);
   assert.equal((await instance.request(`/v1/envelopes/${instance.envelopeId}/process`,{method:'POST'})).status,204);
  }
  assert.equal((await instance.request(`/v1/envelopes/${instance.envelopeId}/finalize`,{method:'POST'})).status,204);
  const evidence=await instance.evidence();assert.equal(evidence.envelopeId,instance.envelopeId);assert.equal(evidence.artifacts.length,4);assert.equal(evidence.signatures.length,2);
  await instance.dispose();
  instance=await createIsolatedSyntheticEnvelope(directory);
  const restored=await instance.evidence();assert.equal(restored.envelopeId,evidence.envelopeId);assert.deepEqual(restored.artifacts,evidence.artifacts);
 } finally {await instance.dispose();await rm(directory,{recursive:true,force:true});}
});

test('uploaded instance accepts only bounded valid PDFs and keeps envelopes isolated',async()=>{
 const {createIsolatedUploadedEnvelope}=await import('../scripts/synthetic-seal-isolated.ts');
 const {PDFDocument}=await import('pdf-lib');
 const p=await PDFDocument.create();p.addPage();const bytes=await p.save();
 await assert.rejects(createIsolatedUploadedEnvelope(new Uint8Array([1,2,3])));
 await assert.rejects(createIsolatedUploadedEnvelope(new Uint8Array(1024*1024+1)));
 const a=await createIsolatedUploadedEnvelope(bytes),b=await createIsolatedUploadedEnvelope(bytes);
 try {
  assert.notEqual(a.envelopeId,b.envelopeId);
  assert.equal((await a.request(`/v1/envelopes/${b.envelopeId}`)).status,403);
  assert.equal((await b.request(`/v1/envelopes/${a.envelopeId}`)).status,403);
  await assert.rejects(a.evidence(),/incomplete/i);
 } finally {await a.dispose();await b.dispose();await rm(a.directory,{recursive:true,force:true});await rm(b.directory,{recursive:true,force:true});}
});
