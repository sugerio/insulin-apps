/**
 * Sign-by deadlines. A recipient may carry a deadline (tasks.expires_at); once it passes while
 * that recipient has not signed, the envelope EXPIRES for everyone. Every signing path requires
 * an envelope IN_PROGRESS, so an expired envelope can no longer be opened, verified or signed.
 * A recipient who has signed is past their deadline's reach: a countersigner without a
 * deadline never makes the envelope expire.
 *
 * Expiry is applied lazily, before a request touches the envelope, and by the cron sweep.
 */
import { AUDIT } from './audit.ts';

/** The longest deadline accepted at envelope creation. */
export const MAX_DEADLINE_MS = 400 * 86_400_000;

/** A recipient's deadline from the create request: epoch ms, null when absent, or 'invalid'. */
export function parseDeadline(value: unknown, now = Date.now()): number | null | 'invalid' {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return 'invalid';
  const at = Date.parse(value);
  if (!Number.isFinite(at) || at <= now || at > now + MAX_DEADLINE_MS) return 'invalid';
  return at;
}

// A recipient whose signature exists has signed, even before the task is marked SIGNED.
const UNSIGNED = "t.status <> 'SIGNED' AND NOT EXISTS (SELECT 1 FROM signatures g WHERE g.task_id = t.id)";
const DUE = `EXISTS (SELECT 1 FROM tasks t WHERE t.envelope_id = envelopes.id AND t.expires_at <= ?1 AND ${UNSIGNED})`;

/** Expires the envelope if a recipient's deadline passed unsigned. True when it is EXPIRED now. */
export async function expireIfDue(db: D1Database, envelopeId: string, now = Date.now()): Promise<boolean> {
  const task = await db.prepare(`SELECT t.id FROM tasks t JOIN envelopes e ON e.id = t.envelope_id WHERE t.envelope_id = ?1 AND e.status = 'IN_PROGRESS' AND t.expires_at <= ?2 AND ${UNSIGNED} ORDER BY t.routing_order LIMIT 1`)
    .bind(envelopeId, now).first<{ id: string }>();
  if (!task) return false;
  // One batch: the status change and its audit event commit together, once.
  await db.batch([
    db.prepare(`UPDATE envelopes SET status = 'EXPIRED' WHERE id = ?2 AND status = 'IN_PROGRESS' AND ${DUE}`).bind(now, envelopeId),
    db.prepare("INSERT INTO audit_events (envelope_id, task_id, type, occurred_at, ip, user_agent, detail_json) SELECT ?1, NULL, ?2, ?3, NULL, NULL, ?4 WHERE EXISTS (SELECT 1 FROM envelopes WHERE id = ?1 AND status = 'EXPIRED') AND NOT EXISTS (SELECT 1 FROM audit_events WHERE envelope_id = ?1 AND type = ?2)")
      .bind(envelopeId, AUDIT.expired, now, JSON.stringify({ taskId: task.id })),
  ]);
  return true;
}

/** Process-due: expires every envelope of the organization with a passed deadline. Returns how many it expired. */
export async function expireDueEnvelopes(db: D1Database, now = Date.now(), tenantId: string | null = null): Promise<number> {
  const due = await db.prepare(`SELECT id FROM envelopes WHERE status = 'IN_PROGRESS' AND (?2 IS NULL OR tenant_id = ?2) AND ${DUE} LIMIT 200`).bind(now, tenantId).all<{ id: string }>();
  let expired = 0;
  for (const { id } of due.results) if (await expireIfDue(db, id, now)) expired++;
  return expired;
}
