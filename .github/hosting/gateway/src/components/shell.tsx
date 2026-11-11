// The two-level navigation around the gateway's signed-in pages (DESIGN.md §3.2), drawn from navigation.ts's model:
// level 1 (the organization switcher, the sections, the platform's items, the collapse toggle and the person), level 2
// (the open section's items under a header naming it), a breadcrumb above the page, and on narrow screens a top bar
// whose menu opens both levels in a drawer. Shadcn's sidebar colours and spacing, without a script: links, plain form
// POSTs, <details> menus and a <details> drawer. Each level collapses to its icons through a link to /__insulin/nav,
// which remembers the choice in a cookie and comes back.
import { Fragment } from "react"
import type { ReactNode } from "react"
import {
  Check, ChevronRight, ChevronsLeft, ChevronsRight, ChevronsUpDown, LayoutGrid, LogOut, Menu as MenuIcon, PanelLeftClose,
  PanelLeftOpen, Plus, UserRound, X,
} from "lucide-react"
import { cn } from "@/lib/utils"
import type { Context } from "../context.ts"
import { apexUrl } from "../context.ts"
import type { MembershipRow } from "../db/orgs.ts"
import type { Crumb, NavGroup, NavLevelState, NavLink, NavSection, ShellModel } from "../navigation.ts"
import { ROLE_LABELS } from "../roles.ts"
import { InsulinMark } from "./brand.tsx"
import { Menu, MenuContent, MenuLabel, MenuSeparator, MenuTrigger, menuItemClass } from "./menu.tsx"
import { NavIcon } from "./nav-icon.tsx"
import { initials } from "./site-header.tsx"
import { SiteFooter } from "./site-footer.tsx"

/** The menus of the shell share a name, so opening one closes the other (<details name>). */
const MENU_NAME = "insulin-shell"
export const PRIMARY_ID = "insulin-nav-primary"
export const SECTION_ID = "insulin-nav-section"

const focusRing = "outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring"

/** shadcn's SidebarMenuButton, as a link: the open page highlighted, its label truncated, the icon 16px. */
const itemClass = cn(
  "flex h-8 w-full items-center gap-2 overflow-hidden rounded-md px-2 text-left text-sm text-sidebar-foreground",
  "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
  "data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground",
  "[&>span]:truncate [&>svg]:size-4 [&>svg]:shrink-0",
  focusRing
)

/** shadcn's SidebarGroupLabel, in small capitals as the design asks. */
const groupLabelClass = "flex h-8 shrink-0 items-center px-2 text-xs font-medium tracking-wider text-sidebar-foreground/70 uppercase"

/** A large menu button (the organization switcher, the person): shadcn's SidebarMenuButton size "lg". */
const largeButtonClass = cn(
  "flex h-12 w-full cursor-pointer items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm",
  "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground group-open/menu:bg-sidebar-accent",
  focusRing
)

function collapsedOf(state: NavLevelState): boolean {
  return state === "collapsed"
}

/** The first letter of the organization's name, shown when level 1 is collapsed. */
export function orgInitial(name: string): string {
  return (Array.from(name.trim())[0] ?? "?").toLocaleUpperCase("en")
}

function ItemLink({ item, collapsed }: { item: NavLink; collapsed: boolean }) {
  return (
    <a
      href={item.href}
      aria-current={item.current ? (item.section ? "true" : "page") : undefined}
      data-active={item.current ? "true" : undefined}
      title={collapsed ? item.label : undefined}
      aria-label={collapsed ? item.label : undefined}
      className={cn(itemClass, collapsed && "justify-center px-0")}
    >
      <NavIcon name={item.icon} />
      {collapsed ? null : <span>{item.label}</span>}
    </a>
  )
}

/** Groups of items, each under its heading (kept for screen readers when collapsed). `idPrefix` keeps ids unique. */
function Groups({ groups, collapsed, idPrefix }: { groups: NavGroup[]; collapsed: boolean; idPrefix: string }) {
  return (
    <>
      {groups.map((group, index) => {
        const headingId = group.heading ? `${idPrefix}-group-${index}` : undefined
        return (
          <div key={`${group.heading ?? ""}-${index}`} data-slot="nav-group" className="flex flex-col">
            {group.heading ? (
              <div id={headingId} className={collapsed ? "sr-only" : groupLabelClass}>
                {group.heading}
              </div>
            ) : null}
            <ul aria-labelledby={headingId} className="flex flex-col gap-1">
              {group.items.map((item) => (
                <li key={item.key}>
                  <ItemLink item={item} collapsed={collapsed} />
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </>
  )
}

function SwitchOrgForm({ org, returnTo }: { org: MembershipRow; returnTo: string | null }) {
  return (
    <form method="post" action="/orgs/switch">
      <input type="hidden" name="org_id" defaultValue={org.org_id} />
      {returnTo ? <input type="hidden" name="return_to" defaultValue={returnTo} /> : null}
      <button type="submit" className={menuItemClass}>
        <span className="size-4" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{org.org_name}</span>
        <span className="text-xs text-muted-foreground">{ROLE_LABELS[org.role]}</span>
      </button>
    </form>
  )
}

/** At the top of level 1: the mark, the organization's name and a chevron (its initial, collapsed). */
function OrgSwitcher({ ctx, model, collapsed }: { ctx: Context; model: ShellModel; collapsed: boolean }) {
  const org = model.org
  const name = org?.name ?? "No organization"
  const orgs = model.orgs.length || !org ? model.orgs : [{ org_id: org.id, org_name: org.name, role: org.role, created_at: 0 }]
  return (
    <Menu name={MENU_NAME} data-slot="org-switcher">
      <MenuTrigger
        className={cn(largeButtonClass, collapsed && "size-10 justify-center p-0")}
        title={collapsed ? name : undefined}
        aria-label={collapsed ? `Organization: ${name}` : undefined}
      >
        {collapsed ? (
          <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-sm font-semibold text-sidebar-primary-foreground">
            {orgInitial(name)}
          </span>
        ) : (
          <>
            <InsulinMark className="size-8" />
            <span className="grid min-w-0 flex-1 leading-tight">
              <span className="sr-only">Organization: </span>
              <span className="truncate font-semibold">{name}</span>
              {org ? <span className="truncate text-xs text-muted-foreground">{ROLE_LABELS[org.role]}</span> : null}
            </span>
            <ChevronsUpDown aria-hidden="true" className="ml-auto size-4 shrink-0 text-muted-foreground" />
          </>
        )}
      </MenuTrigger>
      <MenuContent align="start" className="w-64">
        <MenuLabel className="text-xs font-normal text-muted-foreground">Organizations</MenuLabel>
        {orgs.map((item) =>
          item.org_id === org?.id ? (
            <div key={item.org_id} className={cn(menuItemClass, "hover:bg-transparent")} aria-current="true">
              <Check className="text-foreground" />
              <span className="min-w-0 flex-1 truncate font-medium">{item.org_name}</span>
              <span className="text-xs text-muted-foreground">{ROLE_LABELS[item.role]}</span>
            </div>
          ) : (
            <SwitchOrgForm key={item.org_id} org={item} returnTo={model.switchReturnTo} />
          )
        )}
        <MenuSeparator />
        <a className={menuItemClass} href={apexUrl(ctx, "/")}>
          <LayoutGrid />
          All apps
        </a>
        <a className={menuItemClass} href={apexUrl(ctx, "/orgs/new")}>
          <Plus />
          Create an organization
        </a>
      </MenuContent>
    </Menu>
  )
}

function Avatar({ model }: { model: ShellModel }) {
  return (
    <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-xs font-medium text-primary-foreground">
      {initials(model.person.name, model.person.email)}
    </span>
  )
}

/** At the bottom of level 1: the person's initials and name, opening Account and Sign out above it. */
function PersonMenu({ ctx, model, collapsed }: { ctx: Context; model: ShellModel; collapsed: boolean }) {
  const { name, email } = model.person
  return (
    <Menu name={MENU_NAME} data-slot="person">
      <MenuTrigger className={cn(largeButtonClass, collapsed && "size-10 justify-center p-0")} title={collapsed ? name : undefined}>
        <Avatar model={model} />
        <span className="sr-only">Account menu for {name}</span>
        {collapsed ? null : (
          <>
            <span aria-hidden="true" className="grid min-w-0 flex-1 leading-tight">
              <span className="truncate font-medium">{name}</span>
              <span className="truncate text-xs text-muted-foreground">{email}</span>
            </span>
            <ChevronsUpDown aria-hidden="true" className="ml-auto size-4 shrink-0 text-muted-foreground" />
          </>
        )}
      </MenuTrigger>
      <MenuContent align="start" className="top-auto bottom-full mt-0 mb-2 w-60">
        <div className="px-2 py-1.5">
          <p className="truncate text-sm font-medium">{name}</p>
          <p className="truncate text-xs text-muted-foreground">{email}</p>
        </div>
        <MenuSeparator />
        <a className={menuItemClass} href={apexUrl(ctx, "/account")}>
          <UserRound />
          Account
        </a>
        <MenuSeparator />
        <SignOut />
      </MenuContent>
    </Menu>
  )
}

/** Sign-out posts to the apex's own route, where every shell page is, so the Origin check and form-action allow it. */
function SignOut() {
  return (
    <form method="post" action="/logout">
      <button type="submit" className={menuItemClass}>
        <LogOut />
        Sign out
      </button>
    </form>
  )
}

/** A level's collapse toggle: a link to /__insulin/nav, which flips it and comes back to this page. */
function Toggle({ level, state, returnPath, controls }: { level: "l1" | "l2"; state: NavLevelState; returnPath: string; controls: string }) {
  const collapsed = collapsedOf(state)
  const what = level === "l1" ? "navigation" : "section"
  const label = `${collapsed ? "Expand" : "Collapse"} ${what}`
  const Icon = level === "l1" ? (collapsed ? PanelLeftOpen : PanelLeftClose) : collapsed ? ChevronsRight : ChevronsLeft
  const href = `/__insulin/nav?${level}=${collapsed ? "expanded" : "collapsed"}&return=${encodeURIComponent(returnPath)}`
  const showText = level === "l1" && !collapsed
  return (
    <a
      href={href}
      data-slot="nav-toggle"
      aria-expanded={!collapsed}
      aria-controls={controls}
      aria-label={label}
      title={label}
      className={cn(
        itemClass,
        "text-muted-foreground",
        showText ? "" : "justify-center px-0",
        level === "l2" && "size-8 shrink-0"
      )}
    >
      <Icon aria-hidden="true" />
      {showText ? <span>Collapse</span> : null}
    </a>
  )
}

function Primary({ ctx, model }: { ctx: Context; model: ShellModel }) {
  const collapsed = collapsedOf(model.state.l1)
  return (
    <nav
      aria-label="Primary"
      id={PRIMARY_ID}
      data-slot="nav-primary"
      data-state={model.state.l1}
      className={cn(
        "sticky top-0 z-30 hidden h-svh shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex",
        collapsed ? "w-14" : "w-60"
      )}
    >
      <div className="flex flex-col p-2">
        <OrgSwitcher ctx={ctx} model={model} collapsed={collapsed} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-2">
        <Groups groups={model.primary} collapsed={collapsed} idPrefix="nav-primary" />
        {model.platform ? (
          <div className="mt-auto flex flex-col">
            <Groups groups={[model.platform]} collapsed={collapsed} idPrefix="nav-platform" />
          </div>
        ) : null}
      </div>
      <div className="flex flex-col gap-1 border-t border-sidebar-border p-2">
        <Toggle level="l1" state={model.state.l1} returnPath={model.returnPath} controls={PRIMARY_ID} />
        <PersonMenu ctx={ctx} model={model} collapsed={collapsed} />
      </div>
    </nav>
  )
}

function Section({ model, section }: { model: ShellModel; section: NavSection }) {
  const collapsed = collapsedOf(model.state.l2)
  return (
    <nav
      aria-label="Section"
      id={SECTION_ID}
      data-slot="nav-section"
      data-state={model.state.l2}
      className={cn(
        "sticky top-0 z-20 hidden h-svh shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex",
        collapsed ? "w-14" : "w-56"
      )}
    >
      <div className={cn("flex h-14 shrink-0 items-center gap-2 border-b border-sidebar-border px-2", collapsed ? "justify-center" : "pl-4")}>
        <div data-slot="nav-section-title" className={collapsed ? "sr-only" : "min-w-0 flex-1 truncate text-sm font-semibold"}>
          {section.title}
        </div>
        <Toggle level="l2" state={model.state.l2} returnPath={model.returnPath} controls={SECTION_ID} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-2">
        <Groups groups={section.groups} collapsed={collapsed} idPrefix="nav-section" />
      </div>
    </nav>
  )
}

/** Below 768px: a top bar with the organization switcher and a menu button, whose drawer holds both levels. */
function MobileBar({ ctx, model }: { ctx: Context; model: ShellModel }) {
  return (
    <div data-slot="nav-mobile" className="sticky top-0 z-40 flex h-14 shrink-0 items-center gap-2 border-b border-sidebar-border bg-sidebar px-2 text-sidebar-foreground md:hidden">
      <div className="min-w-0 flex-1">
        <OrgSwitcher ctx={ctx} model={model} collapsed={false} />
      </div>
      <details data-slot="nav-drawer" className="group/drawer">
        <summary className={cn("flex size-10 cursor-pointer list-none items-center justify-center rounded-md hover:bg-sidebar-accent [&::-webkit-details-marker]:hidden", focusRing)}>
          <MenuIcon aria-hidden="true" className="size-5 group-open/drawer:hidden" />
          <X aria-hidden="true" className="hidden size-5 group-open/drawer:block" />
          <span className="sr-only">Menu</span>
        </summary>
        <div className="absolute inset-x-0 top-full flex max-h-[calc(100svh-3.5rem)] flex-col gap-4 overflow-y-auto border-b border-sidebar-border bg-sidebar p-2 shadow-md">
          <nav aria-label="Primary" className="flex flex-col gap-4">
            <Groups groups={model.platform ? [...model.primary, model.platform] : model.primary} collapsed={false} idPrefix="drawer-primary" />
          </nav>
          {model.section ? (
            <nav aria-label="Section" className="flex flex-col gap-2 border-t border-sidebar-border pt-4">
              <div className="px-2 text-sm font-semibold">{model.section.title}</div>
              <Groups groups={model.section.groups} collapsed={false} idPrefix="drawer-section" />
            </nav>
          ) : null}
          <div className="flex flex-col gap-1 border-t border-sidebar-border pt-4">
            <div className="flex items-center gap-2 px-2 py-1.5">
              <Avatar model={model} />
              <span className="grid min-w-0 flex-1 leading-tight">
                <span className="truncate text-sm font-medium">{model.person.name}</span>
                <span className="truncate text-xs text-muted-foreground">{model.person.email}</span>
              </span>
            </div>
            <a className={menuItemClass} href={apexUrl(ctx, "/account")}>
              <UserRound />
              Account
            </a>
            <SignOut />
          </div>
        </div>
      </details>
    </div>
  )
}

/** The page's header: the breadcrumb (section › item), shadcn's Breadcrumb. */
function Breadcrumb({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex flex-wrap items-center gap-1.5 text-sm break-words text-muted-foreground sm:gap-2.5">
        {crumbs.map((crumb, index) => (
          <Fragment key={`${crumb.label}-${index}`}>
            {index ? (
              <li role="presentation" aria-hidden="true" className="[&>svg]:size-3.5">
                <ChevronRight />
              </li>
            ) : null}
            <li className="inline-flex items-center gap-1.5">
              {crumb.href ? (
                <a href={crumb.href} className="rounded-sm transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
                  {crumb.label}
                </a>
              ) : (
                <span aria-current="page" className="font-normal text-foreground">
                  {crumb.label}
                </span>
              )}
            </li>
          </Fragment>
        ))}
      </ol>
    </nav>
  )
}

/** The shell around a signed-in page's content. The root carries data-insulin-shell, so the account bar stays away. */
export function Shell({ ctx, model, children }: { ctx: Context; model: ShellModel; children: ReactNode }) {
  return (
    <div data-insulin-shell="" className="flex min-h-svh flex-1 flex-col md:flex-row">
      <MobileBar ctx={ctx} model={model} />
      <Primary ctx={ctx} model={model} />
      {model.section ? <Section model={model} section={model.section} /> : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4 sm:px-6 md:sticky md:top-0 md:z-10">
          <Breadcrumb crumbs={model.breadcrumb} />
        </header>
        <main id="main" className="flex-1">
          {children}
        </main>
        <SiteFooter ctx={ctx} />
      </div>
    </div>
  )
}
