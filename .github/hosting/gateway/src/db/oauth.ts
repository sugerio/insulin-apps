// OAuth for MCP clients and service accounts (DESIGN.md §5.2, §5.3): registered clients, authorization requests waiting
// for consent, grants, codes, tokens and service accounts. Tokens, codes, request ids and client secrets are stored as
// SHA-256 only. Writes that commit together are one batch; every check that a race could defeat is inside a statement.
import { appAdmin, type GrantInput, type GrantRole } from './grants.ts'

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
  created_at: number
  last_used_at: number | null
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
       AND EXISTS (SELECT 1 FROM oauth_grants g WHERE g.id = oauth_codes.grant_id AND g.client_id = ?3)
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
  return db.prepare(`${GRANT_SELECT} WHERE g.id = ?1 AND g.expires_at > ?2`).bind(id, now).first<GrantRow>()
}

/** Ends a grant: its codes and tokens go with it. */
export async function deleteGrant(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM oauth_grants WHERE id = ?1').bind(id).run()
}

/** A person ends one of their own grants. False when it isn't theirs. */
export async function deleteUserGrant(db: D1Database, id: string, userId: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM oauth_grants WHERE id = ?1 AND user_id = ?2').bind(id, userId).run()
  return result.meta.changes > 0
}

export async function listUserGrants(db: D1Database, userId: string, now: number): Promise<UserGrantRow[]> {
  const { results } = await db.prepare(
    `SELECT g.id, g.client_id, c.name AS client_name, g.user_id, g.org_id, o.name AS org_name, g.app, g.created_at,
       g.expires_at, g.last_used_at
     FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id JOIN orgs o ON o.id = g.org_id
     WHERE g.user_id = ?1 AND g.expires_at > ?2 ORDER BY g.created_at DESC`,
  ).bind(userId, now).all<UserGrantRow>()
  return results
}

export async function touchGrant(db: D1Database, id: string, now: number): Promise<void> {
  await db.prepare('UPDATE oauth_grants SET last_used_at = ?2 WHERE id = ?1').bind(id, now).run()
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
     WHERE t.token_hash = ?1 AND t.kind = 'access' AND t.expires_at > ?2`,
  ).bind(hash, now).first<AccessTokenRow>()
}

/**
 * Uses a refresh token once (it rotates), if it was issued to `clientId`: its grant, or null when it is unknown,
 * expired, already used or another client's (which leaves it unused).
 */
export async function redeemRefresh(db: D1Database, hash: string, clientId: string, now: number): Promise<string | null> {
  const row = await db.prepare(
    `UPDATE oauth_tokens SET used_at = ?2 WHERE token_hash = ?1 AND kind = 'refresh' AND used_at IS NULL AND expires_at > ?2
       AND EXISTS (SELECT 1 FROM oauth_grants g WHERE g.id = oauth_tokens.grant_id AND g.client_id = ?3)
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
    s.client_id, s.secret_hash, s.created_at, s.last_used_at
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

/** Creates a service account while `actorId` is still the app's admin. False otherwise. */
export async function insertServiceAccount(db: D1Database, account: {
  id: string; orgId: string; app: string; name: string; grant: GrantInput; clientId: string; secretHash: string; actorId: string; now: number
}): Promise<boolean> {
  const result = await db.prepare(
    `INSERT INTO service_accounts (id, org_id, app, name, role, custom_role_id, client_id, secret_hash, created_by, created_at, updated_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10 WHERE ${appAdmin('?2', '?9', '?3')}`,
  ).bind(account.id, account.orgId, account.app, account.name, account.grant.role, account.grant.customRoleId, account.clientId,
    account.secretHash, account.actorId, account.now).run()
  return result.meta.changes > 0
}

/** Renames a service account or changes its role while `actorId` is still the app's admin. */
export async function updateServiceAccount(db: D1Database, account: {
  id: string; orgId: string; app: string; name: string; grant: GrantInput; actorId: string; now: number
}): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE service_accounts SET name = ?4, role = ?5, custom_role_id = ?6, updated_at = ?7
     WHERE id = ?1 AND org_id = ?2 AND app = ?3 AND ${appAdmin('?2', '?8', '?3')}`,
  ).bind(account.id, account.orgId, account.app, account.name, account.grant.role, account.grant.customRoleId, account.now, account.actorId).run()
  return result.meta.changes > 0
}

/** A new secret for a service account while `actorId` is still the app's admin; its tokens stop in the same batch. */
export async function rotateServiceAccount(db: D1Database, account: { id: string; orgId: string; app: string; secretHash: string; actorId: string; now: number }): Promise<boolean> {
  const [rotated] = await db.batch([
    db.prepare(
      `UPDATE service_accounts SET secret_hash = ?4, updated_at = ?5
       WHERE id = ?1 AND org_id = ?2 AND app = ?3 AND ${appAdmin('?2', '?6', '?3')}`,
    ).bind(account.id, account.orgId, account.app, account.secretHash, account.now, account.actorId),
    db.prepare(
      `DELETE FROM oauth_tokens WHERE service_account_id = ?1
         AND EXISTS (SELECT 1 FROM service_accounts s WHERE s.id = ?1 AND s.secret_hash = ?2)`,
    ).bind(account.id, account.secretHash),
  ])
  return (rotated?.meta.changes ?? 0) > 0
}

/** Deletes a service account (and its tokens) while `actorId` is still the app's admin. */
export async function deleteServiceAccount(db: D1Database, account: { id: string; orgId: string; app: string; actorId: string }): Promise<boolean> {
  const result = await db.prepare(`DELETE FROM service_accounts WHERE id = ?1 AND org_id = ?2 AND app = ?3 AND ${appAdmin('?2', '?4', '?3')}`)
    .bind(account.id, account.orgId, account.app, account.actorId).run()
  return result.meta.changes > 0
}

export async function touchServiceAccount(db: D1Database, id: string, now: number): Promise<void> {
  await db.prepare('UPDATE service_accounts SET last_used_at = ?2 WHERE id = ?1').bind(id, now).run()
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
