// Sessions: an opaque random cookie on the site domain; D1 keeps only its SHA-256. Expiry slides, with at most one
// write per hour per session. A session belongs to one credential version of its user and dies when that changes.
import type { Context } from '../context.ts'
import { isToken, randomToken, sha256Hex } from '../crypto.ts'
import { listMemberships } from '../db/orgs.ts'
import { deleteSession, findSession, insertSession, setSessionOrg, touchSession, type SessionRow } from '../db/sessions.ts'
import { cookieValues, serializeCookie, type CookieOptions } from '../http/cookies.ts'
import { isRole, type Role } from '../roles.ts'

export const SESSION_COOKIE = 'insulin_session'
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const TOUCH_INTERVAL_MS = 60 * 60 * 1000
// A browser may hold a stale host-only cookie next to the domain cookie; try a few, never an unbounded list.
const MAX_CANDIDATES = 3

export interface ActiveOrg {
  id: string
  name: string
  role: Role
}

export interface Session {
  idHash: string
  /** The user's credential version this session was created under (findSession only returns matching ones). */
  credentialVersion: number
  user: { id: string; email: string; name: string; verified: boolean; hasPassword: boolean }
  /** The session's organization, when it is still one of the user's memberships. */
  activeOrg: ActiveOrg | null
}

/** Domain=SITE_DOMAIN; Path=/; Secure; HttpOnly; SameSite=Lax (Secure dropped only on http://*.localhost in test mode). */
function cookieOptions(ctx: Context, maxAgeSeconds: number): CookieOptions {
  return { domain: ctx.config.domain, path: '/', maxAge: maxAgeSeconds, secure: !ctx.relaxed, httpOnly: true, sameSite: 'Lax' }
}

function toSession(row: SessionRow): Session {
  return {
    idHash: row.id_hash,
    credentialVersion: row.credential_version,
    user: {
      id: row.user_id,
      email: row.email,
      name: row.name,
      verified: row.email_verified_at !== null,
      hasPassword: row.has_password === 1,
    },
    activeOrg: row.active_org_id && row.active_org_name && isRole(row.active_role)
      ? { id: row.active_org_id, name: row.active_org_name, role: row.active_role }
      : null,
  }
}

function presentedTokens(ctx: Context): string[] {
  return cookieValues(ctx.request.headers.get('Cookie'), SESSION_COOKIE).filter(isToken).slice(0, MAX_CANDIDATES)
}

/** The signed-in session for this request, or null; looked up once per request. */
export async function loadSession(ctx: Context): Promise<Session | null> {
  if (ctx.session) return ctx.session.value
  let session: Session | null = null
  for (const token of presentedTokens(ctx)) {
    const row = await findSession(ctx.config.db, await sha256Hex(token), ctx.now)
    if (!row) continue
    session = toSession(row)
    if (ctx.now - row.last_seen_at >= TOUCH_INTERVAL_MS) {
      await touchSession(ctx.config.db, row.id_hash, ctx.now, ctx.now + SESSION_TTL_MS)
      ctx.setCookies.push(serializeCookie(SESSION_COOKIE, token, cookieOptions(ctx, SESSION_TTL_MS / 1000)))
    }
    break
  }
  ctx.session = { value: session }
  return session
}

/**
 * Signs the user in with a brand-new session (never reusing one the browser presented), replacing any current one.
 * `credentialVersion` is the user's version when the request verified who they are; if it has changed since (a reset
 * landed in between), no session is created and this returns false.
 */
export async function startSession(ctx: Context, user: { id: string; credential_version: number }, activeOrgId: string | null = null): Promise<boolean> {
  for (const token of presentedTokens(ctx)) await deleteSession(ctx.config.db, await sha256Hex(token))
  const token = randomToken()
  const created = await insertSession(ctx.config.db, {
    idHash: await sha256Hex(token),
    userId: user.id,
    activeOrgId,
    credentialVersion: user.credential_version,
    now: ctx.now,
    expiresAt: ctx.now + SESSION_TTL_MS,
  })
  ctx.session = undefined
  if (!created) return false
  ctx.setCookies.push(serializeCookie(SESSION_COOKIE, token, cookieOptions(ctx, SESSION_TTL_MS / 1000)))
  return true
}

/** Deletes the presented session(s) and clears the cookie with the same Domain and Path. */
export async function endSession(ctx: Context): Promise<void> {
  for (const token of presentedTokens(ctx)) await deleteSession(ctx.config.db, await sha256Hex(token))
  clearSessionCookie(ctx)
}

export function clearSessionCookie(ctx: Context): void {
  ctx.setCookies.push(serializeCookie(SESSION_COOKIE, '', cookieOptions(ctx, 0)))
  ctx.session = { value: null }
}

/**
 * The organization requests act in: the session's, while it is still a membership, else the user's oldest membership
 * (remembered on the session). Null when the user belongs to no organization.
 */
export async function activeOrg(ctx: Context, session: Session): Promise<ActiveOrg | null> {
  if (session.activeOrg) return session.activeOrg
  const [oldest] = await listMemberships(ctx.config.db, session.user.id)
  if (!oldest) return null
  await setSessionOrg(ctx.config.db, session.idHash, oldest.org_id)
  session.activeOrg = { id: oldest.org_id, name: oldest.org_name, role: oldest.role }
  return session.activeOrg
}

/** Makes `org` the session's active organization (the caller has checked the membership). */
export async function switchActiveOrg(ctx: Context, session: Session, org: ActiveOrg): Promise<void> {
  await setSessionOrg(ctx.config.db, session.idHash, org.id)
  session.activeOrg = org
}
