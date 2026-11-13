// The operator console's pages and actions under /super on the apex (DESIGN.md §11). Without its configuration every
// path here is a 404, as if it weren't there. Every page needs a console session; every action also needs the operator
// to be an admin now (SUPER_ADMIN_EMAILS), and gives a reason, which the audit log keeps with the operator's address.
import type { HostedApp } from '../config.ts'
import type { Context } from '../context.ts'
import { apexUrl } from '../context.ts'
import { UUID_PATTERN, newId } from '../crypto.ts'
import { DAY_MS, dailySeries, fastestGrowing, latestForOrg, latestReport, latestReports, parseMetrics } from '../db/metrics.ts'
import { field } from '../http/request.ts'
import { redirect } from '../http/response.ts'
import { log } from '../log.ts'
import { orgCreatedForYouMail } from '../mail/templates.ts'
import { sendMail } from '../mail/transport.ts'
import { auditPage } from '../pages/super/audit.tsx'
import { appDetailPage, appsPage } from '../pages/super/apps.tsx'
import { cloudflarePage } from '../pages/super/cloudflare.tsx'
import { superMessage } from '../pages/super/layout.tsx'
import { newOrgPage, orgDetailPage, orgsPage } from '../pages/super/orgs.tsx'
import { overviewPage } from '../pages/super/overview.tsx'
import { userDetailPage, usersPage } from '../pages/super/users.tsx'
import { notFoundPage } from '../pages/status.tsx'
import { checkOrgName, cleanText, length, normalizeEmail } from '../validate.ts'
import { assertionConsumer, loadOperator, metadata, signInResponse, signOut, startSignIn, type OperatorSession } from './auth.ts'
import { headroom, parseSnapshot } from './cloudflare.ts'
import {
  createOrgForUser, dailyNew, findAccount, isStatus, lastJob, listAudit, listOrgs, listUsers, orgDetail, orgNames, overview,
  setOrgStatus, setUserStatus, signals, snapshots, userDetail, type OrgSort, type Status, type UserSort,
} from './db.ts'
import { CLOUDFLARE_JOB } from './jobs.ts'

export const REASON_MIN = 3
export const REASON_MAX = 500

type Page = (ctx: Context, session: OperatorSession, params: string[]) => Promise<Response> | Response

interface Route {
  method: 'GET' | 'POST'
  pattern: RegExp
  /** A page or action, for a signed-in operator; `admin` ones for admins only. */
  handler: Page
  admin?: true
}

const ORG = UUID_PATTERN
const USER = UUID_PATTERN
const APP = '[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?'

function route(method: 'GET' | 'POST', path: string, handler: Page, options: { admin?: true } = {}): Route {
  return { method, pattern: new RegExp(`^/super${path}$`), handler, ...options }
}

const ROUTES: Route[] = [
  route('GET', '', overviewRoute),
  route('POST', '/logout', (ctx, session) => signOut(ctx, session)),
  route('GET', '/orgs', orgsRoute),
  route('GET', '/orgs/new', (ctx, session) => newOrgPage(ctx, session, {}), { admin: true }),
  route('POST', '/orgs', createOrgRoute, { admin: true }),
  route('GET', `/orgs/(${ORG})`, orgRoute),
  route('POST', `/orgs/(${ORG})/status`, orgStatusRoute, { admin: true }),
  route('GET', '/users', usersRoute),
  route('GET', `/users/(${USER})`, userRoute),
  route('POST', `/users/(${USER})/status`, userStatusRoute, { admin: true }),
  route('GET', '/apps', appsRoute),
  route('GET', `/apps/(${APP})`, appRoute),
  route('GET', '/cloudflare', cloudflareRoute),
  route('GET', '/audit', auditRoute),
]

/** Paths the router sends here: /super and everything below it. */
export function isSuperPath(path: string): boolean {
  return path === '/super' || path.startsWith('/super/')
}

/**
 * The console's own routes. The router has already checked a POST's Origin and read its form (the SAML response, from
 * Google, is the one cross-site form, `crossSite` in router.ts). Sign-in, the ACS and the metadata need no session.
 */
export async function superRoutes(ctx: Context): Promise<Response> {
  const config = ctx.config.super
  if (ctx.site !== 'apex' || !config) return notFoundPage(ctx)
  const path = ctx.url.pathname
  const method = ctx.request.method === 'HEAD' ? 'GET' : ctx.request.method
  if (path === '/super/login' && method === 'GET') return startSignIn(ctx, config)
  if (path === '/super/saml/acs' && method === 'POST') return assertionConsumer(ctx, config)
  if (path === '/super/saml/metadata' && method === 'GET') return metadata(ctx)
  const match = ROUTES.map((candidate) => ({ candidate, match: candidate.pattern.exec(path) })).find(({ candidate, match }) => match && candidate.method === method)
  if (!match) return notFoundPage(ctx)
  const session = await loadOperator(ctx, config)
  if (!session) return method === 'GET' ? signInResponse(ctx) : redirect(apexUrl(ctx, '/super'), 303)
  if (match.candidate.admin && !session.admin) {
    log('super_admin_refused', { operator: session.operator.id, path })
    return superMessage(ctx, session, 403, 'Admins only', 'Only the console\'s admins can do that.')
  }
  return match.candidate.handler(ctx, session, match.match!.slice(1))
}

/** Whether the router must read this POST as a cross-site form (Google's SAML response). */
export function isSuperCrossSite(path: string): boolean {
  return path === '/super/saml/acs'
}

function page(ctx: Context): number {
  const value = Number(ctx.url.searchParams.get('page') ?? '1')
  return Number.isInteger(value) && value >= 1 && value <= 10_000 ? value : 1
}

function statusFilter(ctx: Context): Status | null {
  const value = ctx.url.searchParams.get('status')
  return isStatus(value) ? value : null
}

function query(ctx: Context): string {
  return (ctx.url.searchParams.get('q') ?? '').slice(0, 200)
}

async function overviewRoute(ctx: Context, session: OperatorSession): Promise<Response> {
  const db = ctx.config.db
  const since = Math.floor((ctx.now - 29 * DAY_MS) / DAY_MS) * DAY_MS
  const [counts, daily, watch, reports, recent] = await Promise.all([
    overview(db, ctx.now),
    dailyNew(db, since),
    signals(db, ctx.now),
    latestReports(db),
    snapshots(db, ctx.now - 2 * 60 * 60 * 1000),
  ])
  const latest = recent.length ? parseSnapshot(recent[recent.length - 1]!.data) : null
  return overviewPage(ctx, session, { counts, daily, since, signals: watch, reports, headroom: latest ? headroom(latest) : null, snapshotAt: latest?.takenAt ?? null })
}

async function orgsRoute(ctx: Context, session: OperatorSession): Promise<Response> {
  const sorts: OrgSort[] = ['created', 'active', 'name', 'members']
  const sort = (sorts as string[]).includes(ctx.url.searchParams.get('sort') ?? '') ? (ctx.url.searchParams.get('sort') as OrgSort) : 'created'
  const filters = { query: query(ctx), status: statusFilter(ctx), sort, page: page(ctx) }
  return orgsPage(ctx, session, filters, await listOrgs(ctx.config.db, filters))
}

async function usersRoute(ctx: Context, session: OperatorSession): Promise<Response> {
  const sorts: UserSort[] = ['created', 'active', 'name', 'email']
  const sort = (sorts as string[]).includes(ctx.url.searchParams.get('sort') ?? '') ? (ctx.url.searchParams.get('sort') as UserSort) : 'created'
  const filters = { query: query(ctx), status: statusFilter(ctx), sort, page: page(ctx) }
  return usersPage(ctx, session, filters, await listUsers(ctx.config.db, filters))
}

async function orgRoute(ctx: Context, session: OperatorSession, [orgId]: string[], problem?: string): Promise<Response> {
  const db = ctx.config.db
  const detail = await orgDetail(db, orgId!, ctx.now)
  if (!detail) return superMessage(ctx, session, 404, 'No such organization', 'There is no organization with that id.')
  const since = ctx.now - 30 * DAY_MS
  const [latest, history] = await Promise.all([latestForOrg(db, orgId!), listAudit(db, { target: { type: 'org', id: orgId! }, limit: 50 })])
  const series = await Promise.all(latest.map(async (row) => ({ app: row.app, days: await dailySeries(db, row.app, orgId!, since) })))
  return orgDetailPage(ctx, session, {
    ...detail,
    usage: detail.usage,
    apps: latest.map((row) => ({
      app: appOf(ctx, row.app),
      hour: row.hour,
      metrics: parseMetrics(row.metrics),
      days: (series.find((entry) => entry.app === row.app)?.days ?? []).map((day) => ({ day: day.day, metrics: parseMetrics(day.metrics) })),
    })),
    history,
  }, problem, problem ? 400 : 200)
}

async function userRoute(ctx: Context, session: OperatorSession, [userId]: string[], problem?: string): Promise<Response> {
  const db = ctx.config.db
  const detail = await userDetail(db, userId!)
  if (!detail) return superMessage(ctx, session, 404, 'No such account', 'There is no account with that id.')
  const history = await listAudit(db, { target: { type: 'user', id: userId! }, limit: 50 })
  return userDetailPage(ctx, session, { ...detail, history }, problem, problem ? 400 : 200)
}

/** The reason an admin gives, cleaned: 3 to 500 characters, or the problem to show. */
export function checkReason(input: string): { reason: string } | { problem: string } {
  const reason = cleanText(input)
  if (length(reason) < REASON_MIN) return { problem: 'Give a reason: the audit log keeps it, and the other operators read it.' }
  if (length(reason) > REASON_MAX) return { problem: `Use at most ${REASON_MAX} characters for the reason.` }
  return { reason }
}

async function orgStatusRoute(ctx: Context, session: OperatorSession, [orgId]: string[]): Promise<Response> {
  const status = field(ctx.form, 'status')
  const reason = checkReason(field(ctx.form, 'reason'))
  if (!isStatus(status)) return orgRoute(ctx, session, [orgId!], 'Choose what to do.')
  if ('problem' in reason) return orgRoute(ctx, session, [orgId!], reason.problem)
  const row = await ctx.config.db.prepare('SELECT name FROM orgs WHERE id = ?1').bind(orgId).first<{ name: string }>()
  if (!row) return superMessage(ctx, session, 404, 'No such organization', 'There is no organization with that id.')
  const changed = await setOrgStatus(ctx.config.db, { orgId: orgId!, status, reason: reason.reason, operator: session.operator, label: row.name, now: ctx.now })
  log('super_org_status', { operator: session.operator.id, org: orgId, status, changed })
  return redirect(apexUrl(ctx, `/super/orgs/${orgId}?notice=${changed ? status : 'unchanged'}`), 303)
}

async function userStatusRoute(ctx: Context, session: OperatorSession, [userId]: string[]): Promise<Response> {
  const status = field(ctx.form, 'status')
  const reason = checkReason(field(ctx.form, 'reason'))
  if (!isStatus(status)) return userRoute(ctx, session, [userId!], 'Choose what to do.')
  if ('problem' in reason) return userRoute(ctx, session, [userId!], reason.problem)
  const row = await ctx.config.db.prepare('SELECT email FROM users WHERE id = ?1').bind(userId).first<{ email: string }>()
  if (!row) return superMessage(ctx, session, 404, 'No such account', 'There is no account with that id.')
  const changed = await setUserStatus(ctx.config.db, { userId: userId!, status, reason: reason.reason, operator: session.operator, label: row.email, now: ctx.now })
  log('super_user_status', { operator: session.operator.id, user: userId, status, changed })
  return redirect(apexUrl(ctx, `/super/users/${userId}?notice=${changed ? status : 'unchanged'}`), 303)
}

/**
 * POST /super/orgs: an organization for an existing, confirmed, active account, past its owner domain's limit. The
 * person is told by e-mail, from the platform, without the operator's name.
 */
async function createOrgRoute(ctx: Context, session: OperatorSession): Promise<Response> {
  const values = { email: field(ctx.form, 'email').slice(0, 254), name: field(ctx.form, 'name').slice(0, 200), reason: field(ctx.form, 'reason').slice(0, 1000) }
  const again = (error: string, status = 400) => newOrgPage(ctx, session, { values, error }, status)
  const email = normalizeEmail(values.email)
  if (!email) return again('Enter the address of the account that will own the organization.')
  const name = checkOrgName(values.name)
  if ('problem' in name) return again(name.problem)
  const reason = checkReason(values.reason)
  if ('problem' in reason) return again(reason.problem)
  const account = await findAccount(ctx.config.db, email)
  if (!account) return again('There is no account with that address. The person signs up first.', 404)
  if (!account.verified) return again('That account hasn\'t confirmed its address yet.', 409)
  if (account.status !== 'active') return again(`That account is ${account.status}.`, 409)
  const orgId = newId()
  if (!(await createOrgForUser(ctx.config.db, { id: orgId, name: name.name, user: account, reason: reason.reason, operator: session.operator, now: ctx.now }))) {
    return again('The organization wasn\'t created: the account changed meanwhile. Check it and try again.', 409)
  }
  log('super_org_created', { operator: session.operator.id, org: orgId, user: account.id })
  await sendMail(ctx, 'org_created_for_you', account.email, orgCreatedForYouMail(account.name, name.name, apexUrl(ctx, `/settings/organization?org=${orgId}`)))
  return redirect(apexUrl(ctx, `/super/orgs/${orgId}?notice=created`), 303)
}

function appOf(ctx: Context, name: string): Pick<HostedApp, 'name' | 'title'> {
  const app = ctx.config.apps.find((candidate) => candidate.name === name)
  return { name, title: app?.title ?? name }
}

async function appsRoute(ctx: Context, session: OperatorSession): Promise<Response> {
  const db = ctx.config.db
  const reports = await latestReports(db)
  const since = ctx.now - 30 * DAY_MS
  const apps = await Promise.all(ctx.config.apps.map(async (app) => {
    const report = reports.find((entry) => entry.app === app.name) ?? null
    const rows = report ? await latestReport(db, app.name) : []
    const totals: Record<string, number> = {}
    for (const row of rows) {
      if (!row.org_id) continue
      for (const [name, value] of Object.entries(parseMetrics(row.metrics))) totals[name] = (totals[name] ?? 0) + value
    }
    const appWide = parseMetrics(rows.find((row) => !row.org_id)?.metrics)
    const days = (await dailySeries(db, app.name, '', since)).map((day) => ({ day: day.day, metrics: parseMetrics(day.metrics) }))
    return { app: { name: app.name, title: app.title, scheduled: app.scheduled }, report, appWide, totals, days }
  }))
  return appsPage(ctx, session, apps)
}

async function appRoute(ctx: Context, session: OperatorSession, [name]: string[]): Promise<Response> {
  const app = ctx.config.apps.find((candidate) => candidate.name === name)
  if (!app) return superMessage(ctx, session, 404, 'No such app', 'There is no app with that name.')
  const db = ctx.config.db
  const rows = await latestReport(db, app.name)
  const orgRows = rows.filter((row) => row.org_id).map((row) => ({ orgId: row.org_id, metrics: parseMetrics(row.metrics) }))
  const metricNames = [...new Set(orgRows.flatMap((row) => Object.keys(row.metrics)))].sort()
  const requested = ctx.url.searchParams.get('sort') ?? ''
  const sort = metricNames.includes(requested) ? requested : (metricNames.includes('storage_bytes') ? 'storage_bytes' : metricNames[0] ?? null)
  orgRows.sort((a, b) => (sort ? (b.metrics[sort] ?? 0) - (a.metrics[sort] ?? 0) : 0) || a.orgId.localeCompare(b.orgId))
  const top = orgRows.slice(0, 200)
  const growth = sort ? await fastestGrowing(db, app.name, sort, 10) : []
  const names = await orgNames(db, [...new Set([...top.map((row) => row.orgId), ...growth.map((row) => row.org_id)])])
  return appDetailPage(ctx, session, {
    app: { name: app.name, title: app.title },
    hour: rows[0]?.hour ?? null,
    appWide: parseMetrics(rows.find((row) => !row.org_id)?.metrics),
    metricNames,
    sort,
    organizations: top.map((row) => ({ ...row, name: names.get(row.orgId) ?? null })),
    total: orgRows.length,
    growth: growth.map((row) => ({ ...row, name: names.get(row.org_id) ?? null })),
  })
}

async function cloudflareRoute(ctx: Context, session: OperatorSession): Promise<Response> {
  const db = ctx.config.db
  const [rows, job] = await Promise.all([snapshots(db, ctx.now - 30 * DAY_MS), lastJob(db, CLOUDFLARE_JOB)])
  const parsed = rows.map((row) => parseSnapshot(row.data)).filter((snapshot) => snapshot !== null)
  const latest = parsed[parsed.length - 1] ?? null
  return cloudflarePage(ctx, session, {
    configured: ctx.config.cloudflare !== null,
    latest,
    headroom: latest ? headroom(latest) : [],
    history: parsed,
    job,
  })
}

async function auditRoute(ctx: Context, session: OperatorSession): Promise<Response> {
  const before = Number(ctx.url.searchParams.get('before') ?? '')
  const rows = await listAudit(ctx.config.db, { limit: 100, before: Number.isInteger(before) && before > 0 ? before : undefined })
  return auditPage(ctx, session, rows)
}

