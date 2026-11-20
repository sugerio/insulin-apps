// What the navigation shows, as data (App.tsx draws it): the sections of the navigation manifest (package.json
// `insulin.navigation`, DESIGN.md §3.2, which the gateway renders level 1 from too), filtered by the person's role in
// Knowledge, then Docs and Settings. Settings' pages live on insulinapps.com; the same paths on the app's host redirect
// there. Level 2 under Collections lists the person's collections, which the app draws itself.
import packageJson from '../../package.json' with { type: 'json' }

export type AppRole = 'ADMIN' | 'EDITOR' | 'VIEWER'
export interface NavItem {
  key: string
  label: string
  icon: string
  path: string
  group?: string
  role?: AppRole
  maxRole?: AppRole
}

const RANK: Record<AppRole, number> = { VIEWER: 0, EDITOR: 1, ADMIN: 2 }

export const NAVIGATION = (packageJson as { insulin: { navigation: NavItem[] } }).insulin.navigation

/** The manifest's items a role sees: at or above each item's `role`, and at or below its `maxRole`. */
export function visibleItems(role: AppRole): NavItem[] {
  return NAVIGATION.filter((item) => RANK[role] >= RANK[item.role ?? 'VIEWER'] && RANK[role] <= RANK[item.maxRole ?? 'ADMIN'])
}

/** The platform's pages, on insulinapps.com (the app's host redirects these paths there). */
export const SETTINGS_LINKS = [
  { key: 'people', label: 'People', path: '/settings/users' },
  { key: 'integrations', label: 'Integrations', path: '/settings/integrations' },
  { key: 'api', label: 'API access', path: '/settings/api' },
  { key: 'connect-ai', label: 'Connect AI', path: '/settings/connect-ai' },
] as const

/** The item an address belongs to: the longest matching path, Home only for `/` itself. */
export function activeKey(pathname: string, items: NavItem[]): string | null {
  const matches = items.filter((item) => (item.path === '/' ? pathname === '/' : pathname === item.path || pathname.startsWith(`${item.path}/`)))
  return matches.sort((a, b) => b.path.length - a.path.length)[0]?.key ?? (pathname.startsWith('/docs') ? 'docs' : null)
}

/** Items in order, under headings: consecutive items with the same `group` share one; an item without one has none. */
export function groupNavigation<T extends NavItem>(items: readonly T[]): { heading: string | null; items: T[] }[] {
  const groups: { heading: string | null; items: T[] }[] = []
  for (const item of items) {
    const heading = item.group ?? null
    const last = groups.at(-1)
    if (last && last.heading === heading) last.items.push(item)
    else groups.push({ heading, items: [item] })
  }
  return groups
}

// Each level's collapse, remembered in this browser as every Insulin app does (`insulin-nav`).

export type NavState = 'collapsed' | 'expanded'
export interface NavCollapse {
  l1: NavState
  l2: NavState
}
export const NAV_STORAGE_KEY = 'insulin-nav'
const EXPANDED: NavCollapse = { l1: 'expanded', l2: 'expanded' }
const isState = (value: unknown): value is NavState => value === 'collapsed' || value === 'expanded'

export function readNavCollapse(): NavCollapse {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(NAV_STORAGE_KEY) ?? 'null')
    if (!stored || typeof stored !== 'object') return EXPANDED
    const { l1, l2 } = stored as Record<string, unknown>
    return { l1: isState(l1) ? l1 : 'expanded', l2: isState(l2) ? l2 : 'expanded' }
  } catch {
    return EXPANDED
  }
}

export function writeNavCollapse(value: NavCollapse): void {
  try {
    window.localStorage.setItem(NAV_STORAGE_KEY, JSON.stringify({ l1: value.l1, l2: value.l2 }))
  } catch {
    // Storage can be off (a private window): the choice then lasts until the page is reloaded.
  }
}
