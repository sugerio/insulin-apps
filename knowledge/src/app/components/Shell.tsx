import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router'
import {
  BookOpen, Bot, Check, ChevronsUpDown, FileText, KeyRound, LayoutGrid, LogOut, Menu, PanelLeftClose, PanelLeftOpen, Plug, Plus, Settings,
  SunMoon, UserRound, Users, X, type LucideIcon,
} from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar.tsx'
import { Button } from '@/components/ui/button.tsx'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx'
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuButton,
  SidebarMenuItem, SidebarProvider, useSidebar,
} from '@/components/ui/sidebar.tsx'
import { TooltipProvider } from '@/components/ui/tooltip.tsx'
import { cn } from '@/lib/utils.ts'
import { activeKey, groupNavigation, readNavCollapse, SETTINGS_LINKS, visibleItems, writeNavCollapse, type NavCollapse } from '../navigation.ts'
import {
  createOrganizationLink, httpUrl, initials, PlatformAccountContext, settingsLinks, signOut, switchOrganization, usePlatformAccount,
  type PlatformAccount,
} from '../lib/platform.ts'
import type { CollectionSummary, Me } from '../lib/types.ts'
import { canCreate, navigationRole, personRole } from '../session.tsx'
import { NavIcon } from './Icon.tsx'
import { CrumbSlotContext } from './Page.tsx'

// The shell around every page: the two-level navigation every Insulin app shares (DESIGN.md §3.2), built from
// shadcn/ui's Sidebar as Cap Table's is. Level 1 has the organization switcher, Knowledge's sections from the navigation
// manifest (`insulin.navigation` in package.json) for what the person's permissions leave them, then Docs and Settings,
// and the person at the bottom. Level 2 lists the person's collections under Collections (with "New collection" for
// those who may start one), or Settings' pages, which are Insulin Apps' own pages on insulinapps.com. Each level
// collapses to its icons (a collapsed item's label is its `title` and `aria-label`), remembered in this browser
// (`insulin-nav`). Below 768 px both levels open stacked in a drawer from the menu button in the header.

const PANELS_ID = 'insulin-nav'
const L1_ID = 'insulin-nav-primary'
const L2_ID = 'insulin-nav-section'
const SETTINGS_ICONS: Record<string, LucideIcon> = { users: Users, integrations: Plug, api: KeyRound, 'connect-ai': Bot }

export function Shell({ me, collections, children }: { me: Me; collections: CollectionSummary[] | null; children: ReactNode }) {
  const [collapse, setCollapse] = useState<NavCollapse>(readNavCollapse)
  function setLevel(level: keyof NavCollapse, value: NavCollapse[keyof NavCollapse]) {
    setCollapse((current) => {
      const next: NavCollapse = { ...current, [level]: value }
      writeNavCollapse(next)
      return next
    })
  }
  return (
    <TooltipProvider>
      <SidebarProvider open={collapse.l1 === 'expanded'} onOpenChange={(open) => setLevel('l1', open ? 'expanded' : 'collapsed')}>
        <Frame me={me} collections={collections} collapse={collapse} setLevel={setLevel}>{children}</Frame>
      </SidebarProvider>
    </TooltipProvider>
  )
}

function Frame({ me, collections, collapse, setLevel, children }: {
  me: Me
  collections: CollectionSummary[] | null
  collapse: NavCollapse
  setLevel: (level: keyof NavCollapse, value: NavCollapse[keyof NavCollapse]) => void
  children: ReactNode
}) {
  const { pathname, key } = useLocation()
  const platform = usePlatformAccount()
  const { isMobile, openMobile, setOpenMobile } = useSidebar()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [crumbSlot, setCrumbSlot] = useState<HTMLElement | null>(null)
  const menuButton = useRef<HTMLButtonElement>(null)
  const items = useMemo(() => visibleItems(navigationRole(me)), [me])
  const active = activeKey(pathname, items)
  const inCollections = active === 'collections'
  const l1Collapsed = collapse.l1 === 'collapsed' && !isMobile
  const l2Collapsed = collapse.l2 === 'collapsed' && !isMobile

  // A new page closes the narrow screens' drawer and Settings' column.
  useEffect(() => {
    setOpenMobile(false)
    setSettingsOpen(false)
  }, [key, setOpenMobile])

  const close = () => {
    setSettingsOpen(false)
    setOpenMobile(false)
  }

  const level2: { title: string; body: ReactNode } | null = settingsOpen
    ? { title: 'Settings', body: <SettingsItems platform={platform} collapsed={l2Collapsed} /> }
    : inCollections
      ? { title: 'Collections', body: <CollectionItems me={me} collections={collections} pathname={pathname} collapsed={l2Collapsed} onPick={close} /> }
      : null

  return (
    <div className="flex min-h-svh w-full" data-insulin-shell="" data-l1={collapse.l1} data-l2={collapse.l2} data-menu={openMobile ? 'open' : 'closed'}>
      <a className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:shadow-md"
        href="#main">Skip to content</a>
      <div id={PANELS_ID} className="contents">
        <Sidebar collapsible="icon" id={L1_ID} onMobileCloseAutoFocus={(event: Event) => { event.preventDefault(); menuButton.current?.focus() }}>
          <SidebarHeader>
            {isMobile ? (
              <Button type="button" variant="ghost" size="sm" className="self-end" onClick={() => setOpenMobile(false)}>
                <X aria-hidden="true" /> Close navigation
              </Button>
            ) : <OrgSwitcher platform={platform} collapsed={l1Collapsed} />}
          </SidebarHeader>
          <SidebarContent>
            <nav aria-label="Primary" className="flex flex-1 flex-col">
              {groupNavigation(items).map((group, index) => (
                <SidebarGroup key={`${group.heading ?? ''}-${index}`}>
                  {group.heading ? <SidebarGroupLabel id={`insulin-nav-group-${index}`}>{group.heading}</SidebarGroupLabel> : null}
                  <SidebarMenu aria-labelledby={group.heading ? `insulin-nav-group-${index}` : undefined}>
                    {group.items.map((item) => {
                      const current = active === item.key ? (item.key === 'collections' && pathname !== '/collections' ? 'true' : 'page') : undefined
                      return (
                        <SidebarMenuItem key={item.key}>
                          <NavEntry to={item.path} label={item.label} icon={<NavIcon name={item.icon} />} current={current} collapsed={l1Collapsed} onClick={close} />
                        </SidebarMenuItem>
                      )
                    })}
                  </SidebarMenu>
                </SidebarGroup>
              ))}
              {/* The platform's items, in every app: the in-app Docs, and Settings (Insulin Apps' pages for this app). */}
              <SidebarGroup className="mt-auto">
                <SidebarMenu>
                  <SidebarMenuItem>
                    <NavEntry to="/docs" label="Docs" icon={<BookOpen aria-hidden="true" />} current={active === 'docs' ? 'page' : undefined} collapsed={l1Collapsed} onClick={close} />
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton isActive={settingsOpen} aria-expanded={settingsOpen} aria-controls={L2_ID} {...collapsedName(l1Collapsed, 'Settings')}
                      onClick={() => setSettingsOpen((open) => !open)}>
                      <Settings aria-hidden="true" />
                      <span>Settings</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroup>
            </nav>
            {isMobile && level2 ? (
              <SidebarGroup id={L2_ID} className="border-t border-sidebar-border">
                <SidebarGroupLabel>{level2.title}</SidebarGroupLabel>
                <nav aria-label="Section">{level2.body}</nav>
              </SidebarGroup>
            ) : null}
          </SidebarContent>
          <SidebarFooter className="border-t border-sidebar-border">
            <PersonMenu me={me} platform={platform} collapsed={l1Collapsed} />
            {isMobile ? null : (
              <SidebarMenu>
                <SidebarMenuItem>
                  <CollapseToggle collapsed={collapse.l1 === 'collapsed'} controls={L1_ID} name="navigation" menu
                    onToggle={() => setLevel('l1', collapse.l1 === 'collapsed' ? 'expanded' : 'collapsed')} />
                </SidebarMenuItem>
              </SidebarMenu>
            )}
          </SidebarFooter>
        </Sidebar>
        {isMobile ? null : (
          <Sidebar collapsible="none" id={L2_ID} hidden={level2 === null} data-collapsible={l2Collapsed ? 'icon' : ''}
            data-state={l2Collapsed ? 'collapsed' : 'expanded'}
            className={cn('group sticky top-0 h-svh shrink-0 border-r border-sidebar-border transition-[width] duration-200 ease-linear',
              l2Collapsed ? 'w-(--sidebar-width-icon)' : 'w-60')}>
            {level2 ? (
              <>
                <SidebarHeader className="flex-row items-center gap-2 group-data-[collapsible=icon]:justify-center">
                  <h2 className="min-w-0 flex-1 truncate px-2 text-sm font-semibold group-data-[collapsible=icon]:sr-only">{level2.title}</h2>
                  <CollapseToggle collapsed={l2Collapsed} controls={L2_ID} name={level2.title}
                    onToggle={() => setLevel('l2', l2Collapsed ? 'expanded' : 'collapsed')} />
                </SidebarHeader>
                <SidebarContent className="px-2">
                  <nav aria-label="Section">{level2.body}</nav>
                </SidebarContent>
              </>
            ) : null}
          </Sidebar>
        )}
      </div>
      <div data-slot="sidebar-inset" className="relative flex min-w-0 flex-1 flex-col bg-background">
        {me.preview ? (
          <p className="border-b bg-muted px-4 py-1.5 text-xs text-muted-foreground md:px-8">
            Preview: you are the preview organization's owner, and collections use the in-memory engine.
          </p>
        ) : null}
        <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b px-4 md:px-8">
          {isMobile ? <div className="min-w-0 flex-1"><OrgSwitcher platform={platform} collapsed={false} /></div> : null}
          <Button ref={menuButton} type="button" variant="ghost" size="icon-sm" className="md:hidden" aria-expanded={openMobile} aria-controls={PANELS_ID}
            aria-label={openMobile ? 'Close navigation' : 'Open navigation'} onClick={() => setOpenMobile(!openMobile)}>
            {openMobile ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
          </Button>
          <div className={cn('min-w-0 flex-1 py-3', isMobile && 'basis-full py-2')} ref={setCrumbSlot} />
        </header>
        <main id="main" className="min-w-0 flex-1 outline-none" tabIndex={-1}>
          <PlatformAccountContext value={platform}>
            <CrumbSlotContext value={crumbSlot}>{children}</CrumbSlotContext>
          </PlatformAccountContext>
        </main>
      </div>
    </div>
  )
}

/** A collapsed item's label, as DESIGN.md §3.2 asks: its tooltip (`title`) and its accessible name. */
const collapsedName = (collapsed: boolean, label: string) => (collapsed ? { title: label, 'aria-label': label } : {})

function NavEntry({ to, label, icon, current, collapsed, onClick }: {
  to: string
  label: string
  icon: ReactNode
  current: 'page' | 'true' | undefined
  collapsed: boolean
  onClick: () => void
}) {
  return (
    <SidebarMenuButton asChild isActive={current !== undefined}>
      <Link to={to} aria-current={current} {...collapsedName(collapsed, label)} onClick={onClick}>
        {icon}
        <span className="truncate">{label}</span>
      </Link>
    </SidebarMenuButton>
  )
}

function CollapseToggle({ collapsed, controls, name, menu = false, onToggle }: {
  collapsed: boolean
  controls: string
  name: string
  menu?: boolean
  onToggle: () => void
}) {
  const label = `${collapsed ? 'Expand' : 'Collapse'} ${name}`
  const Glyph = collapsed ? PanelLeftOpen : PanelLeftClose
  const props = { type: 'button' as const, 'aria-expanded': !collapsed, 'aria-controls': controls, 'aria-label': label, title: label, onClick: onToggle }
  if (menu) {
    return (
      <SidebarMenuButton {...props}>
        <Glyph aria-hidden="true" />
        <span>{collapsed ? 'Expand' : 'Collapse'}</span>
      </SidebarMenuButton>
    )
  }
  return (
    <Button variant="ghost" size="icon-sm" className="shrink-0" {...props}>
      <Glyph aria-hidden="true" />
    </Button>
  )
}

/** Level 2 under Collections: the person's collections, and "New collection" for those who may start one. */
function CollectionItems({ me, collections, pathname, collapsed, onPick }: {
  me: Me
  collections: CollectionSummary[] | null
  pathname: string
  collapsed: boolean
  onPick: () => void
}) {
  return (
    <SidebarGroup className="px-0">
      <SidebarMenu>
        <SidebarMenuItem>
          <NavEntry to="/collections" label="All collections" icon={<LayoutGrid aria-hidden="true" />} current={pathname === '/collections' ? 'page' : undefined}
            collapsed={collapsed} onClick={onPick} />
        </SidebarMenuItem>
        {(collections ?? []).map((collection) => {
          const base = `/collections/${collection.id}`
          return (
            <SidebarMenuItem key={collection.id}>
              <NavEntry to={base} label={collection.name} icon={<FileText aria-hidden="true" />}
                current={pathname === base || pathname.startsWith(`${base}/`) ? 'page' : undefined} collapsed={collapsed} onClick={onPick} />
            </SidebarMenuItem>
          )
        })}
        {canCreate(me) ? (
          <SidebarMenuItem>
            <NavEntry to="/collections/new" label="New collection" icon={<Plus aria-hidden="true" />} current={pathname === '/collections/new' ? 'page' : undefined}
              collapsed={collapsed} onClick={onPick} />
          </SidebarMenuItem>
        ) : null}
      </SidebarMenu>
      {collections && collections.length === 0 && !collapsed ? (
        <p className="mt-2 px-2 text-xs text-muted-foreground">No collections yet.</p>
      ) : null}
    </SidebarGroup>
  )
}

/** Settings' level 2: Insulin Apps' pages for this app, on insulinapps.com, which the app only links to. */
function SettingsItems({ platform, collapsed }: { platform: PlatformAccount | null | undefined; collapsed: boolean }) {
  const fromPlatform = settingsLinks(platform)
  return (
    <SidebarGroup className="px-0">
      <SidebarMenu>
        {SETTINGS_LINKS.map(({ key, label, path }) => {
          const Glyph = SETTINGS_ICONS[key] ?? Settings
          // The app's own host redirects these paths to insulinapps.com when the platform's account doesn't name them.
          const href = fromPlatform.find((link) => link.key === key)?.href ?? path
          return (
            <SidebarMenuItem key={key}>
              <SidebarMenuButton asChild>
                <a href={href} {...collapsedName(collapsed, label)}>
                  <Glyph aria-hidden="true" />
                  <span>{label}</span>
                </a>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )
        })}
      </SidebarMenu>
      {collapsed ? null : (
        <p className="mt-2 px-2 text-xs text-muted-foreground">
          People, integrations, API access and Connect AI are Insulin Apps' pages, on insulinapps.com. Knowledge only links to them.
        </p>
      )}
    </SidebarGroup>
  )
}

const initialOf = (name: string) => Array.from(name.trim())[0]?.toLocaleUpperCase('en') ?? '?'

function OrgTile({ name, className }: { name: string; className?: string }) {
  return (
    <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sm font-semibold text-sidebar-primary-foreground', className)}
      aria-hidden="true" data-org-initial="">
      {initialOf(name)}
    </span>
  )
}

/** The organization switcher: on Insulin Apps the person's organizations; elsewhere the app's name, with nothing to switch. */
function OrgSwitcher({ platform, collapsed }: { platform: PlatformAccount | null | undefined; collapsed: boolean }) {
  const { isMobile } = useSidebar()
  const [status, setStatus] = useState('')
  const name = platform?.organization?.name ?? 'Your organization'
  const face = (
    <>
      <OrgTile name={name} />
      <span className="grid min-w-0 flex-1 text-left leading-tight">
        <span className="truncate font-semibold">{name}</span>
        <span className="truncate text-xs text-sidebar-foreground/70">Knowledge</span>
      </span>
    </>
  )
  if (!platform) {
    return (
      <SidebarMenu>
        <SidebarMenuItem data-org-switcher="">
          <div className="flex h-12 w-full items-center gap-2 overflow-hidden rounded-md p-2 text-sm group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-0!"
            title={collapsed ? name : undefined}>
            {face}
          </div>
        </SidebarMenuItem>
      </SidebarMenu>
    )
  }
  const create = createOrganizationLink(platform)
  const apps = httpUrl(platform.links.apps)
  async function choose(orgId: string) {
    setStatus('Switching…')
    try {
      await switchOrganization(orgId)
    } catch {
      setStatus('Couldn’t switch organization. Please try again.')
    }
  }
  return (
    <SidebarMenu>
      <SidebarMenuItem data-org-switcher="">
        <DropdownMenu onOpenChange={() => setStatus('')}>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" className="data-open:bg-sidebar-accent data-open:text-sidebar-accent-foreground" aria-label={`Organization: ${name}`}
              title={collapsed ? name : undefined}>
              {face}
              <ChevronsUpDown className="ml-auto" aria-hidden="true" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-(--radix-dropdown-menu-trigger-width) min-w-60" align="start" side={isMobile ? 'bottom' : 'right'} sideOffset={4}>
            <DropdownMenuLabel className="text-xs text-muted-foreground">Organizations</DropdownMenuLabel>
            <DropdownMenuGroup>
              {platform.organizations.map((organization) => (
                <DropdownMenuItem key={organization.id} className="gap-2 p-2" aria-current={organization.active ? 'true' : undefined} disabled={organization.active}
                  onSelect={(event) => { event.preventDefault(); void choose(organization.id) }}>
                  <OrgTile name={organization.name} className="size-6 rounded-md text-xs" />
                  <span className="grid min-w-0 flex-1 leading-tight">
                    <span className="truncate font-medium">{organization.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{organization.roleLabel}</span>
                  </span>
                  {organization.active ? <Check aria-hidden="true" /> : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            {apps || create ? <DropdownMenuSeparator /> : null}
            {apps ? <DropdownMenuItem asChild><a href={apps}><LayoutGrid aria-hidden="true" />All apps</a></DropdownMenuItem> : null}
            {create ? <DropdownMenuItem asChild><a href={create}><Plus aria-hidden="true" />Create organization</a></DropdownMenuItem> : null}
            <p className="px-2 py-1 text-xs text-muted-foreground empty:hidden" role="status" aria-live="polite">{status}</p>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

/** The person at the bottom of level 1: their initials, name and role; Account and Sign out on Insulin Apps. */
function PersonMenu({ me, platform, collapsed }: { me: Me; platform: PlatformAccount | null | undefined; collapsed: boolean }) {
  const { isMobile } = useSidebar()
  const [status, setStatus] = useState('')
  const name = me.user.name ?? me.user.email ?? 'You'
  const role = personRole(me)
  const account = platform ? httpUrl(platform.links.account) : null
  function toggleTheme() {
    const html = document.documentElement
    html.dataset.theme = html.dataset.theme === 'dark' ? 'light' : 'dark'
  }
  async function leave() {
    setStatus('Signing out…')
    try {
      await signOut()
    } catch {
      setStatus('Couldn’t sign out. Please try again.')
    }
  }
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu onOpenChange={() => setStatus('')}>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" className="data-open:bg-sidebar-accent data-open:text-sidebar-accent-foreground" aria-label={`${name}, ${role}`}
              title={collapsed ? name : undefined} data-person="">
              <Avatar className="rounded-lg after:rounded-lg">
                <AvatarFallback className="rounded-lg text-xs">{initials(me.user.name, me.user.email)}</AvatarFallback>
              </Avatar>
              <span className="grid min-w-0 flex-1 text-left leading-tight">
                <span className="truncate font-medium">{name}</span>
                <span className="truncate text-xs text-sidebar-foreground/70">{role}</span>
              </span>
              <ChevronsUpDown className="ml-auto" aria-hidden="true" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-(--radix-dropdown-menu-trigger-width) min-w-56" align="end" side={isMobile ? 'top' : 'right'} sideOffset={4}>
            {me.user.email ? <DropdownMenuLabel className="truncate font-normal text-muted-foreground">{me.user.email}</DropdownMenuLabel> : null}
            {me.user.email ? <DropdownMenuSeparator /> : null}
            {account ? <DropdownMenuItem asChild><a href={account}><UserRound aria-hidden="true" />Account</a></DropdownMenuItem> : null}
            <DropdownMenuItem onSelect={toggleTheme}><SunMoon aria-hidden="true" />Switch theme</DropdownMenuItem>
            {platform ? (
              <DropdownMenuItem onSelect={(event) => { event.preventDefault(); void leave() }}><LogOut aria-hidden="true" />Sign out</DropdownMenuItem>
            ) : null}
            <p className="px-2 py-1 text-xs text-muted-foreground empty:hidden" role="status" aria-live="polite">{status}</p>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

