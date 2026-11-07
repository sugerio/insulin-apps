import { canonicalSignatureEvent, type PositionedSignatureEvent } from './signature-event.ts';
import { validatePositionedSnapshot } from './positioned-signature-snapshot.ts';
import {canonicalPositionedV3,validatePositionedV3,type PositionedV3Snapshot} from './positioned-v3-snapshot.ts';
import {processPositionedV3Job} from './positioned-v3-processing.ts';
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
type Row={id:string;sequence:number;task_id:string;recipient_name:string;input_artifact_id:string;input_sha256:string;otp_verified_at:number;consented_at:number;previous_hash:string;event_hash:string;artifact_id:string;object_key:string;sha256:string};
/**
 * The evidence manifest of a finished envelope, rebuilt from its stored records after checking
 * the whole chain: the source, each signature event and output, and the files' hashes. Sealed
 * by the local HMAC test seal below or by the managed KMS + TSA seal (managed-evidence.ts).
 */
export async function buildEvidenceManifest(db:D1Database,bucket:R2Bucket,tenantId:string,envelopeId:string,allowSyntheticCompleted=false) {
  const envelope=await db.prepare('SELECT status FROM envelopes WHERE id=? AND tenant_id=?').bind(envelopeId,tenantId).first<{status:string}>();
  if (!envelope || !(['FINALIZING','COMPLETED'].includes(envelope.status) || (allowSyntheticCompleted && envelope.status==='SYNTHETIC_TSA_TEST_COMPLETED'))) throw new Error('Envelope not finalizable');
  const d0=await db.prepare('SELECT id,object_key,sha256 FROM artifacts WHERE envelope_id=?').bind(envelopeId).first<{id:string;object_key:string;sha256:string}>();
  const tasks=await db.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN status=\'SIGNED\' THEN 1 ELSE 0 END) AS signed FROM tasks WHERE envelope_id=?').bind(envelopeId).first<{total:number;signed:number}>();
  const rows=(await db.prepare(`SELECT r.id,r.sequence,r.task_id,r.recipient_name,r.input_artifact_id,r.input_sha256,r.otp_verified_at,r.consented_at,e.previous_hash,e.event_hash,o.artifact_id,o.object_key,o.sha256
    FROM signature_records r JOIN signature_events e ON e.signature_id=r.id AND e.envelope_id=r.envelope_id AND e.sequence=r.sequence
    JOIN signature_jobs j ON j.signature_id=r.id AND j.status='DONE' JOIN signature_outputs o ON o.job_id=j.id
    WHERE r.envelope_id=? ORDER BY r.sequence`).bind(envelopeId).all<Row>()).results;
  if(!d0 || !tasks || tasks.total<1 || tasks.total!==tasks.signed || rows.length!==tasks.total) throw new Error('Incomplete signing');
  const verifyFile=async (objectKey:string,hash:string) => {const object=await bucket.get(objectKey);if(!object || await digest(await object.arrayBuffer())!==hash) throw new Error('Artifact integrity failure');};
  await verifyFile(d0.object_key,d0.sha256);
  let previous='', inputId=d0.id, inputHash=d0.sha256;
  const positionedSignatures:{signatureId:string;payload:PositionedSignatureEvent}[]=[];
  const positionedV3:{signatureId:string;payload:PositionedV3Snapshot}[]=[];
  const syntheticV3Guards:{signatureId:string;role:string;payloadJson:string;inputObjectKey:string;inputPageCount:number;sessionHash:string;otpRecipientEmail:string}[]=[];
  for(const [i,row] of rows.entries()) {
    if(row.sequence!==i+1 || row.previous_hash!==previous || row.input_artifact_id!==inputId || row.input_sha256!==inputHash) throw new Error('Invalid signature chain');
    const version=await db.prepare('SELECT e.event_version,p.payload_json,p.input_page_count FROM signature_events e LEFT JOIN positioned_signature_inputs p ON p.signature_id=e.signature_id WHERE e.signature_id=?').bind(row.id).first<{event_version:number;payload_json:string|null;input_page_count:number|null}>();
    if(!version||![1,2,3].includes(version.event_version))throw new Error('Unknown event version');
    let payload:PositionedSignatureEvent|undefined;
    if(version.event_version===2){
      if(!version.payload_json)throw new Error('Missing positioned evidence');payload=validatePositionedSnapshot(JSON.parse(version.payload_json),version.input_page_count??0);
      for(const field of payload.fields){if(!field||typeof field.id!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(field.id)||typeof field.imageHash!=='string'||!/^[a-f0-9]{64}$/.test(field.imageHash))throw new Error('Invalid image evidence');await verifyFile(`envelopes/${envelopeId}/signature-images/${row.id}/${field.id}.png`,field.imageHash);}
      positionedSignatures.push({signatureId:row.id,payload});
    }else if(version.event_version===3){
      if(!version.payload_json)throw new Error('Missing v3 evidence');const snapshot=validatePositionedV3(JSON.parse(version.payload_json),version.input_page_count??0,row.consented_at);
      if(allowSyntheticCompleted){
        const task=await db.prepare('SELECT role,status,recipient_name FROM tasks WHERE id=? AND envelope_id=?').bind(row.task_id,envelopeId).first<{role:string;status:string;recipient_name:string}>();
        const capture=await db.prepare('SELECT input_object_key FROM positioned_signature_inputs WHERE signature_id=?').bind(row.id).first<{input_object_key:string}>();
        const historical=await db.prepare(`SELECT r.session_hash,r.otp_recipient_email FROM signature_records r
          JOIN recipient_page_sessions s ON s.token_hash=r.session_hash AND s.task_id=r.task_id AND s.envelope_id=r.envelope_id AND s.tenant_id=?
          JOIN recipient_otp_verifications v ON v.task_id=r.task_id AND v.session_hash=s.token_hash AND v.verified_at=r.otp_verified_at AND v.recipient_email=r.otp_recipient_email COLLATE BINARY
          JOIN tasks t ON t.id=r.task_id AND t.envelope_id=r.envelope_id AND t.recipient_email=v.recipient_email COLLATE BINARY WHERE r.id=? AND r.envelope_id=?`).bind(tenantId,row.id,envelopeId).first<{session_hash:string;otp_recipient_email:string}>();
        if(!task||task.role!==snapshot.role||task.status!=='SIGNED'||task.recipient_name!==row.recipient_name||!capture||!version.input_page_count||!historical?.session_hash||!historical.otp_recipient_email)throw new Error('Synthetic v3 signer mismatch');
        syntheticV3Guards.push({signatureId:row.id,role:task.role,payloadJson:version.payload_json,inputObjectKey:capture.input_object_key,inputPageCount:version.input_page_count,sessionHash:historical.session_hash,otpRecipientEmail:historical.otp_recipient_email});
      }
      const job=await db.prepare("SELECT id FROM signature_jobs WHERE signature_id=? AND status='DONE'").bind(row.id).first<{id:string}>();if(!job)throw new Error('Missing v3 job');await processPositionedV3Job(db,bucket,job.id);positionedV3.push({signatureId:row.id,payload:snapshot});
    }else if(version.payload_json!==null)throw new Error('Unexpected positioned evidence');
    const event={envelopeId,sequence:row.sequence,previousHash:previous,signatureId:row.id,taskId:row.task_id,recipientName:row.recipient_name,artifactId:row.input_artifact_id,artifactHash:row.input_sha256,otpVerifiedAt:row.otp_verified_at,consentedAt:row.consented_at};
    const canonical=version.event_version===3?canonicalPositionedV3(event,positionedV3[positionedV3.length-1].payload):canonicalSignatureEvent(event,payload);
    if(await digest(text.encode(canonical).buffer)!==row.event_hash) throw new Error('Invalid event hash');
    await verifyFile(row.object_key,row.sha256);previous=row.event_hash;inputId=row.artifact_id;inputHash=row.sha256;
  }
  if(positionedV3.length&&positionedV3.length!==rows.length)throw new Error('Mixed v3 event versions');
  const manifest=positionedV3.length?JSON.stringify({format:'esign-local-test-manifest-v3',envelopeId,source:d0,signatures:rows,finalArtifactId:inputId,finalSha256:inputHash,positionedSignatures:positionedV3}):JSON.stringify({format:positionedSignatures.length?'esign-local-test-manifest-v2':'esign-local-test-manifest-v1',envelopeId,source:d0,signatures:rows,finalArtifactId:inputId,finalSha256:inputHash,...(positionedSignatures.length?{positionedSignatures}:{})});
  return {source:d0,signatures:rows,finalArtifactId:inputId,finalSha256:inputHash,manifest,syntheticV3Guards};
}
export async function prepareLocalTestEvidence(db:D1Database,bucket:R2Bucket,tenantId:string,envelopeId:string,key:Uint8Array,allowSyntheticCompleted=false) {
  const {source:d0,signatures:rows,finalArtifactId:inputId,finalSha256:inputHash,manifest,syntheticV3Guards}=await buildEvidenceManifest(db,bucket,tenantId,envelopeId,allowSyntheticCompleted);
  const seal=await makeLocalTestSeal(manifest,key,rows[rows.length-1].consented_at);
  if(!await verifyLocalTestSeal(seal,key)) throw new Error('Test seal verification failed');
  const bytes=text.encode(JSON.stringify(seal)), hash=await digest(bytes.buffer), objectKey=`envelopes/${envelopeId}/local-test-evidence.json`;
  return {source:d0,signatures:rows,finalArtifactId:inputId,finalSha256:inputHash,seal,bytes,hash,objectKey,syntheticV3Guards};
}
export async function finalizeLocalTestEvidence(db:D1Database,bucket:R2Bucket,tenantId:string,envelopeId:string,key:Uint8Array,verifyOnly=false):Promise<{source:{id:string;object_key:string;sha256:string};signatures:Row[];finalArtifactId:string;finalSha256:string}|void> {
  const {source,signatures,finalArtifactId,finalSha256,bytes,hash,objectKey}=await prepareLocalTestEvidence(db,bucket,tenantId,envelopeId,key);
  if (verifyOnly) {
    const evidence=await db.prepare('SELECT object_key,sha256 FROM local_test_evidence WHERE envelope_id=?').bind(envelopeId).first<{object_key:string;sha256:string}>();
    const object=evidence && await bucket.get(evidence.object_key);
    if (!evidence || evidence.object_key!==objectKey || evidence.sha256!==hash || !object || await digest(await object.arrayBuffer())!==hash) throw new Error('Evidence integrity failure');
    return {source,signatures,finalArtifactId,finalSha256};
  }
  const stored=await bucket.put(objectKey,bytes,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}});
  if(!stored) {const previousObject=await bucket.get(objectKey);if(!previousObject || await digest(await previousObject.arrayBuffer())!==hash) throw new Error('Evidence conflict');}
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO local_test_evidence SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM envelopes WHERE id=? AND tenant_id=? AND status IN ('FINALIZING','COMPLETED'))").bind(envelopeId,objectKey,hash,envelopeId,tenantId),
    db.prepare("UPDATE envelopes SET status='COMPLETED' WHERE id=? AND tenant_id=? AND status='FINALIZING' AND EXISTS (SELECT 1 FROM local_test_evidence WHERE envelope_id=? AND object_key=? AND sha256=?)").bind(envelopeId,tenantId,envelopeId,objectKey,hash),
    db.prepare("INSERT INTO recipient_auth_assertions SELECT CASE WHEN EXISTS (SELECT 1 FROM envelopes e JOIN local_test_evidence v ON v.envelope_id=e.id WHERE e.id=? AND e.tenant_id=? AND e.status='COMPLETED' AND v.object_key=? AND v.sha256=?) THEN 1 ELSE 0 END").bind(envelopeId,tenantId,objectKey,hash),
    db.prepare('DELETE FROM recipient_auth_assertions'),
  ]);
}
