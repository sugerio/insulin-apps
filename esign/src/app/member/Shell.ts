// The members' navigation (DESIGN.md §3.2): two columns, each collapsible, beside the page.
//
// - Level 1 ("Primary"): the organization switcher (from /__insulin/me, switching through /__insulin/switch-org, as the
//   gateway's account bar does), Esign's sections from package.json `insulin.navigation` for the member's role, then the
//   platform's Docs and Settings, and the person at the bottom with Account and Sign out.
// - Level 2 ("Section"): the open section's items: an Envelopes view, a Docs topic, or Settings' People, Integrations,
//   API access and Connect AI, which are the gateway's pages on the apex (`https://<apex>/apps/esign/settings/...`).
// - The page's header carries the breadcrumb (section › page).
//
// Each level collapses to its icons (a collapsed item's label is its `title` and `aria-label`), remembered in
// localStorage `insulin-nav`. Below 768px a top bar holds the switcher and a menu button, which opens both levels
// stacked in a drawer. The root carries `data-insulin-shell`, so the gateway's floating account bar stays out of the way.
// The platform's controls (switching, signing out) appear only where the gateway answers /__insulin/me; they navigate
// with location.assign, which the app does only there, never in the console's sandboxed preview.
import React, { useEffect, useRef, useState } from 'react'
import {
  Archive, Award, Bell, BookOpen, Bot, Building, Calendar, ChartPie, CheckCircle, ChevronRight, ChevronsUpDown, Clock,
  FilePen, FileText, Files, Folder, Heart, Home, Inbox, Key, Layers, LayoutDashboard, LayoutGrid, List, LogOut, Menu, PanelLeftClose,
  PanelLeftOpen, Plug, Plus, Search, Send, Settings, Shield, Signature, Table, UserRound, Users, X, type LucideIcon,
} from 'lucide-react'
import { sidebarGroupLabel, sidebarIconButton, sidebarMenuButton } from '../components/ui/sidebar.ts'
import { docsNavigation } from '../components/Docs.ts'
import { cn } from '../lib/utils.ts'
import { Link } from './router.ts'
import {
  APP_NAME, apexOrigin, grouped, httpUrl, initials, isAt, isWithin, NAVIGATION, navigationRole, readNavState, settingsLinks, visibleNavigation,
  writeNavState, type IconName, type NavState, type PlatformMe,
} from './navigation.ts'

const h = React.createElement

export const ICONS: Record<IconName, LucideIcon> = {
  'layout-dashboard': LayoutDashboard, home: Home, table: Table, layers: Layers, 'chart-pie': ChartPie, shield: Shield,
  heart: Heart, users: Users, building: Building, 'file-text': FileText, award: Award, inbox: Inbox, files: Files,
  'file-pen': FilePen, signature: Signature, send: Send, clock: Clock, 'check-circle': CheckCircle, archive: Archive,
  settings: Settings, 'book-open': BookOpen, plug: Plug, key: Key, bot: Bot, folder: Folder, list: List, calendar: Calendar,
  bell: Bell, search: Search,
}

/** One entry of a column: an in-app page (`to`), a page elsewhere (`href`), or a button that opens a section. */
type Entry = {
  key: string
  label: string
  icon: IconName
  group?: string
  to?: string
  href?: string
  onSelect?: () => void
  active: boolean
  current?: 'page' | 'true'
  expanded?: boolean
  /** Listed, but there is nowhere to go (Settings where the gateway doesn't answer). */
  disabled?: boolean
}

type Level2 = { key: string; label: string; entries: Entry[] }

export type ShellProps = {
  pathname: string
  search: string
  /** The member's app role from /api/me (undefined until it answers, or for someone not signed in). */
  role?: string
  /** Its effective permissions from /api/me: a custom role's narrow what the role shows. */
  permissions?: readonly string[]
  /** The member from /api/me, shown at the bottom where /__insulin/me isn't answered (the local preview). */
  user?: { name: string | null; email: string | null } | null
  roleLabel?: string
  /** The page's own name: the breadcrumb's last part. */
  title: string
  children?: React.ReactNode
}

const PLATFORM_ITEMS = { docs: { key: 'docs', label: 'Docs', icon: 'book-open', path: '/docs' }, settings: { key: 'settings', label: 'Settings', icon: 'settings' } } as const

const storage = () => { try { return typeof window === 'undefined' ? null : window.localStorage } catch { return null } }

/** /__insulin/me: who the gateway says is signed in, or null where it isn't answered (the console, the local preview). */
export async function loadPlatformMe(): Promise<PlatformMe | null> {
  try {
    const response = await fetch('/__insulin/me', { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } })
    if (!response.ok || !/\bjson\b/i.test(response.headers.get('content-type') ?? '')) return null
    const data = await response.json() as PlatformMe
    return data && typeof data === 'object' && data.user && Array.isArray(data.organizations) ? data : null
  } catch { return null }
}

// A POST to the gateway's /__insulin/* with a real Origin header whatever the page's referrer policy (as bar-js.ts does).
const postPlatform = (path: string, body: Record<string, string>, json: boolean) => fetch(path, {
  method: 'POST',
  credentials: 'same-origin',
  referrerPolicy: 'strict-origin',
  headers: { Accept: 'application/json', 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded' },
  body: json ? JSON.stringify(body) : new URLSearchParams(body).toString(),
})

const assign = (url: string) => { try { window.location.assign(url) } catch { /* not a real window */ } }

export function Shell({ pathname, search, role, permissions, user, roleLabel, title, children }: ShellProps) {
  const [nav, setNav] = useState<NavState>(() => readNavState(storage()))
  const [platform, setPlatform] = useState<PlatformMe | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [menu, setMenu] = useState<string | null>(null)
  const menuButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    let live = true
    void loadPlatformMe().then((me) => { if (live) setPlatform(me) })
    return () => { live = false }
  }, [])
  // Moving to another page closes what was opened on this one.
  useEffect(() => { setSettingsOpen(false); setDrawerOpen(false); setMenu(null) }, [pathname, search])

  const toggle = (level: keyof NavState) => setNav((state) => {
    const next = { ...state, [level]: state[level] === 'collapsed' ? 'expanded' : 'collapsed' } as NavState
    writeNavState(storage(), next)
    return next
  })

  // Level 1: the sections the role and its permissions reach, then Docs and Settings.
  const reach = navigationRole(role, permissions)
  const sections = reach ? visibleNavigation(NAVIGATION, reach) : []
  const routeSection = sections.find((item) => isWithin(item.path, pathname)) ?? (isWithin('/docs', pathname) ? PLATFORM_ITEMS.docs : null)
  const docSlug = pathname.replace(/\/+$/, '').split('/')[2] ?? 'getting-started'
  const apex = apexOrigin(platform)
  const routeChildren: Entry[] = routeSection?.key === 'docs'
    ? [
        ...docsNavigation().map((item) => ({ ...item, to: item.path, active: item.key === docSlug })),
        // Esign's public docs, where the gateway says where the apex is.
        ...apex ? [{ key: 'public-docs', label: 'Public docs', icon: 'book-open' as const, group: 'On the web', href: `${apex}/docs/${APP_NAME}/`, active: false }] : [],
      ]
    : (sections.find((item) => item.key === routeSection?.key)?.children ?? []).map((item) => ({ ...item, to: item.path, active: isAt(item.path, pathname, search) }))
  const childIsPage = routeChildren.some((entry) => entry.active)
  for (const entry of routeChildren) if (entry.active) entry.current = 'page'

  const sectionEntry = (item: { key: string; label: string; icon: IconName; path: string; group?: string }): Entry => {
    const here = item.key === routeSection?.key
    return { ...item, to: item.path, active: here && !settingsOpen, current: here ? (childIsPage ? 'true' : 'page') : undefined }
  }
  const primary: Entry[] = sections.map(sectionEntry)
  const platformEntries: Entry[] = [
    sectionEntry(PLATFORM_ITEMS.docs),
    { ...PLATFORM_ITEMS.settings, active: settingsOpen, expanded: settingsOpen, onSelect: () => { setSettingsOpen((open) => !open); setMenu(null) } },
  ]

  // Level 2: Settings while it is open, else the page's section when it has items.
  const level2: Level2 | null = settingsOpen
    ? { key: 'settings', label: 'Settings', entries: settingsLinks(platform).map(({ href, ...item }) => ({ ...item, href: href ?? undefined, disabled: !href, active: false })) }
    : routeSection && routeChildren.length ? { key: routeSection.key, label: routeSection.label, entries: routeChildren } : null

  const crumbs: { label: string; to?: string }[] = routeSection && routeSection.label !== title ? [{ label: routeSection.label, to: routeSection.path }, { label: title }] : [{ label: title }]
  const person = platform?.user ?? user ?? null

  return h('div', {
    'data-insulin-shell': '',
    className: 'flex min-h-svh flex-col bg-background text-foreground md:flex-row',
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key !== 'Escape' || !drawerOpen) return
      setDrawerOpen(false)
      menuButton.current?.focus?.()
    },
  },
    // Narrow screens: the switcher and the menu button.
    h('div', { className: 'sticky top-0 z-50 flex h-14 shrink-0 items-center gap-2 border-b border-sidebar-border bg-sidebar px-2 text-sidebar-foreground md:hidden' },
      h('div', { className: 'min-w-0 flex-1' }, h(OrgSwitcher, { id: 'insulin-org-mobile', platform, apex, collapsed: false, open: menu === 'org-mobile', setOpen: (open: boolean) => setMenu(open ? 'org-mobile' : null) })),
      h('button', {
        ref: menuButton, type: 'button', className: sidebarIconButton, 'aria-expanded': drawerOpen, 'aria-controls': 'insulin-nav',
        'aria-label': drawerOpen ? 'Close menu' : 'Open menu', title: drawerOpen ? 'Close menu' : 'Open menu',
        onClick: () => { setDrawerOpen((open) => !open); setMenu(null) },
      }, h(drawerOpen ? X : Menu, { 'aria-hidden': true }))),
    // Both levels: columns from 768px up, a drawer below.
    h('div', {
      id: 'insulin-nav', 'data-open': drawerOpen ? 'true' : 'false',
      className: cn('md:sticky md:top-0 md:flex md:h-svh md:shrink-0', drawerOpen ? 'flex flex-col max-md:fixed max-md:inset-x-0 max-md:top-14 max-md:bottom-0 max-md:z-40 max-md:overflow-y-auto max-md:bg-sidebar md:flex-row' : 'hidden'),
    },
      h('aside', {
        id: 'insulin-nav-l1', 'data-state': nav.l1,
        className: cn('flex shrink-0 flex-col bg-sidebar text-sidebar-foreground md:h-svh md:border-r md:border-sidebar-border', nav.l1 === 'collapsed' ? 'md:w-14' : 'md:w-60'),
      },
        h('div', { className: cn('hidden h-14 shrink-0 items-center px-2 md:flex', nav.l1 === 'collapsed' && 'md:px-3') },
          h(OrgSwitcher, { id: 'insulin-org', platform, apex, collapsed: nav.l1 === 'collapsed', open: menu === 'org', setOpen: (open: boolean) => setMenu(open ? 'org' : null) })),
        h('nav', { 'aria-label': 'Primary', className: cn('flex flex-1 flex-col gap-2 overflow-y-auto p-2', nav.l1 === 'collapsed' && 'md:px-3') },
          ...grouped(primary).map((run, index) => h(EntryGroup, { key: `l1-${index}`, id: `insulin-l1-group-${index}`, heading: run.heading, entries: run.items, collapsed: nav.l1 === 'collapsed' })),
          h('div', { className: 'mt-auto' }, h(EntryGroup, { id: 'insulin-l1-platform', entries: platformEntries, collapsed: nav.l1 === 'collapsed', controls: 'insulin-nav-l2' }))),
        h('div', { className: cn('flex shrink-0 items-center gap-1 border-t border-sidebar-border p-2', nav.l1 === 'collapsed' && 'md:flex-col-reverse md:px-3') },
          h('div', { className: 'min-w-0 flex-1' }, person ? h(Person, { platform, person, roleLabel, collapsed: nav.l1 === 'collapsed', open: menu === 'person', setOpen: (open: boolean) => setMenu(open ? 'person' : null) }) : null),
          h(CollapseToggle, { level: 'l1', collapsed: nav.l1 === 'collapsed', onToggle: () => toggle('l1') }))),
      h('aside', {
        id: 'insulin-nav-l2', hidden: !level2, 'data-state': nav.l2,
        className: cn('flex shrink-0 flex-col border-sidebar-border bg-sidebar text-sidebar-foreground max-md:border-t md:h-svh md:border-r', nav.l2 === 'collapsed' ? 'md:w-14' : 'md:w-56', !level2 && 'hidden'),
      },
        level2 ? [
          h('div', { key: 'header', className: cn('flex h-14 shrink-0 items-center gap-2 px-2', nav.l2 === 'collapsed' && 'md:justify-center md:px-3') },
            h('h2', { id: 'insulin-nav-l2-title', className: cn('min-w-0 flex-1 truncate px-2 text-sm font-semibold', nav.l2 === 'collapsed' && 'md:sr-only') }, level2.label),
            h(CollapseToggle, { level: 'l2', collapsed: nav.l2 === 'collapsed', onToggle: () => toggle('l2') })),
          h('nav', { key: 'nav', 'aria-label': 'Section', 'aria-describedby': 'insulin-nav-l2-title', className: cn('flex flex-1 flex-col gap-2 overflow-y-auto p-2 pt-0', nav.l2 === 'collapsed' && 'md:px-3') },
            ...grouped(level2.entries).map((run, index) => h(EntryGroup, { key: `l2-${level2.key}-${index}`, id: `insulin-l2-group-${index}`, heading: run.heading, entries: run.items, collapsed: nav.l2 === 'collapsed', wrap: true }))),
        ] : null)),
    h('div', { className: 'flex min-w-0 flex-1 flex-col' },
      h('header', { className: 'flex h-14 shrink-0 items-center border-b px-4 sm:px-6' }, h(Breadcrumb, { crumbs })),
      h('main', { className: 'mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6' }, children)))
}

/** A run of entries under an optional heading; a collapsed column keeps the heading for screen readers only. */
function EntryGroup({ id, heading, entries, collapsed, controls, wrap = false }: { id: string; heading?: string; entries: Entry[]; collapsed: boolean; controls?: string; wrap?: boolean }) {
  return h('div', { className: 'flex flex-col gap-1' },
    heading ? h('p', { id, className: cn(sidebarGroupLabel, collapsed && 'md:sr-only') }, heading) : null,
    h('ul', { className: cn('flex flex-col gap-1', collapsed && 'md:items-center'), 'aria-labelledby': heading ? id : undefined },
      ...entries.map((entry) => h('li', { key: entry.key }, h(EntryControl, { entry, collapsed, controls, wrap })))))
}

function EntryControl({ entry, collapsed, controls, wrap }: { entry: Entry; collapsed: boolean; controls?: string; wrap: boolean }) {
  const Icon = ICONS[entry.icon]
  const props = {
    className: sidebarMenuButton({ collapsed, wrap }),
    'data-active': entry.active ? 'true' : 'false',
    title: collapsed ? entry.label : undefined,
    'aria-label': collapsed ? entry.label : undefined,
  }
  const content = [h(Icon, { key: 'icon', 'aria-hidden': true }), h('span', { key: 'label', className: cn(collapsed && 'md:sr-only') }, entry.label)]
  if (entry.onSelect) return h('button', { ...props, type: 'button', 'aria-expanded': entry.expanded ?? false, 'aria-controls': controls, onClick: entry.onSelect }, ...content)
  if (entry.disabled) return h('span', { ...props, className: cn(props.className, 'pointer-events-none opacity-50'), 'aria-disabled': 'true' }, ...content)
  if (entry.href) return h('a', { ...props, href: entry.href }, ...content)
  return h(Link, { ...props, to: entry.to ?? '/', 'aria-current': entry.current }, ...content)
}

function CollapseToggle({ level, collapsed, onToggle }: { level: 'l1' | 'l2'; collapsed: boolean; onToggle: () => void }) {
  const label = `${collapsed ? 'Expand' : 'Collapse'} ${level === 'l1' ? 'navigation' : 'section'}`
  return h('button', {
    type: 'button', className: cn(sidebarIconButton, 'max-md:hidden'), onClick: onToggle,
    'aria-expanded': !collapsed, 'aria-controls': `insulin-nav-${level}`, 'aria-label': label, title: label,
  }, h(collapsed ? PanelLeftOpen : PanelLeftClose, { 'aria-hidden': true }))
}

/** A square with an initial, or an icon: the organization's mark (and the person's avatar, round). */
function Tile({ children, round = false }: { children?: React.ReactNode; round?: boolean }) {
  return h('span', { 'aria-hidden': true, className: cn('flex size-8 shrink-0 items-center justify-center bg-sidebar-primary text-xs font-semibold text-sidebar-primary-foreground [&>svg]:size-4', round ? 'rounded-full' : 'rounded-md') }, children)
}

/**
 * The organization switcher: the organization's mark (its initial), its name and a chevron, opening the person's
 * organizations and the link to create one. Where the gateway doesn't answer /__insulin/me, the app's own name.
 */
const menuLink = 'flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring [&>svg]:size-4'

function OrgSwitcher({ id, platform, apex, collapsed, open, setOpen }: { id: string; platform: PlatformMe | null; apex: string | null; collapsed: boolean; open: boolean; setOpen: (open: boolean) => void }) {
  const [status, setStatus] = useState('')
  const button = useRef<HTMLButtonElement>(null)
  const panel = useClickOutside(open, () => setOpen(false))
  const onKeyDown = closeOnEscape(open, setOpen, button)
  const org = platform?.organization ?? null
  if (!platform || !org) {
    return h(Link, { to: '/', className: sidebarMenuButton({ size: 'lg', collapsed }), title: collapsed ? 'Esign' : undefined, 'aria-label': collapsed ? 'Esign' : undefined },
      h(Tile, null, h(Signature, { 'aria-hidden': true })),
      h('span', { className: cn('font-semibold', collapsed && 'md:sr-only') }, 'Esign'))
  }
  const name = org.name || 'Organization'
  const switchTo = async (orgId: string) => {
    setStatus('Switching…')
    try {
      const response = await postPlatform('/__insulin/switch-org', { orgId }, true)
      if (!response.ok) throw new Error('switch failed')
      assign('/')
    } catch { setStatus('Couldn’t switch organization. Please try again.') }
  }
  const create = apex ? `${apex}/orgs/new` : null
  const apps = httpUrl(platform.links?.apps)?.href ?? null
  return h('div', { ref: panel, className: 'relative w-full', onKeyDown },
    h('button', {
      ref: button, type: 'button', className: sidebarMenuButton({ size: 'lg', collapsed }),
      'aria-expanded': open, 'aria-controls': `${id}-menu`, title: collapsed ? `Organization: ${name}` : undefined,
      'aria-label': collapsed ? `Organization: ${name}` : undefined, onClick: () => setOpen(!open),
    },
      h(Tile, null, initials(name)),
      h('span', { className: cn('flex min-w-0 flex-1 flex-col leading-tight', collapsed && 'md:sr-only') },
        h('span', { className: 'sr-only' }, 'Organization: '),
        h('span', { className: 'truncate font-semibold' }, name),
        org.roleLabel ? h('span', { className: 'truncate text-xs text-sidebar-foreground/70' }, org.roleLabel) : null),
      h(ChevronsUpDown, { 'aria-hidden': true, className: cn('ml-auto', collapsed && 'md:hidden') })),
    h('div', {
      id: `${id}-menu`, hidden: !open, role: 'group', 'aria-label': 'Organizations',
      className: cn('absolute top-full left-0 z-50 mt-1 w-64 rounded-md border bg-popover p-1 text-popover-foreground shadow-md', !open && 'hidden'),
    },
      h('p', { className: 'px-2 py-1.5 text-xs font-medium text-muted-foreground' }, 'Organizations'),
      h('ul', { className: 'flex flex-col' }, ...platform.organizations.map((item) => h('li', { key: item.id },
        h('button', {
          type: 'button', 'aria-current': item.active ? 'true' : undefined, disabled: !!item.active,
          className: 'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-hidden hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-100 aria-[current=true]:font-medium',
          onClick: () => void switchTo(item.id),
        }, h('span', { className: 'min-w-0 flex-1 truncate' }, item.name), item.roleLabel ? h('span', { className: 'text-xs text-muted-foreground' }, item.roleLabel) : null)))),
      apps || create ? h('div', { className: 'mt-1 border-t pt-1' },
        apps ? h('a', { href: apps, className: menuLink }, h(LayoutGrid, { 'aria-hidden': true }), 'All apps') : null,
        create ? h('a', { href: create, className: menuLink }, h(Plus, { 'aria-hidden': true }), 'Create an organization') : null) : null,
      h('p', { role: 'status', className: cn('px-2 text-xs text-muted-foreground', status && 'py-1.5') }, status)))
}

/** The person: initials and name, opening Account and Sign out where the gateway answers /__insulin/me. */
function Person({ platform, person, roleLabel, collapsed, open, setOpen }: { platform: PlatformMe | null; person: { name?: string | null; email?: string | null }; roleLabel?: string; collapsed: boolean; open: boolean; setOpen: (open: boolean) => void }) {
  const [status, setStatus] = useState('')
  const button = useRef<HTMLButtonElement>(null)
  const panel = useClickOutside(open, () => setOpen(false))
  const onKeyDown = closeOnEscape(open, setOpen, button)
  const name = person.name || person.email || 'Signed in'
  const label = collapsed ? `${name}${roleLabel ? ` (${roleLabel})` : ''}` : undefined
  const face = [
    h(Tile, { key: 'face', round: true }, initials(person.name, person.email) || h(UserRound, { 'aria-hidden': true })),
    h('span', { key: 'text', className: cn('flex min-w-0 flex-1 flex-col text-left leading-tight', collapsed && 'md:sr-only') },
      h('span', { className: 'truncate font-medium' }, name),
      roleLabel ? h('span', { className: 'truncate text-xs text-sidebar-foreground/70' }, roleLabel) : null),
  ]
  if (!platform) return h('div', { className: sidebarMenuButton({ size: 'lg', collapsed }), title: label }, ...face)
  const account = httpUrl(platform.links?.account)?.href ?? null
  const signOut = async () => {
    setStatus('Signing out…')
    try {
      const response = await postPlatform('/__insulin/logout', {}, false)
      const data = response.ok ? await response.json() as { next?: string } : null
      assign(httpUrl(data?.next)?.href ?? '/')
    } catch { setStatus('Couldn’t sign out. Please try again.') }
  }
  return h('div', { ref: panel, className: 'relative w-full', onKeyDown },
    h('button', { ref: button, type: 'button', className: sidebarMenuButton({ size: 'lg', collapsed }), 'aria-expanded': open, 'aria-controls': 'insulin-person-menu', title: label, 'aria-label': label, onClick: () => setOpen(!open) }, ...face),
    h('div', {
      id: 'insulin-person-menu', hidden: !open, role: 'group', 'aria-label': 'Account',
      className: cn('absolute bottom-full left-0 z-50 mb-1 w-60 rounded-md border bg-popover p-1 text-popover-foreground shadow-md', !open && 'hidden'),
    },
      person.email ? h('p', { className: 'truncate px-2 py-1.5 text-xs text-muted-foreground' }, person.email) : null,
      account ? h('a', { href: account, className: 'flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring [&>svg]:size-4' }, h(UserRound, { 'aria-hidden': true }), 'Account') : null,
      h('button', { type: 'button', onClick: () => void signOut(), className: 'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-hidden hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring [&>svg]:size-4' }, h(LogOut, { 'aria-hidden': true }), 'Sign out'),
      h('p', { role: 'status', className: cn('px-2 text-xs text-muted-foreground', status && 'py-1.5') }, status)))
}

/** The page header's breadcrumb: the section (a link) › the page. */
function Breadcrumb({ crumbs }: { crumbs: { label: string; to?: string }[] }) {
  return h('nav', { 'aria-label': 'Breadcrumb', className: 'min-w-0' },
    h('ol', { className: 'flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground' },
      ...crumbs.flatMap((crumb, index) => {
        const last = index === crumbs.length - 1
        const part = h('li', { key: `crumb-${index}`, className: 'min-w-0 truncate' }, last
          ? h('span', { 'aria-current': 'page', className: 'font-medium text-foreground' }, crumb.label)
          : h(Link, { to: crumb.to ?? '/', className: 'rounded-sm outline-hidden transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring' }, crumb.label))
        return index === 0 ? [part] : [h('li', { key: `sep-${index}`, role: 'presentation', 'aria-hidden': true, className: '[&>svg]:size-3.5' }, h(ChevronRight)), part]
      })))
}

/** A popover's key handler: Escape closes it and returns the focus to its button. */
function closeOnEscape(open: boolean, setOpen: (open: boolean) => void, button: React.RefObject<HTMLButtonElement | null>) {
  return (event: React.KeyboardEvent) => {
    if (event.key !== 'Escape' || !open) return
    event.stopPropagation()
    setOpen(false)
    button.current?.focus?.()
  }
}

/** A ref for a popover: a press outside it closes it (where there is a document). */
function useClickOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open || typeof document === 'undefined' || typeof document.addEventListener !== 'function') return
    const onPointer = (event: Event) => {
      const node = ref.current
      if (node && typeof node.contains === 'function' && !node.contains(event.target as Node)) close()
    }
    document.addEventListener('pointerdown', onPointer)
    return () => document.removeEventListener('pointerdown', onPointer)
  }, [open])
  return ref
}
