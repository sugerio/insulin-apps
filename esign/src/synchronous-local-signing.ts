import { recordSignature } from './signature-record.ts';
import { processSignatureJob } from './signature-processing.ts';
import { finalizeLocalTestEvidence } from './local-test-evidence.ts';

type Command = { token:string; origin:string; now:number; artifactId:string; artifactHash:string; consent:boolean };
type Existing = { id:string; job_id:string; event_version:number; envelope_id:string; tenant_id:string; fields_json:string };
const hex = (value:ArrayBuffer) => Array.from(new Uint8Array(value), n=>n.toString(16).padStart(2,'0')).join('');

/** Unmounted fieldless LOCAL TEST candidate. This is not an identity or production sealing boundary. */
export async function signSynchronouslyLocalTest(db:D1Database, bucket:R2Bucket, cmd:Command, sealKey:Uint8Array):Promise<{mode:'LOCAL_TEST_ONLY'; signatureId:string; status:'IN_PROGRESS'|'COMPLETED_LOCAL_TEST'}> {
  if (!cmd || cmd.consent!==true || !/^[a-f0-9]{64}$/.test(cmd.token) || !/^[a-f0-9]{64}$/.test(cmd.artifactHash) || !Number.isSafeInteger(cmd.now) || sealKey.length<32) throw new Error('Invalid local signing request');
  const tokenHash=hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(cmd.token)));
  const session=await db.prepare(`SELECT s.envelope_id,s.tenant_id,p.fields_json FROM recipient_page_sessions s JOIN tenant_page_origins o ON o.tenant_id=s.tenant_id AND o.origin=s.origin JOIN envelopes e ON e.id=s.envelope_id AND e.tenant_id=s.tenant_id JOIN templates p ON p.id=e.template_id AND p.tenant_id=e.tenant_id JOIN tasks t ON t.id=s.task_id AND t.envelope_id=s.envelope_id JOIN recipient_otp_verifications v ON v.task_id=s.task_id AND v.session_hash=s.token_hash AND v.recipient_email=t.recipient_email COLLATE BINARY WHERE s.token_hash=? AND s.origin=? AND s.expires_at>? AND v.verified_at<=?`).bind(tokenHash,cmd.origin,cmd.now,cmd.now).first<{envelope_id:string;tenant_id:string;fields_json:string}>();
  if(!session || session.fields_json!=='[]') throw new Error('Local session unavailable or non-fieldless template');
  const find=()=>db.prepare(`SELECT r.id,j.id AS job_id,ev.event_version,s.envelope_id,s.tenant_id,p.fields_json FROM signature_records r JOIN signature_jobs j ON j.signature_id=r.id JOIN signature_events ev ON ev.signature_id=r.id JOIN recipient_page_sessions s ON s.token_hash=r.session_hash AND s.task_id=r.task_id AND s.envelope_id=r.envelope_id JOIN tasks t ON t.id=r.task_id AND t.envelope_id=r.envelope_id JOIN recipient_otp_verifications v ON v.task_id=t.id AND v.session_hash=s.token_hash AND v.recipient_email=t.recipient_email COLLATE BINARY AND v.recipient_email=r.otp_recipient_email COLLATE BINARY AND v.verified_at=r.otp_verified_at JOIN envelopes e ON e.id=s.envelope_id AND e.tenant_id=s.tenant_id JOIN templates p ON p.id=e.template_id AND p.tenant_id=e.tenant_id WHERE r.session_hash=? AND r.input_artifact_id=? AND r.input_sha256=?`).bind(tokenHash,cmd.artifactId,cmd.artifactHash).first<Existing>();
  let existing=await find();
  if(!existing) {
    try { await recordSignature(db,bucket,cmd); }
    catch(error) { existing=await find(); if(!existing) throw error; }
    existing=existing ?? await find();
  }
  if(!existing || existing.event_version!==1 || existing.fields_json!=='[]' || existing.envelope_id!==session.envelope_id || existing.tenant_id!==session.tenant_id) throw new Error('Local signature unavailable');
  await processSignatureJob(db,bucket,existing.job_id);
  const output=await db.prepare(`SELECT o.object_key,o.sha256 FROM signature_outputs o JOIN signature_jobs j ON j.id=o.job_id WHERE j.id=? AND j.status='DONE'`).bind(existing.job_id).first<{object_key:string;sha256:string}>();
  const object=output && await bucket.get(output.object_key);
  if(!output || !object || hex(await crypto.subtle.digest('SHA-256',await object.arrayBuffer()))!==output.sha256) throw new Error('Local output integrity failure');
  const envelope=await db.prepare('SELECT status FROM envelopes WHERE id=? AND tenant_id=?').bind(session.envelope_id,session.tenant_id).first<{status:string}>();
  if(envelope?.status==='IN_PROGRESS') return {mode:'LOCAL_TEST_ONLY',signatureId:existing.id,status:'IN_PROGRESS'};
  if(envelope?.status!=='FINALIZING' && envelope?.status!=='COMPLETED') throw new Error('Local envelope unavailable');
  await finalizeLocalTestEvidence(db,bucket,session.tenant_id,session.envelope_id,sealKey);
  return {mode:'LOCAL_TEST_ONLY',signatureId:existing.id,status:'COMPLETED_LOCAL_TEST'};
}
