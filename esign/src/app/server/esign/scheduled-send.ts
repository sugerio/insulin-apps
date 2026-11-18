// Send later: a draft envelope that sends itself at a time its sender chose. It stays a draft (status DRAFT) until
// then; what it needs is kept in its own request, `draft_json`, under `schedule`, never in a column of its own:
//
//   schedule: { at: epoch ms, by: who scheduled it, error?: why it couldn't be sent, waiting?: why it hasn't been yet,
//               retryAt?: epoch ms, when a waiting one is tried again }
//
// The platform's five-minute tick (and POST /api/process-due, for one organization) sends the drafts whose time has
// come, as the person who scheduled them, through the very send a person's Send runs (app.ts). One the send refuses
// stays a draft: its time is cleared and the reason kept, for its sender to see. The partial index
// `envelopes_scheduled` (migration 0004) is on `json_extract(draft_json, '$.schedule.at')` for drafts only: every
// query here spells that expression exactly, so the index serves it.
import type { AppRole } from '@fours/app/server';
import { rolePermissions, type AccessVia, type Caller, type Permission } from './identity.ts';
import { memberNow, memberStatusConfigured, type DirectoryEnv } from './directory.ts';

/** The expression the index is on: write it only as this. */
export const SCHEDULE_AT = "json_extract(draft_json, '$.schedule.at')";
/** How far ahead a send may be scheduled, as a signing deadline may be. */
export const MAX_SCHEDULE_MS = 400 * 24 * 60 * 60 * 1000;
/** How soon: the tick runs every five minutes, so a time a minute away is sent at the next one. */
export const MIN_SCHEDULE_MS = 60 * 1000;
/** Drafts sent per tick (or per process-due), oldest time first: the rest wait for the next. */
export const SCHEDULED_PER_RUN = 25;
/**
 * How long a run goes on starting sends: the platform gives the tick 25 seconds, and what is left is for expiring
 * envelopes, the sweep and the usage report. The drafts not reached wait for the next run.
 */
export const SCHEDULED_BUDGET_MS = 10_000;
/**
 * How long a waiting draft (Schedule.waiting) rests before it is tried again: the drafts due are taken oldest first, so
 * without it an organization's waiting drafts would take every run's 25 places from everyone else's. Two ticks.
 */
export const WAITING_RETRY_MS = 10 * 60 * 1000;
/** When a waiting draft is tried again: write it only as this, as SCHEDULE_AT. */
const RETRY_AT = "json_extract(draft_json, '$.schedule.retryAt')";

/** Who scheduled a send: the caller then, as the send needs them when no one is calling. */
export interface ScheduledBy {
  userId: string;
  email: string | null;
  name: string | null;
  role: AppRole;
  permissions: Permission[];
  accessVia: AccessVia;
}
/**
 * `waiting`: a due draft the platform can't vouch for yet (`organization_unconfirmed`), still scheduled and tried
 * again from `retryAt` on.
 */
export interface Schedule { at: number | null; by: ScheduledBy; error?: string; waiting?: string; retryAt?: number }

/** `sendAt` as a request gives it (an ISO 8601 time): epoch ms, or 'invalid' (not a time, too soon or too far). */
export function parseSendAt(value: unknown, now: number): number | 'invalid' {
  if (typeof value !== 'string' || value.length > 40) return 'invalid';
  const at = Date.parse(value);
  if (!Number.isFinite(at) || at < now + MIN_SCHEDULE_MS || at > now + MAX_SCHEDULE_MS) return 'invalid';
  return at;
}

export const scheduledBy = (caller: Caller): ScheduledBy => ({
  userId: caller.userId, email: caller.email, name: caller.name, role: caller.role, permissions: [...caller.permissions], accessVia: caller.accessVia,
});

/** The caller a scheduled send runs as: whoever scheduled it, as they were then. */
export const callerOf = (by: ScheduledBy, organizationId: string): Caller => ({
  userId: by.userId, organizationId, email: by.email, name: by.name, role: by.role, orgRole: null, permissions: new Set(by.permissions), accessVia: by.accessVia, preview: false,
});

/**
 * Whoever scheduled a send, as they are now: with their role and permissions in Esign as the platform's member status
 * says them (directory.ts), so that someone removed from the organization or from Esign, an API client revoked or
 * deleted, an account Insulin Apps suspended or disabled, or someone who may no longer send, sends nothing (null).
 * 'unavailable' when the platform didn't answer, or while the organization is suspended or disabled: asked again at
 * the next tick. 'unconfirmed' while the platform has no record that Esign is used in the organization (one whose
 * only use came just before the platform began to record it: the next request to Esign there records it, DESIGN.md
 * §8.9): asked again every WAITING_RETRY_MS, and the draft says so. Without the platform to ask (the local preview),
 * as they were when they scheduled it.
 */
export async function scheduledCaller(env: DirectoryEnv, by: ScheduledBy, organizationId: string): Promise<Caller | null | 'unavailable' | 'unconfirmed'> {
  const then = callerOf(by, organizationId);
  if (!memberStatusConfigured(env)) return then;
  const now = await memberNow(env, organizationId, by.userId);
  if (!now) return 'unavailable';
  if (now.status === 'unconfirmed') return 'unconfirmed';
  if (now.status !== 'member') return null;
  if (!now.orgActive) return 'unavailable';
  if (!now.active) return null;
  if (now.role !== 'ADMIN' && now.role !== 'EDITOR' && now.role !== 'VIEWER') return null;
  const own = rolePermissions(now.role);
  return { ...then, role: now.role, permissions: new Set(now.permissions ? own.filter((p) => now.permissions!.includes(p)) : own) };
}

/** A draft's request and its schedule, apart: the request is what was asked to be sent, as given. */
export function splitDraft(raw: string | null): { request: Record<string, unknown>; schedule: Schedule | null } {
  let parsed: unknown;
  try { parsed = JSON.parse(raw ?? '{}'); } catch { return { request: {}, schedule: null }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { request: {}, schedule: null };
  const { schedule, ...request } = parsed as Record<string, unknown>;
  const valid = !!schedule && typeof schedule === 'object' && !Array.isArray(schedule) && !!(schedule as Schedule).by;
  return { request, schedule: valid ? schedule as Schedule : null };
}

/**
 * What a draft's schedule shows its readers: when it sends, why it didn't, or why it is still waiting past its time.
 * Never who scheduled it in full.
 */
export function scheduleView(schedule: Schedule | null): { sendAt?: string; sendError?: string; sendWaiting?: string } {
  if (!schedule) return {};
  return {
    ...(typeof schedule.at === 'number' ? { sendAt: new Date(schedule.at).toISOString() } : {}),
    ...(schedule.error ? { sendError: schedule.error } : {}),
    ...(typeof schedule.at === 'number' && schedule.waiting ? { sendWaiting: schedule.waiting } : {}),
  };
}

/** The drafts due now, oldest time first, of one organization or (null) all; a waiting one only once it may be retried. */
export async function dueScheduled(db: D1Database, now: number, tenantId: string | null): Promise<{ id: string; tenant_id: string; draft_json: string }[]> {
  const { results } = await db.prepare(`SELECT id, tenant_id, draft_json FROM envelopes
      WHERE status = 'DRAFT' AND ${SCHEDULE_AT} <= ?1 AND (${RETRY_AT} IS NULL OR ${RETRY_AT} <= ?1) AND (?2 IS NULL OR tenant_id = ?2)
      ORDER BY ${SCHEDULE_AT} LIMIT ${SCHEDULED_PER_RUN}`)
    .bind(now, tenantId).all<{ id: string; tenant_id: string; draft_json: string }>();
  return results;
}

/**
 * A scheduled draft that couldn't be sent: its time is cleared and `error` kept. Only while it is still the draft that
 * was due at `at`: one its sender has changed or sent meanwhile is left as it is.
 */
export async function recordScheduleFailure(db: D1Database, id: string, at: number, error: string): Promise<void> {
  await db.prepare(`UPDATE envelopes SET draft_json = json_remove(json_set(draft_json, '$.schedule.at', NULL, '$.schedule.error', ?1), '$.schedule.waiting', '$.schedule.retryAt')
      WHERE id = ?2 AND status = 'DRAFT' AND ${SCHEDULE_AT} = ?3`).bind(error.slice(0, 100), id, at).run();
}

/**
 * A due draft that waits (`organization_unconfirmed`): still scheduled, tried again WAITING_RETRY_MS from `now`, and its
 * readers told why. Only while it is still the draft that was due at `at`.
 */
export async function recordScheduleWaiting(db: D1Database, id: string, at: number, reason: string, now: number): Promise<void> {
  await db.prepare(`UPDATE envelopes SET draft_json = json_set(draft_json, '$.schedule.waiting', ?1, '$.schedule.retryAt', ?4)
      WHERE id = ?2 AND status = 'DRAFT' AND ${SCHEDULE_AT} = ?3`).bind(reason, id, at, now + WAITING_RETRY_MS).run();
}
