import { processSignature } from '../signature-processing.ts';
import { artifactObjectKey, envelopeSignatures, verifySignatureRecord } from '../signatures.ts';
/**
 * What every seal covers and how a seal completes an envelope: the evidence manifest rebuilt and
 * checked from the stored records, and the commit of a seal stored in R2.
 */
const hex = (value:ArrayBuffer) => Array.from(new Uint8Array(value),n=>n.toString(16).padStart(2,'0')).join('');
const digest = async (value:ArrayBuffer) => hex(await crypto.subtle.digest('SHA-256',value));
/** One signature as the certificate shows it (the response of GET /v1/envelopes/:id/certificate). */
export type SignatureRow={id:string;sequence:number;task_id:string;recipient_name:string;input_artifact_id:string;input_sha256:string;otp_verified_at:number;consented_at:number;previous_hash:string;event_hash:string;artifact_id:string;object_key:string;sha256:string};
const MANIFEST_FORMAT='esign-evidence-manifest-v1';
/**
 * The evidence manifest of a finished envelope, rebuilt from its stored signatures after checking
 * the whole chain: the source, each signature's record and event hash, its rendered PDF (rendered
 * again, byte for byte) and the files' hashes. Sealed by the local HMAC test seal (local.ts) or by
 * the managed KMS + TSA seal (managed.ts).
 */
export async function buildEvidenceManifest(db:D1Database,bucket:R2Bucket,tenantId:string,envelopeId:string) {
  const envelope=await db.prepare('SELECT status FROM envelopes WHERE id=? AND tenant_id=?').bind(envelopeId,tenantId).first<{status:string}>();
  if (!envelope || !['FINALIZING','COMPLETED'].includes(envelope.status)) throw new Error('Envelope not finalizable');
  const d0=await db.prepare('SELECT id,object_key,sha256 FROM artifacts WHERE envelope_id=?').bind(envelopeId).first<{id:string;object_key:string;sha256:string}>();
  const tasks=await db.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN status=\'SIGNED\' THEN 1 ELSE 0 END) AS signed FROM tasks WHERE envelope_id=?').bind(envelopeId).first<{total:number;signed:number}>();
  const stored=await envelopeSignatures(db,envelopeId);
  if(!d0 || !tasks || tasks.total<1 || tasks.total!==tasks.signed || stored.length!==tasks.total || stored.some(row=>row.status!=='DONE')) throw new Error('Incomplete signing');
  const verifyFile=async (objectKey:string,hash:string) => {const object=await bucket.get(objectKey);if(!object || await digest(await object.arrayBuffer())!==hash) throw new Error('Artifact integrity failure');};
  await verifyFile(d0.object_key,d0.sha256);
  let previous:string|null=null, inputId=d0.id, inputHash=d0.sha256;
  const rows:SignatureRow[]=[], records:{signatureId:string;facts:unknown;render:unknown}[]=[];
  for(const [i,row] of stored.entries()) {
    if(row.sequence!==i+1 || row.previous_hash!==previous || row.input_artifact_id!==inputId || row.input_sha256!==inputHash || !row.output_artifact_id || !row.output_sha256) throw new Error('Invalid signature chain');
    const {facts}=await verifySignatureRecord(row);
    // Renders the signature again: its images, its record and its stored PDF must all still agree.
    await processSignature(db,bucket,row.id);
    const objectKey=artifactObjectKey(envelopeId,row.output_artifact_id);
    await verifyFile(objectKey,row.output_sha256);
    rows.push({id:row.id,sequence:row.sequence,task_id:row.task_id,recipient_name:facts.recipientName,input_artifact_id:row.input_artifact_id,input_sha256:row.input_sha256,otp_verified_at:facts.otpVerifiedAt,consented_at:facts.consentedAt,previous_hash:row.previous_hash??'',event_hash:row.event_hash,artifact_id:row.output_artifact_id,object_key:objectKey,sha256:row.output_sha256});
    records.push({signatureId:row.id,facts:JSON.parse(row.facts_json),render:JSON.parse(row.render_json)});
    previous=row.event_hash;inputId=row.output_artifact_id;inputHash=row.output_sha256;
  }
  const manifest=JSON.stringify({format:MANIFEST_FORMAT,envelopeId,source:d0,signatures:rows,finalArtifactId:inputId,finalSha256:inputHash,records});
  return {source:d0,signatures:rows,finalArtifactId:inputId,finalSha256:inputHash,manifest};
}
/**
 * Records a seal stored in R2 and completes the envelope. The seal object is written first and is
 * unreachable until its row exists; the row is inserted only while the envelope is FINALIZING, and
 * then a compare-and-set moves the envelope from FINALIZING to COMPLETED only with that same seal.
 * Both are idempotent, so an envelope left FINALIZING with its seal recorded (a lost response, a
 * crash) is completed by the next run, from completion or the cron sweep, which reuses the seal.
 * Throws unless the envelope ends COMPLETED with exactly this seal. True when this call completed it.
 */
export async function commitSeal(db:D1Database,tenantId:string,envelopeId:string,seal:{mode:'LOCAL_TEST'|'KMS_TSA';objectKey:string;sha256:string;keyArn?:string;timestampTime?:number}):Promise<boolean> {
  const [,completed]=await db.batch([
    db.prepare("INSERT OR IGNORE INTO seals (envelope_id,mode,object_key,sha256,key_arn,timestamp_time) SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM envelopes WHERE id=? AND tenant_id=? AND status='FINALIZING')")
      .bind(envelopeId,seal.mode,seal.objectKey,seal.sha256,seal.keyArn??null,seal.timestampTime??null,envelopeId,tenantId),
    db.prepare("UPDATE envelopes SET status='COMPLETED' WHERE id=? AND tenant_id=? AND status='FINALIZING' AND EXISTS (SELECT 1 FROM seals WHERE envelope_id=? AND mode=? AND object_key=? AND sha256=?)")
      .bind(envelopeId,tenantId,envelopeId,seal.mode,seal.objectKey,seal.sha256),
  ]);
  const sealed=await db.prepare("SELECT 1 FROM envelopes e JOIN seals v ON v.envelope_id=e.id WHERE e.id=? AND e.tenant_id=? AND e.status='COMPLETED' AND v.mode=? AND v.object_key=? AND v.sha256=?")
    .bind(envelopeId,tenantId,seal.mode,seal.objectKey,seal.sha256).first();
  if(!sealed) throw new Error('Evidence conflict');
  return completed.meta.changes===1;
}
