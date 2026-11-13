// /__insulin/* on every host: reserved for the gateway and never forwarded to an app. The account bar calls these from
// inside app pages with same-origin fetch, so the app's CSP (connect-src 'self') allows them.
import { appAccess } from './access.ts'
import { integrationProxy } from './integrations/proxy.ts'
import { appMailRelay } from './mail/relay.ts'
import { appMetricsReport } from './metrics/report.ts'
import type { Context } from './context.ts'
import { apexUrl, appSettingsPath, originOf } from './context.ts'
import { listCapturedMail } from './db/mail.ts'
import { findMembership, listMemberships } from './db/orgs.ts'
import { BodyTooLarge, isFormBody, isJsonBody, isSameOrigin, readText, wantsJson } from './http/request.ts'
import { htmlResponse, jsonResponse, redirect } from './http/response.ts'
import { log } from './log.ts'
import { navToggle } from './navigation.ts'
import { devMailPage, mailLinks } from './pages/dev-mail.tsx'
import { afterPost, badRequestPage, methodNotAllowed, notFoundPage } from './pages/status.tsx'
import { ROLE_LABELS } from './roles.ts'
import { activeOrg, endSession, loadSession, switchActiveOrg } from './auth/session.ts'

const BODY_LIMIT_BYTES = 4 * 1024

export async function reservedRoutes(ctx: Context): Promise<Response> {
  const method = ctx.request.method
  // The integration proxy (integrations/proxy.ts), called by app Workers with their own token: any method, apex only.
  if (ctx.url.pathname.startsWith('/__insulin/integrations/')) return integrationProxy(ctx)
  switch (ctx.url.pathname) {
    // The mail relay (mail/relay.ts), called by app Workers with their own token: POST, apex only.
    case '/__insulin/mail':
      return appMailRelay(ctx)
    // Usage reports (metrics/report.ts), sent by app Workers every hour with their own token: POST, apex only.
    case '/__insulin/metrics':
      return appMetricsReport(ctx)
    case '/__insulin/me':
      return method === 'GET' || method === 'HEAD' ? me(ctx) : methodNotAllowed(ctx, ['GET', 'HEAD'])
    case '/__insulin/switch-org':
      return method === 'POST' ? switchOrg(ctx) : methodNotAllowed(ctx, ['POST'])
    case '/__insulin/logout':
      return method === 'POST' ? logout(ctx) : methodNotAllowed(ctx, ['POST'])
    case '/__insulin/nav':
      return nav(ctx)
    case '/__insulin/dev/mail':
      return devMail(ctx)
    default:
      return notFoundPage(ctx)
  }
}

/**
 * What the account bar and an app's navigation show: who is signed in, the active organization with their role (in an
 * app: their role in that app), the other organizations, the apex's origin, links (in an app: its own people,
 * integrations and Connect AI pages) and, in an app the person can use, its four settings pages (DESIGN.md §3.2: the
 * app's Settings links to them on the apex).
 */
async function me(ctx: Context): Promise<Response> {
  const session = await loadSession(ctx)
  if (!session?.user.verified) return jsonResponse({ error: 'unauthorized' }, 401)
  const active = await activeOrg(ctx, session)
  const memberships = await listMemberships(ctx.config.db, session.user.id)
  const access = ctx.app && active ? await appAccess(ctx.config.db, ctx.app, active.id, session.user.id, active.role) : null
  const app = access ? ctx.app : null
  return jsonResponse({
    apex: originOf(ctx, ctx.config.domain),
    settings: app ? {
      users: apexUrl(ctx, appSettingsPath(app, 'users')),
      integrations: apexUrl(ctx, appSettingsPath(app, 'integrations')),
      api: apexUrl(ctx, appSettingsPath(app, 'api')),
      connectAi: apexUrl(ctx, appSettingsPath(app, 'connect-ai')),
    } : null,
    user: { name: session.user.name, email: session.user.email },
    organization: active ? { id: active.id, name: active.name, role: active.role, roleLabel: access?.label ?? ROLE_LABELS[active.role] } : null,
    organizations: memberships.map((membership) => ({
      id: membership.org_id,
      name: membership.org_name,
      role: membership.role,
      roleLabel: ROLE_LABELS[membership.role],
      active: membership.org_id === active?.id,
    })),
    links: {
      members: ctx.app && access ? apexUrl(ctx, appSettingsPath(ctx.app, 'users')) : active ? apexUrl(ctx, `/settings/users?org=${active.id}`) : apexUrl(ctx, '/orgs/new'),
      integrations: ctx.app && access ? apexUrl(ctx, appSettingsPath(ctx.app, 'integrations')) : null,
      connectAi: ctx.app && access ? apexUrl(ctx, appSettingsPath(ctx.app, 'connect-ai')) : null,
      organizations: apexUrl(ctx, '/'),
      account: apexUrl(ctx, '/account'),
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

/**
 * The collapse toggles of the gateway's navigation (DESIGN.md §3.2, navigation.ts): GET only, on the apex only, where
 * the signed-in pages are (apps keep the choice in their own localStorage).
 */
function nav(ctx: Context): Response {
  if (ctx.site !== 'apex') return notFoundPage(ctx)
  const method = ctx.request.method
  if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(ctx, ['GET', 'HEAD'])
  const result = navToggle(ctx)
  if (result instanceof Response) return result
  log('nav_refused', { reason: result.code })
  return badRequestPage(ctx, 400, result.problem)
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
