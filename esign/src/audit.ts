/**
 * The audit trail of a signing: who did what, when and from where. Append-only (the table's
 * triggers refuse changes). The events up to completion are part of the managed seal
 * (seal/managed.ts); later ones, such as the copies sent, are recorded after it.
 */
import { RECIPIENT_SESSION_FROM } from './access.ts';

export const AUDIT = {
  /** A signing link was issued for a recipient (by the host's backend). */
  viewIssued: 'RECIPIENT_VIEW_ISSUED',
  /** The recipient opened the signing page with that link. */
  sessionOpened: 'SIGNING_SESSION_OPENED',
  otpSent: 'OTP_SENT',
  otpVerified: 'OTP_VERIFIED',
  documentViewed: 'DOCUMENT_VIEWED',
  /** The signer looked at these pages of the document for the first time (detail: pages, total). */
  pagesViewed: 'PAGES_VIEWED',
  signed: 'SIGNED',
  completed: 'COMPLETED',
  copySent: 'COPY_SENT',
  /** The sender voided the envelope before everyone had signed (management API). */
  voided: 'VOIDED',
  /** A recipient's sign-by deadline passed before they signed (src/task-expiry.ts). */
  expired: 'EXPIRED',
  /** The signer whose turn it was declined to sign, with a reason. */
  declined: 'DECLINED',
} as const;

export type AuditEvent = {
  id: number; envelopeId: string; taskId: string | null; type: string; occurredAt: number;
  ip: string | null; userAgent: string | null; detail: Record<string, unknown> | null;
};

/** The client IP Cloudflare saw, and the browser's user agent. */
export function requestFacts(request: Request): { ip: string | null; userAgent: string | null } {
  const ip = request.headers.get('cf-connecting-ip') ?? '';
  const userAgent = request.headers.get('user-agent') ?? '';
  return { ip: /^[0-9a-fA-F.:]{2,45}$/.test(ip) ? ip : null, userAgent: userAgent ? userAgent.slice(0, 512) : null };
}

export async function recordAudit(db: D1Database, event: { envelopeId: string; taskId?: string | null; type: string; ip?: string | null; userAgent?: string | null; detail?: Record<string, unknown>; at?: number }): Promise<void> {
  await db.prepare('INSERT INTO audit_events (envelope_id,task_id,type,occurred_at,ip,user_agent,detail_json) VALUES (?,?,?,?,?,?,?)')
    .bind(event.envelopeId, event.taskId ?? null, event.type, event.at ?? Date.now(), event.ip ?? null, event.userAgent ?? null, event.detail ? JSON.stringify(event.detail) : null).run();
}

/** Records an event without failing the request it belongs to; a failure is logged. */
export async function recordAuditQuietly(db: D1Database, event: Parameters<typeof recordAudit>[1]): Promise<void> {
  try { await recordAudit(db, event); }
  catch { console.error(`E-sign: could not record audit event ${event.type} for envelope ${event.envelopeId}`); }
}

type Row = { id: number; envelope_id: string; task_id: string | null; type: string; occurred_at: number; ip: string | null; user_agent: string | null; detail_json: string | null };

export async function auditTrail(db: D1Database, envelopeId: string): Promise<AuditEvent[]> {
  const rows = (await db.prepare('SELECT id,envelope_id,task_id,type,occurred_at,ip,user_agent,detail_json FROM audit_events WHERE envelope_id=? ORDER BY id').bind(envelopeId).all<Row>()).results;
  return rows.map(r => ({ id: r.id, envelopeId: r.envelope_id, taskId: r.task_id, type: r.type, occurredAt: r.occurred_at, ip: r.ip, userAgent: r.user_agent, detail: r.detail_json ? JSON.parse(r.detail_json) as Record<string, unknown> : null }));
}

/** The envelope and task of a recipient page session, by its bearer token. */
export async function sessionContext(db: D1Database, token: string): Promise<{ tenantId: string; envelopeId: string; taskId: string } | null> {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))), b => b.toString(16).padStart(2, '0')).join('');
  const row = await db.prepare(`SELECT s.tenant_id,e.id AS envelope_id,t.id AS task_id FROM ${RECIPIENT_SESSION_FROM} WHERE s.scope='recipient' AND s.token_hash=?`).bind(hash).first<{ tenant_id: string; envelope_id: string; task_id: string }>();
  return row ? { tenantId: row.tenant_id, envelopeId: row.envelope_id, taskId: row.task_id } : null;
}
