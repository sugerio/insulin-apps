// Signing in to the operator console (DESIGN.md §11.1): SP-initiated SAML with the platform's own Google Workspace app,
// never the customers' sign-in. Google vouches for the address and lists the operators' group in the signed
// assertion's `groups` attribute; anyone else is turned away. The console keeps its own session, in a host-only cookie
// on the apex that apps never receive, for eight hours from the sign-in; customers' sessions mean nothing here, and the
// console's mean nothing anywhere else.
import type { SuperConfig } from '../config.ts'
import type { Context } from '../context.ts'
import { apexUrl } from '../context.ts'
import { isToken, newId, randomToken, sha256Hex } from '../crypto.ts'
import { cookieValues, serializeCookie } from '../http/cookies.ts'
import { field } from '../http/request.ts'
import { redirect } from '../http/response.ts'
import { log } from '../log.ts'
import { allowAuth } from '../ratelimit.ts'
import { SamlError, authnRequest, newRequestId, redirectUrl, spMetadata, validateResponse, type ServiceProvider } from '../sso/saml.ts'
import { cleanText, normalizeEmail, truncate, NAME_MAX } from '../validate.ts'
import {
  SESSION_TTL_MS, SIGN_IN_TTL_MS, audit, consumeSignIn, deleteSuperSession, findSuperSession, insertSignIn, insertSuperSession,
  upsertOperator, type Operator,
} from './db.ts'
import { signInFailedPage, signInPage } from '../pages/super/sign-in.tsx'

/** The attribute the Google Workspace app's group membership mapping fills in (the runbook names it so). */
export const GROUPS_ATTRIBUTE = 'groups'

export interface OperatorSession {
  operator: Operator
  /** In SUPER_ADMIN_EMAILS now: may suspend, disable, reinstate and create organizations. */
  admin: boolean
  idHash: string
}

function sessionCookieName(ctx: Context): string {
  return ctx.relaxed ? 'insulin_super' : '__Host-insulin_super'
}

/** The flow cookie binds a sign-in to this browser. SameSite=None: Google posts the response from its own site. */
function flowCookieName(ctx: Context): string {
  return ctx.relaxed ? 'insulin_super_flow' : '__Host-insulin_super_flow'
}

function sessionCookie(ctx: Context, value: string, maxAge: number): string {
  return serializeCookie(sessionCookieName(ctx), value, { path: '/', maxAge, secure: !ctx.relaxed, httpOnly: true, sameSite: 'Lax' })
}

function flowCookie(ctx: Context, value: string, maxAge: number): string {
  return serializeCookie(flowCookieName(ctx), value, {
    path: '/', maxAge, secure: !ctx.relaxed, httpOnly: true, sameSite: ctx.relaxed ? 'Lax' : 'None',
  })
}

/** The console as a SAML service provider: its entity id is the console's address, its ACS below it. */
export function superServiceProvider(ctx: Context): ServiceProvider {
  return { entityId: apexUrl(ctx, '/super'), acsUrl: apexUrl(ctx, '/super/saml/acs') }
}

/** The operator signed in to the console, or null; looked up once per request. */
export async function loadOperator(ctx: Context, config: SuperConfig): Promise<OperatorSession | null> {
  const token = cookieValues(ctx.request.headers.get('Cookie'), sessionCookieName(ctx)).find(isToken)
  if (!token) return null
  const idHash = await sha256Hex(token)
  const operator = await findSuperSession(ctx.config.db, idHash, ctx.now)
  if (!operator) return null
  return { operator: { id: operator.id, email: operator.email, name: operator.name }, admin: config.admins.has(operator.email), idHash }
}

/** GET /super/login: a sign-in for this browser, sent on to Google. */
export async function startSignIn(ctx: Context, config: SuperConfig): Promise<Response> {
  if (!(await allowAuth(ctx, 'super'))) return signInFailedPage(ctx, 429, 'Too many attempts. Please wait a minute, then try again.')
  const id = newRequestId()
  const binding = randomToken()
  await insertSignIn(ctx.config.db, { idHash: await sha256Hex(id), bindingHash: await sha256Hex(binding), now: ctx.now })
  ctx.setCookies.push(flowCookie(ctx, binding, SIGN_IN_TTL_MS / 1000))
  log('super_sign_in_started')
  return redirect(await redirectUrl(config.idp.ssoUrl, authnRequest(superServiceProvider(ctx), id, config.idp.ssoUrl, ctx.now)), 302)
}

/** GET /super/saml/metadata: what the Google Workspace app needs to know about the console. */
export function metadata(ctx: Context): Response {
  return new Response(spMetadata(superServiceProvider(ctx)), {
    headers: { 'Content-Type': 'application/samlmetadata+xml; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  })
}

/**
 * POST /super/saml/acs: Google's signed answer, posted cross-site. It must answer a sign-in this browser started, be
 * signed with the configured certificate (sso/saml.ts checks the rest: audience, recipient, issuer, validity), and list
 * the operators' group. Then the operator is recorded and gets a session.
 */
export async function assertionConsumer(ctx: Context, config: SuperConfig): Promise<Response> {
  if (!(await allowAuth(ctx, 'super'))) return signInFailedPage(ctx, 429, 'Too many attempts. Please wait a minute, then try again.')
  const db = ctx.config.db
  const binding = cookieValues(ctx.request.headers.get('Cookie'), flowCookieName(ctx)).find((value) => /^[A-Za-z0-9_-]{43}$/.test(value)) ?? null
  ctx.setCookies.push(flowCookie(ctx, '', 0))
  let identity
  try {
    identity = validateResponse({ samlResponse: field(ctx.form, 'SAMLResponse'), idp: config.idp, sp: superServiceProvider(ctx), now: ctx.now })
  } catch (error) {
    if (!(error instanceof SamlError)) throw error
    log('super_saml_refused', { code: error.code })
    return signInFailedPage(ctx, 400, 'Google sent an answer the console can\'t accept. Start again from the sign-in page.')
  }
  if (!binding || !(await consumeSignIn(db, await sha256Hex(identity.inResponseTo), await sha256Hex(binding), ctx.now))) {
    log('super_saml_unmatched')
    return signInFailedPage(ctx, 400, 'This sign-in expired, was already used, or was started in another browser. Start again.')
  }
  const email = normalizeEmail(identity.email)
  // Google sends each group's name, as the group is called now; the comparison ignores case and extra spaces.
  const groups = (identity.attributes.get(GROUPS_ATTRIBUTE) ?? []).map((group) => cleanText(group).toLowerCase())
  if (!email || !groups.includes(config.group)) {
    log('super_group_refused')
    return signInFailedPage(ctx, 403, 'Your Google account isn\'t one of the console\'s operators. Ask an admin to add you to the operators\' group.')
  }
  const operator = await upsertOperator(db, { id: newId(), email, name: truncate(cleanText(identity.name), NAME_MAX) || email, now: ctx.now })
  const token = randomToken()
  await insertSuperSession(db, { idHash: await sha256Hex(token), operatorId: operator.id, now: ctx.now })
  await audit(db, { operator, action: 'sign_in', targetType: null, targetId: null, targetLabel: null, reason: null, now: ctx.now })
  ctx.setCookies.push(sessionCookie(ctx, token, SESSION_TTL_MS / 1000))
  log('super_sign_in', { operator: operator.id })
  return redirect(apexUrl(ctx, '/super'), 303)
}

/** POST /super/logout: ends the console session (the Google one is Google's). */
export async function signOut(ctx: Context, session: OperatorSession | null): Promise<Response> {
  if (session) await deleteSuperSession(ctx.config.db, session.idHash)
  ctx.setCookies.push(sessionCookie(ctx, '', 0))
  return redirect(apexUrl(ctx, '/super'), 303)
}

/** The sign-in page, for a GET without a console session. */
export function signInResponse(ctx: Context): Response {
  return signInPage(ctx)
}
