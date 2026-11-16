// Enterprise SSO and SCIM (DESIGN.md §7): verified domains, the identity-provider connection, pending sign-ins, SCIM
// tokens and the people SCIM provisioned. An owner's changes re-check the OWNER role in their own statement.
import { owner } from './grants.ts'

export interface SsoDomainRow {
  org_id: string
  domain: string
  token: string
  created_at: number
  verified_at: number | null
}

export interface SsoConnectionRow {
  id: string
  org_id: string
  protocol: 'saml' | 'oidc'
  enabled: number
  require_sso: number
  default_role: 'EDITOR' | 'VIEWER'
  saml_entity_id: string | null
  saml_sso_url: string | null
  /** JSON array of PEM certificates. */
  saml_certificates: string | null
  oidc_issuer: string | null
  oidc_client_id: string | null
  /** Sealed with GATEWAY_SECRET_KEY ('oidc-client-secret'). */
  oidc_client_secret: string | null
  created_at: number
  updated_at: number
}

export interface ScimTokenRow {
  id: string
  org_id: string
  name: string
  created_at: number
  last_used_at: number | null
}

export interface PendingSignIn {
  nonce: string | null
  verifier: string | null
  return_to: string | null
}

// Domains are compared in the form domainOf writes (lower case, punycode); it lives with the owner-domain rules.
export { domainOf } from '../owner-domain.ts'

export async function listDomains(db: D1Database, orgId: string): Promise<SsoDomainRow[]> {
  const { results } = await db.prepare('SELECT org_id, domain, token, created_at, verified_at FROM sso_domains WHERE org_id = ?1 ORDER BY domain')
    .bind(orgId).all<SsoDomainRow>()
  return results
}

/** Whether another organization holds `domain` verified. */
export async function verifiedElsewhere(db: D1Database, orgId: string, domain: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 AS found FROM sso_domains WHERE domain = ?1 AND verified_at IS NOT NULL AND org_id <> ?2')
    .bind(domain, orgId).first<{ found: number }>()
  return row !== null
}

/** Claims a domain while the actor is an OWNER and the organization has fewer than `limit`; false otherwise or if claimed. */
export async function claimDomain(db: D1Database, claim: { orgId: string; domain: string; token: string; actorId: string; now: number; limit: number }): Promise<boolean> {
  const result = await db.prepare(
    `INSERT INTO sso_domains (org_id, domain, token, created_at)
     SELECT ?1, ?2, ?3, ?4 WHERE ${owner('?1', '?5')}
       AND (SELECT COUNT(*) FROM sso_domains d WHERE d.org_id = ?1) < ?6
     ON CONFLICT DO NOTHING`,
  ).bind(claim.orgId, claim.domain, claim.token, claim.now, claim.actorId, claim.limit).run()
  return result.meta.changes > 0
}

/** Marks a claimed domain verified while the actor is an OWNER; false when another organization verified it first. */
export async function markDomainVerified(db: D1Database, orgId: string, domain: string, actorId: string, now: number): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE OR IGNORE sso_domains SET verified_at = ?3 WHERE org_id = ?1 AND domain = ?2 AND verified_at IS NULL AND ${owner('?1', '?4')}`,
  ).bind(orgId, domain, now, actorId).run()
  return result.meta.changes > 0
}

/** SCIM-provisioned people of organization ?1 whose address is in domain ?2 (SQL, for the statements below). */
const PROVISIONED_IN_DOMAIN = `SELECT s.user_id FROM scim_users s JOIN users u ON u.id = s.user_id
  WHERE s.org_id = ?1 AND substr(u.email, instr(u.email, '@') + 1) = ?2`

/**
 * Removes a claimed domain while the actor is an OWNER. With it go the people SCIM provisioned on it: their membership
 * (never an OWNER's, so never the last one) and their SCIM link, in the same batch, so the identity provider keeps no
 * hold on addresses the organization no longer vouches for.
 */
export async function removeDomain(db: D1Database, orgId: string, domain: string, actorId: string): Promise<boolean> {
  const [, , removed] = await db.batch([
    db.prepare(
      `DELETE FROM memberships WHERE org_id = ?1 AND role <> 'OWNER' AND user_id IN (${PROVISIONED_IN_DOMAIN})
         AND EXISTS (SELECT 1 FROM sso_domains d WHERE d.org_id = ?1 AND d.domain = ?2) AND ${owner('?1', '?3')}`,
    ).bind(orgId, domain, actorId),
    db.prepare(
      `DELETE FROM scim_users WHERE org_id = ?1 AND user_id IN (${PROVISIONED_IN_DOMAIN})
         AND EXISTS (SELECT 1 FROM sso_domains d WHERE d.org_id = ?1 AND d.domain = ?2) AND ${owner('?1', '?3')}`,
    ).bind(orgId, domain, actorId),
    db.prepare(`DELETE FROM sso_domains WHERE org_id = ?1 AND domain = ?2 AND ${owner('?1', '?3')}`).bind(orgId, domain, actorId),
  ])
  return (removed?.meta.changes ?? 0) > 0
}

/** Whether `domain` is one of the organization's verified domains. */
export async function isVerifiedDomain(db: D1Database, orgId: string, domain: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 AS found FROM sso_domains WHERE org_id = ?1 AND domain = ?2 AND verified_at IS NOT NULL')
    .bind(orgId, domain).first<{ found: number }>()
  return row !== null
}

const CONNECTION_COLUMNS = `id, org_id, protocol, enabled, require_sso, default_role, saml_entity_id, saml_sso_url, saml_certificates,
  oidc_issuer, oidc_client_id, oidc_client_secret, created_at, updated_at`

export function findConnection(db: D1Database, orgId: string): Promise<SsoConnectionRow | null> {
  return db.prepare(`SELECT ${CONNECTION_COLUMNS} FROM sso_connections WHERE org_id = ?1`).bind(orgId).first<SsoConnectionRow>()
}

export function findConnectionById(db: D1Database, id: string): Promise<SsoConnectionRow | null> {
  return db.prepare(`SELECT ${CONNECTION_COLUMNS} FROM sso_connections WHERE id = ?1`).bind(id).first<SsoConnectionRow>()
}

/** The enabled connection of the organization that holds `domain` verified, if any. */
export function connectionForDomain(db: D1Database, domain: string): Promise<SsoConnectionRow | null> {
  return db.prepare(
    `SELECT ${CONNECTION_COLUMNS.split(',').map((column) => `c.${column.trim()}`).join(', ')}
     FROM sso_domains d JOIN sso_connections c ON c.org_id = d.org_id
     WHERE d.domain = ?1 AND d.verified_at IS NOT NULL AND c.enabled = 1`,
  ).bind(domain).first<SsoConnectionRow>()
}

/** Whether an organization requires its single sign-on for addresses in `domain`. */
export async function ssoRequiredForDomain(db: D1Database, domain: string): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 AS found FROM sso_domains d JOIN sso_connections c ON c.org_id = d.org_id
     WHERE d.domain = ?1 AND d.verified_at IS NOT NULL AND c.enabled = 1 AND c.require_sso = 1`,
  ).bind(domain).first<{ found: number }>()
  return row !== null
}

export interface ConnectionInput {
  protocol: 'saml' | 'oidc'
  enabled: boolean
  requireSso: boolean
  defaultRole: 'EDITOR' | 'VIEWER'
  samlEntityId: string | null
  samlSsoUrl: string | null
  /** Null keeps the stored ones. */
  samlCertificates: string[] | null
  oidcIssuer: string | null
  oidcClientId: string | null
  /** Sealed; null keeps the stored one. */
  oidcClientSecret: string | null
}

/** Creates or replaces the organization's connection while the actor is an OWNER. */
export async function saveConnection(db: D1Database, save: { id: string; orgId: string; input: ConnectionInput; actorId: string; now: number }): Promise<boolean> {
  const { input } = save
  const result = await db.prepare(
    `INSERT INTO sso_connections (id, org_id, protocol, enabled, require_sso, default_role, saml_entity_id, saml_sso_url,
       saml_certificates, oidc_issuer, oidc_client_id, oidc_client_secret, created_by, created_at, updated_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14 WHERE ${owner('?2', '?13')}
     ON CONFLICT (org_id) DO UPDATE SET protocol = excluded.protocol, enabled = excluded.enabled,
       require_sso = excluded.require_sso, default_role = excluded.default_role, saml_entity_id = excluded.saml_entity_id,
       saml_sso_url = excluded.saml_sso_url,
       saml_certificates = COALESCE(excluded.saml_certificates, sso_connections.saml_certificates), oidc_issuer = excluded.oidc_issuer,
       oidc_client_id = excluded.oidc_client_id,
       oidc_client_secret = CASE
         WHEN excluded.oidc_client_secret IS NOT NULL THEN excluded.oidc_client_secret
         WHEN sso_connections.oidc_issuer IS excluded.oidc_issuer AND sso_connections.oidc_client_id IS excluded.oidc_client_id
           THEN sso_connections.oidc_client_secret
         ELSE NULL END,
       updated_at = excluded.updated_at`,
  ).bind(
    save.id, save.orgId, input.protocol, input.enabled ? 1 : 0, input.requireSso ? 1 : 0, input.defaultRole, input.samlEntityId,
    input.samlSsoUrl, input.samlCertificates ? JSON.stringify(input.samlCertificates) : null, input.oidcIssuer, input.oidcClientId,
    input.oidcClientSecret, save.actorId, save.now,
  ).run()
  return result.meta.changes > 0
}

export async function deleteConnection(db: D1Database, orgId: string, actorId: string): Promise<boolean> {
  const result = await db.prepare(`DELETE FROM sso_connections WHERE org_id = ?1 AND ${owner('?1', '?2')}`).bind(orgId, actorId).run()
  return result.meta.changes > 0
}

export async function insertPendingSignIn(db: D1Database, pending: {
  idHash: string; connectionId: string; bindingHash: string; nonce: string | null; verifier: string | null; returnTo: string | null; now: number; expiresAt: number
}): Promise<void> {
  await db.prepare(
    `INSERT INTO sso_requests (id_hash, connection_id, binding_hash, nonce, verifier, return_to, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  ).bind(pending.idHash, pending.connectionId, pending.bindingHash, pending.nonce, pending.verifier, pending.returnTo, pending.now, pending.expiresAt).run()
}

/**
 * Uses up a pending sign-in: it must be this connection's, unexpired, and tied to the browser's flow cookie. One
 * statement, so a replayed response or callback finds nothing.
 */
export function consumePendingSignIn(db: D1Database, idHash: string, connectionId: string, bindingHash: string, now: number): Promise<PendingSignIn | null> {
  return db.prepare(
    `DELETE FROM sso_requests WHERE id_hash = ?1 AND connection_id = ?2 AND binding_hash = ?3 AND expires_at > ?4
     RETURNING nonce, verifier, return_to`,
  ).bind(idHash, connectionId, bindingHash, now).first<PendingSignIn>()
}

export function pruneSsoRequestsStatement(db: D1Database, now: number, limit: number): D1PreparedStatement {
  return db.prepare('DELETE FROM sso_requests WHERE rowid IN (SELECT rowid FROM sso_requests WHERE expires_at <= ?1 LIMIT ?2)').bind(now, limit)
}

export async function listScimTokens(db: D1Database, orgId: string): Promise<ScimTokenRow[]> {
  const { results } = await db.prepare('SELECT id, org_id, name, created_at, last_used_at FROM scim_tokens WHERE org_id = ?1 ORDER BY created_at')
    .bind(orgId).all<ScimTokenRow>()
  return results
}

export async function insertScimToken(db: D1Database, token: { id: string; orgId: string; name: string; tokenHash: string; actorId: string; now: number; limit: number }): Promise<boolean> {
  const result = await db.prepare(
    `INSERT INTO scim_tokens (id, org_id, name, token_hash, created_by, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE ${owner('?2', '?5')} AND (SELECT COUNT(*) FROM scim_tokens t WHERE t.org_id = ?2) < ?7`,
  ).bind(token.id, token.orgId, token.name, token.tokenHash, token.actorId, token.now, token.limit).run()
  return result.meta.changes > 0
}

export async function revokeScimToken(db: D1Database, orgId: string, id: string, actorId: string): Promise<boolean> {
  const result = await db.prepare(`DELETE FROM scim_tokens WHERE org_id = ?1 AND id = ?2 AND ${owner('?1', '?3')}`).bind(orgId, id, actorId).run()
  return result.meta.changes > 0
}

/**
 * The organization a SCIM token belongs to, noting its use (at most once a minute); null for an organization that isn't
 * active (DESIGN.md §11.3), whose identity provider then gets 401.
 */
export async function useScimToken(db: D1Database, tokenHash: string, now: number): Promise<string | null> {
  const row = await db.prepare(
    `UPDATE scim_tokens SET last_used_at = CASE WHEN last_used_at IS NULL OR ?2 - last_used_at >= 60000 THEN ?2 ELSE last_used_at END
     WHERE token_hash = ?1 AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = scim_tokens.org_id AND o.status = 'active') RETURNING org_id`,
  ).bind(tokenHash, now).first<{ org_id: string }>()
  return row?.org_id ?? null
}

/**
 * Adds a member with `role` while the organization has fewer than `limit` members; an existing member keeps their
 * role. True when they are a member afterwards.
 */
export async function joinOrg(db: D1Database, orgId: string, userId: string, role: 'EDITOR' | 'VIEWER', now: number, limit: number): Promise<boolean> {
  const [, member] = await db.batch([
    db.prepare(
      `INSERT INTO memberships (org_id, user_id, role, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?4 WHERE (SELECT COUNT(*) FROM memberships m WHERE m.org_id = ?1) < ?5
         AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = ?1 AND o.status = 'active')
       ON CONFLICT DO NOTHING`,
    ).bind(orgId, userId, role, now, limit),
    db.prepare('SELECT 1 AS found FROM memberships WHERE org_id = ?1 AND user_id = ?2').bind(orgId, userId),
  ])
  return (member?.results.length ?? 0) > 0
}

/**
 * Adds a SCIM-provisioned member with `role`, in one statement that also requires their address to be in one of the
 * organization's verified domains now and the organization to have room; an existing member keeps their role. True
 * when they are a member afterwards.
 */
export async function joinOrgByScim(db: D1Database, orgId: string, userId: string, role: 'EDITOR' | 'VIEWER', now: number, limit: number): Promise<boolean> {
  const [, member] = await db.batch([
    db.prepare(
      `INSERT INTO memberships (org_id, user_id, role, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?4 WHERE (SELECT COUNT(*) FROM memberships m WHERE m.org_id = ?1) < ?5
         AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = ?1 AND o.status = 'active')
         AND EXISTS (SELECT 1 FROM users u JOIN sso_domains d ON d.org_id = ?1 AND d.verified_at IS NOT NULL
           AND d.domain = substr(u.email, instr(u.email, '@') + 1) WHERE u.id = ?2)
       ON CONFLICT DO NOTHING`,
    ).bind(orgId, userId, role, now, limit),
    db.prepare('SELECT 1 AS found FROM memberships WHERE org_id = ?1 AND user_id = ?2').bind(orgId, userId),
  ])
  return (member?.results.length ?? 0) > 0
}

/**
 * Notes an existing account's first sign-in through single sign-on: true once, for an account with a password or a
 * Google link (the person is then told by e-mail); false for one made by single sign-on, or already noted.
 */
export async function markSsoLinked(db: D1Database, userId: string, now: number): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE users SET sso_linked_at = ?2 WHERE id = ?1 AND sso_linked_at IS NULL AND (password_hash IS NOT NULL OR google_sub IS NOT NULL)`,
  ).bind(userId, now).run()
  return result.meta.changes > 0
}

/** Removes a member, never the organization's last OWNER. 'removed', 'not_member' or 'last_owner'. */
export async function leaveBySso(db: D1Database, orgId: string, userId: string): Promise<'removed' | 'not_member' | 'last_owner'> {
  const result = await db.prepare(
    `DELETE FROM memberships WHERE org_id = ?1 AND user_id = ?2
       AND (role <> 'OWNER' OR (SELECT COUNT(*) FROM memberships o WHERE o.org_id = ?1 AND o.role = 'OWNER') > 1)`,
  ).bind(orgId, userId).run()
  if (result.meta.changes > 0) return 'removed'
  const still = await db.prepare('SELECT 1 AS found FROM memberships WHERE org_id = ?1 AND user_id = ?2').bind(orgId, userId).first()
  return still ? 'last_owner' : 'not_member'
}

/**
 * An account whose address an identity provider vouched for: confirmed now. If it wasn't confirmed, someone else may
 * have chosen its password, so the password goes and every session and link ends (as with Google sign-in).
 */
export async function confirmByIdentityProvider(db: D1Database, userId: string, now: number): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE user_id = ?1 AND EXISTS (SELECT 1 FROM users WHERE id = ?1 AND email_verified_at IS NULL)').bind(userId),
    db.prepare('DELETE FROM email_tokens WHERE user_id = ?1 AND EXISTS (SELECT 1 FROM users WHERE id = ?1 AND email_verified_at IS NULL)').bind(userId),
    db.prepare(
      `UPDATE users SET password_hash = NULL, credential_version = credential_version + 1, email_verified_at = ?2, updated_at = ?2
       WHERE id = ?1 AND email_verified_at IS NULL`,
    ).bind(userId, now),
  ])
}

export interface ScimUserRow {
  id: string
  email: string
  name: string
  created_at: number
  updated_at: number
  member: number
  external_id: string | null
}

/** People in one of organization ?1's verified domains now (SQL): the only ones its SCIM client may see or touch. */
const IN_VERIFIED_DOMAIN = `substr(u.email, instr(u.email, '@') + 1) IN (SELECT d.domain FROM sso_domains d WHERE d.org_id = ?1 AND d.verified_at IS NOT NULL)`

/**
 * The people a SCIM client sees: those it provisioned or linked, and members, whose address is in one of the
 * organization's verified domains now. `email` narrows to one address.
 */
export async function listScimUsers(db: D1Database, orgId: string, options: { email?: string | null; offset: number; count: number }): Promise<{ total: number; users: ScimUserRow[] }> {
  const where = `(s.user_id IS NOT NULL OR m.user_id IS NOT NULL) AND ${IN_VERIFIED_DOMAIN}
    AND (?2 IS NULL OR u.email = ?2)`
  const from = `FROM users u LEFT JOIN memberships m ON m.org_id = ?1 AND m.user_id = u.id
    LEFT JOIN scim_users s ON s.org_id = ?1 AND s.user_id = u.id`
  const [counted, listed] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS total ${from} WHERE ${where}`).bind(orgId, options.email ?? null),
    db.prepare(
      `SELECT u.id, u.email, u.name, u.created_at, u.updated_at, (m.user_id IS NOT NULL) AS member, s.external_id
       ${from} WHERE ${where} ORDER BY u.created_at, u.id LIMIT ?3 OFFSET ?4`,
    ).bind(orgId, options.email ?? null, options.count, options.offset),
  ])
  return { total: (counted?.results[0] as { total: number } | undefined)?.total ?? 0, users: (listed?.results ?? []) as ScimUserRow[] }
}

export async function findScimUser(db: D1Database, orgId: string, userId: string): Promise<ScimUserRow | null> {
  return db.prepare(
    `SELECT u.id, u.email, u.name, u.created_at, u.updated_at, (m.user_id IS NOT NULL) AS member, s.external_id
     FROM users u LEFT JOIN memberships m ON m.org_id = ?1 AND m.user_id = u.id
     LEFT JOIN scim_users s ON s.org_id = ?1 AND s.user_id = u.id
     WHERE u.id = ?2 AND (s.user_id IS NOT NULL OR m.user_id IS NOT NULL) AND ${IN_VERIFIED_DOMAIN}`,
  ).bind(orgId, userId).first<ScimUserRow>()
}

export async function linkScimUser(db: D1Database, orgId: string, userId: string, externalId: string | null, now: number): Promise<void> {
  await db.prepare(
    `INSERT INTO scim_users (org_id, user_id, external_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)
     ON CONFLICT (org_id, user_id) DO UPDATE SET external_id = COALESCE(excluded.external_id, scim_users.external_id), updated_at = excluded.updated_at`,
  ).bind(orgId, userId, externalId, now).run()
}

export async function unlinkScimUser(db: D1Database, orgId: string, userId: string): Promise<void> {
  await db.prepare('DELETE FROM scim_users WHERE org_id = ?1 AND user_id = ?2').bind(orgId, userId).run()
}
