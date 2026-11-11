import "./shell.css";
import { useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type RefObject, type SetStateAction } from "react";
import { Link, Outlet, useLocation } from "react-router";
import type { api } from "#shared";
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
import { Icon, NAV_ICON, type IconName } from "./Icon.tsx";
import { NewPanel } from "./NewPanel.tsx";
import { ShellWriteContext, type ShellWriteState } from "./OrgWorkspace.tsx";
import { CrumbSlotContext } from "./Page.tsx";

type Me = api.MeResponse;

// The shell around every page with a navigation: the two-level navigation every Insulin app shares (DESIGN.md §3.2 at
// the repository's root), in Cap Table's own look. Level 1 has the organization switcher, Cap Table's sections from the
// navigation manifest (`insulin.navigation` in package.json) for the person's role and what they have here (the company
// workspace, their own holdings), then Docs and Settings, and the person at the bottom. Level 2 lists the open
// section's items, or Settings' pages, which are Insulin Apps' own pages on insulinapps.com. Each level collapses to
// its icons, remembered in this browser; below 768px both open stacked in a menu under a top bar. The page's breadcrumb
// shows in the header above it.

const PANELS_ID = "insulin-nav";
const L1_ID = "insulin-nav-primary";
const L2_ID = "insulin-nav-section";
const ORG_MENU_ID = "insulin-org-menu";
const PERSON_MENU_ID = "insulin-person-menu";
const SETTINGS_ICONS: Record<SettingsPage, IconName> = { users: "users", integrations: "plug", api: "key", "connect-ai": "bot" };

export function AppLayout() {
  const me = useMe();
  const location = useLocation();
  const platform = usePlatformAccount();
  const [collapse, setCollapse] = useState<NavCollapse>(readNavCollapse);
  const [menuOpen, setMenuOpen] = useState(false);
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
  const l1Collapsed = collapse.l1 === "collapsed";
  const l2Collapsed = collapse.l2 === "collapsed";
  const href = (path: string) => (company ? resolveNavPath(path, company.id) : path);

  // A new page closes the narrow screens' menu and Settings' column.
  useEffect(() => {
    setMenuOpen(false);
    setSettingsOpen(false);
  }, [location.key]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      menuButton.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  function toggle(level: keyof NavCollapse) {
    const next: NavCollapse = { ...collapse, [level]: collapse[level] === "collapsed" ? "expanded" : "collapsed" };
    setCollapse(next);
    writeNavCollapse(next);
  }
  const chose = (key: string | null) => () => {
    setPreferred(key);
    setSettingsOpen(false);
    setMenuOpen(false);
  };
  const collapsedName = (collapsed: boolean, label: string) => (collapsed ? { title: label, "aria-label": label } : {});

  return (
    <div className="shell" data-insulin-shell="" data-l1={collapse.l1} data-l2={collapse.l2} data-menu={menuOpen ? "open" : "closed"}>
      <a className="skip-link" href="#main">Skip to content</a>
      <div className="nav-panels" id={PANELS_ID}>
        <div className="nav-l1" id={L1_ID}>
          <div className="l1-top">
            <OrgSwitcher me={me} platform={platform} collapsed={l1Collapsed} />
            <button ref={menuButton} className="menu-button" type="button" aria-expanded={menuOpen} aria-controls={PANELS_ID}
              aria-label={menuOpen ? "Close navigation" : "Open navigation"} onClick={() => setMenuOpen((open) => !open)}>
              <Icon name={menuOpen ? "x" : "rows"} />
            </button>
          </div>
          <div className="l1-scroll">
            {canWrite && !portal ? (
              <button className="new-button" type="button" {...collapsedName(l1Collapsed, "New")} onClick={() => { setNewPanel(true); setMenuOpen(false); }}>
                <Icon name="plus" /><span className="nav-label">New</span>
              </button>
            ) : null}
            <nav aria-label="Primary" className="nav-primary">
              {groupNavigation(items).map((group, index) => (
                <div className="nav-block" key={`${group.heading ?? ""}-${index}`}>
                  {group.heading ? <div className="nav-heading" id={`insulin-nav-group-${index}`}>{group.heading}</div> : null}
                  <ul className="nav-list" aria-labelledby={group.heading ? `insulin-nav-group-${index}` : undefined}>
                    {group.items.map((item) => {
                      const current = match?.section.key === item.key ? (match.child ? "true" : "page") : undefined;
                      return (
                        <li key={item.key}>
                          <NavEntry to={href(item.path)} label={item.label} icon={NAV_ICON[item.icon]} current={current} collapsed={l1Collapsed} onClick={chose(item.key)} />
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
              {/* The platform's items, in every app: the in-app Docs, and Settings (Insulin Apps' pages for this app). */}
              <ul className="nav-list nav-platform">
                <li><NavEntry to={docs} label="Docs" icon="book" current={inDocs ? "page" : undefined} collapsed={l1Collapsed} onClick={chose(null)} /></li>
                <li>
                  <button type="button" className="nav-link" aria-expanded={settingsOpen} aria-controls={L2_ID} {...collapsedName(l1Collapsed, "Settings")}
                    onClick={() => setSettingsOpen((open) => !open)}>
                    <Icon name="settings" /><span className="nav-label">Settings</span>
                  </button>
                </li>
              </ul>
            </nav>
          </div>
          <div className="l1-foot">
            <PersonMenu me={me} platform={platform} collapsed={l1Collapsed} />
            <CollapseToggle collapsed={l1Collapsed} controls={L1_ID} name="navigation" onToggle={() => toggle("l1")} />
          </div>
        </div>
        <div className="nav-l2" id={L2_ID} hidden={!settingsOpen && section === null}>
          {settingsOpen ? (
            <Level2 title="Settings" collapsed={l2Collapsed} onToggle={() => toggle("l2")}>
              <SettingsItems platform={platform} collapsed={l2Collapsed} />
            </Level2>
          ) : section ? (
            <Level2 title={section.label} collapsed={l2Collapsed} onToggle={() => toggle("l2")}>
              {groupNavigation(section.children ?? []).map((group, index) => (
                <div className="nav-block" key={`${group.heading ?? ""}-${index}`}>
                  {group.heading ? <div className="nav-heading" id={`insulin-nav-subgroup-${index}`}>{group.heading}</div> : null}
                  <ul className="nav-list" aria-labelledby={group.heading ? `insulin-nav-subgroup-${index}` : undefined}>
                    {group.items.map((child: NavLink) => (
                      <li key={child.key}>
                        <NavEntry to={href(child.path)} label={child.label} icon={NAV_ICON[child.icon]} current={match?.child?.key === child.key ? "page" : undefined}
                          collapsed={l2Collapsed} onClick={chose(section.key)} />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </Level2>
          ) : null}
        </div>
      </div>
      <div className="content">
        {me.preview ? <PreviewStrip /> : null}
        <header className="shell-header">
          <div className="shell-crumbs" ref={setCrumbSlot} />
        </header>
        <main id="main" className="main" tabIndex={-1}>
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

/** An item of either level: its icon and label, the label only as a tooltip when the level is collapsed. */
function NavEntry({ to, label, icon, current, collapsed, onClick }: {
  to: string;
  label: string;
  icon: IconName;
  current: "page" | "true" | undefined;
  collapsed: boolean;
  onClick: () => void;
}) {
  return (
    <Link className={current ? "nav-link active" : "nav-link"} to={to} aria-current={current} title={collapsed ? label : undefined}
      aria-label={collapsed ? label : undefined} onClick={onClick}>
      <Icon name={icon} /><span className="nav-label">{label}</span>
    </Link>
  );
}

function CollapseToggle({ collapsed, controls, name, onToggle }: { collapsed: boolean; controls: string; name: string; onToggle: () => void }) {
  const label = `${collapsed ? "Expand" : "Collapse"} ${name}`;
  return (
    <button className="nav-toggle" type="button" aria-expanded={!collapsed} aria-controls={controls} aria-label={label} title={label} onClick={onToggle}>
      <Icon name="panel" />
    </button>
  );
}

/** Level 2: a header naming the section, with the level's toggle, above its items. */
function Level2({ title, collapsed, onToggle, children }: { title: string; collapsed: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <>
      <div className="l2-head">
        <span className="l2-title">{title}</span>
        <CollapseToggle collapsed={collapsed} controls={L2_ID} name={title} onToggle={onToggle} />
      </div>
      <nav aria-label="Section" className="nav-section">{children}</nav>
    </>
  );
}

/** Settings' level 2: Insulin Apps' pages for this app, on insulinapps.com, which the app only links to. */
function SettingsItems({ platform, collapsed }: { platform: PlatformAccount | null | undefined; collapsed: boolean }) {
  const links = settingsLinks(platform);
  const reachable = links.some((link) => link.href);
  return (
    <>
      <ul className="nav-list">
        {links.map(({ key, label, href }) => (
          <li key={key}>
            {href ? (
              <a className="nav-link" href={href} title={collapsed ? label : undefined} aria-label={collapsed ? label : undefined}>
                <Icon name={SETTINGS_ICONS[key]} /><span className="nav-label">{label}</span>
              </a>
            ) : (
              <span className="nav-link disabled" aria-disabled="true" title={collapsed ? label : undefined}>
                <Icon name={SETTINGS_ICONS[key]} /><span className="nav-label">{label}</span>
              </span>
            )}
          </li>
        ))}
      </ul>
      {reachable ? null : (
        <p className="nav-note">People, integrations, API access and Connect AI are managed on Insulin Apps (insulinapps.com) when Cap Table is used there.</p>
      )}
    </>
  );
}

/** Closes a menu on Escape (focus back on its button) or on a click outside it. */
function useDismiss(open: boolean, root: RefObject<HTMLElement | null>, setOpen: Dispatch<SetStateAction<boolean>>) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      root.current?.querySelector<HTMLButtonElement>("button")?.focus();
    };
    const onPointer = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
    };
  }, [open, root, setOpen]);
}

const initialOf = (name: string) => Array.from(name.trim())[0]?.toLocaleUpperCase("en") ?? "?";

/**
 * The organization switcher: the mark, the organization's name and a chevron. On Insulin Apps it lists the person's
 * organizations, switches between them and links to creating one; elsewhere it names the company, with nothing to switch.
 */
function OrgSwitcher({ me, platform, collapsed }: { me: Me; platform: PlatformAccount | null | undefined; collapsed: boolean }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState("");
  const root = useRef<HTMLDivElement>(null);
  useDismiss(open, root, setOpen);
  const name = platform?.organization?.name ?? me.company?.displayName ?? "Cap Table";
  const face = (
    <>
      {collapsed ? <span className="org-initial" aria-hidden="true">{initialOf(name)}</span> : <BrandMark size={28} />}
      <span className="org-text"><b>{name}</b><small>Cap Table</small></span>
    </>
  );
  if (!platform) {
    return <div className="org-switcher"><div className="org-button static" title={collapsed ? name : undefined}>{face}</div></div>;
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
    <div className="org-switcher" ref={root}>
      <button type="button" className="org-button" aria-expanded={open} aria-controls={ORG_MENU_ID} title={collapsed ? name : undefined}
        aria-label={`Organization: ${name}`} onClick={() => { setOpen(!open); setStatus(""); }}>
        {face}
        <Icon name="chevrons" />
      </button>
      <div className="nav-menu org-menu" id={ORG_MENU_ID} hidden={!open}>
        <div className="menu-heading" id={`${ORG_MENU_ID}-heading`}>Organizations</div>
        <ul aria-labelledby={`${ORG_MENU_ID}-heading`}>
          {platform.organizations.map((organization) => (
            <li key={organization.id}>
              <button type="button" className="menu-row" aria-current={organization.active ? "true" : undefined} disabled={organization.active}
                onClick={() => void choose(organization.id)}>
                <span className="org-initial" aria-hidden="true">{initialOf(organization.name)}</span>
                <span className="menu-row-text"><b>{organization.name}</b><small>{organization.roleLabel}</small></span>
                {organization.active ? <Icon name="check" /> : null}
              </button>
            </li>
          ))}
        </ul>
        {apps ? <a className="menu-row" href={apps}><Icon name="grid" />All apps</a> : null}
        {create ? <a className="menu-row" href={create}><Icon name="plus" />Create organization</a> : null}
        <p className="menu-status" role="status" aria-live="polite">{status}</p>
      </div>
    </div>
  );
}

/** The person at the bottom of level 1: their initials, name and role; Account and Sign out on Insulin Apps. */
function PersonMenu({ me, platform, collapsed }: { me: Me; platform: PlatformAccount | null | undefined; collapsed: boolean }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState("");
  const root = useRef<HTMLDivElement>(null);
  useDismiss(open, root, setOpen);
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
    <div className="nav-person" ref={root}>
      <button type="button" className="person-button" aria-expanded={open} aria-controls={PERSON_MENU_ID} title={collapsed ? name : undefined}
        aria-label={`${name}, ${role}`} onClick={() => { setOpen(!open); setStatus(""); }}>
        <span className="avatar" aria-hidden="true">{initials(me.user.displayName, me.user.email)}</span>
        <span className="person-text"><b>{name}</b><small>{role}</small></span>
        <Icon name="chevrons" />
      </button>
      <div className="nav-menu person-menu" id={PERSON_MENU_ID} hidden={!open}>
        {me.user.email ? <p className="menu-email">{me.user.email}</p> : null}
        {account ? <a className="menu-row" href={account}><Icon name="user" />Account</a> : null}
        <button type="button" className="menu-row" onClick={toggleTheme}><Icon name="contrast" />Switch theme</button>
        {platform ? <button type="button" className="menu-row" onClick={() => void leave()}><Icon name="logOut" />Sign out</button> : null}
        <p className="menu-status" role="status" aria-live="polite">{status}</p>
      </div>
    </div>
  );
}
