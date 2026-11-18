// Send later: a draft envelope that sends itself at a time its sender chose. It stays a draft (status DRAFT) until
// then; what it needs is kept in its own request, `draft_json`, under `schedule`, never in a column of its own:
//
//   schedule: { at: epoch ms, by: who scheduled it, error?: why it couldn't be sent, waiting?: why it hasn't been yet,
//               retryAt?: epoch ms, when a waiting or deferred one is tried again }
//
// The platform's five-minute tick (and POST /api/process-due, for one organization) sends the drafts whose time has
// come, as the person who scheduled them, through the very send a person's Send runs (app.ts). One the send refuses
// stays a draft: its time is cleared and the reason kept, for its sender to see. The partial index
// `envelopes_scheduled` (migration 0004) is on `json_extract(draft_json, '$.schedule.at')` for drafts only: every
// query here spells that expression exactly, so the index serves it.
import type { AppRole } from '@fours/app/server';
import { rolePermissions, type AccessVia, type Caller, type Permission } from './identity.ts';
import type { OrganizationNow } from './directory.ts';

/** The expression the index is on: write it only as this. */
export const SCHEDULE_AT = "json_extract(draft_json, '$.schedule.at')";
/** How far ahead a send may be scheduled, as a signing deadline may be. */
export const MAX_SCHEDULE_MS = 400 * 24 * 60 * 60 * 1000;
/** How soon: the tick runs every five minutes, so a time a minute away is sent at the next one. */
export const MIN_SCHEDULE_MS = 60 * 1000;
/** Drafts sent (or refused) per tick (or per process-due), oldest time first: the rest wait for the next. */
export const SCHEDULED_PER_RUN = 25;
/**
 * How long a run goes on starting sends: the platform gives the tick 25 seconds, and what is left is for expiring
 * envelopes, the sweep and the usage report. The drafts not reached wait for the next run.
 */
export const SCHEDULED_BUDGET_MS = 10_000;
/**
 * How long a waiting draft (Schedule.waiting) rests before its organization is asked about again: two ticks. Every due
 * draft of an organization the platform can't vouch for rests at once, after one question (restWaiting), so waiting
 * drafts never take the places of other organizations' (app.ts sendScheduled).
 */
export const WAITING_RETRY_MS = 10 * 60 * 1000;
/**
 * How long a suspended organization's due drafts step back: less than a tick, so the next run asks again (they wait
 * while it is suspended, as before); until then it isn't asked about.
 */
export const DEFER_MS = 4 * 60 * 1000;
/** The organizations one wave of a run takes, all asked about at once (sendScheduled). */
export const WAVE_ORGANIZATIONS = 10;
/** The `app_settings` row holding the last organization a run reached (a JSON string; none before the first run). */
export const CURSOR_SETTING = 'scheduled_cursor';
/**
 * The `app_settings` row a run holds while it sends scheduled drafts for every organization (`{"id", "until"}`), so
 * two runs never take turns from the same cursor at once; one whose `until` has passed (a run that crashed) is taken
 * over.
 */
export const LEASE_SETTING = 'scheduled_lease';
/**
 * How much longer than its budget a run's lease lasts: past the 25 seconds the platform gives its tick, so a lease
 * outlives any run still going.
 */
export const LEASE_MARGIN_MS = 20_000;
/** When a waiting or deferred draft is tried again: write it only as this, as SCHEDULE_AT. */
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
 * `waiting`: a due draft the platform can't vouch for yet (`organization_unconfirmed`), still scheduled. `retryAt`: when
 * a waiting draft, or one of a suspended organization (DEFER_MS), is tried again.
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
 * Whoever scheduled a send, as they are now, from the platform's answer about the organization (`now`, directory.ts
 * organizationNow; undefined without the platform to ask, the local preview): with their role and permissions in
 * Esign as the platform says them, so that someone removed from the organization or from Esign, an API client revoked
 * or deleted, an account Insulin Apps suspended or disabled, someone who may no longer send, or anyone of a deleted
 * organization, sends nothing (null). 'unavailable' when the platform didn't answer, or about them, or while the
 * organization is suspended or disabled: asked again at the next tick. 'unconfirmed' while the platform has no record
 * that Esign is used in the organization (one whose only use came just before the platform began to record it: the
 * next request to Esign there records it, DESIGN.md §8.9): the draft rests and says so (restWaiting). Without the
 * platform, as they were when they scheduled it.
 */
export function scheduledCaller(by: ScheduledBy, organizationId: string, now: OrganizationNow | null | undefined): Caller | null | 'unavailable' | 'unconfirmed' {
  const then = callerOf(by, organizationId);
  if (now === undefined) return then;
  if (now === null) return 'unavailable';
  if (now.status === 'unconfirmed') return 'unconfirmed';
  if (now.status === 'deleted') return null;
  const member = now.members.get(by.userId);
  if (!member) return 'unavailable';
  if (member.status !== 'member') return null;
  if (!now.active) return 'unavailable';
  if (!member.active) return null;
  if (member.role !== 'ADMIN' && member.role !== 'EDITOR' && member.role !== 'VIEWER') return null;
  const own = rolePermissions(member.role);
  return { ...then, role: member.role, permissions: new Set(member.permissions ? own.filter((p) => member.permissions!.includes(p)) : own) };
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

/**
 * The organizations with a draft due now (?1 now; ?2 one organization, or null for all), WAVE_ORGANIZATIONS of them,
 * those after the cursor (?3) first in id order, then from the start again, leaving out ?4 (a JSON list: those a run
 * has asked about already). Exported for the query-plan test.
 */
export const DUE_ORGANIZATIONS_SQL = `SELECT tenant_id FROM (
    SELECT DISTINCT tenant_id FROM envelopes INDEXED BY envelopes_scheduled
    WHERE status = 'DRAFT' AND ${SCHEDULE_AT} <= ?1 AND (${RETRY_AT} IS NULL OR ${RETRY_AT} <= ?1) AND (?2 IS NULL OR tenant_id = ?2)
      AND tenant_id NOT IN (SELECT value FROM json_each(?4))
  ) ORDER BY tenant_id > ?3 DESC, tenant_id LIMIT ${WAVE_ORGANIZATIONS}`;

/**
 * The due drafts of the organizations in ?2 (a JSON list), up to SCHEDULED_PER_RUN each, each organization's by when
 * they are next due (retryAt, else their time), numbered `turn` from 1. Both queries read the drafts due through the
 * partial index on the time (never every envelope of an organization). Exported for the query-plan test.
 */
export const DUE_DRAFTS_SQL = `SELECT id, tenant_id, draft_json, turn FROM (
    SELECT id, tenant_id, draft_json, ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY COALESCE(${RETRY_AT}, ${SCHEDULE_AT}), id) AS turn
    FROM envelopes INDEXED BY envelopes_scheduled
    WHERE status = 'DRAFT' AND ${SCHEDULE_AT} <= ?1 AND (${RETRY_AT} IS NULL OR ${RETRY_AT} <= ?1) AND tenant_id IN (SELECT value FROM json_each(?2))
  ) WHERE turn <= ${SCHEDULED_PER_RUN} ORDER BY tenant_id, turn`;

/** The next WAVE_ORGANIZATIONS organizations with a draft due, after `cursor` and round again (DUE_ORGANIZATIONS_SQL). */
export async function dueOrganizations(db: D1Database, now: number, tenantId: string | null, cursor: string, leaveOut: string[]): Promise<string[]> {
  const { results } = await db.prepare(DUE_ORGANIZATIONS_SQL).bind(now, tenantId, cursor, JSON.stringify(leaveOut)).all<{ tenant_id: string }>();
  return results.map((row) => row.tenant_id);
}

/** The due drafts of these organizations, each organization's in its order (DUE_DRAFTS_SQL). */
export async function dueDrafts(db: D1Database, now: number, organizations: string[]): Promise<Map<string, { id: string; tenant_id: string; draft_json: string }[]>> {
  const { results } = await db.prepare(DUE_DRAFTS_SQL).bind(now, JSON.stringify(organizations)).all<{ id: string; tenant_id: string; draft_json: string }>();
  const drafts = new Map<string, { id: string; tenant_id: string; draft_json: string }[]>(organizations.map((org) => [org, []]));
  for (const row of results) drafts.get(row.tenant_id)?.push(row);
  return drafts;
}

/** The last organization a run reached (CURSOR_SETTING), or '' (before the first). */
export async function readCursor(db: D1Database): Promise<string> {
  const row = await db.prepare("SELECT json_extract(value, '$') AS org FROM app_settings WHERE name = ?").bind(CURSOR_SETTING).first<{ org: unknown }>();
  return typeof row?.org === 'string' ? row.org : '';
}

/**
 * Takes the run lease (LEASE_SETTING) until `until`, in one conditional statement: only while no unexpired lease is
 * held. True when this run (`id`) now holds it.
 */
export async function takeLease(db: D1Database, id: string, now: number, until: number): Promise<boolean> {
  const row = await db.prepare(`INSERT INTO app_settings (name, value) VALUES (?1, json_object('id', ?2, 'until', ?4))
      ON CONFLICT (name) DO UPDATE SET value = excluded.value WHERE json_extract(app_settings.value, '$.until') <= ?3
      RETURNING json_extract(value, '$.id') AS id`).bind(LEASE_SETTING, id, now, until).first<{ id: string }>();
  return row?.id === id;
}

/** Gives the run lease back, if this run (`id`) still holds it. */
export async function releaseLease(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM app_settings WHERE name = ?1 AND json_extract(value, '$.id') = ?2").bind(LEASE_SETTING, id).run();
}

/**
 * Records the last organization a run reached, in one conditional statement: only while the run (`lease`) still holds
 * the run lease. A run that outlived its lease, which another run has taken over, leaves the cursor to that one. True
 * when written.
 */
export async function writeCursor(db: D1Database, org: string, lease: string): Promise<boolean> {
  const result = await db.prepare(`INSERT INTO app_settings (name, value)
      SELECT ?1, json_quote(?2) WHERE EXISTS (SELECT 1 FROM app_settings WHERE name = ?3 AND json_extract(value, '$.id') = ?4)
      ON CONFLICT (name) DO UPDATE SET value = excluded.value`).bind(CURSOR_SETTING, org, LEASE_SETTING, lease).run();
  return result.meta.changes > 0;
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
 * Every draft of the organization due now and not resting, which waits (`reason`: `organization_unconfirmed`): still
 * scheduled, its organization asked about again WAITING_RETRY_MS from `now`, and its readers told why. One statement,
 * whatever their number.
 */
export async function restWaiting(db: D1Database, tenantId: string, reason: string, now: number): Promise<void> {
  await stepBack(db, tenantId, now, now + WAITING_RETRY_MS, reason);
}

/** Every draft of a suspended organization due now and not resting steps back DEFER_MS (sendScheduled), its note unchanged. */
export async function deferOrganization(db: D1Database, tenantId: string, now: number): Promise<void> {
  await stepBack(db, tenantId, now, now + DEFER_MS, null);
}

async function stepBack(db: D1Database, tenantId: string, now: number, retryAt: number, reason: string | null): Promise<void> {
  const set = reason === null ? "json_set(draft_json, '$.schedule.retryAt', ?4)" : "json_set(draft_json, '$.schedule.retryAt', ?4, '$.schedule.waiting', ?2)";
  await db.prepare(`UPDATE envelopes SET draft_json = ${set}
      WHERE tenant_id = ?1 AND status = 'DRAFT' AND ${SCHEDULE_AT} <= ?3 AND (${RETRY_AT} IS NULL OR ${RETRY_AT} <= ?3)`)
    .bind(tenantId, reason ?? '', now, retryAt).run();
}
