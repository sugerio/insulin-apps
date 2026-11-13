// OAuth for MCP clients and service accounts (DESIGN.md §5.2, §5.3): registered clients, authorization requests waiting
// for consent, grants, codes, tokens and service accounts (the "OAuth clients" of an app's API access page). Tokens,
// codes, request ids and client secrets are stored as SHA-256 only. Writes that commit together are one batch; every
// check that a race could defeat is inside a statement.
import { orgAdmin, type GrantInput, type GrantRole } from './grants.ts'

export interface ClientRow {
  id: string
  name: string
  /** JSON array of the registered redirect URIs. */
  redirect_uris: string
  created_at: number
}

export interface RequestRow {
  id_hash: string
  session_hash: string
  client_id: string
  app: string
  redirect_uri: string
  code_challenge: string
  state: string | null
  expires_at: number
}

export interface GrantRow {
  id: string
  client_id: string
  client_name: string
  user_id: string
  org_id: string
  app: string
  created_at: number
  expires_at: number
  last_used_at: number | null
}

/** A person's grant with the names the account page shows. */
export interface UserGrantRow extends GrantRow {
  org_name: string
}

/** A grant for one app with the person who allowed it, for an owner's or admin's view of Connect AI. */
export interface AppGrantRow extends GrantRow {
  user_name: string
  user_email: string
}

/** An access token and whoever it acts for: a person's grant, or a service account. */
export interface AccessTokenRow {
  token_hash: string
  grant_id: string | null
  service_account_id: string | null
  // The grant, for a person's token.
  user_id: string | null
  grant_org_id: string | null
  grant_app: string | null
  grant_expires_at: number | null
  grant_last_used_at: number | null
  client_name: string | null
  user_email: string | null
  user_name: string | null
  // The service account, for a machine's token.
  sa_org_id: string | null
  sa_app: string | null
  sa_name: string | null
  sa_role: GrantRole | null
  sa_custom_role_id: string | null
  sa_custom_role_name: string | null
  sa_custom_permissions: string | null
  sa_last_used_at: number | null
}

export interface ServiceAccountRow {
  id: string
  org_id: string
  app: string
  name: string
  role: GrantRole
  custom_role_id: string | null
  custom_role_name: string | null
  client_id: string
  secret_hash: string
  /** The secret a rotation replaced, valid until `previous_secret_expires_at` (DESIGN.md §5.3). */
  previous_secret_hash: string | null
  previous_secret_expires_at: number | null
  /** When the current secret was made by a rotation; null while the client has its first secret. */
  secret_rotated_at: number | null
  created_at: number
  last_used_at: number | null
  /** When an owner or admin revoked it (/settings/oauth-clients): it then gets no token, and may only be deleted. */
  revoked_at: number | null
}

export interface TokenToIssue {
  hash: string
  kind: 'access' | 'refresh'
  grantId: string | null
  serviceAccountId: string | null
  expiresAt: number
}

export async function insertClient(db: D1Database, client: { id: string; name: string; redirectUris: string[]; now: number }): Promise<void> {
  await db.prepare('INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(client.id, client.name, JSON.stringify(client.redirectUris), client.now).run()
}

export function findClient(db: D1Database, id: string): Promise<ClientRow | null> {
  return db.prepare('SELECT id, name, redirect_uris, created_at FROM oauth_clients WHERE id = ?1').bind(id).first<ClientRow>()
}

export async function insertRequest(db: D1Database, request: Omit<RequestRow, 'expires_at'> & { now: number; expiresAt: number }): Promise<void> {
  await db.prepare(
    `INSERT INTO oauth_requests (id_hash, session_hash, client_id, app, redirect_uri, code_challenge, state, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  ).bind(request.id_hash, request.session_hash, request.client_id, request.app, request.redirect_uri, request.code_challenge,
    request.state, request.now, request.expiresAt).run()
}

/** The request, if it belongs to this browser session and is still open; a decision takes it (single use). */
export function takeRequest(db: D1Database, idHash: string, sessionHash: string, now: number): Promise<RequestRow | null> {
  return db.prepare(
    `DELETE FROM oauth_requests WHERE id_hash = ?1 AND session_hash = ?2 AND expires_at > ?3
     RETURNING id_hash, session_hash, client_id, app, redirect_uri, code_challenge, state, expires_at`,
  ).bind(idHash, sessionHash, now).first<RequestRow>()
}

/**
 * Records what the person allowed and the code for it, in one batch: the grant only while they are still a member of
 * the organization, and the code only with the grant. False when the membership was gone.
 */
export async function insertGrantWithCode(db: D1Database, grant: {
  id: string; clientId: string; userId: string; orgId: string; app: string; now: number; expiresAt: number
  codeHash: string; redirectUri: string; codeChallenge: string; codeExpiresAt: number
}): Promise<boolean> {
  const [inserted] = await db.batch([
    db.prepare(
      `INSERT INTO oauth_grants (id, client_id, user_id, org_id, app, created_at, expires_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
       WHERE EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = ?4 AND m.user_id = ?3)`,
    ).bind(grant.id, grant.clientId, grant.userId, grant.orgId, grant.app, grant.now, grant.expiresAt),
    db.prepare(
      `INSERT INTO oauth_codes (code_hash, grant_id, redirect_uri, code_challenge, created_at, expires_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE EXISTS (SELECT 1 FROM oauth_grants g WHERE g.id = ?2)`,
    ).bind(grant.codeHash, grant.id, grant.redirectUri, grant.codeChallenge, grant.now, grant.codeExpiresAt),
  ])
  return (inserted?.meta.changes ?? 0) > 0
}

/**
 * Uses a code once, if it was issued to `clientId`: its grant, redirect URI and challenge, or null when it is unknown,
 * expired, already used or another client's (which leaves it unused).
 */
export function redeemCode(db: D1Database, codeHash: string, clientId: string, now: number): Promise<{ grant_id: string; redirect_uri: string; code_challenge: string } | null> {
  return db.prepare(
    `UPDATE oauth_codes SET used_at = ?2 WHERE code_hash = ?1 AND used_at IS NULL AND expires_at > ?2
       AND EXISTS (SELECT 1 FROM oauth_grants g WHERE g.id = oauth_codes.grant_id AND g.client_id = ?3 AND g.revoked_at IS NULL)
     RETURNING grant_id, redirect_uri, code_challenge`,
  ).bind(codeHash, now, clientId).first()
}

/** A code that was used before: its grant, so a replay can revoke it (RFC 6749 §4.1.2). */
export async function usedCodeGrant(db: D1Database, codeHash: string): Promise<string | null> {
  const row = await db.prepare('SELECT grant_id FROM oauth_codes WHERE code_hash = ?1 AND used_at IS NOT NULL').bind(codeHash).first<{ grant_id: string }>()
  return row?.grant_id ?? null
}

const GRANT_SELECT = `SELECT g.id, g.client_id, c.name AS client_name, g.user_id, g.org_id, g.app, g.created_at, g.expires_at,
    g.last_used_at
  FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id`

export function findGrant(db: D1Database, id: string, now: number): Promise<GrantRow | null> {
  return db.prepare(`${GRANT_SELECT} WHERE g.id = ?1 AND g.expires_at > ?2 AND g.revoked_at IS NULL`).bind(id, now).first<GrantRow>()
}

/** Ends a grant: its codes and tokens go with it. */
export async function deleteGrant(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM oauth_grants WHERE id = ?1').bind(id).run()
}

/**
 * A person ends one of their own live grants. False when it isn't theirs, or was revoked: that record is the
 * organization's (DESIGN.md §5.4), and only its owners and admins delete it.
 */
export async function deleteUserGrant(db: D1Database, id: string, userId: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM oauth_grants WHERE id = ?1 AND user_id = ?2 AND revoked_at IS NULL').bind(id, userId).run()
  return result.meta.changes > 0
}

export async function listUserGrants(db: D1Database, userId: string, now: number): Promise<UserGrantRow[]> {
  const { results } = await db.prepare(
    `SELECT g.id, g.client_id, c.name AS client_name, g.user_id, g.org_id, o.name AS org_name, g.app, g.created_at,
       g.expires_at, g.last_used_at
     FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id JOIN orgs o ON o.id = g.org_id
     WHERE g.user_id = ?1 AND g.expires_at > ?2 AND g.revoked_at IS NULL ORDER BY g.created_at DESC`,
  ).bind(userId, now).all<UserGrantRow>()
  return results
}

/** The person's own live grants for one app in one organization (the app's Connect AI page). */
export async function listOwnAppGrants(db: D1Database, grant: { userId: string; orgId: string; app: string; now: number }): Promise<GrantRow[]> {
  const { results } = await db.prepare(`${GRANT_SELECT} WHERE g.user_id = ?1 AND g.org_id = ?2 AND g.app = ?3 AND g.expires_at > ?4 AND g.revoked_at IS NULL ORDER BY g.created_at DESC`)
    .bind(grant.userId, grant.orgId, grant.app, grant.now).all<GrantRow>()
  return results
}

/**
 * Everyone's live grants for one app in one organization, with who allowed each, while `actorId` is still an OWNER or
 * ADMIN there (checked in the statement): empty for anyone else.
 */
export async function listAppGrantsAsAdmin(db: D1Database, grant: { orgId: string; app: string; actorId: string; now: number }): Promise<AppGrantRow[]> {
  const { results } = await db.prepare(
    `SELECT g.id, g.client_id, c.name AS client_name, g.user_id, u.name AS user_name, u.email AS user_email, g.org_id, g.app,
       g.created_at, g.expires_at, g.last_used_at
     FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id JOIN users u ON u.id = g.user_id
     WHERE g.org_id = ?1 AND g.app = ?2 AND g.expires_at > ?3 AND g.revoked_at IS NULL AND ${orgAdmin('?1', '?4')}
     ORDER BY u.name COLLATE NOCASE, g.created_at DESC`,
  ).bind(grant.orgId, grant.app, grant.now, grant.actorId).all<AppGrantRow>()
  return results
}

/**
 * Ends a grant from an app's Connect AI page: the actor's own live one, or anyone's in that app and organization while
 * the actor is still an OWNER or ADMIN there (checked in the statement). Its codes and tokens go with it. False otherwise.
 */
export async function deleteAppGrant(db: D1Database, grant: { id: string; orgId: string; app: string; actorId: string }): Promise<boolean> {
  const result = await db.prepare(`DELETE FROM oauth_grants WHERE id = ?1 AND org_id = ?2 AND app = ?3 AND ((user_id = ?4 AND revoked_at IS NULL) OR ${orgAdmin('?2', '?4')})`)
    .bind(grant.id, grant.orgId, grant.app, grant.actorId).run()
  return result.meta.changes > 0
}

/** Notes an agent's use (at most once an hour), and its person and organization as active then. */
export async function touchGrant(db: D1Database, id: string, now: number): Promise<void> {
  await db.batch([
    db.prepare('UPDATE oauth_grants SET last_used_at = ?2 WHERE id = ?1').bind(id, now),
    db.prepare('UPDATE users SET last_active_at = ?2 WHERE id = (SELECT user_id FROM oauth_grants WHERE id = ?1)').bind(id, now),
    db.prepare('UPDATE orgs SET last_active_at = ?2 WHERE id = (SELECT org_id FROM oauth_grants WHERE id = ?1)').bind(id, now),
  ])
}

export function issueStatements(db: D1Database, tokens: TokenToIssue[], now: number): D1PreparedStatement[] {
  return tokens.map((token) => db.prepare(
    `INSERT INTO oauth_tokens (token_hash, kind, grant_id, service_account_id, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  ).bind(token.hash, token.kind, token.grantId, token.serviceAccountId, now, token.expiresAt))
}

export async function issueTokens(db: D1Database, tokens: TokenToIssue[], now: number): Promise<void> {
  await db.batch(issueStatements(db, tokens, now))
}

export function findAccessToken(db: D1Database, hash: string, now: number): Promise<AccessTokenRow | null> {
  return db.prepare(
    `SELECT t.token_hash, t.grant_id, t.service_account_id,
       g.user_id, g.org_id AS grant_org_id, g.app AS grant_app, g.expires_at AS grant_expires_at,
       g.last_used_at AS grant_last_used_at, c.name AS client_name, u.email AS user_email, u.name AS user_name,
       s.org_id AS sa_org_id, s.app AS sa_app, s.name AS sa_name, s.role AS sa_role, s.custom_role_id AS sa_custom_role_id,
       cr.name AS sa_custom_role_name, cr.permissions AS sa_custom_permissions, s.last_used_at AS sa_last_used_at
     FROM oauth_tokens t
     LEFT JOIN oauth_grants g ON g.id = t.grant_id
     LEFT JOIN oauth_clients c ON c.id = g.client_id
     LEFT JOIN users u ON u.id = g.user_id
     LEFT JOIN service_accounts s ON s.id = t.service_account_id
     LEFT JOIN custom_roles cr ON cr.id = s.custom_role_id
     JOIN orgs o ON o.id = COALESCE(g.org_id, s.org_id) AND o.status = 'active'
     WHERE t.token_hash = ?1 AND t.kind = 'access' AND t.expires_at > ?2
       AND (t.grant_id IS NULL OR (g.revoked_at IS NULL AND u.status = 'active'))
       AND (t.service_account_id IS NULL OR s.revoked_at IS NULL)`,
  ).bind(hash, now).first<AccessTokenRow>()
}

/**
 * Uses a refresh token once (it rotates), if it was issued to `clientId`: its grant, or null when it is unknown,
 * expired, already used or another client's (which leaves it unused).
 */
export async function redeemRefresh(db: D1Database, hash: string, clientId: string, now: number): Promise<string | null> {
  const row = await db.prepare(
    `UPDATE oauth_tokens SET used_at = ?2 WHERE token_hash = ?1 AND kind = 'refresh' AND used_at IS NULL AND expires_at > ?2
       AND EXISTS (SELECT 1 FROM oauth_grants g JOIN users u ON u.id = g.user_id AND u.status = 'active'
         JOIN orgs o ON o.id = g.org_id AND o.status = 'active'
         WHERE g.id = oauth_tokens.grant_id AND g.client_id = ?3 AND g.revoked_at IS NULL)
     RETURNING grant_id`,
  ).bind(hash, now, clientId).first<{ grant_id: string | null }>()
  return row?.grant_id ?? null
}

/** A refresh token that was used before: its grant, which a reuse revokes (it was stolen, or the client is confused). */
export async function usedRefreshGrant(db: D1Database, hash: string): Promise<string | null> {
  const row = await db.prepare("SELECT grant_id FROM oauth_tokens WHERE token_hash = ?1 AND kind = 'refresh' AND used_at IS NOT NULL")
    .bind(hash).first<{ grant_id: string | null }>()
  return row?.grant_id ?? null
}

/** A token by hash with the client it was issued to (for revocation): a grant's client, or a service account's id. */
export function findTokenOwner(db: D1Database, hash: string): Promise<{ kind: 'access' | 'refresh'; grant_id: string | null; client_id: string | null; service_account_client_id: string | null } | null> {
  return db.prepare(
    `SELECT t.kind, t.grant_id, g.client_id, s.client_id AS service_account_client_id
     FROM oauth_tokens t LEFT JOIN oauth_grants g ON g.id = t.grant_id LEFT JOIN service_accounts s ON s.id = t.service_account_id
     WHERE t.token_hash = ?1`,
  ).bind(hash).first()
}

export async function deleteToken(db: D1Database, hash: string): Promise<void> {
  await db.prepare('DELETE FROM oauth_tokens WHERE token_hash = ?1').bind(hash).run()
}

const SERVICE_ACCOUNT_SELECT = `SELECT s.id, s.org_id, s.app, s.name, s.role, s.custom_role_id, c.name AS custom_role_name,
    s.client_id, s.secret_hash, s.previous_secret_hash, s.previous_secret_expires_at, s.secret_rotated_at, s.created_at, s.last_used_at,
    s.revoked_at
  FROM service_accounts s LEFT JOIN custom_roles c ON c.id = s.custom_role_id`

export async function listServiceAccounts(db: D1Database, orgId: string, app: string): Promise<ServiceAccountRow[]> {
  const { results } = await db.prepare(`${SERVICE_ACCOUNT_SELECT} WHERE s.org_id = ?1 AND s.app = ?2 ORDER BY s.name COLLATE NOCASE, s.created_at`)
    .bind(orgId, app).all<ServiceAccountRow>()
  return results
}

export function findServiceAccount(db: D1Database, orgId: string, app: string, id: string): Promise<ServiceAccountRow | null> {
  return db.prepare(`${SERVICE_ACCOUNT_SELECT} WHERE s.org_id = ?1 AND s.app = ?2 AND s.id = ?3`).bind(orgId, app, id).first<ServiceAccountRow>()
}

export function findServiceAccountByClientId(db: D1Database, clientId: string): Promise<ServiceAccountRow | null> {
  return db.prepare(`${SERVICE_ACCOUNT_SELECT} WHERE s.client_id = ?1`).bind(clientId).first<ServiceAccountRow>()
}

/**
 * A service account's access token, recording the secret that issued it, if that secret is still one of the account's
 * valid ones (checked in the statement): a rotation or "Revoke previous secret now" between the caller's check and this
 * insert leaves no token behind. False otherwise.
 */
export async function issueServiceToken(db: D1Database, token: { hash: string; serviceAccountId: string; secretHash: string; now: number; expiresAt: number }): Promise<boolean> {
  const result = await db.prepare(
    `INSERT INTO oauth_tokens (token_hash, kind, grant_id, service_account_id, client_secret_hash, created_at, expires_at)
     SELECT ?1, 'access', NULL, ?2, ?3, ?4, ?5
     WHERE EXISTS (SELECT 1 FROM service_accounts s JOIN orgs o ON o.id = s.org_id AND o.status = 'active'
       WHERE s.id = ?2 AND s.revoked_at IS NULL
       AND (s.secret_hash = ?3 OR (s.previous_secret_hash = ?3 AND s.previous_secret_expires_at > ?4)))`,
  ).bind(token.hash, token.serviceAccountId, token.secretHash, token.now, token.expiresAt).run()
  return result.meta.changes > 0
}

/** Creates a service account while `actorId` is still an OWNER or ADMIN of the organization. False otherwise. */
export async function insertServiceAccount(db: D1Database, account: {
  id: string; orgId: string; app: string; name: string; grant: GrantInput; clientId: string; secretHash: string; actorId: string; now: number
}): Promise<boolean> {
  const result = await db.prepare(
    `INSERT INTO service_accounts (id, org_id, app, name, role, custom_role_id, client_id, secret_hash, created_by, created_at, updated_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10 WHERE ${orgAdmin('?2', '?9')}`,
  ).bind(account.id, account.orgId, account.app, account.name, account.grant.role, account.grant.customRoleId, account.clientId,
    account.secretHash, account.actorId, account.now).run()
  return result.meta.changes > 0
}

/** Renames a service account or changes its role while `actorId` is still an OWNER or ADMIN of the organization. */
export async function updateServiceAccount(db: D1Database, account: {
  id: string; orgId: string; app: string; name: string; grant: GrantInput; actorId: string; now: number
}): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE service_accounts SET name = ?4, role = ?5, custom_role_id = ?6, updated_at = ?7
     WHERE id = ?1 AND org_id = ?2 AND app = ?3 AND revoked_at IS NULL AND ${orgAdmin('?2', '?8')}`,
  ).bind(account.id, account.orgId, account.app, account.name, account.grant.role, account.grant.customRoleId, account.now, account.actorId).run()
  return result.meta.changes > 0
}

/**
 * Deletes the tokens of a service account's previous secret, while it has one and `actorId` is still an OWNER or ADMIN
 * of the organization. Tokens issued before migration 0008 recorded no secret; they count as the previous secret's (or
 * an older one's), since only a rotation after that migration makes a previous secret at all.
 */
function endPreviousSecretTokens(db: D1Database, account: { id: string; orgId: string; app: string; actorId: string }): D1PreparedStatement {
  return db.prepare(
    `DELETE FROM oauth_tokens WHERE service_account_id = ?1
       AND EXISTS (SELECT 1 FROM service_accounts s WHERE s.id = ?1 AND s.org_id = ?2 AND s.app = ?3 AND s.previous_secret_hash IS NOT NULL)
       AND (client_secret_hash IS NULL OR client_secret_hash = (SELECT s.previous_secret_hash FROM service_accounts s WHERE s.id = ?1))
       AND ${orgAdmin('?2', '?4')}`,
  ).bind(account.id, account.orgId, account.app, account.actorId)
}

/**
 * A new secret for a service account while `actorId` is still an OWNER or ADMIN of the organization, in one batch: the
 * current secret becomes the previous one, valid until `previousExpiresAt`, and the tokens it issued keep working until
 * they expire. A previous secret still there is replaced, so at most two secrets are ever valid, and its tokens end now.
 */
export async function rotateServiceAccount(db: D1Database, account: {
  id: string; orgId: string; app: string; secretHash: string; previousExpiresAt: number; actorId: string; now: number
}): Promise<boolean> {
  const [, rotated] = await db.batch([
    endPreviousSecretTokens(db, account),
    db.prepare(
      `UPDATE service_accounts SET previous_secret_hash = secret_hash, previous_secret_expires_at = ?5, secret_hash = ?4,
         secret_rotated_at = ?6, updated_at = ?6
       WHERE id = ?1 AND org_id = ?2 AND app = ?3 AND revoked_at IS NULL AND ${orgAdmin('?2', '?7')}`,
    ).bind(account.id, account.orgId, account.app, account.secretHash, account.previousExpiresAt, account.now, account.actorId),
  ])
  return (rotated?.meta.changes ?? 0) > 0
}

/**
 * Ends a service account's previous secret at once, and the tokens it issued, in one batch, while `actorId` is still an
 * OWNER or ADMIN of the organization. False when there was no previous secret, or the actor may not.
 */
export async function revokePreviousSecret(db: D1Database, account: { id: string; orgId: string; app: string; actorId: string; now: number }): Promise<boolean> {
  const [, revoked] = await db.batch([
    endPreviousSecretTokens(db, account),
    db.prepare(
      `UPDATE service_accounts SET previous_secret_hash = NULL, previous_secret_expires_at = NULL, updated_at = ?4
       WHERE id = ?1 AND org_id = ?2 AND app = ?3 AND previous_secret_hash IS NOT NULL AND revoked_at IS NULL AND ${orgAdmin('?2', '?5')}`,
    ).bind(account.id, account.orgId, account.app, account.now, account.actorId),
  ])
  return (revoked?.meta.changes ?? 0) > 0
}

/** Deletes a service account (and its tokens) while `actorId` is still an OWNER or ADMIN of the organization. */
export async function deleteServiceAccount(db: D1Database, account: { id: string; orgId: string; app: string; actorId: string }): Promise<boolean> {
  const result = await db.prepare(`DELETE FROM service_accounts WHERE id = ?1 AND org_id = ?2 AND app = ?3 AND ${orgAdmin('?2', '?4')}`)
    .bind(account.id, account.orgId, account.app, account.actorId).run()
  return result.meta.changes > 0
}

// --- The organization's OAuth clients (/settings/oauth-clients, DESIGN.md §5.4) -----------------------------------------
// Every app's clients for API access and every person's AI agents in one organization, for its owners and admins: each
// list and each write re-checks OWNER or ADMIN inside its statement, so a demoted admin sees and changes nothing. No
// secret is ever read here; secrets are made, shown once and rotated on each app's API access page.

/** An app's OAuth client for API access, with who created it and, once revoked, who revoked it. */
export interface OrgServiceAccountRow {
  id: string
  app: string
  name: string
  role: GrantRole
  custom_role_id: string | null
  custom_role_name: string | null
  client_id: string
  created_at: number
  last_used_at: number | null
  /** Null when the person who created it has since deleted their account. */
  created_by_name: string | null
  created_by_email: string | null
  revoked_at: number | null
  revoked_by_name: string | null
  revoked_by_email: string | null
}

export async function listOrgServiceAccountsAsAdmin(db: D1Database, list: { orgId: string; actorId: string }): Promise<OrgServiceAccountRow[]> {
  const { results } = await db.prepare(
    `SELECT s.id, s.app, s.name, s.role, s.custom_role_id, c.name AS custom_role_name, s.client_id, s.created_at, s.last_used_at,
       cu.name AS created_by_name, cu.email AS created_by_email, s.revoked_at, ru.name AS revoked_by_name, ru.email AS revoked_by_email
     FROM service_accounts s LEFT JOIN custom_roles c ON c.id = s.custom_role_id
       LEFT JOIN users cu ON cu.id = s.created_by LEFT JOIN users ru ON ru.id = s.revoked_by
     WHERE s.org_id = ?1 AND ${orgAdmin('?1', '?2')}
     ORDER BY s.created_at DESC, s.id`,
  ).bind(list.orgId, list.actorId).all<OrgServiceAccountRow>()
  return results
}

/** A person's AI agent (an MCP client's grant) in one app, live or revoked, with who allowed it and who revoked it. */
export interface OrgGrantRow extends AppGrantRow {
  revoked_at: number | null
  revoked_by_name: string | null
  revoked_by_email: string | null
}

/** Every grant in the organization that hasn't expired, revoked ones included (they stay listed until they would expire). */
export async function listOrgGrantsAsAdmin(db: D1Database, list: { orgId: string; actorId: string; now: number }): Promise<OrgGrantRow[]> {
  const { results } = await db.prepare(
    `SELECT g.id, g.client_id, c.name AS client_name, g.user_id, u.name AS user_name, u.email AS user_email, g.org_id, g.app,
       g.created_at, g.expires_at, g.last_used_at, g.revoked_at, ru.name AS revoked_by_name, ru.email AS revoked_by_email
     FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id JOIN users u ON u.id = g.user_id
       LEFT JOIN users ru ON ru.id = g.revoked_by
     WHERE g.org_id = ?1 AND g.expires_at > ?3 AND ${orgAdmin('?1', '?2')}
     ORDER BY g.created_at DESC, g.id`,
  ).bind(list.orgId, list.actorId, list.now).all<OrgGrantRow>()
  return results
}

/**
 * Revokes an app's OAuth client in one batch, while `actorId` is still an OWNER or ADMIN of the organization: it is marked
 * revoked by them, its previous secret ends, and every token it holds is deleted. Its current secret is kept only as a
 * hash that no longer issues anything (issueServiceToken). False when it was already revoked, or the actor may not.
 */
export async function revokeOrgServiceAccount(db: D1Database, account: { id: string; orgId: string; actorId: string; now: number }): Promise<boolean> {
  const [revoked] = await db.batch([
    db.prepare(
      `UPDATE service_accounts SET revoked_at = ?3, revoked_by = ?4, previous_secret_hash = NULL, previous_secret_expires_at = NULL, updated_at = ?3
       WHERE id = ?1 AND org_id = ?2 AND revoked_at IS NULL AND ${orgAdmin('?2', '?4')}`,
    ).bind(account.id, account.orgId, account.now, account.actorId),
    db.prepare(
      `DELETE FROM oauth_tokens WHERE service_account_id = ?1
         AND EXISTS (SELECT 1 FROM service_accounts s WHERE s.id = ?1 AND s.org_id = ?2 AND s.revoked_at IS NOT NULL)`,
    ).bind(account.id, account.orgId),
  ])
  return (revoked?.meta.changes ?? 0) > 0
}

/** Deletes an app's OAuth client of the organization (revoked or not) and its tokens, while `actorId` is still an OWNER or ADMIN. */
export async function deleteOrgServiceAccount(db: D1Database, account: { id: string; orgId: string; actorId: string }): Promise<boolean> {
  const result = await db.prepare(`DELETE FROM service_accounts WHERE id = ?1 AND org_id = ?2 AND ${orgAdmin('?2', '?3')}`)
    .bind(account.id, account.orgId, account.actorId).run()
  return result.meta.changes > 0
}

/**
 * Revokes a person's AI agent in one batch, while `actorId` is still an OWNER or ADMIN of the organization: the grant is
 * marked revoked by them and its codes and tokens are deleted, so the agent must be allowed again. False when it was
 * already revoked or has expired, or the actor may not.
 */
export async function revokeOrgGrant(db: D1Database, grant: { id: string; orgId: string; actorId: string; now: number }): Promise<boolean> {
  const revokedHere = 'EXISTS (SELECT 1 FROM oauth_grants g WHERE g.id = ?1 AND g.org_id = ?2 AND g.revoked_at IS NOT NULL)'
  const [revoked] = await db.batch([
    db.prepare(
      `UPDATE oauth_grants SET revoked_at = ?3, revoked_by = ?4
       WHERE id = ?1 AND org_id = ?2 AND revoked_at IS NULL AND expires_at > ?3 AND ${orgAdmin('?2', '?4')}`,
    ).bind(grant.id, grant.orgId, grant.now, grant.actorId),
    db.prepare(`DELETE FROM oauth_tokens WHERE grant_id = ?1 AND ${revokedHere}`).bind(grant.id, grant.orgId),
    db.prepare(`DELETE FROM oauth_codes WHERE grant_id = ?1 AND ${revokedHere}`).bind(grant.id, grant.orgId),
  ])
  return (revoked?.meta.changes ?? 0) > 0
}

/** Deletes a person's AI agent in the organization (revoked or not), with its codes and tokens, while `actorId` is still an OWNER or ADMIN. */
export async function deleteOrgGrant(db: D1Database, grant: { id: string; orgId: string; actorId: string }): Promise<boolean> {
  const result = await db.prepare(`DELETE FROM oauth_grants WHERE id = ?1 AND org_id = ?2 AND ${orgAdmin('?2', '?3')}`)
    .bind(grant.id, grant.orgId, grant.actorId).run()
  return result.meta.changes > 0
}

/** Notes an API client's use (at most once an hour), and its organization as active then. */
export async function touchServiceAccount(db: D1Database, id: string, now: number): Promise<void> {
  await db.batch([
    db.prepare('UPDATE service_accounts SET last_used_at = ?2 WHERE id = ?1').bind(id, now),
    db.prepare('UPDATE orgs SET last_active_at = ?2 WHERE id = (SELECT org_id FROM service_accounts WHERE id = ?1)').bind(id, now),
  ])
}

/** The bounded cleanup (housekeeping.ts): expired requests, codes, tokens and grants, and clients nobody uses. */
export function pruneOAuthStatements(db: D1Database, now: number, limit: number): D1PreparedStatement[] {
  return [
    db.prepare('DELETE FROM oauth_requests WHERE id_hash IN (SELECT id_hash FROM oauth_requests WHERE expires_at <= ?1 LIMIT ?2)').bind(now, limit),
    db.prepare('DELETE FROM oauth_codes WHERE code_hash IN (SELECT code_hash FROM oauth_codes WHERE expires_at <= ?1 LIMIT ?2)').bind(now, limit),
    db.prepare('DELETE FROM oauth_tokens WHERE token_hash IN (SELECT token_hash FROM oauth_tokens WHERE expires_at <= ?1 LIMIT ?2)').bind(now, limit),
    db.prepare('DELETE FROM oauth_grants WHERE id IN (SELECT id FROM oauth_grants WHERE expires_at <= ?1 LIMIT ?2)').bind(now, limit),
    db.prepare(
      `DELETE FROM oauth_clients WHERE id IN (SELECT c.id FROM oauth_clients c WHERE c.created_at <= ?1
         AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.id)
         AND NOT EXISTS (SELECT 1 FROM oauth_requests r WHERE r.client_id = c.id) LIMIT ?2)`,
    ).bind(now - CLIENT_IDLE_MS, limit),
  ]
}

/** A registered client that never got a grant is deleted after a day. */
export const CLIENT_IDLE_MS = 24 * 60 * 60 * 1000
