import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, Outlet, useLocation } from "react-router";
import {
  BookOpen, Bot, Check, ChevronsUpDown, KeyRound, LayoutGrid, LogOut, Menu, PanelLeftClose, PanelLeftOpen, Plug, Plus, Settings,
  SunMoon, UserRound, Users, X, type LucideIcon,
} from "lucide-react";
import type { api } from "#shared";
import { Avatar, AvatarFallback } from "@/components/ui/avatar.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem,
  SidebarProvider, useSidebar,
} from "@/components/ui/sidebar.tsx";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/utils.ts";
import { useMe } from "../auth/AuthProvider.tsx";
import { hasAdminAccess, personName, roleLabel } from "../auth/access.ts";
import { PreviewStrip } from "../auth/guards.tsx";
import {
  NAVIGATION, appRootPath, groupNavigation, matchNavigation, navigationFor, navigationRole, readNavCollapse, resolveNavPath,
  writeNavCollapse, type NavCollapse, type NavLink,
} from "../lib/navigation.ts";
import {
  createOrganizationLink, httpUrl, initials, PlatformAccountContext, settingsLinks, signOut, switchOrganization, usePlatformAccount,
  type PlatformAccount, type SettingsPage,
} from "../lib/platform.ts";
import { BrandMark } from "./BrandMark.tsx";
import { Icon, NAV_ICON } from "./Icon.tsx";
import { NewPanel } from "./NewPanel.tsx";
import { ShellWriteContext, type ShellWriteState } from "./OrgWorkspace.tsx";
import { CrumbSlotContext } from "./Page.tsx";

type Me = api.MeResponse;

// The shell around every page with a navigation: the two-level navigation every Insulin app shares (DESIGN.md §3.2 at
// the repository's root), built from shadcn/ui's Sidebar. Level 1 has the organization switcher, Cap Table's sections
// from the navigation manifest (`insulin.navigation` in package.json) for the person's role and what they have here
// (the company workspace, their own holdings), then Docs and Settings, and the person at the bottom. Level 2 lists the
// open section's items, or Settings' pages, which are Insulin Apps' own pages on insulinapps.com. Each level collapses
// to its icons (a collapsed item's label is its `title` and `aria-label`), remembered in this browser (`insulin-nav`).
// On a narrow screen (use-mobile.ts) both levels open stacked in a sheet from the menu button beside the breadcrumb,
// which the header above each page carries.

const PANELS_ID = "insulin-nav";
const L1_ID = "insulin-nav-primary";
const L2_ID = "insulin-nav-section";
const SETTINGS_ICONS: Record<SettingsPage, LucideIcon> = { users: Users, integrations: Plug, api: KeyRound, "connect-ai": Bot };

export function AppLayout() {
  const [collapse, setCollapse] = useState<NavCollapse>(readNavCollapse);
  function setLevel(level: keyof NavCollapse, value: NavCollapse[keyof NavCollapse]) {
    setCollapse((current) => {
      const next: NavCollapse = { ...current, [level]: value };
      writeNavCollapse(next);
      return next;
    });
  }
  // Level 1 is shadcn's sidebar, controlled here so its state is the one this browser remembers.
  return (
    <TooltipProvider>
      <SidebarProvider open={collapse.l1 === "expanded"} onOpenChange={(open) => setLevel("l1", open ? "expanded" : "collapsed")}>
        <Shell collapse={collapse} setLevel={setLevel} />
      </SidebarProvider>
    </TooltipProvider>
  );
}

function Shell({ collapse, setLevel }: {
  collapse: NavCollapse;
  setLevel: (level: keyof NavCollapse, value: NavCollapse[keyof NavCollapse]) => void;
}) {
  const me = useMe();
  const location = useLocation();
  const platform = usePlatformAccount();
  const { isMobile, openMobile, setOpenMobile } = useSidebar();
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The section chosen last: a page in two sections (Equity Plans) stays in the one it was opened from.
  const [preferred, setPreferred] = useState<string | null>(null);
  const [newPanel, setNewPanel] = useState(false);
  // "+ New" follows the workspace's resolved write access (role, company loaded and active), not the role alone.
  const [workspaceWrite, setWorkspaceWrite] = useState<ShellWriteState | null>(null);
  const [crumbSlot, setCrumbSlot] = useState<HTMLElement | null>(null);
  const menuButton = useRef<HTMLButtonElement>(null);

  const company = me.company;
  const admin = hasAdminAccess(me);
  const companyBase = company && admin ? `/companies/${company.id}` : "";
  // The person's own records in the company (an individual and their trust are separate stakeholders).
  const holdings = company ? me.portal.matches.filter((match) => match.orgId === company.id) : [];
  const portfolio = company && holdings.length ? `/portfolio/${company.id}` : null;
  // In the portfolio, or a holder who isn't an admin: the holder's frame, with no "+ New".
  const portal = location.pathname.startsWith("/portfolio") || (!admin && holdings.length > 0);
  const canWrite = company !== null && workspaceWrite?.orgId === company.id && workspaceWrite.canWrite;
  // The docs open inside the frame they are chosen from: the portfolio's, the workspace's, or on their own pages for
  // someone with neither (an owner setting up the company).
  const docs = portal && portfolio ? `${portfolio}/docs` : !portal && companyBase ? `${companyBase}/docs` : "/docs";
  const inDocs = location.pathname === docs || location.pathname.startsWith(`${docs}/`);

  const items = useMemo(
    () => navigationFor(NAVIGATION, navigationRole(me), { workspace: companyBase !== "", portfolio: portfolio !== null }),
    [me, companyBase, portfolio],
  );
  const root = company && !inDocs ? appRootPath(location.pathname, company.id) : null;
  const match = root ? matchNavigation(items, root, preferred) : null;
  const section = !settingsOpen && match?.section.children?.length ? match.section : null;
  const l1Collapsed = collapse.l1 === "collapsed" && !isMobile;
  const l2Collapsed = collapse.l2 === "collapsed" && !isMobile;
  const href = (path: string) => (company ? resolveNavPath(path, company.id) : path);

  // A new page closes the narrow screens' sheet and Settings' column.
  useEffect(() => {
    setOpenMobile(false);
    setSettingsOpen(false);
  }, [location.key, setOpenMobile]);
  // Below the breakpoint the sheet closes itself on Escape and gives focus back through onMobileCloseAutoFocus; focusing
  // the button here, while its focus trap still holds, would lose focus.
  useEffect(() => {
    if (!openMobile || isMobile) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpenMobile(false);
      menuButton.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openMobile, isMobile, setOpenMobile]);

  const chose = (key: string | null) => () => {
    setPreferred(key);
    setSettingsOpen(false);
    setOpenMobile(false);
  };

  const level2: { title: string; body: ReactNode } | null = settingsOpen
    ? { title: "Settings", body: <SettingsItems platform={platform} collapsed={l2Collapsed} /> }
    : section
      ? {
          title: section.label,
          body: groupNavigation(section.children ?? []).map((group, index) => (
            <SidebarGroup key={`${group.heading ?? ""}-${index}`} className="px-0">
              {group.heading ? <SidebarGroupLabel id={`insulin-nav-subgroup-${index}`}>{group.heading}</SidebarGroupLabel> : null}
              <SidebarMenu aria-labelledby={group.heading ? `insulin-nav-subgroup-${index}` : undefined}>
                {group.items.map((child: NavLink) => (
                  <SidebarMenuItem key={child.key}>
                    <NavEntry to={href(child.path)} label={child.label} icon={<Icon name={NAV_ICON[child.icon]} />}
                      current={match?.child?.key === child.key ? "page" : undefined} collapsed={l2Collapsed} onClick={chose(section.key)} />
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroup>
          )),
        }
      : null;

  return (
    <div className="flex min-h-svh w-full" data-insulin-shell="" data-l1={collapse.l1} data-l2={collapse.l2} data-menu={openMobile ? "open" : "closed"}>
      <a className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:shadow-md"
        href="#main">Skip to content</a>
      {/* Both levels: beside the page on a wide screen, stacked in the sheet on a narrow one. */}
      <div id={PANELS_ID} className="contents">
        <Sidebar collapsible="icon" id={L1_ID} onMobileCloseAutoFocus={(event) => { event.preventDefault(); menuButton.current?.focus(); }}>
          <SidebarHeader>
            {/* On a narrow screen the switcher is in the top bar, and the menu has its own Close button. */}
            {isMobile ? (
              <Button type="button" variant="ghost" size="sm" className="self-end" onClick={() => setOpenMobile(false)}>
                <X aria-hidden="true" /> Close navigation
              </Button>
            ) : <OrgSwitcher me={me} platform={platform} collapsed={l1Collapsed} />}
            {canWrite && !portal ? (
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton variant="outline" className="font-medium" {...collapsedName(l1Collapsed, "New")}
                    onClick={() => { setNewPanel(true); setOpenMobile(false); }}>
                    <Plus aria-hidden="true" />
                    <span>New</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            ) : null}
          </SidebarHeader>
          <SidebarContent>
            <nav aria-label="Primary" className="flex flex-1 flex-col">
              {groupNavigation(items).map((group, index) => (
                <SidebarGroup key={`${group.heading ?? ""}-${index}`}>
                  {group.heading ? <SidebarGroupLabel id={`insulin-nav-group-${index}`}>{group.heading}</SidebarGroupLabel> : null}
                  <SidebarMenu aria-labelledby={group.heading ? `insulin-nav-group-${index}` : undefined}>
                    {group.items.map((item) => {
                      const current = match?.section.key === item.key ? (match.child ? "true" : "page") : undefined;
                      return (
                        <SidebarMenuItem key={item.key}>
                          <NavEntry to={href(item.path)} label={item.label} icon={<Icon name={NAV_ICON[item.icon]} />} current={current}
                            collapsed={l1Collapsed} onClick={chose(item.key)} />
                        </SidebarMenuItem>
                      );
                    })}
                  </SidebarMenu>
                </SidebarGroup>
              ))}
              {/* The platform's items, in every app: the in-app Docs, and Settings (Insulin Apps' pages for this app). */}
              <SidebarGroup className="mt-auto">
                <SidebarMenu>
                  <SidebarMenuItem>
                    <NavEntry to={docs} label="Docs" icon={<BookOpen aria-hidden="true" />} current={inDocs ? "page" : undefined} collapsed={l1Collapsed}
                      onClick={chose(null)} />
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton isActive={settingsOpen} aria-expanded={settingsOpen} aria-controls={L2_ID} {...collapsedName(l1Collapsed, "Settings")}
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
                  <CollapseToggle collapsed={collapse.l1 === "collapsed"} controls={L1_ID} name="navigation" menu
                    onToggle={() => setLevel("l1", collapse.l1 === "collapsed" ? "expanded" : "collapsed")} />
                </SidebarMenuItem>
              </SidebarMenu>
            )}
          </SidebarFooter>
        </Sidebar>
        {isMobile ? null : (
          <Sidebar collapsible="none" id={L2_ID} hidden={level2 === null} data-collapsible={l2Collapsed ? "icon" : ""}
            data-state={l2Collapsed ? "collapsed" : "expanded"}
            className={cn("group sticky top-0 h-svh shrink-0 border-r border-sidebar-border transition-[width] duration-200 ease-linear",
              l2Collapsed ? "w-(--sidebar-width-icon)" : "w-56")}>
            {level2 ? (
              <>
                <SidebarHeader className="flex-row items-center gap-2 group-data-[collapsible=icon]:justify-center">
                  <h2 className="min-w-0 flex-1 truncate px-2 text-sm font-semibold group-data-[collapsible=icon]:sr-only">{level2.title}</h2>
                  <CollapseToggle collapsed={l2Collapsed} controls={L2_ID} name={level2.title}
                    onToggle={() => setLevel("l2", l2Collapsed ? "expanded" : "collapsed")} />
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
        {me.preview ? <PreviewStrip /> : null}
        <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b px-4 md:px-8">
          {isMobile ? <div className="min-w-0 flex-1"><OrgSwitcher me={me} platform={platform} collapsed={false} /></div> : null}
          <Button ref={menuButton} type="button" variant="ghost" size="icon-sm" className="md:hidden" aria-expanded={openMobile} aria-controls={PANELS_ID}
            aria-label={openMobile ? "Close navigation" : "Open navigation"} onClick={() => setOpenMobile(!openMobile)}>
            {openMobile ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
          </Button>
          <div className={cn("min-w-0 flex-1 py-3", isMobile && "basis-full py-2")} ref={setCrumbSlot} />
        </header>
        <main id="main" className="min-w-0 flex-1 outline-none" tabIndex={-1}>
          <PlatformAccountContext value={platform}>
            <CrumbSlotContext value={crumbSlot}>
              <ShellWriteContext value={setWorkspaceWrite}><Outlet /></ShellWriteContext>
            </CrumbSlotContext>
          </PlatformAccountContext>
          {newPanel && canWrite && companyBase ? <NewPanel companyBase={companyBase} onClose={() => setNewPanel(false)} /> : null}
        </main>
      </div>
    </div>
  );
}

/** A collapsed item's label, as DESIGN.md §3.2 asks: its tooltip (`title`) and its accessible name. */
const collapsedName = (collapsed: boolean, label: string) => (collapsed ? { title: label, "aria-label": label } : {});

/** An item of either level: its icon and label, the label only as a tooltip when the level is collapsed. */
function NavEntry({ to, label, icon, current, collapsed, onClick }: {
  to: string;
  label: string;
  icon: ReactNode;
  current: "page" | "true" | undefined;
  collapsed: boolean;
  onClick: () => void;
}) {
  return (
    <SidebarMenuButton asChild isActive={current !== undefined}>
      <Link to={to} aria-current={current} {...collapsedName(collapsed, label)} onClick={onClick}>
        {icon}
        <span>{label}</span>
      </Link>
    </SidebarMenuButton>
  );
}

/** A level's toggle: level 1's sits in its menu at the foot, level 2's in its header. */
function CollapseToggle({ collapsed, controls, name, menu = false, onToggle }: {
  collapsed: boolean;
  controls: string;
  name: string;
  menu?: boolean;
  onToggle: () => void;
}) {
  const label = `${collapsed ? "Expand" : "Collapse"} ${name}`;
  const Glyph = collapsed ? PanelLeftOpen : PanelLeftClose;
  const props = { type: "button" as const, "aria-expanded": !collapsed, "aria-controls": controls, "aria-label": label, title: label, onClick: onToggle };
  if (menu) {
    return (
      <SidebarMenuButton {...props}>
        <Glyph aria-hidden="true" />
        <span>{collapsed ? "Expand" : "Collapse"}</span>
      </SidebarMenuButton>
    );
  }
  return (
    <Button variant="ghost" size="icon-sm" className="shrink-0" {...props}>
      <Glyph aria-hidden="true" />
    </Button>
  );
}

/** Settings' level 2: Insulin Apps' pages for this app, on insulinapps.com, which the app only links to. */
function SettingsItems({ platform, collapsed }: { platform: PlatformAccount | null | undefined; collapsed: boolean }) {
  const links = settingsLinks(platform);
  const reachable = links.some((link) => link.href);
  return (
    <SidebarGroup className="px-0">
      <SidebarMenu>
        {links.map(({ key, label, href }) => {
          const Glyph = SETTINGS_ICONS[key];
          return (
            <SidebarMenuItem key={key}>
              <SidebarMenuButton asChild>
                {href ? (
                  <a href={href} {...collapsedName(collapsed, label)}>
                    <Glyph aria-hidden="true" />
                    <span>{label}</span>
                  </a>
                ) : (
                  <span aria-disabled="true" title={collapsed ? label : undefined}>
                    <Glyph aria-hidden="true" />
                    <span>{label}</span>
                  </span>
                )}
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
      {reachable ? null : (
        <p className="mt-2 px-2 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
          People, integrations, API access and Connect AI are managed on Insulin Apps (insulinapps.com) when Cap Table is used there.
        </p>
      )}
    </SidebarGroup>
  );
}

const initialOf = (name: string) => Array.from(name.trim())[0]?.toLocaleUpperCase("en") ?? "?";

/** A square tile for an organization: its initial. */
function OrgTile({ name, className }: { name: string; className?: string }) {
  return (
    <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sm font-semibold text-sidebar-primary-foreground", className)}
      aria-hidden="true" data-org-initial="">
      {initialOf(name)}
    </span>
  );
}

/**
 * The organization switcher: the mark, the organization's name and a chevron (the initial alone when level 1 is
 * collapsed). On Insulin Apps it lists the person's organizations, switches between them and links to creating one;
 * elsewhere it names the company, with nothing to switch.
 */
function OrgSwitcher({ me, platform, collapsed }: { me: Me; platform: PlatformAccount | null | undefined; collapsed: boolean }) {
  const { isMobile } = useSidebar();
  const [status, setStatus] = useState("");
  const name = platform?.organization?.name ?? me.company?.displayName ?? "Cap Table";
  const face = (
    <>
      {collapsed ? <OrgTile name={name} /> : <BrandMark size={32} />}
      <span className="grid min-w-0 flex-1 text-left leading-tight">
        <span className="truncate font-semibold">{name}</span>
        <span className="truncate text-xs text-sidebar-foreground/70">Cap Table</span>
      </span>
    </>
  );
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
    );
  }
  const create = createOrganizationLink(platform);
  const apps = httpUrl(platform.links.apps);
  async function choose(orgId: string) {
    setStatus("Switching…");
    try {
      await switchOrganization(orgId);
    } catch {
      setStatus("Couldn’t switch organization. Please try again.");
    }
  }
  return (
    <SidebarMenu>
      <SidebarMenuItem data-org-switcher="">
        <DropdownMenu onOpenChange={() => setStatus("")}>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" className="data-open:bg-sidebar-accent data-open:text-sidebar-accent-foreground" aria-label={`Organization: ${name}`}
              title={collapsed ? name : undefined}>
              {face}
              <ChevronsUpDown className="ml-auto" aria-hidden="true" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-(--radix-dropdown-menu-trigger-width) min-w-60" align="start" side={isMobile ? "bottom" : "right"} sideOffset={4}>
            <DropdownMenuLabel className="text-xs text-muted-foreground">Organizations</DropdownMenuLabel>
            <DropdownMenuGroup>
              {platform.organizations.map((organization) => (
                <DropdownMenuItem key={organization.id} className="gap-2 p-2" aria-current={organization.active ? "true" : undefined} disabled={organization.active}
                  onSelect={(event) => { event.preventDefault(); void choose(organization.id); }}>
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
  );
}

/** The person at the bottom of level 1: their initials, name and role; Account and Sign out on Insulin Apps. */
function PersonMenu({ me, platform, collapsed }: { me: Me; platform: PlatformAccount | null | undefined; collapsed: boolean }) {
  const { isMobile } = useSidebar();
  const [status, setStatus] = useState("");
  const name = personName(me);
  const role = roleLabel(me);
  const account = platform ? httpUrl(platform.links.account) : null;
  function toggleTheme() {
    const html = document.documentElement;
    html.dataset.theme = html.dataset.theme === "dark" ? "light" : "dark";
  }
  async function leave() {
    setStatus("Signing out…");
    try {
      await signOut();
    } catch {
      setStatus("Couldn’t sign out. Please try again.");
    }
  }
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu onOpenChange={() => setStatus("")}>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" className="data-open:bg-sidebar-accent data-open:text-sidebar-accent-foreground" aria-label={`${name}, ${role}`}
              title={collapsed ? name : undefined}>
              <Avatar className="rounded-lg after:rounded-lg">
                <AvatarFallback className="rounded-lg text-xs">{initials(me.user.displayName, me.user.email)}</AvatarFallback>
              </Avatar>
              <span className="grid min-w-0 flex-1 text-left leading-tight">
                <span className="truncate font-medium">{name}</span>
                <span className="truncate text-xs text-sidebar-foreground/70">{role}</span>
              </span>
              <ChevronsUpDown className="ml-auto" aria-hidden="true" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-(--radix-dropdown-menu-trigger-width) min-w-56" align="end" side={isMobile ? "top" : "right"} sideOffset={4}>
            {me.user.email ? <DropdownMenuLabel className="truncate font-normal text-muted-foreground">{me.user.email}</DropdownMenuLabel> : null}
            {me.user.email ? <DropdownMenuSeparator /> : null}
            {account ? <DropdownMenuItem asChild><a href={account}><UserRound aria-hidden="true" />Account</a></DropdownMenuItem> : null}
            <DropdownMenuItem onSelect={toggleTheme}><SunMoon aria-hidden="true" />Switch theme</DropdownMenuItem>
            {platform ? (
              <DropdownMenuItem onSelect={(event) => { event.preventDefault(); void leave(); }}><LogOut aria-hidden="true" />Sign out</DropdownMenuItem>
            ) : null}
            <p className="px-2 py-1 text-xs text-muted-foreground empty:hidden" role="status" aria-live="polite">{status}</p>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
