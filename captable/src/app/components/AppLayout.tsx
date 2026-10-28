import { useState } from "react";
import { Link, Outlet, useLocation } from "react-router";
import { useMe } from "../auth/AuthProvider.tsx";
import { hasAdminAccess, personName, roleLabel } from "../auth/access.ts";
import { BrandMark } from "./BrandMark.tsx";
import { Icon, type IconName } from "./Icon.tsx";
import { NewPanel } from "./NewPanel.tsx";
import { ShellWriteContext, type ShellWriteState } from "./OrgWorkspace.tsx";

type NavChild = readonly [path: string, label: string];
interface NavGroup {
  key: string;
  label: string;
  icon: IconName;
  /** Where the item itself goes; null for a parent that only expands (Hire and Retain). */
  path: string | null;
  children?: readonly NavChild[];
}

// The admin sidebar: Pulley's order and labels; unfinished items stay hidden.
const adminNav: readonly NavGroup[] = [
  { key: "dashboard", label: "Dashboard", icon: "home", path: "dashboard" },
  {
    key: "captable", label: "Cap Table", icon: "table", path: "captable",
    children: [["share-classes", "Share Classes"], ["equity-plans", "Equity Plans"], ["securities-status", "Securities Status"], ["vesting", "Vesting"]],
  },
  { key: "compliance", label: "Compliance & Tax", icon: "shield", path: "compliance/409a" },
  {
    key: "hire", label: "Hire and Retain", icon: "heart", path: null,
    children: [["exercise-requests", "Exercise Requests"], ["equity-plans", "Equity Plans"], ["stakeholder-portal", "Stakeholder Portal"]],
  },
  { key: "stakeholders", label: "Stakeholders", icon: "users", path: "stakeholders" },
  { key: "company", label: "Company", icon: "building", path: "company", children: [["documents", "Documents"], ["reports", "Reports"], ["activity", "Recent Activity"]] },
  { key: "certificates", label: "Certificates", icon: "award", path: "certificates", children: [["certificates/legends", "Legends"], ["certificates/terms", "Terms"]] },
];

/** Which group and sub-item a company path belongs to (security pages sit under Cap Table). */
function activeNav(rest: string): { group: string; child: string | null } {
  const [first = "", second = ""] = rest.split("/");
  if (["share-classes", "equity-plans", "securities-status", "vesting"].includes(first)) return { group: "captable", child: first };
  if (["captable", "securities", "convertibles", "issue"].includes(first)) return { group: "captable", child: null };
  if (first === "compliance") return { group: "compliance", child: null };
  if (first === "exercise-requests" || first === "stakeholder-portal") return { group: "hire", child: first };
  if (first === "documents" || first === "reports" || first === "activity") return { group: "company", child: first };
  if (first === "certificates") return { group: "certificates", child: second === "legends" || second === "terms" ? `certificates/${second}` : null };
  return { group: first, child: null };
}

export function AppLayout() {
  const me = useMe();
  const location = useLocation();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [newPanel, setNewPanel] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // "+ New" follows the workspace's resolved write access (role, company loaded and active), not the role alone.
  const [workspaceWrite, setWorkspaceWrite] = useState<ShellWriteState | null>(null);
  const company = me.company;
  const admin = hasAdminAccess(me);
  const companyBase = company && admin ? `/companies/${company.id}` : "";
  // The person's own records in the company (an individual and their trust are separate stakeholders).
  const holdings = company ? me.portal.matches.filter((match) => match.orgId === company.id) : [];
  // A holder who isn't an admin keeps the portal's navigation on every page.
  const portal = location.pathname.startsWith("/portfolio") || (!admin && holdings.length > 0);
  const companyRest = companyBase && location.pathname.startsWith(`${companyBase}/`) ? location.pathname.slice(companyBase.length + 1) : "";
  const current = activeNav(companyRest);
  const canWrite = company !== null && workspaceWrite?.orgId === company.id && workspaceWrite.canWrite;
  const portfolio = company && holdings.length ? `/portfolio/${company.id}` : null;
  // The docs open inside the navigation they are chosen from: the portfolio's, the workspace's, or on their own pages
  // for someone with neither (an owner setting up the company).
  const docs = portal && portfolio ? `${portfolio}/docs` : !portal && companyBase ? `${companyBase}/docs` : "/docs";
  const inDocs = location.pathname === docs || location.pathname.startsWith(`${docs}/`);

  function toggleTheme() {
    const root = document.documentElement;
    root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
  }
  return (
    <div className="shell">
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="topbar">
        <button className="menu-button" type="button" aria-label="Open navigation" aria-expanded={navigationOpen}
          onClick={() => setNavigationOpen((open) => !open)}>☰</button>
        <Link to="/" className="brand"><BrandMark /><strong>Cap Table</strong></Link>
        <span className="divider" />
        <span className="org-name">
          {portal ? <>{company?.displayName ?? "Cap Table"}<span className="muted"> · My portfolio</span></> : company?.displayName ?? "Cap Table"}
        </span>
        <details className="user-menu">
          <summary><span><b>{personName(me)}</b><small>{roleLabel(me)}</small></span></summary>
          <div className="user-menu-popover">
            {me.user.email ? <span className="small muted">{me.user.email}</span> : null}
            {portfolio && !portal ? <Link to={portfolio}>My portfolio</Link> : null}
            {portal && admin ? <Link to="/">Admin workspace</Link> : null}
            <button className="link-button" type="button" onClick={toggleTheme}>Switch theme</button>
          </div>
        </details>
      </header>
      <div className="workspace">
        {navigationOpen ? <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setNavigationOpen(false)} /> : null}
        <aside className={`sidebar${navigationOpen ? " sidebar-open" : ""}`}>
          {canWrite && !portal ? <button className="new-button" type="button" onClick={() => { setNewPanel(true); setNavigationOpen(false); }}><Icon name="plus" /> New</button> : null}
          {portal ? <PortalNav base={portfolio} onNavigate={() => setNavigationOpen(false)} /> : companyBase ? <div className="nav-title">ESSENTIALS</div> : null}
          {portal || !companyBase ? null : <nav aria-label="Primary">
            {adminNav.map((item) => {
              const inGroup = current.group === item.key;
              const open = item.children ? expanded[item.key] ?? inGroup : false;
              const itemClass = inGroup ? (current.child ? "nav-item parent-active" : "nav-item active") : "nav-item";
              const toggle = () => setExpanded((previous) => ({ ...previous, [item.key]: !open }));
              return (
                <div key={item.key}>
                  {item.path ? (
                    <div className="nav-group">
                      <Link className={itemClass} to={`${companyBase}/${item.path}`} aria-current={inGroup && !current.child ? "page" : undefined}
                        onClick={() => setNavigationOpen(false)}>
                        <Icon name={item.icon} /><span>{item.label}</span>
                      </Link>
                      {item.children ? (
                        <button type="button" className="nav-chev" aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${item.label}`} onClick={toggle}>
                          <Icon name={open ? "chevDown" : "chevRight"} />
                        </button>
                      ) : null}
                    </div>
                  ) : (
                    <button type="button" className={`${itemClass} nav-parent-button`} aria-expanded={open} onClick={toggle}>
                      <Icon name={item.icon} /><span>{item.label}</span><span className="spacer" /><Icon name={open ? "chevDown" : "chevRight"} />
                    </button>
                  )}
                  {open && item.children ? item.children.map(([path, label]) => (
                    <Link key={path} className={inGroup && current.child === path ? "nav-sub active" : "nav-sub"} to={`${companyBase}/${path}`}
                      aria-current={inGroup && current.child === path ? "page" : undefined} onClick={() => setNavigationOpen(false)}>
                      {label}
                    </Link>
                  )) : null}
                </div>
              );
            })}
          </nav>}
          {/* Last, in its own section, for everyone: the guide to the app and to equity. */}
          <div className="nav-title">HELP</div>
          <nav aria-label="Help">
            <Link className={inDocs ? "nav-item active" : "nav-item"} to={docs} aria-current={inDocs ? "page" : undefined} onClick={() => setNavigationOpen(false)}>
              <Icon name="book" /><span>Docs</span>
            </Link>
          </nav>
          <div className="sidebar-foot">
            {portal ? (
              <>
                {company ? <span className="muted">{company.displayName}</span> : null}
                {admin ? <Link to="/">Admin workspace</Link> : null}
              </>
            ) : portfolio ? (
              <Link to={portfolio}>My portfolio</Link>
            ) : null}
          </div>
        </aside>
        <main id="main" className="main" tabIndex={-1}>
          <ShellWriteContext value={setWorkspaceWrite}><Outlet /></ShellWriteContext>
          {newPanel && canWrite && companyBase ? <NewPanel companyBase={companyBase} onClose={() => setNewPanel(false)} /> : null}
        </main>
      </div>
    </div>
  );
}

/** The holder portal's navigation: Portfolio · How to exercise · Documents. */
function PortalNav({ base, onNavigate }: { base: string | null; onNavigate: () => void }) {
  const location = useLocation();
  const rest = base && location.pathname.startsWith(base) ? location.pathname.slice(base.length).replace(/^\//, "") : null;
  const items: [path: string, label: string, icon: IconName][] = [["", "Portfolio", "pie"], ["how-to-exercise", "How to exercise", "help"], ["documents", "Documents", "folder"]];
  const isCurrent = (path: string) => rest !== null && (path === "" ? rest === "" || /^(securities|convertibles)\//.test(rest) : rest === path);
  if (!base) return null;
  return (
    <>
      <div className="nav-title">MY EQUITY</div>
      <nav aria-label="Portfolio">
        {items.map(([path, label, icon]) => (
          <Link key={label} className={isCurrent(path) ? "nav-item active" : "nav-item"} to={path ? `${base}/${path}` : base} aria-current={isCurrent(path) ? "page" : undefined} onClick={onNavigate}>
            <Icon name={icon} /><span>{label}</span>
          </Link>
        ))}
      </nav>
    </>
  );
}
