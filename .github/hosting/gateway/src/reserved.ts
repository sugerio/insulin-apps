// /__insulin/* on every host: reserved for the gateway and never forwarded to an app. The account bar calls these from
// inside app pages with same-origin fetch, so the app's CSP (connect-src 'self') allows them.
import type { Context } from './context.ts'
import { apexUrl, authUrl } from './context.ts'
import { listCapturedMail } from './db/mail.ts'
import { findMembership, listMemberships } from './db/orgs.ts'
import { BodyTooLarge, isFormBody, isJsonBody, isSameOrigin, readText, wantsJson } from './http/request.ts'
import { htmlResponse, jsonResponse, redirect } from './http/response.ts'
import { log } from './log.ts'
import { devMailPage, mailLinks } from './pages/dev-mail.ts'
import { afterPost, methodNotAllowed, notFoundPage } from './pages/status.ts'
import { ROLE_LABELS } from './roles.ts'
import { activeOrg, endSession, loadSession, switchActiveOrg } from './auth/session.ts'

const BODY_LIMIT_BYTES = 4 * 1024

export async function reservedRoutes(ctx: Context): Promise<Response> {
  const method = ctx.request.method
  switch (ctx.url.pathname) {
    case '/__insulin/me':
      return method === 'GET' || method === 'HEAD' ? me(ctx) : methodNotAllowed(ctx, ['GET', 'HEAD'])
    case '/__insulin/switch-org':
      return method === 'POST' ? switchOrg(ctx) : methodNotAllowed(ctx, ['POST'])
    case '/__insulin/logout':
      return method === 'POST' ? logout(ctx) : methodNotAllowed(ctx, ['POST'])
    case '/__insulin/dev/mail':
      return devMail(ctx)
    default:
      return notFoundPage(ctx)
  }
}

/** What the account bar shows: who is signed in, the active organization and role, the other organizations, links. */
async function me(ctx: Context): Promise<Response> {
  const session = await loadSession(ctx)
  if (!session?.user.verified) return jsonResponse({ error: 'unauthorized' }, 401)
  const active = await activeOrg(ctx, session)
  const memberships = await listMemberships(ctx.config.db, session.user.id)
  return jsonResponse({
    user: { name: session.user.name, email: session.user.email },
    organization: active ? { id: active.id, name: active.name, role: active.role, roleLabel: ROLE_LABELS[active.role] } : null,
    organizations: memberships.map((membership) => ({
      id: membership.org_id,
      name: membership.org_name,
      role: membership.role,
      roleLabel: ROLE_LABELS[membership.role],
      active: membership.org_id === active?.id,
    })),
    links: {
      members: active ? authUrl(ctx, `/orgs/${active.id}`) : authUrl(ctx, '/orgs/new'),
      organizations: authUrl(ctx, '/'),
      account: authUrl(ctx, '/account'),
      apps: apexUrl(ctx),
    },
  })
}

/** The body of a /__insulin/* POST: same host only; a form, or JSON where allowed. */
async function readBody(ctx: Context, allowJson: boolean): Promise<URLSearchParams | Record<string, unknown> | Response> {
  if (!isSameOrigin(ctx)) {
    log('origin_rejected', { site: ctx.site, path: ctx.url.pathname })
    return jsonResponse({ error: 'forbidden' }, 403)
  }
  const json = isJsonBody(ctx.request)
  if (!isFormBody(ctx.request) && !(allowJson && json)) return jsonResponse({ error: 'unsupported_media_type' }, 415)
  let text: string
  try {
    text = await readText(ctx.request, BODY_LIMIT_BYTES)
  } catch (error) {
    if (error instanceof BodyTooLarge) return jsonResponse({ error: 'payload_too_large' }, 413)
    throw error
  }
  if (!json) return new URLSearchParams(text)
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400)
  }
}

async function switchOrg(ctx: Context): Promise<Response> {
  const body = await readBody(ctx, true)
  if (body instanceof Response) return body
  const orgId = body instanceof URLSearchParams ? body.get('org_id') : body.orgId
  const session = await loadSession(ctx)
  if (!session?.user.verified) return jsonResponse({ error: 'unauthorized' }, 401)
  const membership = typeof orgId === 'string' ? await findMembership(ctx.config.db, orgId, session.user.id) : null
  if (!membership) return jsonResponse({ error: 'not_found' }, 404)
  await switchActiveOrg(ctx, session, { id: membership.org_id, name: membership.org_name, role: membership.role })
  log('org_switched', { org: membership.org_id, user: session.user.id })
  if (!(body instanceof URLSearchParams) || wantsJson(ctx.request)) {
    return jsonResponse({ ok: true, organization: { id: membership.org_id, name: membership.org_name, role: membership.role } })
  }
  return redirect('/', 303)
}

async function logout(ctx: Context): Promise<Response> {
  const body = await readBody(ctx, false)
  if (body instanceof Response) return body
  await endSession(ctx)
  if (wantsJson(ctx.request)) return jsonResponse({ ok: true, next: apexUrl(ctx) })
  return afterPost(ctx, apexUrl(ctx))
}

/** Local development only: SITE_ENV=test and a *.localhost host; a 404 everywhere else. */
async function devMail(ctx: Context): Promise<Response> {
  if (!ctx.config.testMode || !ctx.host.endsWith('.localhost')) return notFoundPage(ctx)
  if (ctx.request.method !== 'GET' && ctx.request.method !== 'HEAD') return methodNotAllowed(ctx, ['GET', 'HEAD'])
  const mails = await listCapturedMail(ctx.config.db, 50)
  if (ctx.url.searchParams.get('format') === 'json' || wantsJson(ctx.request)) {
    return jsonResponse({
      mails: mails.map((mail) => ({
        id: mail.id, to: mail.recipient, subject: mail.subject, text: mail.body_text, links: mailLinks(mail.body_text), createdAt: mail.created_at,
      })),
    })
  }
  return htmlResponse(devMailPage(ctx, mails))
}
