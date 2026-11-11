// What OAuth's secrets look like, how long they last, and who a bearer token acts for (DESIGN.md §5.2, §5.3). Every
// secret is 32 random bytes with a short prefix that says what it is (so a leaked one is recognisable in a log or a
// repository); only its SHA-256 is stored.
import { grantAccess, appAccess, type AppAccess } from '../access.ts'
import type { HostedApp } from '../config.ts'
import type { Context } from '../context.ts'
import { appUrl, originOf } from '../context.ts'
import { base64url, randomBytes, sha256, sha256Hex } from '../crypto.ts'
import { findAccessToken, touchGrant, touchServiceAccount, type AccessTokenRow } from '../db/oauth.ts'
import type { Actor } from '../http/forward.ts'
import { logError } from '../log.ts'

export const ACCESS_TTL_MS = 60 * 60 * 1000
export const GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const CODE_TTL_MS = 60 * 1000
export const REQUEST_TTL_MS = 10 * 60 * 1000
/** How long a service account's previous secret keeps working after a rotation (DESIGN.md §5.3). */
export const PREVIOUS_SECRET_TTL_MS = 24 * 60 * 60 * 1000
const TOUCH_INTERVAL_MS = 60 * 60 * 1000

export const PREFIX = {
  access: 'ia_at_',
  refresh: 'ia_rt_',
  code: 'ia_ac_',
  request: 'ia_rq_',
  secret: 'ia_sk_',
  client: 'mcp_',
  serviceAccount: 'ia_sa_',
} as const

/** A new secret with its prefix: 32 random bytes, base64url. */
export function newSecret(prefix: string): string {
  return `${prefix}${base64url(randomBytes(32))}`
}

/** A new public identifier (client ids): 16 random bytes, base64url. */
export function newIdentifier(prefix: string): string {
  return `${prefix}${base64url(randomBytes(16))}`
}

/** Whether `value` is a secret with this prefix, before any lookup. */
export function isSecret(value: unknown, prefix: string): value is string {
  return typeof value === 'string' && value.length === prefix.length + 43 && value.startsWith(prefix)
    && /^[A-Za-z0-9_-]{43}$/.test(value.slice(prefix.length))
}

export function hashSecret(value: string): Promise<string> {
  return sha256Hex(value)
}

/** PKCE S256 (RFC 7636): the verifier is 43–128 unreserved characters, and its SHA-256 is the challenge. */
export async function pkceMatches(verifier: string, challenge: string): Promise<boolean> {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false
  return base64url(await sha256(verifier)) === challenge
}

export function isChallenge(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value)
}

/** The authorization server's issuer: the apex origin, without a trailing slash (RFC 8414). */
export function issuer(ctx: Context): string {
  return originOf(ctx, ctx.config.domain)
}

/** An app's MCP resource (RFC 8707), what its tokens are for. */
export function mcpResource(ctx: Context, app: HostedApp): string {
  return appUrl(ctx, app, '/mcp')
}

/** An app's API resource, what its service accounts' tokens are for: the app's origin. */
export function apiResource(ctx: Context, app: HostedApp): string {
  return originOf(ctx, app.host)
}

/** `Authorization: Bearer <token>`, or null. */
export function bearerToken(request: Request): string | null {
  const match = /^Bearer[ ]+([^\s]+)\s*$/i.exec(request.headers.get('Authorization') ?? '')
  return match ? match[1]! : null
}

export function hasBearer(request: Request): boolean {
  return /^Bearer(?:\s|$)/i.test(request.headers.get('Authorization') ?? '')
}

export type BearerIdentity =
  | { kind: 'person'; grantId: string; clientName: string; orgId: string; actor: Actor; access: AppAccess; row: AccessTokenRow }
  | { kind: 'service'; serviceAccountId: string; orgId: string; actor: Actor; access: AppAccess; row: AccessTokenRow }

export type BearerResult = BearerIdentity | { refused: 'invalid_token' | 'no_access' }

/**
 * Who an access token acts for in `app`, checked again at every request: the token is live, it is for this app, the
 * grant hasn't ended, and the person still has access to the app in that organization (or the service account still
 * exists, with its role). `invalid_token` sends a client to sign in again; `no_access` means the person lost access.
 */
export async function resolveBearer(ctx: Context, app: HostedApp, token: string | null): Promise<BearerResult> {
  if (!isSecret(token, PREFIX.access)) return { refused: 'invalid_token' }
  const row = await findAccessToken(ctx.config.db, await hashSecret(token), ctx.now)
  if (!row) return { refused: 'invalid_token' }
  if (row.grant_id) {
    if (row.grant_app !== app.name || !row.user_id || !row.grant_org_id || (row.grant_expires_at ?? 0) <= ctx.now) return { refused: 'invalid_token' }
    const access = await appAccess(ctx.config.db, app, row.grant_org_id, row.user_id)
    if (!access) return { refused: 'no_access' }
    if (ctx.now - (row.grant_last_used_at ?? 0) >= TOUCH_INTERVAL_MS) touch(ctx, () => touchGrant(ctx.config.db, row.grant_id!, ctx.now))
    const email = row.user_email ?? ''
    return {
      kind: 'person', grantId: row.grant_id, clientName: row.client_name ?? 'MCP client', orgId: row.grant_org_id,
      actor: { id: row.user_id, email, name: row.user_name || email }, access, row,
    }
  }
  if (row.service_account_id && row.sa_app === app.name && row.sa_org_id && row.sa_role) {
    const access = grantAccess(app, { role: row.sa_role, customRoleId: row.sa_custom_role_id, customRoleName: row.sa_custom_role_name, customPermissions: row.sa_custom_permissions })
    if (!access) return { refused: 'no_access' }
    if (ctx.now - (row.sa_last_used_at ?? 0) >= TOUCH_INTERVAL_MS) touch(ctx, () => touchServiceAccount(ctx.config.db, row.service_account_id!, ctx.now))
    const name = row.sa_name ?? 'Service account'
    return {
      kind: 'service', serviceAccountId: row.service_account_id, orgId: row.sa_org_id,
      actor: { id: row.service_account_id, email: serviceAccountEmail(row.service_account_id), name }, access: { ...access, admin: false }, row,
    }
  }
  return { refused: 'invalid_token' }
}

/** The address an app receives for a service account: on a reserved domain nobody can own (RFC 2606). */
export function serviceAccountEmail(id: string): string {
  return `${id}@service-accounts.invalid`
}

function touch(ctx: Context, write: () => Promise<void>): void {
  ctx.exec.waitUntil(write().catch((error) => logError('oauth_touch_failed', error)))
}
