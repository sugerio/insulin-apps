import { AUDIT, recordAuditQuietly } from './audit.ts';
import { envelopeDetails, taskDetails } from './details.ts';
import type { Mailer } from './mail.ts';

/**
 * How a signer reaches the signing page, and the sender's message to them.
 *
 * A signer is the host's (`delivery` 'host', the default): Esign emails them nothing, and only the
 * host opens their page (POST .../recipient-view), naming the account signed in to it, which must
 * have the signer's email. Or Esign invites them (`delivery` 'email'): when their turn comes, they
 * are emailed a link to the signing page, and the host can't open it for them. Either way they then
 * confirm a code emailed to them.
 *
 * An invitation's link carries a random token (only its SHA-256 is stored, in `invitations`). It
 * opens the page while the signer's task is the active one: each open gets a one-time code for the
 * page, like the host's. Each invitation is reserved before sending, so concurrent runs (the request
 * that activated the task, due work) send it once; a reservation whose send failed is retried after
 * a while. Sending it again (resend) replaces the token, so only the latest link works.
 */

/** The sender's message: a subject (for an invitation's email) and a body (in it, and on the signing page). */
export type Message = { subject?: string; body?: string };
export type Delivery = 'host' | 'email';

export const MAX_MESSAGE_SUBJECT = 100;
export const MAX_MESSAGE_BODY = 10_000;
/** How long a reservation without a sent invitation blocks another attempt. */
const RETRY_AFTER_MS = 15 * 60 * 1000;

const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const tokenHash = async (token: string) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))));

/** A message from a request: null when absent or empty, or 'invalid'. The subject is one line; the body may have line breaks. */
export function parseMessage(value: unknown): Message | null | 'invalid' {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return 'invalid';
  const v = value as { subject?: unknown; body?: unknown };
  if (Object.keys(v).some(key => key !== 'subject' && key !== 'body')) return 'invalid';
  if ((v.subject !== undefined && typeof v.subject !== 'string') || (v.body !== undefined && typeof v.body !== 'string')) return 'invalid';
  const subject = (v.subject ?? '').trim(), body = (v.body ?? '').replace(/\r\n?/g, '\n').trim();
  if (subject.length > MAX_MESSAGE_SUBJECT || /[\u0000-\u001f\u007f]/.test(subject)) return 'invalid';
  if (body.length > MAX_MESSAGE_BODY || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(body)) return 'invalid';
  if (!subject && !body) return null;
  return { ...(subject ? { subject } : {}), ...(body ? { body } : {}) };
}

/** A recipient's delivery from a request: 'host' when absent, or 'invalid'. */
export function parseDelivery(value: unknown): Delivery | 'invalid' {
  if (value === undefined || value === null) return 'host';
  return value === 'host' || value === 'email' ? value : 'invalid';
}

/** The message a signer sees: their own when the host gave one, else the envelope's. */
export function messageFor(envelopeDetailsJson: string | null | undefined, taskDetailsJson: string | null | undefined): Message | null {
  return taskDetails(taskDetailsJson).message ?? envelopeDetails(envelopeDetailsJson).message ?? null;
}

/** An email address compared as Esign compares a signer's: trimmed and case-insensitive. */
export const sameEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

type InvitedTask = { id: string; envelope_id: string; recipient_name: string; recipient_email: string; task_details: string; envelope_details: string; expires_at: number | null };

/** The invitation email: the subject and body the sender gave, or defaults; who sent it; the link. */
export function invitationEmail(task: Pick<InvitedTask, 'recipient_name' | 'expires_at'> & { documentName?: string; senderName?: string; senderOrganization?: string; message: Message | null }, link: string): { subject: string; text: string } {
  const document = task.documentName ?? 'a document';
  const from = task.senderName ? `${task.senderName}${task.senderOrganization ? ` (${task.senderOrganization})` : ''}` : task.senderOrganization ?? 'The sender';
  const subject = task.message?.subject ?? `Please sign: ${document}`;
  const lines = [`Hello ${task.recipient_name},`, '', `${from} asks you to sign ${document}.`];
  if (task.message?.body) lines.push('', task.message.body);
  lines.push('', 'Open the document and sign it:', '', link, '', 'You will confirm a code sent to this email address before you sign.');
  if (task.expires_at !== null) lines.push(`Sign by ${new Date(task.expires_at).toISOString().replace('.000Z', 'Z')}.`);
  return { subject, text: lines.join('\n') };
}

/**
 * Emails the invitation of every active task of the envelope whose signer Esign invites and who has
 * none yet (or one whose send failed a while ago), with a link to the signing page at `origin` (the
 * app's own). Safe to run concurrently with itself.
 */
export async function sendInvitations(db: D1Database, tenantId: string, envelopeId: string, mailer: Mailer, origin: string, now = Date.now()): Promise<{ sent: number; skipped: number }> {
  const tasks = (await db.prepare(`SELECT t.id,t.envelope_id,t.recipient_name,t.recipient_email,t.details_json AS task_details,e.details_json AS envelope_details,t.expires_at
      FROM tasks t JOIN envelopes e ON e.id=t.envelope_id
      WHERE e.id=? AND e.tenant_id=? AND e.status='IN_PROGRESS' AND t.status='ACTIVE' AND json_extract(t.details_json,'$.delivery')='email'
        AND NOT EXISTS (SELECT 1 FROM invitations i WHERE i.task_id=t.id AND i.sent_at IS NOT NULL)`)
    .bind(envelopeId, tenantId).all<InvitedTask>()).results;
  let sent = 0, skipped = 0;
  for (const task of tasks) {
    if (await sendInvitation(db, tenantId, task, mailer, origin, now, false)) sent++;
    else skipped++;
  }
  return { sent, skipped };
}

/**
 * Emails the active task's invitation again with a new link (the old one stops working): the sender's
 * resend. False when the task isn't one Esign invites, isn't active, or the send failed.
 */
export async function resendInvitation(db: D1Database, tenantId: string, envelopeId: string, taskId: string, mailer: Mailer, origin: string, now = Date.now()): Promise<'sent' | 'not_invited' | 'failed'> {
  const task = await db.prepare(`SELECT t.id,t.envelope_id,t.recipient_name,t.recipient_email,t.details_json AS task_details,e.details_json AS envelope_details,t.expires_at
      FROM tasks t JOIN envelopes e ON e.id=t.envelope_id
      WHERE e.id=? AND e.tenant_id=? AND t.id=? AND e.status='IN_PROGRESS' AND t.status='ACTIVE' AND json_extract(t.details_json,'$.delivery')='email'`)
    .bind(envelopeId, tenantId, taskId).first<InvitedTask>();
  if (!task) return 'not_invited';
  return await sendInvitation(db, tenantId, task, mailer, origin, now, true) ? 'sent' : 'failed';
}

async function sendInvitation(db: D1Database, tenantId: string, task: InvitedTask, mailer: Mailer, origin: string, now: number, resend: boolean): Promise<boolean> {
  const token = hex(crypto.getRandomValues(new Uint8Array(32))), hash = await tokenHash(token);
  // Reserved with the new token: a first send, a retry of one that failed a while ago, or a resend.
  const reserved = await db.prepare(`INSERT INTO invitations (task_id,tenant_id,envelope_id,token_hash,reserved_at,sent_at) VALUES (?,?,?,?,?,NULL)
      ON CONFLICT(task_id) DO UPDATE SET token_hash=excluded.token_hash,reserved_at=excluded.reserved_at,sent_at=NULL
      WHERE ?6=1 OR (invitations.sent_at IS NULL AND invitations.reserved_at<?7)`)
    .bind(task.id, tenantId, task.envelope_id, hash, now, resend ? 1 : 0, now - RETRY_AFTER_MS).run();
  if (reserved.meta.changes !== 1) return false;
  try {
    const envelope = envelopeDetails(task.envelope_details);
    const email = invitationEmail({ recipient_name: task.recipient_name, expires_at: task.expires_at, documentName: envelope.documentName, senderName: envelope.sender?.name, senderOrganization: envelope.sender?.organization, message: messageFor(task.envelope_details, task.task_details) }, `${origin}/sign#invite=${token}`);
    await mailer.send(task.recipient_email, email.subject, email.text);
    await db.prepare('UPDATE invitations SET sent_at=? WHERE task_id=? AND token_hash=?').bind(now, task.id, hash).run();
    await recordAuditQuietly(db, { envelopeId: task.envelope_id, taskId: task.id, type: AUDIT.invitationSent, detail: { to: task.recipient_email, ...(resend ? { resend: true } : {}) } });
    return true;
  } catch {
    console.error(`Esign: could not send the invitation for envelope ${task.envelope_id}; process-due retries it`);
    return false;
  }
}

/**
 * The task an invitation link opens: its envelope and organization, while the invitation is the
 * task's latest one, sent, and the task is active in an envelope in progress. Null otherwise.
 */
export async function openInvitation(db: D1Database, token: string, now = Date.now()): Promise<{ tenantId: string; envelopeId: string; taskId: string } | null> {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const row = await db.prepare(`SELECT i.tenant_id,i.envelope_id,i.task_id FROM invitations i JOIN tasks t ON t.id=i.task_id JOIN envelopes e ON e.id=i.envelope_id AND e.tenant_id=i.tenant_id
      WHERE i.token_hash=? AND i.sent_at IS NOT NULL AND t.status='ACTIVE' AND e.status='IN_PROGRESS' AND (t.expires_at IS NULL OR t.expires_at>?)
        AND json_extract(t.details_json,'$.delivery')='email'`)
    .bind(await tokenHash(token), now).first<{ tenant_id: string; envelope_id: string; task_id: string }>();
  return row ? { tenantId: row.tenant_id, envelopeId: row.envelope_id, taskId: row.task_id } : null;
}

/** Envelopes in progress with an active task whose signer Esign invites and has not been invited; of one organization, when given. */
export async function envelopesOwingInvitations(db: D1Database, limit = 25, tenantId: string | null = null): Promise<{ id: string; tenant_id: string }[]> {
  return (await db.prepare(`SELECT e.id,e.tenant_id FROM envelopes e WHERE e.status='IN_PROGRESS' AND (?2 IS NULL OR e.tenant_id=?2) AND EXISTS (
      SELECT 1 FROM tasks t WHERE t.envelope_id=e.id AND t.status='ACTIVE' AND json_extract(t.details_json,'$.delivery')='email'
        AND NOT EXISTS (SELECT 1 FROM invitations i WHERE i.task_id=t.id AND i.sent_at IS NOT NULL))
    ORDER BY RANDOM() LIMIT ?1`).bind(limit, tenantId).all<{ id: string; tenant_id: string }>()).results;
}
