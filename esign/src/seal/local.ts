import { buildEvidenceManifest, commitSeal, type SignatureRow } from './evidence.ts';
/** Fake HMAC adapters for local tests only; neither a managed KMS nor an external TSA. */
const text = new TextEncoder();
const hex = (value:ArrayBuffer) => Array.from(new Uint8Array(value),n=>n.toString(16).padStart(2,'0')).join('');
const digest = async (value:ArrayBuffer) => hex(await crypto.subtle.digest('SHA-256',value));
async function mac(key:Uint8Array, value:string):Promise<string> {
  if(key.length<32) throw new Error('Local test seal key too short');
  const imported=await crypto.subtle.importKey('raw',Uint8Array.from(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return hex(await crypto.subtle.sign('HMAC',imported,text.encode(value)));
}
export type LocalTestSeal = {mode:'LOCAL_TEST_ONLY';manifest:string;testKmsMac:string;testTsaMac:string;syntheticTimestampMs:number};
export async function makeLocalTestSeal(manifest:string,key:Uint8Array,syntheticTimestampMs:number):Promise<LocalTestSeal> {
  if(!Number.isSafeInteger(syntheticTimestampMs)) throw new Error('Invalid synthetic timestamp');
  const testKmsMac=await mac(key,`local-test-kms-v1\n${manifest}`);
  const testTsaMac=await mac(key,`local-test-tsa-v1\n${syntheticTimestampMs}\n${testKmsMac}`);
  return {mode:'LOCAL_TEST_ONLY',manifest,testKmsMac,testTsaMac,syntheticTimestampMs};
}
export async function verifyLocalTestSeal(seal:LocalTestSeal,key:Uint8Array):Promise<boolean> {
  if(!seal || seal.mode!=='LOCAL_TEST_ONLY' || typeof seal.manifest!=='string' || !Number.isSafeInteger(seal.syntheticTimestampMs) || !/^[a-f0-9]{64}$/.test(seal.testKmsMac) || !/^[a-f0-9]{64}$/.test(seal.testTsaMac)) return false;
  const imported=await crypto.subtle.importKey('raw',Uint8Array.from(key),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  const bytes=(s:string)=>new Uint8Array(s.match(/../g)!.map(x=>parseInt(x,16)));
  return await crypto.subtle.verify('HMAC',imported,bytes(seal.testKmsMac),text.encode(`local-test-kms-v1\n${seal.manifest}`)) &&
    await crypto.subtle.verify('HMAC',imported,bytes(seal.testTsaMac),text.encode(`local-test-tsa-v1\n${seal.syntheticTimestampMs}\n${seal.testKmsMac}`));
}
export async function finalizeLocalTestEvidence(db:D1Database,bucket:R2Bucket,tenantId:string,envelopeId:string,key:Uint8Array,verifyOnly=false):Promise<{source:{id:string;object_key:string;sha256:string};signatures:SignatureRow[];finalArtifactId:string;finalSha256:string}|void> {
  const {source,signatures,finalArtifactId,finalSha256,manifest}=await buildEvidenceManifest(db,bucket,tenantId,envelopeId);
  const seal=await makeLocalTestSeal(manifest,key,signatures[signatures.length-1].consented_at);
  if(!await verifyLocalTestSeal(seal,key)) throw new Error('Test seal verification failed');
  const bytes=text.encode(JSON.stringify(seal)), hash=await digest(bytes.buffer), objectKey=`envelopes/${envelopeId}/local-test-evidence.json`;
  if (verifyOnly) {
    const evidence=await db.prepare("SELECT object_key,sha256 FROM seals WHERE envelope_id=? AND mode='LOCAL_TEST'").bind(envelopeId).first<{object_key:string;sha256:string}>();
    const object=evidence && await bucket.get(evidence.object_key);
    if (!evidence || evidence.object_key!==objectKey || evidence.sha256!==hash || !object || await digest(await object.arrayBuffer())!==hash) throw new Error('Evidence integrity failure');
    return {source,signatures,finalArtifactId,finalSha256};
  }
  const stored=await bucket.put(objectKey,bytes,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}});
  if(!stored) {const previousObject=await bucket.get(objectKey);if(!previousObject || await digest(await previousObject.arrayBuffer())!==hash) throw new Error('Evidence conflict');}
  await commitSeal(db,tenantId,envelopeId,{mode:'LOCAL_TEST',objectKey,sha256:hash});
}
