/** Internal fixture manifest primitive, not a seal or a command. */
import { createHash } from 'node:crypto';
import type { createSyntheticFixture } from './synthetic-seal-fixture.ts';

type Fixture=Awaited<ReturnType<typeof createSyntheticFixture>>;
const hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const hex=(value:unknown):value is string=>typeof value==='string' && /^[0-9a-f]{64}$/.test(value);
const exact=(value:unknown,keys:string[])=>{
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).sort().join(',')!==keys.slice().sort().join(',')) throw new Error('Manifest schema mismatch');
};
const rowKeys=['id','sequence','task_id','recipient_name','input_artifact_id','input_sha256','otp_verified_at','consented_at','previous_hash','event_hash','artifact_id','object_key','sha256'];

export function createManifest(fixture:Fixture,keyHash:string):string {
  return createTypedManifest(fixture,keyHash,false);
}

export function createUploadedManifest(fixture:Fixture,keyHash:string):string {
  return createTypedManifest(fixture,keyHash,true);
}

function createTypedManifest(fixture:Fixture,keyHash:string,uploaded:boolean):string {
  if(fixture.artifacts.length!==4 || !hex(keyHash)) throw new Error('Invalid fixture');
  const document={format:uploaded ? 'esign-uploaded-envelope-manifest-v1' : 'esign-synthetic-fixture-manifest-v1',canonicalization:'json-stringify-schema-v1',digest:'sha256',kmsAlgorithm:'ECDSA_SHA_256',timestampImprint:'sha256-signature-der',nonceAlgorithm:'sha256-domain-signature-first-16-v1',keyHash,...(uploaded ? {} : {syntheticOnly:true}),envelopeId:fixture.envelopeId,source:fixture.source,signatures:fixture.signatures,artifacts:fixture.artifacts.map((bytes:Uint8Array)=>({sha256:hash(bytes),length:bytes.length}))};
  const manifest=JSON.stringify(document);
  verifyTypedManifest(manifest,fixture.artifacts,keyHash,uploaded);
  return manifest;
}

export function verifyManifest(manifest:string,artifacts:Uint8Array[],keyHash:string):true {
  return verifyTypedManifest(manifest,artifacts,keyHash,false);
}

export function verifyUploadedManifest(manifest:string,artifacts:Uint8Array[],keyHash:string):true {
  return verifyTypedManifest(manifest,artifacts,keyHash,true);
}

function verifyTypedManifest(manifest:string,artifacts:Uint8Array[],keyHash:string,uploaded:boolean):true {
  const m=JSON.parse(manifest);
  exact(m,['format','canonicalization','digest','kmsAlgorithm','timestampImprint','nonceAlgorithm','keyHash',...(uploaded ? [] : ['syntheticOnly']),'envelopeId','source','signatures','artifacts']);
  if(m.format!==(uploaded ? 'esign-uploaded-envelope-manifest-v1' : 'esign-synthetic-fixture-manifest-v1') || m.canonicalization!=='json-stringify-schema-v1' || m.digest!=='sha256' || m.kmsAlgorithm!=='ECDSA_SHA_256' || m.timestampImprint!=='sha256-signature-der' || m.nonceAlgorithm!=='sha256-domain-signature-first-16-v1' || (!uploaded && m.syntheticOnly!==true) || !hex(keyHash) || m.keyHash!==keyHash || typeof m.envelopeId!=='string' || !m.envelopeId) throw new Error('Invalid manifest header');
  exact(m.source,['id','object_key','sha256']);
  if(typeof m.source.id!=='string' || typeof m.source.object_key!=='string' || !hex(m.source.sha256)) throw new Error('Invalid source');
  if(!Array.isArray(m.artifacts) || m.artifacts.length!==4 || artifacts.length!==4 || !Array.isArray(m.signatures) || m.signatures.length!==2) throw new Error('Invalid artifact count');
  for(let i=0;i<4;i++) {
    const item=m.artifacts[i];exact(item,['sha256','length']);
    if(!hex(item.sha256) || !Number.isSafeInteger(item.length) || item.length!==artifacts[i].length || item.sha256!==hash(artifacts[i])) throw new Error('Artifact mismatch');
  }
  if(m.source.sha256!==m.artifacts[0].sha256) throw new Error('Source mismatch');
  let previous='',inputId=m.source.id,inputHash=m.source.sha256;
  for(let i=0;i<2;i++) {
    const row=m.signatures[i];exact(row,rowKeys);
    for(const key of ['id','task_id','recipient_name','input_artifact_id','artifact_id','object_key']) if(typeof row[key]!=='string' || !row[key]) throw new Error('Invalid signature field');
    if(row.sequence!==i+1 || row.previous_hash!==previous || row.input_artifact_id!==inputId || row.input_sha256!==inputHash || !hex(row.event_hash) || !hex(row.sha256) || row.sha256!==m.artifacts[i+1].sha256 || !Number.isSafeInteger(row.otp_verified_at) || !Number.isSafeInteger(row.consented_at) || row.otp_verified_at<=0 || row.consented_at<row.otp_verified_at) throw new Error('Invalid signature chain');
    const event=JSON.stringify(['esign-signature-event-v1',m.envelopeId,row.sequence,previous,row.id,row.task_id,row.recipient_name,row.input_artifact_id,row.input_sha256,row.otp_verified_at,row.consented_at]);
    if(hash(event)!==row.event_hash) throw new Error('Invalid signature event: real sealing supports v1 only, not positioned v2 signatures');
    previous=row.event_hash;inputId=row.artifact_id;inputHash=row.sha256;
  }
  // Reconstruct every object in its defined order; whitespace, duplicate keys and alternate order are rejected.
  const source={id:m.source.id,object_key:m.source.object_key,sha256:m.source.sha256};
  const signatures=m.signatures.map((r:Record<string,unknown>)=>Object.fromEntries(rowKeys.map(k=>[k,r[k]])));
  const canonical=JSON.stringify({format:m.format,canonicalization:m.canonicalization,digest:m.digest,kmsAlgorithm:m.kmsAlgorithm,timestampImprint:m.timestampImprint,nonceAlgorithm:m.nonceAlgorithm,keyHash:m.keyHash,...(uploaded ? {} : {syntheticOnly:m.syntheticOnly}),envelopeId:m.envelopeId,source,signatures,artifacts:m.artifacts.map((a:{sha256:string;length:number})=>({sha256:a.sha256,length:a.length}))});
  if(manifest!==canonical) throw new Error('Noncanonical manifest');
  return true;
}
