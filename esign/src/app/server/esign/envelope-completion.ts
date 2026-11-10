import { RECIPIENT_SESSION_FROM } from './access.ts';
import { advanceStatements, processSignature } from './signature-processing.ts';
import { finalizeLocalTestEvidence } from './seal/local.ts';
import { finalizeManagedEvidence } from './seal/managed.ts';
import type { BlobStore } from './blob-store.ts';
import { envelopesOwingCopies, sendSignedCopies } from './signed-copies.ts';
import { mailerFor, type MailEnv } from './mail.ts';
import { testSealKey, type EnvironmentEnv } from './environment.ts';
import { managedEvidenceFromEnv, type SealEnv } from './seal/config.ts';

/**
 * Finishing envelopes: rendering each accepted signature's PDF (signature-processing.ts), then
 * sealing the envelope once nobody is left to sign. The signing request does it after every
 * signature (COMPLETE_AFTER_SIGN), and POST /api/process-due catches up, through the same functions.
 */

export type ProcessStepResult = 'processed' | 'job_unavailable' | 'processing_failed';

/**
 * One processing step: the oldest pending signature of the envelope, or, with none pending, every
 * rendered one again in signing order, so that a lost write is repaired and a changed PDF or image
 * is noticed. A failure is counted on the signature (attempts, last_error) and retried later.
 */
export async function processEnvelopeStep(db: D1Database, bucket: BlobStore, tenantId: string, envelopeId: string): Promise<ProcessStepResult> {
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

/** `APP_ORIGIN`: the app's own origin, which signed-copy links point to (set per request by the router). */
export type CompletionEnv = { DB: D1Database; ARTIFACTS: BlobStore; APP_ORIGIN?: string } & Omit<EnvironmentEnv, 'TEST_MAIL'> & { TEST_MAIL?: unknown } & SealEnv & MailEnv;
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
  // The HMAC test seal: dev only (testSealKey is null in prod, which seals with KMS and TSA only).
  const testKey = testSealKey(env);
  if (!testKey) return 'waiting';
  await finalizeLocalTestEvidence(env.DB,env.ARTIFACTS,tenantId,envelopeId,testKey);
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
  const testKey = testSealKey(env);
  if (!testKey) return 'local_test_disabled';
  try { await finalizeLocalTestEvidence(env.DB,env.ARTIFACTS,tenantId,envelopeId,testKey); return 'finalized'; }
  catch { return 'finalization_failed'; }
}

/** Emails each signer a link to the signed copy, when mail is configured; process-due retries failures. */
async function sendCopies(env: CompletionEnv, tenantId: string, envelopeId: string): Promise<void> {
  const mailer = mailerFor(env, tenantId);
  if (!mailer) return;
  const managed = await managedEvidenceFromEnv(env);
  try {
    if (env.APP_ORIGIN && (managed || testSealKey(env))) await sendSignedCopies(env.DB,tenantId,envelopeId,mailer,env.APP_ORIGIN);
  } catch { console.error(`E-sign: sending the signed-copy notices of envelope ${envelopeId} failed; process-due retries it`); }
}

/** The envelope a recipient page session signs, by the session's bearer token. */
export async function completeEnvelopeOfSession(env: CompletionEnv, token: string): Promise<Completion> {
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));
  const tokenHash=Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('');
  const session=await env.DB.prepare(`SELECT e.id AS envelope_id,s.tenant_id FROM ${RECIPIENT_SESSION_FROM} WHERE s.scope='recipient' AND s.token_hash=?`).bind(tokenHash).first<{envelope_id:string;tenant_id:string}>();
  if (!session) return 'failed';
  return completeEnvelope(env,session.tenant_id,session.envelope_id);
}

/** Envelopes one process-due run looks at; picked at random so that a stuck one cannot starve the rest. */
export const SWEEP_LIMIT = 25;

/**
 * Process-due: finishes the organization's envelopes (every organization's, without a tenant) whose
 * signing request did not finish them, and sends signed-copy notices still owed.
 */
export async function sweepEnvelopes(env: CompletionEnv, tenantId: string | null = null): Promise<Record<Completion, number>> {
  // FINALIZING (to seal, or sealed but not yet COMPLETED), or IN_PROGRESS with work left: a pending
  // signature, or no task ACTIVE and still unsigned (a signature whose task was not marked, a
  // next task not activated, every task signed but the envelope not FINALIZING).
  const rows=(await env.DB.prepare(`SELECT e.id,e.tenant_id FROM envelopes e WHERE e.status='FINALIZING' OR (e.status='IN_PROGRESS' AND (
      EXISTS (SELECT 1 FROM signatures s WHERE s.envelope_id=e.id AND s.status='PENDING')
      OR NOT EXISTS (SELECT 1 FROM tasks t WHERE t.envelope_id=e.id AND t.status='ACTIVE' AND NOT EXISTS (SELECT 1 FROM signatures g WHERE g.task_id=t.id))))
    AND (?2 IS NULL OR e.tenant_id=?2)
    ORDER BY RANDOM() LIMIT ?1`).bind(SWEEP_LIMIT,tenantId).all<{id:string;tenant_id:string}>()).results;
  const counts: Record<Completion, number> = { completed: 0, waiting: 0, failed: 0 };
  for (const row of rows) {
    try { counts[await completeEnvelope(env,row.tenant_id,row.id)]++; }
    catch { counts.failed++; }
  }
  // Completed envelopes whose signed copies were not all sent.
  for (const row of await envelopesOwingCopies(env.DB, Date.now(), 25, tenantId)) if (mailerFor(env, row.tenant_id)) await sendCopies(env,row.tenant_id,row.id);
  return counts;
}
