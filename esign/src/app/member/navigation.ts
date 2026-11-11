// What the members' navigation shows, as data (Shell.ts draws it): the app's sections from its navigation manifest
// (package.json `insulin.navigation`, DESIGN.md §3.2, which the gateway renders from too), filtered by the member's app
// role; the platform's Settings items, which link to the gateway's pages on the apex; which item an address opens; and
// the collapsed or expanded state of each level, remembered in this browser (localStorage `insulin-nav`).
import packageJson from '../../../package.json' with { type: 'json' }

/** The app's name on the platform: its directory, its host (esign.insulinapps.com) and its settings pages' path. */
export const APP_NAME = 'esign'

/** The Lucide icons a manifest item may name: the ones the gateway bundles. */
export const ICON_NAMES = [
  'layout-dashboard', 'home', 'table', 'layers', 'chart-pie', 'shield', 'heart', 'users', 'building', 'file-text', 'award',
  'inbox', 'files', 'file-pen', 'signature', 'send', 'clock', 'check-circle', 'archive', 'settings', 'book-open', 'plug',
  'key', 'bot', 'folder', 'list', 'calendar', 'bell', 'search',
] as const
export type IconName = (typeof ICON_NAMES)[number]

export type AppRole = 'ADMIN' | 'EDITOR' | 'VIEWER'
export type NavChild = { key: string; label: string; icon: IconName; path: string; group?: string; role?: AppRole }
export type NavItem = NavChild & { children?: NavChild[] }

const ROLES: readonly AppRole[] = ['VIEWER', 'EDITOR', 'ADMIN']
const KEY = /^[a-z0-9-]+$/
const MAX_ITEMS = 12
// The gateway's paths on an app host: never forwarded to the app, so never an item's path.
const RESERVED = [/^\/__insulin(\/|$)/, /^\/settings(\/|$)/, /^\/mcp(\/|$)/, /^\/\.well-known(\/|$)/]

/**
 * Why a navigation manifest is refused, one line per problem; empty when it is valid. The rules are DESIGN.md §3.2's,
 * which the deploy's list-apps.mjs applies too: a unique `key` of [a-z0-9-]; a `label` of 1 to 40 characters; an
 * `icon` the gateway bundles; a `path` on the app's host outside the gateway's paths; optional `group` and `role`; at
 * most 12 items with at most 12 `children` each, and children have no children.
 */
export function navigationProblems(raw: unknown): string[] {
  const problems: string[] = []
  const keys = new Set<string>()
  const check = (entry: unknown, where: string, child: boolean) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) { problems.push(`${where} is not an object`); return }
    const item = entry as Record<string, unknown>
    const allowed = ['key', 'label', 'icon', 'path', 'group', 'role', ...(child ? [] : ['children'])]
    for (const name of Object.keys(item)) if (!allowed.includes(name)) problems.push(`${where} has an unknown field "${name}"`)
    if (typeof item.key !== 'string' || !KEY.test(item.key)) problems.push(`${where}.key must match [a-z0-9-]+`)
    else if (keys.has(item.key)) problems.push(`${where}.key "${item.key}" is used twice`)
    else keys.add(item.key)
    if (typeof item.label !== 'string' || item.label.trim().length === 0 || item.label.length > 40) problems.push(`${where}.label must be 1 to 40 characters`)
    if (typeof item.icon !== 'string' || !(ICON_NAMES as readonly string[]).includes(item.icon)) problems.push(`${where}.icon must be one of the bundled Lucide icons`)
    if (typeof item.path !== 'string' || !item.path.startsWith('/') || item.path.startsWith('//') || /\s|\.\.|#/.test(item.path)) problems.push(`${where}.path must be a path on the app's host`)
    else if (RESERVED.some((pattern) => pattern.test(item.path as string))) problems.push(`${where}.path is one of the gateway's paths`)
    if (item.group !== undefined && (typeof item.group !== 'string' || item.group.trim().length === 0 || item.group.length > 40)) problems.push(`${where}.group must be 1 to 40 characters`)
    if (item.role !== undefined && !(ROLES as readonly unknown[]).includes(item.role)) problems.push(`${where}.role must be VIEWER, EDITOR or ADMIN`)
    if (item.children !== undefined) {
      if (!Array.isArray(item.children) || item.children.length > MAX_ITEMS) problems.push(`${where}.children must be an array of at most ${MAX_ITEMS}`)
      else item.children.forEach((nested, index) => check(nested, `${where}.children[${index}]`, true))
    }
  }
  if (!Array.isArray(raw) || raw.length > MAX_ITEMS) return [`navigation must be an array of at most ${MAX_ITEMS}`]
  raw.forEach((entry, index) => check(entry, `navigation[${index}]`, false))
  return problems
}

/** The app's level 1, as package.json declares it (test/navigation.test.ts checks it with navigationProblems). */
export const NAVIGATION: readonly NavItem[] = (packageJson as { insulin: { navigation: NavItem[] } }).insulin.navigation

/** The member's app role as the navigation ranks it: the console's OWNER counts as ADMIN, USER and anything unknown as VIEWER. */
export function appRole(role: string | undefined | null): AppRole {
  if (role === 'OWNER' || role === 'ADMIN') return 'ADMIN'
  if (role === 'EDITOR') return 'EDITOR'
  return 'VIEWER'
}

const sees = (role: AppRole, item: NavChild) => ROLES.indexOf(role) >= ROLES.indexOf(item.role ?? 'VIEWER')

/** The items, and their children, a role sees: each item's `role` is the least app role that sees it. */
export function visibleNavigation(items: readonly NavItem[], role: AppRole): NavItem[] {
  return items.filter((item) => sees(role, item)).map((item) => item.children ? { ...item, children: item.children.filter((child) => sees(role, child)) } : item)
}

/** Items in runs that share a heading: consecutive items with the same `group`, or with none (no heading). */
export function grouped<T extends { group?: string }>(items: readonly T[]): { heading: string | undefined; items: T[] }[] {
  const runs: { heading: string | undefined; items: T[] }[] = []
  for (const item of items) {
    const last = runs.at(-1)
    if (last && last.heading === item.group) last.items.push(item)
    else runs.push({ heading: item.group, items: [item] })
  }
  return runs
}

// Where an address is: its path without a trailing slash ("/" is the Envelopes list) and its query.
function place(pathname: string, search: string): { path: string; query: URLSearchParams } {
  const path = pathname.replace(/\/+$/, '') || '/envelopes'
  return { path, query: new URLSearchParams(search) }
}

/** Whether the address is exactly the item's page: the same path and the same query, in any order. */
export function isAt(itemPath: string, pathname: string, search: string): boolean {
  const [path, query = ''] = itemPath.split('?')
  const here = place(pathname, search)
  const want = place(path!, query)
  if (here.path !== want.path) return false
  const sorted = (q: URLSearchParams) => [...q.entries()].map(([k, v]) => `${k}=${v}`).sort().join('&')
  return sorted(here.query) === sorted(want.query)
}

/** Whether the address is within the item's section: its path or a page under it. */
export function isWithin(itemPath: string, pathname: string): boolean {
  const path = place(itemPath.split('?')[0]!, '').path
  const here = place(pathname, '').path
  return here === path || here.startsWith(`${path}/`)
}

/** Each level's state, as localStorage `insulin-nav` keeps it: `{"l1":"collapsed"|"expanded","l2":…}`. */
export type NavState = { l1: 'collapsed' | 'expanded'; l2: 'collapsed' | 'expanded' }
export const NAV_STORAGE_KEY = 'insulin-nav'
export const EXPANDED: NavState = { l1: 'expanded', l2: 'expanded' }

type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void }

/** The remembered state, or both levels expanded when there is none, it is malformed or storage is unavailable. */
export function readNavState(storage: Storage | undefined | null): NavState {
  try {
    const stored = JSON.parse(storage?.getItem(NAV_STORAGE_KEY) ?? 'null') as Partial<Record<keyof NavState, unknown>> | null
    const level = (value: unknown) => value === 'collapsed' ? 'collapsed' : 'expanded'
    return stored && typeof stored === 'object' ? { l1: level(stored.l1), l2: level(stored.l2) } : EXPANDED
  } catch { return EXPANDED }
}

/** Remembers the state; a browser that refuses storage keeps it for this page only. */
export function writeNavState(storage: Storage | undefined | null, state: NavState): void {
  try { storage?.setItem(NAV_STORAGE_KEY, JSON.stringify({ l1: state.l1, l2: state.l2 })) } catch { /* private mode or storage full */ }
}

/** Who the platform says is signed in, at /__insulin/me on the app's host (the gateway answers it; see bar-js.ts). */
export type PlatformOrganization = { id: string; name: string; role?: string; roleLabel?: string; active?: boolean }
export type PlatformMe = {
  user: { name?: string | null; email?: string | null }
  organization: PlatformOrganization | null
  organizations: PlatformOrganization[]
  links?: { account?: string | null; apps?: string | null; organizations?: string | null; members?: string | null }
  apex?: string | null
}

/** An http(s) address as a URL, or null for anything else (a javascript: link from a confused proxy, say). */
export function httpUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || !value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null
  } catch { return null }
}

/** The apex's origin (https://insulinapps.com), from /__insulin/me: its `apex`, else the origin of its apex links. */
export function apexOrigin(me: PlatformMe | null): string | null {
  if (!me) return null
  for (const value of [me.apex, me.links?.apps, me.links?.organizations, me.links?.account]) {
    const url = httpUrl(value)
    if (url) return url.origin
  }
  return null
}

/** Settings' level 2: the gateway's pages for this app on the apex (DESIGN.md §3). */
export const SETTINGS_ITEMS = [
  { key: 'users', label: 'People', icon: 'users' },
  { key: 'integrations', label: 'Integrations', icon: 'plug' },
  { key: 'api', label: 'API access', icon: 'key' },
  { key: 'connect-ai', label: 'Connect AI', icon: 'bot' },
] as const satisfies readonly { key: string; label: string; icon: IconName }[]

/**
 * Where each Settings item links: `https://<apex>/apps/esign/settings/<page>`. Before the apex is known (or where the
 * gateway doesn't answer /__insulin/me), the same path on the app's host, which the gateway redirects to the apex.
 */
export function settingsLinks(apex: string | null): { key: string; label: string; icon: IconName; href: string }[] {
  return SETTINGS_ITEMS.map((item) => ({ ...item, href: `${apex ?? ''}${apex ? `/apps/${APP_NAME}` : ''}/settings/${item.key}` }))
}

/** Up to two initials: the first letters of the first two words of the name, else the address's first letter. */
export function initials(name: string | null | undefined, email?: string | null): string {
  const words = String(name ?? '').trim().split(/\s+/).filter(Boolean)
  const source = words.length ? words.slice(0, 2) : [String(email ?? '')]
  return source.map((word) => Array.from(word)[0] ?? '').join('').toLocaleUpperCase('en')
}
