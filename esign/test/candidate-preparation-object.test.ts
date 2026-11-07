import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare} from 'miniflare';
import {putCandidatePreparationObject} from '../src/candidate-preparation-object.ts';

test('candidate preparation object is create-only, verifies bytes and permits exact retry',async()=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response()}}',r2Buckets:['ARTIFACTS']});
 try {
  const bucket=await mf.getR2Bucket('ARTIFACTS') as unknown as R2Bucket;
  const bytes=new TextEncoder().encode('synthetic D0');
  const hash=Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
  assert.equal(await putCandidatePreparationObject(bucket,'candidate/d0',bytes,hash),hash);
  assert.equal(await putCandidatePreparationObject(bucket,'candidate/d0',bytes,hash),hash);
  await assert.rejects(putCandidatePreparationObject(bucket,'candidate/d0',new TextEncoder().encode('different'),hash));
  const other=new TextEncoder().encode('different');
  const otherHash=Buffer.from(await crypto.subtle.digest('SHA-256',other)).toString('hex');
  await assert.rejects(putCandidatePreparationObject(bucket,'candidate/d0',other,otherHash));
  assert.deepEqual(new Uint8Array(await (await bucket.get('candidate/d0'))!.arrayBuffer()),bytes);
  const results=await Promise.allSettled([putCandidatePreparationObject(bucket,'candidate/race',bytes,hash),putCandidatePreparationObject(bucket,'candidate/race',other,otherHash)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.filter(r=>r.status==='rejected').length,1);
 } finally {await mf.dispose();}
});

test('candidate preparation object rejects replacement after conditional write',async()=>{
 const bytes=new TextEncoder().encode('synthetic D0');
 const hash=Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
 const bucket={put:async()=>({}),get:async()=>({size:5,arrayBuffer:async()=>new TextEncoder().encode('other').buffer})} as unknown as R2Bucket;
 await assert.rejects(putCandidatePreparationObject(bucket,'candidate/d0',bytes,hash));
});
