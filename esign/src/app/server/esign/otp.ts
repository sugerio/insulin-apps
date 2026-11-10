/**
 * The recipient page's access and emailed-code (OTP) steps, called by the signing routes
 * (signing-routes.ts): issuing and exchanging recipient codes, authorizing a page session,
 * and sending and checking the emailed code. Each takes the token and origin the route read from
 * the request; the routes decide which steps a request needs.
 */
import { accessHash, authorizeAccess, exchangeAccessCode, issueAccessCode, RECIPIENT_SESSION_FROM } from './access.ts';
const encoder = new TextEncoder();
/** How long an emailed code stays valid: 10 minutes, inside the 15-minute page session. */
export const OTP_TTL_MS = 10 * 60 * 1000;
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
const digest = accessHash;
/** The stored form of a code: HMAC-SHA-256 keyed by OTP_KEY over the task, its email and the code. */
export async function otpHash(pepper: Uint8Array, taskId: string, otp: string, recipientEmail:string): Promise<string> {
  if (pepper.length < 32) throw new Error('OTP key too short');
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(JSON.stringify(['esign-otp-recipient-v1',taskId,recipientEmail,otp]))));
}
export function otpCode(): string {
  const values = new Uint32Array(1);
  do { crypto.getRandomValues(values); } while (values[0] >= 4294000000);
  return String(values[0] % 1000000).padStart(6, '0');
}
type View = { tenantId: string; envelopeId: string; taskId: string; origin: string; now: number };
/** A one-time code (scope `recipient`) for the ACTIVE task of an IN_PROGRESS envelope of the tenant. */
export async function issueRecipientCode(db: D1Database, view: View): Promise<string> {
  return issueAccessCode(db, { scope: 'recipient', tenantId: view.tenantId, subjectId: view.taskId, origin: view.origin, now: view.now,
    where: { sql: 'EXISTS (SELECT 1 FROM tasks WHERE id=v.subject_id AND envelope_id=?)', binds: [view.envelopeId] } });
}
/** Exchanges a recipient code, only at the origin it was issued for, for a page session token. */
export async function exchangeRecipientCode(db: D1Database, code: string, origin: string, now: number): Promise<string> {
  return exchangeAccessCode(db, { scope: 'recipient', code, origin, now });
}
async function session(db: D1Database, token: string, origin: string, now: number): Promise<{task_id:string; recipient_email:string}> {
  const access = await authorizeAccess(db, { scope: 'recipient', token, origin, now });
  const row = await db.prepare('SELECT id AS task_id, recipient_email FROM tasks WHERE id=?').bind(access.subjectId).first<{task_id:string;recipient_email:string}>();
  if (!row) throw new Error('Invalid session');
  return row;
}
/** The task of a live recipient page session at this origin. Editor tokens are refused. */
export async function authorizeRecipientSession(db: D1Database, token: string, origin: string, now: number): Promise<string> { return (await session(db, token, origin, now)).task_id; }
/** At most 5 entries and 3 sends per window of 15 minutes, counted per task, and 60 seconds between sends. */
export const OTP_WINDOW_MS = 15 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_MAX_SENDS = 3;
export const OTP_RESEND_MS = 60 * 1000;
/**
 * Sends the task's recipient a new code for this session. The commit point is one statement on
 * the task's `otp_challenges` row (insert, or replace the code): it adds or changes a row only
 * while the session is live at this origin, the task is ACTIVE in an IN_PROGRESS envelope with the
 * email the code is hashed with and sent to, and the task's budget allows a send: a new window
 * (the current one opened 15 minutes ago or more), or fewer than 5 entries and 3 sends in this
 * window and 60 seconds since the last send. A code this session already entered is not replaced.
 * The mail goes out only after that changed one row.
 */
export async function sendRecipientOtp(db: D1Database, token: string, origin: string, now: number, pepper: Uint8Array, send: (email:string, otp:string) => Promise<void>): Promise<void> {
  const s = await session(db, token, origin, now), otp = otpCode(), sessionHash = await digest(token);
  const newWindow = `otp_challenges.window_started_at + ${OTP_WINDOW_MS} <= excluded.last_sent_at`;
  const result = await db.prepare(`INSERT INTO otp_challenges (task_id, session_hash, otp_hash, expires_at, window_started_at, last_sent_at)
    SELECT t.id, s.token_hash, ?, ?, ?, ? FROM ${RECIPIENT_SESSION_FROM} WHERE s.scope='recipient' AND s.token_hash=? AND s.origin=? AND s.expires_at>? AND e.status='IN_PROGRESS' AND t.status='ACTIVE' AND t.recipient_email=? COLLATE BINARY
    ON CONFLICT(task_id) DO UPDATE SET session_hash=excluded.session_hash, otp_hash=excluded.otp_hash, expires_at=excluded.expires_at, used_at=NULL, last_sent_at=excluded.last_sent_at,
      attempts=CASE WHEN ${newWindow} THEN 0 ELSE otp_challenges.attempts END,
      sends=CASE WHEN ${newWindow} THEN 1 ELSE otp_challenges.sends+1 END,
      window_started_at=CASE WHEN ${newWindow} THEN excluded.last_sent_at ELSE otp_challenges.window_started_at END
    WHERE (otp_challenges.used_at IS NULL OR otp_challenges.session_hash <> excluded.session_hash) AND (${newWindow} OR
      (otp_challenges.attempts<${OTP_MAX_ATTEMPTS} AND otp_challenges.sends<${OTP_MAX_SENDS} AND otp_challenges.last_sent_at + ${OTP_RESEND_MS} <= excluded.last_sent_at))`)
    .bind(await otpHash(pepper, s.task_id, otp, s.recipient_email), now + OTP_TTL_MS, now, now, sessionHash, origin, now, s.recipient_email).run();
  if (result.meta.changes !== 1) {
    const wait = await sendWait(db, s.task_id, sessionHash, now);
    throw wait === null ? new Error('OTP unavailable') : new OtpSendRefused(wait);
  }
  await send(s.recipient_email, otp);
}
/** A send the task's budget refuses for now: the next one is allowed `retryAfterMs` from now. */
export class OtpSendRefused extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) { super('OTP send limited'); this.retryAfterMs = retryAfterMs; }
}
type Challenge = { session_hash: string; expires_at: number; used_at: number | null; attempts: number; sends: number; window_started_at: number; last_sent_at: number };
const challengeOf = (db: D1Database, taskId: string) =>
  db.prepare('SELECT session_hash, expires_at, used_at, attempts, sends, window_started_at, last_sent_at FROM otp_challenges WHERE task_id=?').bind(taskId).first<Challenge>();
/** How long until the task's budget allows a send (the rule in sendRecipientOtp), or null when the budget is not what refused it. */
async function sendWait(db: D1Database, taskId: string, sessionHash: string, now: number): Promise<number | null> {
  const c = await challengeOf(db, taskId);
  if (!c || (c.used_at !== null && c.session_hash === sessionHash)) return null;
  const windowEnd = c.window_started_at + OTP_WINDOW_MS;
  if (windowEnd <= now) return null;
  const at = c.attempts >= OTP_MAX_ATTEMPTS || c.sends >= OTP_MAX_SENDS ? windowEnd : c.last_sent_at + OTP_RESEND_MS;
  return at > now ? at - now : null;
}
/**
 * Why a code this session entered was not accepted, read after verifyRecipientOtp said no, so the
 * page can say what to do: `superseded`, a later send (another page session of this task) replaced
 * the code; `locked`, the window's 5 entries are spent, and a new code can be asked for in
 * `retryAfterMs`; `expired`, ask for a new code; `wrong`, the code is not the one sent, with the
 * entries left. Throws when the session is not live (as verifyRecipientOtp does).
 */
export type OtpEntryRefusal =
  | { reason: 'superseded' }
  | { reason: 'locked'; retryAfterMs: number }
  | { reason: 'expired' }
  | { reason: 'wrong'; attemptsLeft: number };
export async function otpEntryRefusal(db: D1Database, token: string, origin: string, now: number): Promise<OtpEntryRefusal> {
  const s = await session(db, token, origin, now), sessionHash = await digest(token);
  const c = await challengeOf(db, s.task_id);
  if (!c) return { reason: 'expired' };
  if (c.session_hash !== sessionHash) return { reason: 'superseded' };
  if (c.attempts >= OTP_MAX_ATTEMPTS) return { reason: 'locked', retryAfterMs: Math.max(0, c.window_started_at + OTP_WINDOW_MS - now) };
  if (c.expires_at <= now) return { reason: 'expired' };
  return { reason: 'wrong', attemptsLeft: OTP_MAX_ATTEMPTS - c.attempts };
}
/**
 * Checks a code entered in this session. One batch of compare-and-set statements:
 *
 * 1. Counts the entry and, when the code matches, marks it used, only while the code is this
 *    session's, unexpired, unused, with fewer than 5 entries, the session live at this origin and
 *    the task ACTIVE in an IN_PROGRESS envelope with the email the entry was hashed with.
 * 2. Marks this session verified, only if statement 1 just used the task's code for it.
 * 3. Clears the mark from the task's other sessions once this one entered its latest code, so at
 *    most one session of a task can sign, as before.
 *
 * A lost response may be retried by the same still-live verified session with the same code.
 */
export async function verifyRecipientOtp(db: D1Database, token: string, origin: string, now: number, pepper: Uint8Array, otp: string): Promise<boolean> {
  if (!/^\d{6}$/.test(otp)) return false;
  const s = await session(db, token, origin, now), sessionHash = await digest(token);
  const hash = await otpHash(pepper, s.task_id, otp, s.recipient_email);
  const [, verified] = await db.batch([
    db.prepare(`UPDATE otp_challenges SET attempts=attempts+1, used_at=CASE WHEN otp_hash=? THEN ? ELSE NULL END
      WHERE task_id=? AND session_hash=? AND expires_at>? AND attempts<${OTP_MAX_ATTEMPTS} AND used_at IS NULL
      AND EXISTS (SELECT 1 FROM ${RECIPIENT_SESSION_FROM} WHERE s.scope='recipient' AND s.token_hash=otp_challenges.session_hash AND s.subject_id=otp_challenges.task_id AND s.origin=? AND s.expires_at>? AND e.status='IN_PROGRESS' AND t.status='ACTIVE' AND t.recipient_email=? COLLATE BINARY)`)
      .bind(hash, now, s.task_id, sessionHash, now, origin, now, s.recipient_email),
    db.prepare(`UPDATE access_sessions SET otp_verified_at=? WHERE scope='recipient' AND token_hash=? AND subject_id=? AND otp_verified_at IS NULL
      AND EXISTS (SELECT 1 FROM otp_challenges c WHERE c.task_id=access_sessions.subject_id AND c.session_hash=access_sessions.token_hash AND c.used_at=?)`)
      .bind(now, sessionHash, s.task_id, now),
    db.prepare(`UPDATE access_sessions SET otp_verified_at=NULL WHERE scope='recipient' AND subject_id=? AND token_hash<>? AND otp_verified_at IS NOT NULL
      AND EXISTS (SELECT 1 FROM otp_challenges c WHERE c.task_id=? AND c.session_hash=? AND c.used_at IS NOT NULL)`)
      .bind(s.task_id, sessionHash, s.task_id, sessionHash),
  ]);
  if (verified.meta.changes === 1) return true;
  // A lost response retried: the same session, still live and verified, with the same code.
  const again = await db.prepare(`SELECT 1 FROM ${RECIPIENT_SESSION_FROM} JOIN otp_challenges c ON c.session_hash=s.token_hash AND c.task_id=t.id
    WHERE c.task_id=? AND c.session_hash=? AND c.otp_hash=? AND c.used_at IS NOT NULL AND s.scope='recipient' AND s.otp_verified_at IS NOT NULL
      AND s.origin=? AND s.expires_at>? AND e.status='IN_PROGRESS' AND t.status='ACTIVE' AND t.recipient_email=? COLLATE BINARY`)
    .bind(s.task_id, sessionHash, hash, origin, now, s.recipient_email).first();
  return !!again;
}
