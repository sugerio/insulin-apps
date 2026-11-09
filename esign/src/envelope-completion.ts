import { advanceStatements, processSignature } from './signature-processing.ts';
import { finalizeLocalTestEvidence } from './local-test-evidence.ts';
import { finalizeManagedEvidence, managedDelivery } from './managed-evidence.ts';
import { envelopesOwingCopies, sendSignedCopies } from './signed-copies.ts';
import { sinkMailer, type OtpSinkEnv } from './otp-mail-sink.ts';
import { managedEvidenceFromEnv, type SealEnv } from './seal-config.ts';

/**
 * Finishing envelopes: rendering each accepted signature's PDF (signature-processing.ts), then
 * sealing the envelope once nobody is left to sign. The Worker does it on its own after every
 * signature (COMPLETE_AFTER_SIGN) and from a cron sweep, through the same functions.
 */

export type ProcessStepResult = 'processed' | 'job_unavailable' | 'processing_failed';

/**
 * One processing step: the oldest pending signature of the envelope, or, with none pending, every
 * rendered one again in signing order, so that a lost write is repaired and a changed PDF or image
 * is noticed. A failure is counted on the signature (attempts, last_error) and retried later.
 */
export async function processEnvelopeStep(db: D1Database, bucket: R2Bucket, tenantId: string, envelopeId: string): Promise<ProcessStepResult> {
  const rows=(await db.prepare(`SELECT s.id,s.status FROM signatures s JOIN envelopes e ON e.id=s.envelope_id WHERE e.id=? AND e.tenant_id=? ORDER BY s.sequence`).bind(envelopeId,tenantId).all<{id:string;status:string}>()).results;
  const pending=rows.find(row=>row.status==='PENDING');
  if (!rows.length) return 'job_unavailable';
  let current='';
  try { for (const row of pending ? [pending] : rows) { current=row.id; await processSignature(db,bucket,row.id); } return 'processed'; }
  catch (error) {
    const message=(error instanceof Error?error.message:String(error)).slice(0,500);
    await db.prepare("UPDATE signatures SET attempts=attempts+1,last_error=? WHERE id=? AND status='PENDING'").bind(message,current).run().catch(()=>{});
    return 'processing_failed';
  }
}

export type CompletionEnv = { DB: D1Database; ARTIFACTS: R2Bucket; LOCAL_TEST_SEAL_KEY?: string } & SealEnv & OtpSinkEnv;
export type Completion = 'completed' | 'waiting' | 'failed';

/** Signatures are processed one at a time, in signing order; an envelope has at most a few. */
const MAX_STEPS = 25;

/**
 * Processes every pending signature of the envelope, moves the envelope on, then seals it once
 * nobody is left to sign; a FINALIZING envelope whose seal is already recorded is completed with
 * that seal. Safe to repeat and to run concurrently with itself: each step and the seal are
 * idempotent. Throws if sealing fails.
 */
export async function completeEnvelope(env: CompletionEnv, tenantId: string, envelopeId: string): Promise<Completion> {
  // First repairs an envelope that a lost or interrupted write left half-advanced: a signature whose
  // task is still ACTIVE, a rendered signature whose next task is still PENDING, every task signed
  // and rendered but the envelope still IN_PROGRESS. The updates are idempotent
  // (signature-processing.ts), and rendering a pending signature below runs them again.
  if (!await env.DB.prepare('SELECT 1 FROM envelopes WHERE id=? AND tenant_id=?').bind(envelopeId,tenantId).first()) return 'waiting';
  await env.DB.batch(advanceStatements(env.DB,envelopeId));
  for (let step=0; step<MAX_STEPS; step++) {
    const pending=await env.DB.prepare(`SELECT 1 FROM signatures s JOIN envelopes e ON e.id=s.envelope_id WHERE e.id=? AND e.tenant_id=? AND s.status='PENDING' LIMIT 1`).bind(envelopeId,tenantId).first();
    if (!pending) break;
    if (await processEnvelopeStep(env.DB,env.ARTIFACTS,tenantId,envelopeId) !== 'processed') return 'failed';
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

export type FinalizeStepResult = 'finalized' | 'local_test_disabled' | 'finalization_failed';

/** Seals a FINALIZING envelope once: the managed seal when configured, else the local test seal. */
export async function finalizeEnvelopeStep(env: CompletionEnv, tenantId: string, envelopeId: string): Promise<FinalizeStepResult> {
  try {
    const managed = await managedEvidenceFromEnv(env);
    if (managed) { await finalizeManagedEvidence(env.DB,env.ARTIFACTS,tenantId,envelopeId,managed); return 'finalized'; }
  } catch { return 'finalization_failed'; }
  if ((env.LOCAL_TEST_SEAL_KEY?.length ?? 0) < 32) return 'local_test_disabled';
  try { await finalizeLocalTestEvidence(env.DB,env.ARTIFACTS,tenantId,envelopeId,new TextEncoder().encode(env.LOCAL_TEST_SEAL_KEY!)); return 'finalized'; }
  catch { return 'finalization_failed'; }
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
export async function completeEnvelopeOfSession(env: CompletionEnv, token: string): Promise<Completion> {
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));
  const tokenHash=Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('');
  const session=await env.DB.prepare('SELECT envelope_id,tenant_id FROM recipient_page_sessions WHERE token_hash=?').bind(tokenHash).first<{envelope_id:string;tenant_id:string}>();
  if (!session) return 'failed';
  return completeEnvelope(env,session.tenant_id,session.envelope_id);
}

/** Envelopes one cron run looks at; picked at random so that a stuck one cannot starve the rest. */
export const SWEEP_LIMIT = 25;

/** Cron: finishes envelopes whose after-signature work did not run or did not succeed. */
export async function sweepEnvelopes(env: CompletionEnv): Promise<Record<Completion, number>> {
  // FINALIZING (to seal, or sealed but not yet COMPLETED), or IN_PROGRESS with work left: a pending
  // signature, or no task ACTIVE and still unsigned (a signature whose task was not marked, a
  // next task not activated, every task signed but the envelope not FINALIZING).
  const rows=(await env.DB.prepare(`SELECT e.id,e.tenant_id FROM envelopes e WHERE e.status='FINALIZING' OR (e.status='IN_PROGRESS' AND (
      EXISTS (SELECT 1 FROM signatures s WHERE s.envelope_id=e.id AND s.status='PENDING')
      OR NOT EXISTS (SELECT 1 FROM tasks t WHERE t.envelope_id=e.id AND t.status='ACTIVE' AND NOT EXISTS (SELECT 1 FROM signatures g WHERE g.task_id=t.id))))
    ORDER BY RANDOM() LIMIT ?`).bind(SWEEP_LIMIT).all<{id:string;tenant_id:string}>()).results;
  const counts: Record<Completion, number> = { completed: 0, waiting: 0, failed: 0 };
  for (const row of rows) {
    try { counts[await completeEnvelope(env,row.tenant_id,row.id)]++; }
    catch { counts.failed++; }
  }
  // Completed envelopes whose signed copies were not all sent.
  if (sinkMailer(env)) for (const row of await envelopesOwingCopies(env.DB)) await sendCopies(env,row.tenant_id,row.id);
  return counts;
}
