// The two-level navigation of the gateway's signed-in pages (DESIGN.md §3.2), as data: what level 1 and level 2 list
// for an organization's own pages, the account pages and an app's settings pages, the breadcrumb, and whether each
// level is collapsed (the `insulin_nav` cookie, set by GET /__insulin/nav). components/shell.tsx draws it.
import type { HostedApp } from './config.ts'
import type { Context } from './context.ts'
import { apexUrl, appSettingsPath, appUrl, ownOrigin, type AppSettingsTab } from './context.ts'
import { listUserGrants } from './db/grants.ts'
import { listMemberships, type MembershipRow } from './db/orgs.ts'
import { cookieValues, serializeCookie } from './http/cookies.ts'
import { appIconName, type NavIconName } from './nav-icons.ts'
import { canManageSso, canSeeMembers, roleHas, type AppRole } from './roles.ts'
import { activeOrg, type ActiveOrg, type Session } from './auth/session.ts'

export interface NavLink {
  key: string
  label: string
  icon: NavIconName
  href: string
  /** The page being shown, or the open section (`section`): the highlight, and `aria-current` "page" or "true". */
  current: boolean
  /** The open level-1 item whose level 2 holds the page, rather than the page itself. */
  section?: boolean
}

/** Items under an optional heading. */
export interface NavGroup {
  heading: string | null
  items: NavLink[]
}

/** Level 2: the open level-1 item's own items, under a header naming it. */
export interface NavSection {
  title: string
  groups: NavGroup[]
}

export interface Crumb {
  label: string
  /** Null for the page itself (the last crumb). */
  href: string | null
}

export type NavLevelState = 'expanded' | 'collapsed'

export interface NavState {
  l1: NavLevelState
  l2: NavLevelState
}

/** What the shell draws around a signed-in page. */
export interface ShellModel {
  person: { name: string; email: string }
  /** The organization the page is in, shown by the switcher; null for someone in none. */
  org: ActiveOrg | null
  /** Every organization of the person, listed by the switcher. */
  orgs: readonly MembershipRow[]
  /** Level 1: the sections, then (pinned to the bottom of the column) the platform's items. */
  primary: NavGroup[]
  platform: NavGroup | null
  /** Level 2, when the open level-1 item has items of its own. */
  section: NavSection | null
  breadcrumb: Crumb[]
  state: NavState
  /** The page on this host the collapse toggles come back to. */
  returnPath: string
  /** Where switching organization comes back to (this page, without an `?org=` that would pin the old one). */
  switchReturnTo: string | null
}

/** What every shell needs from the database: the person's organizations, the page's organization, and its apps. */
export interface ShellData {
  orgs: readonly MembershipRow[]
  org: ActiveOrg | null
  /** The deployed apps the person can use in `org`, for its level 1 (an app's settings pages don't list them). */
  apps: HostedApp[]
}

export const NAV_COOKIE = 'insulin_nav'
const NAV_COOKIE_MAX_AGE = 400 * 24 * 60 * 60
const LEVEL_STATES: readonly NavLevelState[] = ['expanded', 'collapsed']
export const DEFAULT_NAV_STATE: NavState = { l1: 'expanded', l2: 'expanded' }

function isLevelState(value: unknown): value is NavLevelState {
  return typeof value === 'string' && (LEVEL_STATES as readonly string[]).includes(value)
}

/** The cookie's value, `<l1>.<l2>` (each `expanded` or `collapsed`); anything else is the default. */
export function parseNavCookie(value: string | null | undefined): NavState {
  const [l1, l2, extra] = (value ?? '').split('.')
  return isLevelState(l1) && isLevelState(l2) && extra === undefined ? { l1, l2 } : { ...DEFAULT_NAV_STATE }
}

export function navCookieValue(state: NavState): string {
  return `${state.l1}.${state.l2}`
}

/** This browser's choice, from the `insulin_nav` cookie. */
export function navState(ctx: Context): NavState {
  return parseNavCookie(cookieValues(ctx.request.headers.get('Cookie'), NAV_COOKIE)[0])
}

/**
 * A `return` the toggle may come back to: a path on this host (starting with one `/`, no backslash or control
 * character), which resolves to this request's own origin. Absolute URLs, other hosts and anything odd give null.
 */
export function navReturnPath(ctx: Context, value: string | null): string | null {
  if (value === null) return '/'
  if (!value.startsWith('/') || value.startsWith('//') || value.length > 2048 || /[\\\u0000-\u001f\u007f]/.test(value)) return null
  let url: URL
  try {
    url = new URL(value, ownOrigin(ctx))
  } catch {
    return null
  }
  if (url.origin !== ownOrigin(ctx)) return null
  return `${url.pathname}${url.search}`
}

/**
 * GET /__insulin/nav?l1=collapsed|expanded&l2=…&return=<path>: remembers how each level of the gateway's navigation
 * is shown, in a host-only cookie of the apex, and goes back to `return` (a path on the same host) with a 303. A level
 * left out keeps its state; an unknown value, no level at all, or a return to anywhere but this host is a 400.
 */
export function navToggle(ctx: Context): Response | { code: 'params' | 'state' | 'return'; problem: string } {
  const params = ctx.url.searchParams
  const known = new Set(['l1', 'l2', 'return'])
  if ([...params.keys()].some((key) => !known.has(key)) || [...known].some((key) => params.getAll(key).length > 1)) {
    return { code: 'params', problem: 'Unknown or repeated parameters.' }
  }
  const l1 = params.get('l1')
  const l2 = params.get('l2')
  if ((l1 === null && l2 === null) || (l1 !== null && !isLevelState(l1)) || (l2 !== null && !isLevelState(l2))) {
    return { code: 'state', problem: 'Each level is either expanded or collapsed.' }
  }
  const back = navReturnPath(ctx, params.get('return'))
  if (back === null) return { code: 'return', problem: 'The navigation can only return to a page on this site.' }
  const current = navState(ctx)
  const next: NavState = { l1: (l1 as NavLevelState | null) ?? current.l1, l2: (l2 as NavLevelState | null) ?? current.l2 }
  ctx.setCookies.push(serializeCookie(NAV_COOKIE, navCookieValue(next), {
    path: '/', maxAge: NAV_COOKIE_MAX_AGE, secure: !ctx.relaxed, httpOnly: true, sameSite: 'Lax',
  }))
  return new Response(null, { status: 303, headers: { Location: back, 'Cache-Control': 'no-store' } })
}

/** Each app's icon where the gateway lists it (its level 1, its card on the home page). */
export function appIcon(app: HostedApp): NavIconName {
  return appIconName(app.name)
}

/**
 * The shell's data for a page: the person's organizations (`orgs` when the caller has them), the page's organization
 * (`org`; the active one by default) and the deployed apps they can use there (`apps` to skip the lookup).
 */
export async function loadShell(ctx: Context, session: Session, options: { orgs?: readonly MembershipRow[]; org?: ActiveOrg | null; apps?: HostedApp[] } = {}): Promise<ShellData> {
  const [orgs, org] = await Promise.all([
    options.orgs ?? listMemberships(ctx.config.db, session.user.id),
    options.org !== undefined ? options.org : activeOrg(ctx, session),
  ])
  if (options.apps) return { orgs, org, apps: options.apps }
  if (!org) return { orgs, org, apps: [] }
  // An organization role reaches every app; a specific-apps member, only theirs.
  const mine = org.role === 'APPS' ? new Set((await listUserGrants(ctx.config.db, org.id, session.user.id)).map((grant) => grant.app)) : null
  return { orgs, org, apps: ctx.config.apps.filter((app) => app.service && (!mine || mine.has(app.name))) }
}

/** The page's own address on this host, for the toggles; a POST (a form shown again) falls back to `fallback`. */
function returnPathOf(ctx: Context, fallback: string): string {
  const method = ctx.request.method
  return method === 'GET' || method === 'HEAD' ? `${ctx.url.pathname}${ctx.url.search}` : fallback
}

/** After switching organization, this page again for a GET (without `?org=`), else the home page. */
function switchReturnOf(ctx: Context): string | null {
  const method = ctx.request.method
  if (method !== 'GET' && method !== 'HEAD') return null
  const url = new URL(ctx.url.href)
  url.searchParams.delete('org')
  url.searchParams.delete('notice')
  return url.href
}

function base(ctx: Context, session: Session, data: ShellData, fallback: string): Pick<ShellModel, 'person' | 'org' | 'orgs' | 'state' | 'returnPath' | 'switchReturnTo'> {
  return {
    person: { name: session.user.name, email: session.user.email },
    org: data.org,
    orgs: data.orgs,
    state: navState(ctx),
    returnPath: returnPathOf(ctx, fallback),
    switchReturnTo: switchReturnOf(ctx),
  }
}

/** The organization's own pages, in level 1: Home, its apps, and its settings as the role allows. */
export type OrgPage = 'home' | 'users' | 'roles' | 'organization' | 'sso'

const ORG_PAGE_LABELS: Record<OrgPage, string> = {
  home: 'Home', users: 'People', roles: 'Roles', organization: 'Organization', sso: 'Single sign-on',
}

function orgSettingsHref(ctx: Context, path: string, org: ActiveOrg): string {
  return apexUrl(ctx, `${path}?org=${org.id}`)
}

/** Level 1 of the organization's pages: Home; Apps (the ones the person can use); Settings, as the role allows. */
function orgPrimary(ctx: Context, data: ShellData, current: OrgPage | null): NavGroup[] {
  const groups: NavGroup[] = [{ heading: null, items: [{ key: 'home', label: 'Home', icon: 'house', href: apexUrl(ctx, '/'), current: current === 'home' }] }]
  const org = data.org
  if (!org) return groups
  if (data.apps.length) {
    groups.push({
      heading: 'Apps',
      items: data.apps.map((app) => ({ key: `app-${app.name}`, label: app.title, icon: appIcon(app), href: appUrl(ctx, app), current: false })),
    })
  }
  const settings: NavLink[] = [
    { key: 'users', label: ORG_PAGE_LABELS.users, icon: 'users', href: orgSettingsHref(ctx, '/settings/users', org), current: current === 'users' },
  ]
  if (canSeeMembers(org.role)) {
    settings.push({ key: 'roles', label: ORG_PAGE_LABELS.roles, icon: 'shield', href: orgSettingsHref(ctx, '/settings/roles', org), current: current === 'roles' })
  }
  settings.push({ key: 'organization', label: ORG_PAGE_LABELS.organization, icon: 'building', href: orgSettingsHref(ctx, '/settings/organization', org), current: current === 'organization' })
  if (canManageSso(org.role)) {
    settings.push({ key: 'sso', label: ORG_PAGE_LABELS.sso, icon: 'key', href: orgSettingsHref(ctx, '/settings/sso', org), current: current === 'sso' })
  }
  groups.push({ heading: 'Settings', items: settings })
  return groups
}

/** The platform's documentation, at the bottom of the organization's level 1. */
function platformDocs(ctx: Context): NavGroup {
  return { heading: null, items: [{ key: 'docs', label: 'Docs', icon: 'book-open', href: apexUrl(ctx, '/docs/'), current: false }] }
}

/**
 * The shell of an organization's page (the home page, its settings): level 1 only. A page that isn't in the navigation
 * (creating an organization) passes `current` null and `page`, its title and path.
 */
export function orgShell(ctx: Context, session: Session, data: ShellData, current: OrgPage | null, page?: { title: string; path: string }): ShellModel {
  const primary = orgPrimary(ctx, data, current)
  const here = primary.flatMap((group) => group.items).find((item) => item.current)
  const breadcrumb: Crumb[] = current === null || current === 'home'
    ? [{ label: page?.title ?? 'Home', href: null }]
    : [{ label: 'Settings', href: primary.find((group) => group.heading === 'Settings')?.items[0]?.href ?? null }, { label: ORG_PAGE_LABELS[current], href: null }]
  const fallback = here ? new URL(here.href) : null
  return {
    ...base(ctx, session, data, page?.path ?? (fallback ? `${fallback.pathname}${fallback.search}` : '/')),
    primary,
    platform: platformDocs(ctx),
    section: null,
    breadcrumb,
  }
}

/** The account pages: the organization's level 1, and Account in level 2. */
export type AccountPage = 'profile' | 'security' | 'agents'

const ACCOUNT_PAGES: { page: AccountPage; label: string; icon: NavIconName; path: string }[] = [
  { page: 'profile', label: 'Profile', icon: 'user', path: '/account' },
  { page: 'security', label: 'Security', icon: 'shield', path: '/account/security' },
  { page: 'agents', label: 'AI agents', icon: 'bot', path: '/account/agents' },
]

export function accountShell(ctx: Context, session: Session, data: ShellData, current: AccountPage): ShellModel {
  const page = ACCOUNT_PAGES.find((item) => item.page === current)!
  return {
    ...base(ctx, session, data, page.path),
    primary: orgPrimary(ctx, data, null),
    platform: platformDocs(ctx),
    section: {
      title: 'Account',
      groups: [{ heading: null, items: ACCOUNT_PAGES.map((item) => ({ key: item.page, label: item.label, icon: item.icon, href: apexUrl(ctx, item.path), current: item.page === current })) }],
    },
    breadcrumb: [{ label: 'Account', href: apexUrl(ctx, '/account') }, { label: page.label, href: null }],
  }
}

/** An app's settings pages, in its level 2 under Settings. */
const APP_SETTINGS: { tab: AppSettingsTab; label: string; icon: NavIconName }[] = [
  { tab: 'users', label: 'People', icon: 'users' },
  { tab: 'integrations', label: 'Integrations', icon: 'plug' },
  { tab: 'api', label: 'API access', icon: 'key' },
  { tab: 'connect-ai', label: 'Connect AI', icon: 'bot' },
]

/**
 * The app's level 1 from its manifest, as `role` sees it: links to the app's host, under the manifest's group
 * headings (consecutive items with the same group share one heading).
 */
export function appPrimary(ctx: Context, app: HostedApp, role: AppRole): NavGroup[] {
  const groups: NavGroup[] = []
  for (const item of app.navigation) {
    // Between the least and the most role that see it (a holder's own pages are for viewers only).
    if (!roleHas(role, item.role) || (role !== item.maxRole && roleHas(role, item.maxRole))) continue
    const link: NavLink = { key: item.key, label: item.label, icon: item.icon, href: appUrl(ctx, app, item.path), current: false }
    const last = groups.at(-1)
    if (last && last.heading === item.group) last.items.push(link)
    else groups.push({ heading: item.group, items: [link] })
  }
  return groups
}

/**
 * The shell of an app's settings page: the app's own level 1 (its manifest, filtered by the person's role in it), then
 * Docs (the app's in-app Docs) and Settings, open, whose level 2 is People, Integrations, API access and Connect AI.
 */
export function appShell(ctx: Context, session: Session, data: ShellData, app: HostedApp, role: AppRole, current: AppSettingsTab): ShellModel {
  const settingsHref = apexUrl(ctx, appSettingsPath(app, 'users'))
  const page = APP_SETTINGS.find((item) => item.tab === current)!
  return {
    ...base(ctx, session, data, appSettingsPath(app, current)),
    primary: appPrimary(ctx, app, role),
    platform: {
      heading: null,
      items: [
        { key: 'docs', label: 'Docs', icon: 'book-open', href: appUrl(ctx, app, '/docs'), current: false },
        { key: 'settings', label: 'Settings', icon: 'settings', href: settingsHref, current: true, section: true },
      ],
    },
    section: {
      title: 'Settings',
      groups: [{ heading: null, items: APP_SETTINGS.map((item) => ({ key: item.tab, label: item.label, icon: item.icon, href: apexUrl(ctx, appSettingsPath(app, item.tab)), current: item.tab === current })) }],
    },
    breadcrumb: [{ label: app.title, href: appUrl(ctx, app) }, { label: 'Settings', href: settingsHref }, { label: page.label, href: null }],
  }
}
