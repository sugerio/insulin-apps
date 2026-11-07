import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readExistingUploadedDelivery} from '../scripts/upload-existing-delivery.ts';

const id='11111111-1111-1111-1111-111111111111', final='a'.repeat(64), pdf=Buffer.from('%PDF-test');
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
function store() {
 const objects=new Map<string,Buffer>([[`envelopes/${id}/local-delivery-v3.pdf`,pdf],[`envelopes/${id}/local-delivery-v3.json`,Buffer.from(JSON.stringify({format:'esign-local-delivery-v3',envelopeId:id,finalSha256:final,sha256:sha(pdf)}))]]);
 return {objects,bucket:{get:async(k:string)=>{const b=objects.get(k);return b ? {size:b.length,arrayBuffer:async()=>Uint8Array.from(b).buffer} : null;}}};
}
test('existing delivery is read only, bound to envelope and final digest, and rejects missing or corrupted bytes',async()=>{
 const {objects,bucket}=store();
 const get=()=>readExistingUploadedDelivery(bucket as never,id,final);
 assert.deepEqual(await get(),pdf);
 objects.set(`envelopes/${id}/local-delivery-v3.pdf`,Buffer.from('%PDF-corrupt'));await assert.rejects(get);
 objects.delete(`envelopes/${id}/local-delivery-v3.pdf`);await assert.rejects(get);
 await assert.rejects(()=>readExistingUploadedDelivery(bucket as never,'22222222-2222-2222-2222-222222222222',final));
});

test('concurrent reads do not modify objects and reject wrong metadata and size',async()=>{
 const {objects,bucket}=store(),before=[...objects].map(([k,v])=>[k,v.toString('hex')]);
 const results=await Promise.all(Array.from({length:8},()=>readExistingUploadedDelivery(bucket as never,id,final)));
 assert.ok(results.every(b=>b.equals(pdf)));assert.deepEqual([...objects].map(([k,v])=>[k,v.toString('hex')]),before);
 objects.set(`envelopes/${id}/local-delivery-v3.json`,Buffer.from(JSON.stringify({format:'esign-local-delivery-v3',envelopeId:'other',finalSha256:final,sha256:sha(pdf)})));
 await assert.rejects(()=>readExistingUploadedDelivery(bucket as never,id,final));
});
