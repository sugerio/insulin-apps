// The mail relay for apps (DESIGN.md §8.2): POST https://<apex>/__insulin/mail. Apps get no e-mail binding, so an app
// Worker that must write to someone (an Esign recipient's one-time code, say) sends one message at a time here, with
// its SUGER_APP_TOKEN and the organization it is serving. The gateway sends it from its own address, named after the
// app, under the per-recipient caps and a daily cap per organization and app.
import type { Context } from '../context.ts'
import { isId, sha256Hex } from '../crypto.ts'
import { APP_MAIL_DAILY_LIMIT, reserveAppMailSlot } from '../db/mail.ts'
import { BodyTooLarge, isJsonBody, readText } from '../http/request.ts'
import { jsonResponse } from '../http/response.ts'
import { log } from '../log.ts'
import { appForToken } from '../integrations/proxy.ts'
import { bearerToken } from '../oauth/tokens.ts'
import { allowAppMail } from '../ratelimit.ts'
import { cleanText, normalizeEmail } from '../validate.ts'
import { deliver } from './transport.ts'

export { APP_MAIL_DAILY_LIMIT }

const BODY_LIMIT_BYTES = 160 * 1024
const SUBJECT_MAX = 200
const TEXT_MAX = 20_000
const HTML_MAX = 100_000

function problem(error: string, status: number, headers: Record<string, string> = {}): Response {
  return jsonResponse({ error }, status, headers)
}

interface AppMail {
  to: string
  subject: string
  text: string
  html: string
  replyTo: string | null
}

/** The message, or null when any field is missing, too long or malformed. */
function readMail(value: unknown): AppMail | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  const to = normalizeEmail(body.to)
  const subject = typeof body.subject === 'string' ? cleanText(body.subject) : ''
  const text = body.text
  const html = body.html ?? ''
  const replyTo = body.replyTo === undefined || body.replyTo === null ? null : normalizeEmail(body.replyTo)
  if (!to || !subject || [...subject].length > SUBJECT_MAX) return null
  if (typeof text !== 'string' || !text.trim() || text.length > TEXT_MAX) return null
  if (typeof html !== 'string' || html.length > HTML_MAX) return null
  if (body.replyTo !== undefined && body.replyTo !== null && !replyTo) return null
  return { to, subject, text, html, replyTo }
}

export async function appMailRelay(ctx: Context): Promise<Response> {
  if (ctx.site !== 'apex') return problem('not_found', 404)
  if (ctx.request.method !== 'POST') return problem('method_not_allowed', 405, { Allow: 'POST' })
  const master = ctx.config.secretKey
  if (!master) return problem('not_configured', 503)
  const app = await appForToken(ctx, master, bearerToken(ctx.request))
  if (!app) return problem('unauthorized', 401)
  const orgId = ctx.request.headers.get('x-suger-organization-id')
  if (!isId(orgId)) return problem('invalid_request', 400)
  if (!(await allowAppMail(ctx, app.name, orgId))) return problem('rate_limited', 429, { 'Retry-After': '60' })
  const org = await ctx.config.db.prepare('SELECT 1 AS found FROM orgs WHERE id = ?1').bind(orgId).first<{ found: number }>()
  if (!org) return problem('unknown_organization', 404)
  if (!isJsonBody(ctx.request)) return problem('invalid_request', 400)
  let mail: AppMail | null
  try {
    mail = readMail(JSON.parse(await readText(ctx.request, BODY_LIMIT_BYTES)))
  } catch (error) {
    if (error instanceof BodyTooLarge || error instanceof SyntaxError) return problem('invalid_request', 400)
    throw error
  }
  if (!mail) return problem('invalid_request', 400)

  const kind = `app:${app.name}`
  const slot = await reserveAppMailSlot(ctx.config.db, { recipientHash: await sha256Hex(mail.to), kind, orgId, now: ctx.now })
  if (slot === null) {
    log('app_mail_capped', { app: app.name, org: orgId })
    return problem('rate_limited', 429, { 'Retry-After': '3600' })
  }
  const outcome = await deliver(ctx, slot, {
    kind,
    orgId,
    to: mail.to,
    from: { email: ctx.config.mailFrom.email, name: `${app.title} via Insulin Apps` },
    replyTo: mail.replyTo,
    content: { subject: mail.subject, text: mail.text, html: mail.html },
  })
  if (outcome !== 'sent') return problem('send_failed', 502)
  return jsonResponse({ status: 'sent' }, 202)
}
