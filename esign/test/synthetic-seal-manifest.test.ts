import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSyntheticFixture } from '../scripts/synthetic-seal-fixture.ts';
import { createManifest, verifyManifest, createUploadedManifest } from '../scripts/synthetic-seal-manifest.ts';

const keyHash='a'.repeat(64);
test('manifest binds all fixed fixture artifacts and signing facts, and rejects tampering',async()=>{
  const fixture=await createSyntheticFixture();
  const manifest=createManifest(fixture,keyHash);
  assert.equal(verifyManifest(manifest,fixture.artifacts,keyHash),true);
  for(let i=0;i<4;i++) {
    const artifacts=fixture.artifacts.map(x=>Uint8Array.from(x));artifacts[i][0]^=1;
    assert.throws(()=>verifyManifest(manifest,artifacts,keyHash));
  }
  const changed=JSON.parse(manifest);changed.signatures[0].consented_at++;
  assert.throws(()=>verifyManifest(JSON.stringify(changed),fixture.artifacts,keyHash));
  assert.throws(()=>verifyManifest(manifest,fixture.artifacts,'b'.repeat(64)));
  assert.throws(()=>verifyManifest(manifest+' ',fixture.artifacts,keyHash));
  const extended=JSON.parse(manifest);extended.unexpected=true;
  assert.throws(()=>verifyManifest(JSON.stringify(extended),fixture.artifacts,keyHash));
  assert.equal(createHash('sha256').update(manifest).digest('hex').length,64);
});

test('uploaded envelope manifest binds artifacts without claiming synthetic provenance',async()=>{
  const {createUploadedManifest,verifyUploadedManifest}=await import('../scripts/synthetic-seal-manifest.ts');
  const fixture=await createSyntheticFixture();
  const manifest=createUploadedManifest(fixture,keyHash);
  const parsed=JSON.parse(manifest);
  assert.equal(parsed.format,'esign-uploaded-envelope-manifest-v1');
  assert.equal(parsed.syntheticOnly,undefined);
  assert.equal(verifyUploadedManifest(manifest,fixture.artifacts,keyHash),true);
  assert.throws(()=>verifyManifest(manifest,fixture.artifacts,keyHash));
  assert.throws(()=>verifyUploadedManifest(createManifest(fixture,keyHash),fixture.artifacts,keyHash));
  const altered=JSON.parse(manifest); altered.envelopeId='another-envelope';
  assert.throws(()=>verifyUploadedManifest(JSON.stringify(altered),fixture.artifacts,keyHash));
  for(let i=0;i<4;i++) {
    const artifacts=fixture.artifacts.map(x=>Uint8Array.from(x)); artifacts[i][0]^=1;
    assert.throws(()=>verifyUploadedManifest(manifest,artifacts,keyHash));
  }
});

test('real KMS/TSA manifest rejects positioned v2 events before remote sealing',async()=>{
 const {canonicalSignatureEvent}=await import('../src/signature-event.ts');const {createHash}=await import('node:crypto');
 const fixture=await createSyntheticFixture();const row=fixture.signatures[0];const field={id:'a',type:'Signature',role:'ana',page:1,required:true,rect:{x:.1,y:.2,width:.3,height:.1}};
 const event=canonicalSignatureEvent({envelopeId:fixture.envelopeId,sequence:row.sequence,previousHash:row.previous_hash,signatureId:row.id,taskId:row.task_id,recipientName:row.recipient_name,artifactId:row.input_artifact_id,artifactHash:row.input_sha256,otpVerifiedAt:row.otp_verified_at,consentedAt:row.consented_at},{role:'ana',font:'local-stroke-v1',fontHash:'b'.repeat(64),templateFields:[field],fields:[{id:'a',page:1,rect:field.rect,text:'ANA',imageHash:'c'.repeat(64)}]});
 const altered={...fixture,signatures:[{...row,event_hash:createHash('sha256').update(event).digest('hex')},fixture.signatures[1]]};
 assert.throws(()=>createUploadedManifest(altered,'0'.repeat(64)),/real sealing supports v1 only/);
});
