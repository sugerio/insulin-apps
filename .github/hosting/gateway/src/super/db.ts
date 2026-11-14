// The operator console's queries (DESIGN.md §11): its own operators, sessions, sign-ins in flight, audit log, hourly
// jobs and Cloudflare snapshots, and what it reads of the platform's organizations and accounts. It reads names,
// addresses, roles, dates, standings and counts; never a secret, a token, an app's data or what a message said.
import type { AccountStatus } from '../db/users.ts'
import { ownerDomainOf } from '../owner-domain.ts'
import type { Role } from '../roles.ts'

export type Status = AccountStatus
export const STATUSES: readonly Status[] = ['active', 'suspended', 'disabled']

export function isStatus(value: unknown): value is Status {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value)
}

export const SESSION_TTL_MS = 8 * 60 * 60 * 1000
export const SIGN_IN_TTL_MS = 10 * 60 * 1000
const JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
export const SNAPSHOT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000
/** A claimed hourly job that hasn't finished after this long is taken to have died, and may be claimed again. */
const JOB_STALE_MS = 15 * 60 * 1000

export interface Operator {
  id: string
  email: string
  name: string
}

/** Records an operator's sign-in: the first creates them; their name follows what Google says now. */
export async function upsertOperator(db: D1Database, operator: { id: string; email: string; name: string; now: number }): Promise<Operator> {
  const row = await db.prepare(
    `INSERT INTO super_operators (id, email, name, created_at, last_sign_in_at) VALUES (?1, ?2, ?3, ?4, ?4)
     ON CONFLICT (email) DO UPDATE SET name = excluded.name, last_sign_in_at = excluded.last_sign_in_at
     RETURNING id, email, name`,
  ).bind(operator.id, operator.email, operator.name, operator.now).first<Operator>()
  return row!
}

export async function insertSuperSession(db: D1Database, session: { idHash: string; operatorId: string; now: number }): Promise<void> {
  await db.prepare('INSERT INTO super_sessions (id_hash, operator_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(session.idHash, session.operatorId, session.now, session.now + SESSION_TTL_MS).run()
}

export function findSuperSession(db: D1Database, idHash: string, now: number): Promise<(Operator & { expires_at: number }) | null> {
  return db.prepare(
    `SELECT o.id, o.email, o.name, s.expires_at FROM super_sessions s JOIN super_operators o ON o.id = s.operator_id
     WHERE s.id_hash = ?1 AND s.expires_at > ?2`,
  ).bind(idHash, now).first()
}

export async function deleteSuperSession(db: D1Database, idHash: string): Promise<void> {
  await db.prepare('DELETE FROM super_sessions WHERE id_hash = ?1').bind(idHash).run()
}

export async function insertSignIn(db: D1Database, request: { idHash: string; bindingHash: string; now: number }): Promise<void> {
  await db.prepare('INSERT INTO super_saml_requests (id_hash, binding_hash, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(request.idHash, request.bindingHash, request.now, request.now + SIGN_IN_TTL_MS).run()
}

/** Uses a pending sign-in once, if this browser started it and it hasn't expired. */
export async function consumeSignIn(db: D1Database, idHash: string, bindingHash: string, now: number): Promise<boolean> {
  const row = await db.prepare('DELETE FROM super_saml_requests WHERE id_hash = ?1 AND binding_hash = ?2 AND expires_at > ?3 RETURNING id_hash')
    .bind(idHash, bindingHash, now).first()
  return row !== null
}

export interface AuditEntry {
  operator: Operator
  action: string
  targetType: 'org' | 'user' | null
  targetId: string | null
  targetLabel: string | null
  reason: string | null
  now: number
}

/** The audit record of an action, written only if `condition` (SQL, with the action's own parameters) holds. */
function auditStatement(db: D1Database, entry: AuditEntry, condition = '1'): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO super_audit (at, operator_id, operator_email, action, target_type, target_id, target_label, reason)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 WHERE ${condition}`,
  ).bind(entry.now, entry.operator.id, entry.operator.email, entry.action, entry.targetType, entry.targetId, entry.targetLabel, entry.reason)
}

export async function audit(db: D1Database, entry: AuditEntry): Promise<void> {
  await auditStatement(db, entry).run()
}

export interface AuditRow {
  id: number
  at: number
  operator_email: string
  action: string
  target_type: string | null
  target_id: string | null
  target_label: string | null
  reason: string | null
}

/** The audit log, newest first: everything, or one target's history. */
export async function listAudit(db: D1Database, options: { target?: { type: 'org' | 'user'; id: string }; limit: number; before?: number }): Promise<AuditRow[]> {
  const { results } = await db.prepare(
    `SELECT id, at, operator_email, action, target_type, target_id, target_label, reason FROM super_audit
     WHERE (?1 IS NULL OR (target_type = ?1 AND target_id = ?2)) AND (?3 IS NULL OR id < ?3)
     ORDER BY id DESC LIMIT ?4`,
  ).bind(options.target?.type ?? null, options.target?.id ?? null, options.before ?? null, options.limit).all<AuditRow>()
  return results
}

/**
 * Changes an organization's standing (DESIGN.md §11.3) and records it, in one batch. D1 runs a batch as one
 * transaction, one batch at a time, so the statements before the update see the standing as it was: the audit record
 * and the side effects are written only by the batch that changes it, and a repeated request, however close in time,
 * changes and records nothing. Disabling also ends, for good, what acts in the organization without a person present:
 * every AI agent's grant (with its tokens), every API client (revoked, its tokens deleted), the pending invitations and
 * the SCIM tokens. False when nothing changed.
 */
export async function setOrgStatus(db: D1Database, change: { orgId: string; status: Status; reason: string; operator: Operator; label: string; now: number }): Promise<boolean> {
  // The standing is one of three constants (isStatus), so it is written into the conditions; ?6 is the audit's target.
  const statements = [
    auditStatement(db, {
      operator: change.operator, action: `org.${verb(change.status)}`, targetType: 'org', targetId: change.orgId, targetLabel: change.label,
      reason: change.reason, now: change.now,
    }, `EXISTS (SELECT 1 FROM orgs c WHERE c.id = ?6 AND c.status <> '${change.status}')`),
  ]
  if (change.status === 'disabled') {
    const changing = "EXISTS (SELECT 1 FROM orgs c WHERE c.id = ?1 AND c.status <> 'disabled')"
    statements.push(
      db.prepare(`DELETE FROM oauth_grants WHERE org_id = ?1 AND ${changing}`).bind(change.orgId),
      db.prepare(`DELETE FROM oauth_tokens WHERE service_account_id IN (SELECT id FROM service_accounts WHERE org_id = ?1) AND ${changing}`)
        .bind(change.orgId),
      db.prepare(
        `UPDATE service_accounts SET revoked_at = ?2, revoked_by = NULL, previous_secret_hash = NULL, previous_secret_expires_at = NULL
         WHERE org_id = ?1 AND revoked_at IS NULL AND ${changing}`,
      ).bind(change.orgId, change.now),
      db.prepare(`UPDATE invitations SET status = 'revoked', responded_at = ?2 WHERE org_id = ?1 AND status = 'pending' AND ${changing}`)
        .bind(change.orgId, change.now),
      db.prepare(`DELETE FROM scim_tokens WHERE org_id = ?1 AND ${changing}`).bind(change.orgId),
    )
  }
  statements.push(
    db.prepare('UPDATE orgs SET status = ?2, status_reason = ?3, status_changed_at = ?4, updated_at = ?4 WHERE id = ?1 AND status <> ?2')
      .bind(change.orgId, change.status, change.status === 'active' ? null : change.reason, change.now),
  )
  const results = await db.batch(statements)
  return (results[results.length - 1]?.meta.changes ?? 0) > 0
}

/**
 * Changes an account's standing and records it, in one batch, as setOrgStatus does. Disabling also deletes the
 * account's sessions, AI agents' grants (with their tokens) and pending two-step sign-ins; suspending keeps them, refused
 * while it lasts, so reinstating gives everything back. False when nothing changed.
 */
export async function setUserStatus(db: D1Database, change: { userId: string; status: Status; reason: string; operator: Operator; label: string; now: number }): Promise<boolean> {
  const statements = [
    auditStatement(db, {
      operator: change.operator, action: `user.${verb(change.status)}`, targetType: 'user', targetId: change.userId, targetLabel: change.label,
      reason: change.reason, now: change.now,
    }, `EXISTS (SELECT 1 FROM users c WHERE c.id = ?6 AND c.status <> '${change.status}')`),
  ]
  if (change.status === 'disabled') {
    const changing = "EXISTS (SELECT 1 FROM users c WHERE c.id = ?1 AND c.status <> 'disabled')"
    statements.push(
      db.prepare(`DELETE FROM sessions WHERE user_id = ?1 AND ${changing}`).bind(change.userId),
      db.prepare(`DELETE FROM oauth_grants WHERE user_id = ?1 AND ${changing}`).bind(change.userId),
      db.prepare(`DELETE FROM mfa_challenges WHERE user_id = ?1 AND ${changing}`).bind(change.userId),
    )
  }
  statements.push(
    db.prepare('UPDATE users SET status = ?2, status_reason = ?3, status_changed_at = ?4, updated_at = ?4 WHERE id = ?1 AND status <> ?2')
      .bind(change.userId, change.status, change.status === 'active' ? null : change.reason, change.now),
  )
  const results = await db.batch(statements)
  return (results[results.length - 1]?.meta.changes ?? 0) > 0
}

function verb(status: Status): string {
  return status === 'active' ? 'reinstate' : status === 'suspended' ? 'suspend' : 'disable'
}

/**
 * Creates an organization for an existing, confirmed, active account as its OWNER, past its owner domain's limit
 * (DESIGN.md §11.4), and records it, in one batch. The organization still counts for its owner domain like any other,
 * so the person's own next one is limited as before. False when the account isn't there, confirmed and active.
 */
export async function createOrgForUser(db: D1Database, org: { id: string; name: string; user: { id: string; email: string }; reason: string; operator: Operator; now: number }): Promise<boolean> {
  // The id comes from the form, so a form sent twice creates one organization; the statements after the insert run only
  // for the row this batch wrote (its operator and time), never for an organization that already had the id.
  const ours = 'EXISTS (SELECT 1 FROM orgs WHERE id = ?1 AND created_by = ?2 AND created_by_operator = ?4 AND created_at = ?3)'
  const [created] = await db.batch([
    db.prepare(
      `INSERT INTO orgs (id, name, created_by, owner_domain, created_at, updated_at, created_by_operator)
       SELECT ?1, ?2, u.id, ?4, ?5, ?5, ?6 FROM users u WHERE u.id = ?3 AND u.email_verified_at IS NOT NULL AND u.status = 'active'
       ON CONFLICT (id) DO NOTHING`,
    ).bind(org.id, org.name, org.user.id, ownerDomainOf(org.user.email), org.now, org.operator.email),
    db.prepare(`INSERT INTO memberships (org_id, user_id, role, created_at, updated_at) SELECT ?1, ?2, 'OWNER', ?3, ?3 WHERE ${ours}`)
      .bind(org.id, org.user.id, org.now, org.operator.email),
    db.prepare(`UPDATE users SET orgs_created = orgs_created + 1, updated_at = ?3 WHERE id = ?2 AND ${ours}`)
      .bind(org.id, org.user.id, org.now, org.operator.email),
    auditStatement(db, {
      operator: org.operator, action: 'org.create', targetType: 'org', targetId: org.id, targetLabel: `${org.name} (for ${org.user.email})`,
      reason: org.reason, now: org.now,
    }, 'EXISTS (SELECT 1 FROM orgs WHERE id = ?6 AND created_by_operator = ?3 AND created_at = ?1)'),
  ])
  return (created?.meta.changes ?? 0) > 0
}

/** Who an organization was created for and by which operator, for a create form sent again. */
export function createdBy(db: D1Database, orgId: string): Promise<{ created_by: string | null; created_by_operator: string | null } | null> {
  return db.prepare('SELECT created_by, created_by_operator FROM orgs WHERE id = ?1').bind(orgId).first()
}

export interface Overview {
  orgs: number
  orgs_new_7d: number
  orgs_suspended: number
  orgs_disabled: number
  users: number
  users_new_7d: number
  users_unconfirmed: number
  active_1d: number
  active_7d: number
  active_30d: number
  orgs_active_7d: number
  users_suspended: number
  users_disabled: number
}

const DAY = 24 * 60 * 60 * 1000

export async function overview(db: D1Database, now: number): Promise<Overview> {
  const row = await db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM orgs) AS orgs,
       (SELECT COUNT(*) FROM orgs WHERE created_at >= ?2) AS orgs_new_7d,
       (SELECT COUNT(*) FROM orgs WHERE status = 'suspended') AS orgs_suspended,
       (SELECT COUNT(*) FROM orgs WHERE status = 'disabled') AS orgs_disabled,
       (SELECT COUNT(*) FROM orgs WHERE last_active_at >= ?2) AS orgs_active_7d,
       (SELECT COUNT(*) FROM users) AS users,
       (SELECT COUNT(*) FROM users WHERE created_at >= ?2) AS users_new_7d,
       (SELECT COUNT(*) FROM users WHERE email_verified_at IS NULL) AS users_unconfirmed,
       (SELECT COUNT(*) FROM users WHERE last_active_at >= ?1) AS active_1d,
       (SELECT COUNT(*) FROM users WHERE last_active_at >= ?2) AS active_7d,
       (SELECT COUNT(*) FROM users WHERE last_active_at >= ?3) AS active_30d,
       (SELECT COUNT(*) FROM users WHERE status = 'suspended') AS users_suspended,
       (SELECT COUNT(*) FROM users WHERE status = 'disabled') AS users_disabled`,
  ).bind(now - DAY, now - 7 * DAY, now - 30 * DAY).first<Overview>()
  return row!
}

/** New accounts and organizations per UTC day since `since` (days with none are left out). */
export async function dailyNew(db: D1Database, since: number): Promise<{ users: Map<number, number>; orgs: Map<number, number> }> {
  const [users, orgs] = await db.batch<{ day: number; count: number }>([
    db.prepare('SELECT (created_at / 86400000) * 86400000 AS day, COUNT(*) AS count FROM users WHERE created_at >= ?1 GROUP BY day').bind(since),
    db.prepare('SELECT (created_at / 86400000) * 86400000 AS day, COUNT(*) AS count FROM orgs WHERE created_at >= ?1 GROUP BY day').bind(since),
  ])
  const toMap = (rows: { day: number; count: number }[]) => new Map(rows.map((row) => [row.day, row.count]))
  return { users: toMap(users?.results ?? []), orgs: toMap(orgs?.results ?? []) }
}

export interface Signals {
  /** Owner domains with as many organizations as they may have, or more (an allowance lowered later). */
  domainsAtLimit: { owner_domain: string; orgs: number; max_orgs: number }[]
  /** E-mail domains with ten or more new accounts in the last day. */
  signupBursts: { domain: string; accounts: number }[]
  /** Accounts never confirmed, a week after they were made. */
  staleUnconfirmed: number
  /** Requests for more organizations in the last day. */
  orgRequests: number
}

export async function signals(db: D1Database, now: number): Promise<Signals> {
  const [atLimit, bursts, stale, requests] = await db.batch([
    db.prepare(
      `SELECT o.owner_domain, COUNT(*) AS orgs, COALESCE(a.max_orgs, ?1) AS max_orgs
       FROM orgs o LEFT JOIN org_domain_allowances a ON a.owner_domain = o.owner_domain
       WHERE o.owner_domain IS NOT NULL GROUP BY o.owner_domain HAVING COUNT(*) >= COALESCE(a.max_orgs, ?1)
       ORDER BY orgs DESC, o.owner_domain LIMIT 10`,
    ).bind(2),
    db.prepare(
      `SELECT substr(email, instr(email, '@') + 1) AS domain, COUNT(*) AS accounts FROM users WHERE created_at >= ?1
       GROUP BY domain HAVING COUNT(*) >= 10 ORDER BY accounts DESC, domain LIMIT 10`,
    ).bind(now - DAY),
    db.prepare('SELECT COUNT(*) AS count FROM users WHERE email_verified_at IS NULL AND created_at < ?1').bind(now - 7 * DAY),
    db.prepare("SELECT COUNT(*) AS count FROM mail_log WHERE kind = 'org_request' AND created_at >= ?1").bind(now - DAY),
  ])
  return {
    domainsAtLimit: (atLimit?.results ?? []) as Signals['domainsAtLimit'],
    signupBursts: (bursts?.results ?? []) as Signals['signupBursts'],
    staleUnconfirmed: ((stale?.results ?? [])[0] as { count: number } | undefined)?.count ?? 0,
    orgRequests: ((requests?.results ?? [])[0] as { count: number } | undefined)?.count ?? 0,
  }
}

export const PAGE_SIZE = 50

/** A search box's text as a LIKE pattern (its wildcards escaped), or null for none. */
function likePattern(query: string): string | null {
  const text = query.trim().toLowerCase()
  return text ? `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%` : null
}

export interface OrgListRow {
  id: string
  name: string
  owner_domain: string | null
  status: Status
  created_at: number
  last_active_at: number | null
  members: number
}

export type OrgSort = 'created' | 'active' | 'name' | 'members'
const ORG_ORDER: Record<OrgSort, string> = {
  created: 'o.created_at DESC, o.id',
  active: 'o.last_active_at IS NULL, o.last_active_at DESC, o.id',
  name: 'o.name COLLATE NOCASE, o.id',
  members: 'members DESC, o.created_at DESC, o.id',
}

/** Organizations matching a name, id, owner domain or member's address, in a standing, a page at a time. */
export async function listOrgs(db: D1Database, options: { query: string; status: Status | null; sort: OrgSort; page: number }): Promise<{ rows: OrgListRow[]; total: number }> {
  const pattern = likePattern(options.query)
  const where = `(?1 IS NULL OR lower(o.name) LIKE ?1 ESCAPE '\\' OR o.id = ?2 OR o.owner_domain LIKE ?1 ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = o.id AND u.email LIKE ?1 ESCAPE '\\'))
    AND (?3 IS NULL OR o.status = ?3)`
  const [rows, total] = await db.batch([
    db.prepare(
      `SELECT o.id, o.name, o.owner_domain, o.status, o.created_at, o.last_active_at,
         (SELECT COUNT(*) FROM memberships m WHERE m.org_id = o.id) AS members
       FROM orgs o WHERE ${where} ORDER BY ${ORG_ORDER[options.sort]} LIMIT ?4 OFFSET ?5`,
    ).bind(pattern, options.query.trim().toLowerCase(), options.status, PAGE_SIZE, (options.page - 1) * PAGE_SIZE),
    db.prepare(`SELECT COUNT(*) AS count FROM orgs o WHERE ${where}`).bind(pattern, options.query.trim().toLowerCase(), options.status),
  ])
  return { rows: (rows?.results ?? []) as OrgListRow[], total: ((total?.results ?? [])[0] as { count: number } | undefined)?.count ?? 0 }
}

export interface UserListRow {
  id: string
  name: string
  email: string
  status: Status
  verified: number
  created_at: number
  last_active_at: number | null
  orgs: number
}

export type UserSort = 'created' | 'active' | 'name' | 'email'
const USER_ORDER: Record<UserSort, string> = {
  created: 'u.created_at DESC, u.id',
  active: 'u.last_active_at IS NULL, u.last_active_at DESC, u.id',
  name: 'u.name COLLATE NOCASE, u.id',
  email: 'u.email, u.id',
}

/** Accounts matching a name, address or id, in a standing, a page at a time. */
export async function listUsers(db: D1Database, options: { query: string; status: Status | null; sort: UserSort; page: number }): Promise<{ rows: UserListRow[]; total: number }> {
  const pattern = likePattern(options.query)
  const where = `(?1 IS NULL OR lower(u.name) LIKE ?1 ESCAPE '\\' OR u.email LIKE ?1 ESCAPE '\\' OR u.id = ?2) AND (?3 IS NULL OR u.status = ?3)`
  const [rows, total] = await db.batch([
    db.prepare(
      `SELECT u.id, u.name, u.email, u.status, (u.email_verified_at IS NOT NULL) AS verified, u.created_at, u.last_active_at,
         (SELECT COUNT(*) FROM memberships m WHERE m.user_id = u.id) AS orgs
       FROM users u WHERE ${where} ORDER BY ${USER_ORDER[options.sort]} LIMIT ?4 OFFSET ?5`,
    ).bind(pattern, options.query.trim().toLowerCase(), options.status, PAGE_SIZE, (options.page - 1) * PAGE_SIZE),
    db.prepare(`SELECT COUNT(*) AS count FROM users u WHERE ${where}`).bind(pattern, options.query.trim().toLowerCase(), options.status),
  ])
  return { rows: (rows?.results ?? []) as UserListRow[], total: ((total?.results ?? [])[0] as { count: number } | undefined)?.count ?? 0 }
}

export interface OrgDetail {
  id: string
  name: string
  owner_domain: string | null
  status: Status
  status_reason: string | null
  status_changed_at: number | null
  created_at: number
  last_active_at: number | null
  created_by_operator: string | null
  creator_email: string | null
  domain_orgs: number
  domain_max: number
}

export interface OrgMemberRow {
  user_id: string
  name: string
  email: string
  role: Role
  joined_at: number
  last_active_at: number | null
  status: Status
}

export interface OrgUsage {
  invitations: number
  api_clients: number
  agents: number
  integrations: number
  verified_domains: number
  sso: string | null
  scim_tokens: number
  mail_2d: number
}

export async function orgDetail(db: D1Database, orgId: string, now: number): Promise<{ org: OrgDetail; members: OrgMemberRow[]; usage: OrgUsage } | null> {
  const [org, members, usage] = await db.batch([
    db.prepare(
      `SELECT o.id, o.name, o.owner_domain, o.status, o.status_reason, o.status_changed_at, o.created_at, o.last_active_at,
         o.created_by_operator, u.email AS creator_email,
         (SELECT COUNT(*) FROM orgs d WHERE d.owner_domain = o.owner_domain) AS domain_orgs,
         COALESCE((SELECT a.max_orgs FROM org_domain_allowances a WHERE a.owner_domain = o.owner_domain), 2) AS domain_max
       FROM orgs o LEFT JOIN users u ON u.id = o.created_by WHERE o.id = ?1`,
    ).bind(orgId),
    db.prepare(
      `SELECT m.user_id, u.name, u.email, m.role, m.created_at AS joined_at, u.last_active_at, u.status
       FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ?1
       ORDER BY CASE m.role WHEN 'OWNER' THEN 0 WHEN 'ADMIN' THEN 1 WHEN 'EDITOR' THEN 2 WHEN 'VIEWER' THEN 3 ELSE 4 END,
         u.name COLLATE NOCASE, u.email`,
    ).bind(orgId),
    db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM invitations WHERE org_id = ?1 AND status = 'pending' AND expires_at > ?2) AS invitations,
         (SELECT COUNT(*) FROM service_accounts WHERE org_id = ?1 AND revoked_at IS NULL) AS api_clients,
         (SELECT COUNT(*) FROM oauth_grants WHERE org_id = ?1 AND revoked_at IS NULL AND expires_at > ?2) AS agents,
         (SELECT COUNT(*) FROM integrations WHERE org_id = ?1) AS integrations,
         (SELECT COUNT(*) FROM sso_domains WHERE org_id = ?1 AND verified_at IS NOT NULL) AS verified_domains,
         (SELECT protocol FROM sso_connections WHERE org_id = ?1 AND enabled = 1) AS sso,
         (SELECT COUNT(*) FROM scim_tokens WHERE org_id = ?1) AS scim_tokens,
         (SELECT COUNT(*) FROM mail_log WHERE org_id = ?1 AND created_at >= ?3) AS mail_2d`,
    ).bind(orgId, now, now - 2 * DAY),
  ])
  const row = (org?.results ?? [])[0] as OrgDetail | undefined
  if (!row) return null
  return { org: row, members: (members?.results ?? []) as OrgMemberRow[], usage: (usage?.results ?? [])[0] as OrgUsage }
}

export interface UserDetail {
  id: string
  name: string
  email: string
  status: Status
  status_reason: string | null
  status_changed_at: number | null
  verified: number
  created_at: number
  last_active_at: number | null
}

export interface UserMembershipRow {
  org_id: string
  org_name: string
  role: Role
  joined_at: number
  org_status: Status
}

export async function userDetail(db: D1Database, userId: string): Promise<{ user: UserDetail; memberships: UserMembershipRow[] } | null> {
  const [user, memberships] = await db.batch([
    db.prepare(
      `SELECT id, name, email, status, status_reason, status_changed_at, (email_verified_at IS NOT NULL) AS verified, created_at, last_active_at
       FROM users WHERE id = ?1`,
    ).bind(userId),
    db.prepare(
      `SELECT m.org_id, o.name AS org_name, m.role, m.created_at AS joined_at, o.status AS org_status
       FROM memberships m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = ?1 ORDER BY m.created_at`,
    ).bind(userId),
  ])
  const row = (user?.results ?? [])[0] as UserDetail | undefined
  if (!row) return null
  return { user: row, memberships: (memberships?.results ?? []) as UserMembershipRow[] }
}

/** An account by address, for creating an organization for it. */
export function findAccount(db: D1Database, email: string): Promise<{ id: string; email: string; name: string; verified: number; status: Status } | null> {
  return db.prepare('SELECT id, email, name, (email_verified_at IS NOT NULL) AS verified, status FROM users WHERE email = ?1').bind(email).first()
}

/** The names of organizations by id (the apps' reports name organizations by id only). */
export async function orgNames(db: D1Database, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map()
  const { results } = await db.prepare('SELECT o.id, o.name FROM orgs o JOIN json_each(?1) j ON j.value = o.id')
    .bind(JSON.stringify(ids)).all<{ id: string; name: string }>()
  return new Map(results.map((row) => [row.id, row.name]))
}

/**
 * Claims this hour's run of a job, once: true for the one caller that gets it, or that takes over a run that failed or
 * read only part of what it needed (the next tick tries again), or started fifteen minutes ago and never finished.
 */
export async function claimJob(db: D1Database, name: string, hour: number, now: number): Promise<boolean> {
  const result = await db.prepare(
    `INSERT INTO super_jobs (name, hour, started_at) VALUES (?1, ?2, ?3)
     ON CONFLICT (name, hour) DO UPDATE SET started_at = excluded.started_at, finished_at = NULL, outcome = NULL
     WHERE super_jobs.outcome IN ('failed', 'partial') OR (super_jobs.finished_at IS NULL AND super_jobs.started_at < ?4)`,
  ).bind(name, hour, now, now - JOB_STALE_MS).run()
  return result.meta.changes > 0
}

export async function finishJob(db: D1Database, name: string, hour: number, outcome: string, now: number): Promise<void> {
  await db.prepare('UPDATE super_jobs SET finished_at = ?3, outcome = ?4 WHERE name = ?1 AND hour = ?2').bind(name, hour, now, outcome).run()
}

export async function lastJob(db: D1Database, name: string): Promise<{ hour: number; started_at: number; finished_at: number | null; outcome: string | null } | null> {
  return db.prepare('SELECT hour, started_at, finished_at, outcome FROM super_jobs WHERE name = ?1 ORDER BY hour DESC LIMIT 1').bind(name).first()
}

/** Keeps one snapshot an hour: a later try in the hour (after a partial read) replaces the earlier one. */
export async function insertSnapshot(db: D1Database, takenAt: number, hour: number, data: unknown): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM super_cloudflare_snapshots WHERE taken_at >= ?1 AND taken_at < ?2').bind(hour, hour + 60 * 60 * 1000),
    db.prepare('INSERT INTO super_cloudflare_snapshots (taken_at, data) VALUES (?1, ?2) ON CONFLICT (taken_at) DO UPDATE SET data = excluded.data')
      .bind(takenAt, JSON.stringify(data)),
  ])
}

export async function snapshots(db: D1Database, since: number): Promise<{ taken_at: number; data: string }[]> {
  const { results } = await db.prepare('SELECT taken_at, data FROM super_cloudflare_snapshots WHERE taken_at >= ?1 ORDER BY taken_at')
    .bind(since).all<{ taken_at: number; data: string }>()
  return results
}

/** The console's bounded cleanup (housekeeping.ts): expired sessions and sign-ins, old job records and snapshots. */
export function pruneSuperStatements(db: D1Database, now: number, limit: number): D1PreparedStatement[] {
  return [
    db.prepare('DELETE FROM super_sessions WHERE id_hash IN (SELECT id_hash FROM super_sessions WHERE expires_at <= ?1 LIMIT ?2)').bind(now, limit),
    db.prepare('DELETE FROM super_saml_requests WHERE id_hash IN (SELECT id_hash FROM super_saml_requests WHERE expires_at <= ?1 LIMIT ?2)').bind(now, limit),
    db.prepare('DELETE FROM super_jobs WHERE rowid IN (SELECT rowid FROM super_jobs WHERE hour < ?1 LIMIT ?2)').bind(now - JOB_RETENTION_MS, limit),
    db.prepare('DELETE FROM super_cloudflare_snapshots WHERE taken_at IN (SELECT taken_at FROM super_cloudflare_snapshots WHERE taken_at < ?1 LIMIT ?2)')
      .bind(now - SNAPSHOT_RETENTION_MS, limit),
  ]
}
