import { owner, type GrantInput } from './grants.ts'
import { ownerDomainOf, registrableDomain, subdomainPattern } from '../owner-domain.ts'
import type { Role } from '../roles.ts'

export interface OrgRow {
  id: string
  name: string
  created_at: number
}

export interface MembershipRow {
  org_id: string
  org_name: string
  role: Role
  created_at: number
}

export interface MemberRow {
  user_id: string
  name: string
  email: string
  role: Role
  created_at: number
}

const ROLE_ORDER = `CASE m.role WHEN 'OWNER' THEN 0 WHEN 'ADMIN' THEN 1 WHEN 'EDITOR' THEN 2 WHEN 'VIEWER' THEN 3 ELSE 4 END`

// Keeps every organization with at least one OWNER: a statement guarded by this changes an OWNER's membership only
// while another OWNER remains. Each guard runs inside a single SQL statement, so concurrent requests cannot race it.
const ANOTHER_OWNER = `(SELECT COUNT(*) FROM memberships o WHERE o.org_id = ?1 AND o.role = 'OWNER') > 1`

// Every privileged mutation re-reads the actor's role inside its own statement (the organization is ?1). The page
// checked the role earlier, but a member whose role was lowered, or who was removed, since then must change nothing.

/** How many organizations an owner domain may have, unless `org_domain_allowances` says otherwise (DESIGN.md §3.1). */
export const ORGS_PER_DOMAIN = 2

/**
 * The forms the organizations of the owner domain of `email` (owner-domain.ts ownerDomainOf) may be recorded in, as
 * the parameters ?1 to ?4 of OWNED: the owner domain itself; the form migrations 0007 and 0009 wrote for a non-ASCII
 * domain (SQL can't write punycode, so it stayed as typed); and LIKE patterns for the subdomains of both, as those
 * migrations, and the gateway before 0009, recorded the creator's whole domain.
 */
function ownedForms(email: string): [string, string, string | null, string | null] {
  const ownerDomain = ownerDomainOf(email)
  if (ownerDomain.includes('@')) return [ownerDomain, ownerDomain, null, null]
  const typed = email.slice(email.lastIndexOf('@') + 1).toLowerCase()
  const legacy = registrableDomain(typed) ?? typed
  return [ownerDomain, legacy, subdomainPattern(ownerDomain), legacy === ownerDomain ? null : subdomainPattern(legacy)]
}

// The organizations of an owner domain (ownedForms: ?1 to ?4), and how many it may have (?5 by default). A subdomain
// pattern applies to domains only, never to an address at a provider.
const OWNED = `(o.owner_domain IN (?1, ?2)
  OR (instr(o.owner_domain, '@') = 0 AND (o.owner_domain LIKE ?3 ESCAPE '\\' OR o.owner_domain LIKE ?4 ESCAPE '\\')))`
const ALLOWED = 'COALESCE((SELECT a.max_orgs FROM org_domain_allowances a WHERE a.owner_domain = ?1), ?5)'

/** The owner domain of someone with this address, its organizations now, and how many it may have. */
export async function orgAllowance(db: D1Database, email: string): Promise<{ ownerDomain: string; count: number; max: number }> {
  const forms = ownedForms(email)
  const row = await db.prepare(`SELECT (SELECT COUNT(*) FROM orgs o WHERE ${OWNED}) AS count, ${ALLOWED} AS max`)
    .bind(...forms, ORGS_PER_DOMAIN).first<{ count: number; max: number }>()
  return { ownerDomain: forms[0], count: row?.count ?? 0, max: row?.max ?? ORGS_PER_DOMAIN }
}

/**
 * Creates an organization with its creator as OWNER, in one batch whose insert also requires the creator's owner
 * domain (from `email`; its subdomains' organizations count with it) to have fewer organizations than it may
 * (ORGS_PER_DOMAIN, or its allowance), so concurrent creations can't exceed it. The creator's `users.orgs_created`
 * still counts up, as a record only: nothing limits by it any more. False when the owner domain is at its limit.
 */
export async function createOrg(db: D1Database, org: { id: string; name: string; userId: string; email: string; now: number }): Promise<boolean> {
  const [created] = await db.batch([
    db.prepare(
      `INSERT INTO orgs (id, name, created_by, owner_domain, created_at, updated_at)
       SELECT ?6, ?7, ?8, ?1, ?9, ?9
       WHERE (SELECT COUNT(*) FROM orgs o WHERE ${OWNED}) < ${ALLOWED}`,
    ).bind(...ownedForms(org.email), ORGS_PER_DOMAIN, org.id, org.name, org.userId, org.now),
    db.prepare(
      `INSERT INTO memberships (org_id, user_id, role, created_at, updated_at)
       SELECT ?1, ?2, 'OWNER', ?3, ?3 WHERE EXISTS (SELECT 1 FROM orgs WHERE id = ?1)`,
    ).bind(org.id, org.userId, org.now),
    db.prepare('UPDATE users SET orgs_created = orgs_created + 1, updated_at = ?3 WHERE id = ?2 AND EXISTS (SELECT 1 FROM orgs WHERE id = ?1)')
      .bind(org.id, org.userId, org.now),
  ])
  return (created?.meta.changes ?? 0) > 0
}

/**
 * SQL: organization `org` may take in someone whose address is in domain `domain` (lower case and punycode, the form
 * sso_domains keeps and domainOf writes): it invites anyone, or only addresses in its verified domains and this is
 * one of them now (DESIGN.md §3). Each argument names a parameter or column.
 */
export function invitableDomain(org: string, domain: string): string {
  return `(COALESCE((SELECT io.invite_verified_domains_only FROM orgs io WHERE io.id = ${org}), 0) = 0
    OR EXISTS (SELECT 1 FROM sso_domains vd WHERE vd.org_id = ${org} AND vd.verified_at IS NOT NULL AND vd.domain = ${domain}))`
}

/** Whether the organization invites only addresses in its verified domains, and its verified domains now. */
export async function invitePolicy(db: D1Database, orgId: string): Promise<{ verifiedOnly: boolean; domains: string[] }> {
  const row = await db.prepare(
    `SELECT o.invite_verified_domains_only AS only,
       (SELECT json_group_array(domain) FROM (SELECT d.domain FROM sso_domains d WHERE d.org_id = o.id AND d.verified_at IS NOT NULL
         ORDER BY d.domain)) AS domains
     FROM orgs o WHERE o.id = ?1`,
  ).bind(orgId).first<{ only: number; domains: string }>()
  return { verifiedOnly: row?.only === 1, domains: row ? (JSON.parse(row.domains) as string[]) : [] }
}

/**
 * Turns "invite only people in our verified domains" on or off while the actor is still an OWNER; turning it on also
 * needs a verified domain now. False otherwise.
 */
export async function setInviteVerifiedDomainsOnly(db: D1Database, orgId: string, actorId: string, on: boolean, now: number): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE orgs SET invite_verified_domains_only = ?2, updated_at = ?3 WHERE id = ?1 AND ${owner('?1', '?4')}
       AND (?2 = 0 OR EXISTS (SELECT 1 FROM sso_domains d WHERE d.org_id = ?1 AND d.verified_at IS NOT NULL))`,
  ).bind(orgId, on ? 1 : 0, now, actorId).run()
  return result.meta.changes > 0
}

export function findMembership(db: D1Database, orgId: string, userId: string): Promise<MembershipRow | null> {
  return db.prepare(
    `SELECT m.org_id, o.name AS org_name, m.role, m.created_at FROM memberships m JOIN orgs o ON o.id = m.org_id
     WHERE m.org_id = ?1 AND m.user_id = ?2`,
  ).bind(orgId, userId).first<MembershipRow>()
}

/** The user's memberships, oldest first: the first one is the default active organization. */
export async function listMemberships(db: D1Database, userId: string): Promise<MembershipRow[]> {
  const { results } = await db.prepare(
    `SELECT m.org_id, o.name AS org_name, m.role, m.created_at FROM memberships m JOIN orgs o ON o.id = m.org_id
     WHERE m.user_id = ?1 ORDER BY m.created_at, m.org_id`,
  ).bind(userId).all<MembershipRow>()
  return results
}

export async function listMembers(db: D1Database, orgId: string): Promise<MemberRow[]> {
  const { results } = await db.prepare(
    `SELECT m.user_id, u.name, u.email, m.role, m.created_at FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.org_id = ?1 ORDER BY ${ROLE_ORDER}, u.name COLLATE NOCASE, u.email`,
  ).bind(orgId).all<MemberRow>()
  return results
}

export async function countMembers(db: D1Database, orgId: string): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS count FROM memberships WHERE org_id = ?1').bind(orgId).first<{ count: number }>()
  return row?.count ?? 0
}

export async function countOwners(db: D1Database, orgId: string): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS count FROM memberships WHERE org_id = ?1 AND role = 'OWNER'")
    .bind(orgId).first<{ count: number }>()
  return row?.count ?? 0
}

/** Renames the organization if `actorId` is still one of its OWNERs. */
export async function renameOrg(db: D1Database, orgId: string, actorId: string, name: string, now: number): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE orgs SET name = ?2, updated_at = ?3 WHERE id = ?1
       AND EXISTS (SELECT 1 FROM memberships a WHERE a.org_id = ?1 AND a.user_id = ?4 AND a.role = 'OWNER')`,
  ).bind(orgId, name, now, actorId).run()
  return result.meta.changes > 0
}

/**
 * Removes the organization from the gateway if `actorId` is still one of its OWNERs; memberships and invitations
 * cascade, sessions forget it.
 */
export async function deleteOrg(db: D1Database, orgId: string, actorId: string): Promise<boolean> {
  const result = await db.prepare(
    `DELETE FROM orgs WHERE id = ?1
       AND EXISTS (SELECT 1 FROM memberships a WHERE a.org_id = ?1 AND a.user_id = ?2 AND a.role = 'OWNER')`,
  ).bind(orgId, actorId).run()
  return result.meta.changes > 0
}

/**
 * Changes a member's role if it is still `current` (so a concurrent change is never overwritten); when an OWNER loses
 * the role, another OWNER remains; and `actorId` may still make the change: an OWNER, or an ADMIN when neither the
 * current nor the new role is OWNER. Returns false otherwise.
 */
export async function changeRole(db: D1Database, change: { orgId: string; userId: string; current: Role; next: Role; actorId: string; now: number }): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE memberships SET role = ?4, updated_at = ?5
     WHERE org_id = ?1 AND user_id = ?2 AND role = ?3
       AND (?3 <> 'OWNER' OR ?4 = 'OWNER' OR ${ANOTHER_OWNER})
       AND EXISTS (SELECT 1 FROM memberships a WHERE a.org_id = ?1 AND a.user_id = ?6
         AND (a.role = 'OWNER' OR (a.role = 'ADMIN' AND ?3 <> 'OWNER' AND ?4 <> 'OWNER')))`,
  ).bind(change.orgId, change.userId, change.current, change.next, change.now, change.actorId).run()
  return result.meta.changes > 0
}

/**
 * Gives a member access to specific apps instead of an organization role, or changes which apps and roles they have,
 * in one batch: the role becomes APPS if it is still `current` (never the last OWNER), grants for apps left out go, and
 * the given grants are written. Every statement requires `actorId` still to be an OWNER, or an ADMIN when the member
 * was not an OWNER. Moving from an organization role, the grant statements also require that this batch's own role
 * change applied (its `updated_at`), so a decision someone else made meanwhile is never overwritten. False when nothing
 * was written.
 */
export async function setAppAccess(db: D1Database, change: { orgId: string; userId: string; current: Role; grants: GrantInput[]; actorId: string; now: number }): Promise<boolean> {
  const actor = `EXISTS (SELECT 1 FROM memberships a WHERE a.org_id = ?1 AND a.user_id = ?3
    AND (a.role = 'OWNER' OR (a.role = 'ADMIN' AND ?4 <> 'OWNER')))`
  // ?6 is this batch's time: when the member had an organization role, the first statement stamps it on the membership.
  const ours = `(?4 = 'APPS' OR (SELECT m.updated_at FROM memberships m WHERE m.org_id = ?1 AND m.user_id = ?2 AND m.role = 'APPS') = ?6)`
  const apps = JSON.stringify(change.grants.map((grant) => grant.app))
  const grants = JSON.stringify(change.grants.map((grant) => ({ app: grant.app, role: grant.role, customRoleId: grant.customRoleId })))
  const statements = [
    db.prepare(
      `UPDATE memberships SET role = 'APPS', updated_at = ?5
       WHERE org_id = ?1 AND user_id = ?2 AND role = ?4 AND ?4 <> 'APPS'
         AND (?4 <> 'OWNER' OR ${ANOTHER_OWNER}) AND ${actor}`,
    ).bind(change.orgId, change.userId, change.actorId, change.current, change.now),
    db.prepare(
      `DELETE FROM app_grants WHERE org_id = ?1 AND user_id = ?2
         AND app NOT IN (SELECT value FROM json_each(?5)) AND ${actor} AND ${ours}`,
    ).bind(change.orgId, change.userId, change.actorId, change.current, apps, change.now),
    db.prepare(
      `INSERT INTO app_grants (org_id, user_id, app, role, custom_role_id, created_at, updated_at)
       SELECT ?1, ?2, json_extract(value, '$.app'), json_extract(value, '$.role'), json_extract(value, '$.customRoleId'), ?6, ?6
       FROM json_each(?5)
       WHERE (SELECT role FROM memberships WHERE org_id = ?1 AND user_id = ?2) = 'APPS' AND ${actor} AND ${ours}
       ON CONFLICT (org_id, user_id, app) DO UPDATE SET role = excluded.role, custom_role_id = excluded.custom_role_id,
         updated_at = excluded.updated_at`,
    ).bind(change.orgId, change.userId, change.actorId, change.current, grants, change.now),
  ]
  const [moved, , written] = await db.batch(statements)
  return (change.current === 'APPS' || (moved?.meta.changes ?? 0) > 0) && (written?.meta.changes ?? 0) > 0
}

/**
 * Removes another member if their role is still `current`, they are not the last OWNER, and `actorId` may still remove
 * them: an OWNER, or an ADMIN when the member is not an OWNER. Returns false otherwise.
 */
export async function removeMember(db: D1Database, orgId: string, userId: string, current: Role, actorId: string): Promise<boolean> {
  const result = await db.prepare(
    `DELETE FROM memberships WHERE org_id = ?1 AND user_id = ?2 AND role = ?3
       AND (?3 <> 'OWNER' OR ${ANOTHER_OWNER})
       AND EXISTS (SELECT 1 FROM memberships a WHERE a.org_id = ?1 AND a.user_id = ?4
         AND (a.role = 'OWNER' OR (a.role = 'ADMIN' AND ?3 <> 'OWNER')))`,
  ).bind(orgId, userId, current, actorId).run()
  return result.meta.changes > 0
}

/** Leaves the organization (anyone may) unless that would remove its last OWNER. Returns false otherwise. */
export async function leaveOrg(db: D1Database, orgId: string, userId: string, current: Role): Promise<boolean> {
  const result = await db.prepare(
    `DELETE FROM memberships WHERE org_id = ?1 AND user_id = ?2 AND role = ?3
       AND (?3 <> 'OWNER' OR ${ANOTHER_OWNER})`,
  ).bind(orgId, userId, current).run()
  return result.meta.changes > 0
}
