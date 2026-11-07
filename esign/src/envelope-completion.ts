import { processSignatureJob, SignatureInputLayoutMissingError } from './signature-processing.ts';
import { processPositionedV3Job } from './positioned-v3-processing.ts';
import { finalizeLocalTestEvidence } from './local-test-evidence.ts';
import { finalizeManagedEvidence, managedDelivery } from './managed-evidence.ts';
import { envelopesOwingCopies, sendSignedCopies } from './signed-copies.ts';
import { sinkMailer, type OtpSinkEnv } from './otp-mail-sink.ts';
import { managedEvidenceFromEnv, type SealEnv } from './seal-config.ts';

/**
 * Finishing envelopes: processing each accepted signature, then sealing the envelope once
 * nobody is left to sign. POST /v1/envelopes/:id/process and /finalize do one step each on
 * request; the Worker also does it on its own after every signature and from a cron sweep,
 * through the same functions. Local test mode only: the seal is the local HMAC test seal,
 * not production evidence protection.
 */

export type ProcessStepResult = 'processed' | 'job_unavailable' | 'processing_failed' | 'signature_input_layout_missing';

/**
 * One processing step: the oldest pending signature job of the envelope, or, with none
 * pending, the most recent completed one again so that a lost write is repaired.
 */
export async function processEnvelopeStep(db: D1Database, bucket: R2Bucket, tenantId: string, envelopeId: string, v3TestOnly: boolean): Promise<ProcessStepResult> {
  const row=await db.prepare(`SELECT j.id FROM signature_jobs j JOIN signature_records r ON r.id=j.signature_id JOIN envelopes e ON e.id=r.envelope_id WHERE e.id=? AND e.tenant_id=? AND j.status='PENDING' ORDER BY r.sequence LIMIT 1`).bind(envelopeId,tenantId).first<{id:string}>();
  if (!row) {
    const done=await db.prepare(`SELECT j.id,ev.event_version FROM signature_jobs j JOIN signature_records r ON r.id=j.signature_id JOIN signature_events ev ON ev.signature_id=r.id JOIN envelopes e ON e.id=r.envelope_id WHERE e.id=? AND e.tenant_id=? AND j.status='DONE' ORDER BY r.sequence DESC LIMIT 1`).bind(envelopeId,tenantId).first<{id:string;event_version:number}>();
    if(!done)return 'job_unavailable';
    if(done.event_version!==1 && done.event_version!==2 && !(v3TestOnly && done.event_version===3))return 'processing_failed';
    if(done.event_version===3){try{await processPositionedV3Job(db,bucket,done.id);}catch{return 'processing_failed';}}
    if(done.event_version===2){try{
      const jobs=(await db.prepare(`SELECT j.id FROM signature_records r JOIN signature_jobs j ON j.signature_id=r.id AND j.status='DONE' JOIN signature_events ev ON ev.signature_id=r.id AND ev.event_version=2 WHERE r.envelope_id=? ORDER BY r.sequence`).bind(envelopeId).all<{id:string}>()).results;
      const total=await db.prepare('SELECT COUNT(*) AS n FROM signature_records WHERE envelope_id=?').bind(envelopeId).first<{n:number}>();if(!total||jobs.length!==total.n)throw new Error('Incomplete chain');for(const job of jobs)await processSignatureJob(db,bucket,job.id);
    }catch{return 'processing_failed';}}
    return 'processed';
  }
  try {const event=await db.prepare('SELECT e.event_version FROM signature_jobs j JOIN signature_events e ON e.signature_id=j.signature_id WHERE j.id=?').bind(row.id).first<{event_version:number}>();if(event?.event_version===3&&v3TestOnly)await processPositionedV3Job(db,bucket,row.id);else await processSignatureJob(db,bucket,row.id);return 'processed';}
  catch (error) {if (error instanceof SignatureInputLayoutMissingError) return 'signature_input_layout_missing';return 'processing_failed';}
}

export type CompletionEnv = { DB: D1Database; ARTIFACTS: R2Bucket; LOCAL_TEST_SEAL_KEY?: string } & SealEnv & OtpSinkEnv;
export type Completion = 'completed' | 'waiting' | 'failed';

/** Signatures are processed one at a time, in signing order; an envelope has at most a few. */
const MAX_STEPS = 25;

/**
 * Processes every pending signature of the envelope, then seals it once nobody is left to
 * sign. Safe to repeat and to run concurrently with itself or the endpoints: each step and
 * the seal are idempotent. Throws if sealing fails.
 */
export async function completeEnvelope(env: CompletionEnv, tenantId: string, envelopeId: string, v3TestOnly = false): Promise<Completion> {
  for (let step=0; step<MAX_STEPS; step++) {
    const pending=await env.DB.prepare(`SELECT 1 FROM signature_jobs j JOIN signature_records r ON r.id=j.signature_id JOIN envelopes e ON e.id=r.envelope_id WHERE e.id=? AND e.tenant_id=? AND j.status='PENDING' LIMIT 1`).bind(envelopeId,tenantId).first();
    if (!pending) break;
    if (await processEnvelopeStep(env.DB,env.ARTIFACTS,tenantId,envelopeId,v3TestOnly) !== 'processed') return 'failed';
  }
  const envelope=await env.DB.prepare('SELECT status FROM envelopes WHERE id=? AND tenant_id=?').bind(envelopeId,tenantId).first<{status:string}>();
  if (envelope?.status === 'COMPLETED') return 'completed';
  if (envelope?.status !== 'FINALIZING') return 'waiting';
  // The managed seal when configured; otherwise the local test seal, if there is a key for it.
  const managed = await managedEvidenceFromEnv(env);
  if (managed) { await finalizeManagedEvidence(env.DB,env.ARTIFACTS,tenantId,envelopeId,managed); await sendCopies(env,tenantId,envelopeId); return 'completed'; }
  if ((env.LOCAL_TEST_SEAL_KEY?.length ?? 0) < 32) return 'waiting';
  await finalizeLocalTestEvidence(env.DB,env.ARTIFACTS,tenantId,envelopeId,new TextEncoder().encode(env.LOCAL_TEST_SEAL_KEY!));
  await sendCopies(env,tenantId,envelopeId);
  return 'completed';
}

/** Emails each signer the signed copy, when mail is configured; failures are retried by the cron. */
async function sendCopies(env: CompletionEnv, tenantId: string, envelopeId: string): Promise<void> {
  const mailer = sinkMailer(env);
  if (!mailer) return;
  const managed = await managedEvidenceFromEnv(env);
  try {
    if (managed) await sendSignedCopies(env.DB,env.ARTIFACTS,tenantId,envelopeId,managedDelivery(env.DB,env.ARTIFACTS,tenantId,envelopeId,managed.trust),mailer);
    else if ((env.LOCAL_TEST_SEAL_KEY?.length ?? 0) >= 32) await sendSignedCopies(env.DB,env.ARTIFACTS,tenantId,envelopeId,new TextEncoder().encode(env.LOCAL_TEST_SEAL_KEY!),mailer);
  } catch { console.error(`E-sign: sending the signed copies of envelope ${envelopeId} failed; the cron retries it`); }
}

/** The envelope a recipient page session signs, by the session's bearer token. */
export async function completeEnvelopeOfSession(env: CompletionEnv, token: string, v3TestOnly = false): Promise<Completion> {
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));
  const tokenHash=Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('');
  const session=await env.DB.prepare('SELECT envelope_id,tenant_id FROM recipient_page_sessions WHERE token_hash=?').bind(tokenHash).first<{envelope_id:string;tenant_id:string}>();
  if (!session) return 'failed';
  return completeEnvelope(env,session.tenant_id,session.envelope_id,v3TestOnly);
}

/** Envelopes one cron run looks at; picked at random so that a stuck one cannot starve the rest. */
export const SWEEP_LIMIT = 25;

/** Cron: finishes envelopes whose after-signature work did not run or did not succeed. */
export async function sweepEnvelopes(env: CompletionEnv, v3TestOnly = false): Promise<Record<Completion, number>> {
  const rows=(await env.DB.prepare(`SELECT e.id,e.tenant_id FROM envelopes e WHERE e.status='FINALIZING' OR (e.status='IN_PROGRESS' AND EXISTS (SELECT 1 FROM signature_records r JOIN signature_jobs j ON j.signature_id=r.id WHERE r.envelope_id=e.id AND j.status='PENDING')) ORDER BY RANDOM() LIMIT ?`).bind(SWEEP_LIMIT).all<{id:string;tenant_id:string}>()).results;
  const counts: Record<Completion, number> = { completed: 0, waiting: 0, failed: 0 };
  for (const row of rows) {
    try { counts[await completeEnvelope(env,row.tenant_id,row.id,v3TestOnly)]++; }
    catch { counts.failed++; }
  }
  // Completed envelopes whose signed copies were not all sent.
  if (sinkMailer(env)) for (const row of await envelopesOwingCopies(env.DB)) await sendCopies(env,row.tenant_id,row.id);
  return counts;
}
