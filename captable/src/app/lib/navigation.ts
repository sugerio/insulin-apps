import { z } from "zod";
import packageJson from "../../../package.json";
import type { api } from "#shared";

// The navigation manifest (`insulin.navigation` in package.json, DESIGN.md §3.2 at the repository's root): Cap Table's
// level 1, which the app and the Insulin Apps gateway both render. Its paths are app-root paths (`/dashboard`,
// `/portfolio/documents`); the app's own pages live under the company (`/companies/:orgId/...`) or the holder's
// portfolio (`/portfolio/:orgId/...`), so the shell links to those and the router sends the app-root paths there.

/** The Lucide icons the gateway bundles, by name: a manifest icon is one of these. */
export const NAV_ICONS = [
  "layout-dashboard", "home", "table", "layers", "chart-pie", "shield", "heart", "users", "building", "file-text", "award",
  "inbox", "files", "file-pen", "signature", "send", "clock", "check-circle", "archive", "settings", "book-open", "plug",
  "key", "bot", "folder", "list", "calendar", "bell", "search",
] as const;
export type NavIconName = (typeof NAV_ICONS)[number];

/** App roles, least first: an item's `role` is the least role that sees it. */
export const APP_ROLES = ["VIEWER", "EDITOR", "ADMIN"] as const;
export type AppRole = (typeof APP_ROLES)[number];

// The gateway's paths on every app host: never an app's page.
const RESERVED_PATH = /^\/(?:__insulin|settings|mcp|\.well-known)(?:[/?#]|$)/i;

const linkFields = {
  key: z.string().regex(/^[a-z0-9-]+$/),
  label: z.string().max(40).refine((label) => label.trim().length > 0, "must not be blank"),
  icon: z.enum(NAV_ICONS),
  path: z.string().max(200).refine((path) => path.startsWith("/") && !path.startsWith("//") && !RESERVED_PATH.test(path), "must start with / and not be one of the gateway's paths"),
  group: z.string().min(1).max(40).optional(),
  role: z.enum(APP_ROLES).optional(),
  maxRole: z.enum(APP_ROLES).optional(),
};
const navLinkSchema = z.strictObject(linkFields);
const navItemSchema = z.strictObject({ ...linkFields, children: z.array(navLinkSchema).max(12).optional() });

export const navigationSchema = z.array(navItemSchema).max(12).superRefine((items, context) => {
  const seen = new Set<string>();
  for (const key of items.flatMap((item) => [item.key, ...(item.children ?? []).map((child) => child.key)])) {
    if (seen.has(key)) context.addIssue({ code: "custom", message: `key ${key} is used twice` });
    seen.add(key);
  }
});

export type NavLink = z.infer<typeof navLinkSchema>;
export type NavItem = z.infer<typeof navItemSchema>;

/** Cap Table's level 1, as package.json declares it (a malformed manifest fails here, and in the tests). */
export const NAVIGATION: readonly NavItem[] = navigationSchema.parse(packageJson.insulin.navigation);

// ---------------------------------------------------------------------------
// Who sees what

const rank = (role: AppRole) => APP_ROLES.indexOf(role);

/**
 * The person's role for the manifest: their app role, lowered by what their permissions leave them (a custom role that
 * only sees its own holdings is a Viewer here, whatever its base role).
 */
export function navigationRole(me: Pick<api.MeResponse, "consoleRole" | "access">): AppRole {
  const byRole: AppRole = me.consoleRole === "OWNER" || me.consoleRole === "ADMIN" ? "ADMIN" : me.consoleRole === "EDITOR" ? "EDITOR" : "VIEWER";
  const byAccess: AppRole = me.access === "admin_rw" ? "ADMIN" : me.access === "admin_ro" ? "EDITOR" : "VIEWER";
  return rank(byRole) < rank(byAccess) ? byRole : byAccess;
}

/** Whether a path is the holder's portfolio (`/portfolio`, `/portfolio/...`) rather than a company page. */
export function isPortfolioPath(path: string): boolean {
  const pathname = splitPath(path)[0];
  return pathname === "/portfolio" || pathname.startsWith("/portfolio/");
}

/**
 * The items a person sees: those their role reaches (children too), and of those, the company's pages only when they
 * have the company workspace and the portfolio's only when they hold equity in the company.
 */
export function navigationFor(items: readonly NavItem[], role: AppRole, has: { workspace: boolean; portfolio: boolean }): NavItem[] {
  const sees = (link: NavLink) =>
    rank(link.role ?? "VIEWER") <= rank(role) && rank(role) <= rank(link.maxRole ?? "ADMIN") && (isPortfolioPath(link.path) ? has.portfolio : has.workspace);
  return items.filter(sees).map((item) => (item.children ? { ...item, children: item.children.filter(sees) } : item));
}

/** Items in order, under headings: consecutive items with the same `group` share one; an item without one has none. */
export function groupNavigation<T extends NavLink>(items: readonly T[]): { heading: string | null; items: T[] }[] {
  const groups: { heading: string | null; items: T[] }[] = [];
  for (const item of items) {
    const heading = item.group ?? null;
    const last = groups.at(-1);
    if (last && last.heading === heading) last.items.push(item);
    else groups.push({ heading, items: [item] });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Paths

function splitPath(path: string): [pathname: string, rest: string] {
  const at = path.search(/[?#]/);
  return at < 0 ? [path, ""] : [path.slice(0, at), path.slice(at)];
}

/** Where an app-root path leads in this company: `/vesting` → `/companies/:id/vesting`, `/portfolio/documents` → `/portfolio/:id/documents`. */
export function resolveNavPath(path: string, companyId: string): string {
  const [pathname, rest] = splitPath(path);
  if (isPortfolioPath(pathname)) return `/portfolio/${companyId}${pathname.slice("/portfolio".length)}${rest}`;
  return `/companies/${companyId}${pathname === "/" ? "" : pathname}${rest}`;
}

/** The app-root path of a page of this company (the inverse of resolveNavPath), or null for any other page. */
export function appRootPath(pathname: string, companyId: string): string | null {
  for (const [base, root] of [[`/companies/${companyId}`, ""], [`/portfolio/${companyId}`, "/portfolio"]] as const) {
    if (pathname === base || pathname.startsWith(`${base}/`)) return `${root}${pathname.slice(base.length)}` || "/";
  }
  return null;
}

/** Every path the manifest names (without its query), once: each is a route that sends the person to their page. */
export function navigationPaths(items: readonly NavItem[] = NAVIGATION): string[] {
  return [...new Set(items.flatMap((item) => [item, ...(item.children ?? [])]).map((link) => splitPath(link.path)[0]))];
}

// Pages that belong to a section without being one of its items: a security's page sits under Cap Table, the expiry runs
// under Securities Status.
const BELONGS_TO: Record<string, string> = {
  "/securities": "/captable",
  "/convertibles": "/captable",
  "/issue": "/captable",
  "/expiry-runs": "/securities-status",
};

/** How much of `root` a manifest path covers (the length of the match), or -1 when it doesn't lead there. */
function covers(path: string, root: string): number {
  const pathname = splitPath(path)[0].replace(/\/+$/, "") || "/";
  return root === pathname || root.startsWith(`${pathname}/`) ? pathname.length : -1;
}

export interface NavMatch {
  section: NavItem;
  /** The level-2 item the page belongs to, if any. */
  child: NavLink | null;
}

/**
 * The section and item an app-root path belongs to: the longest match wins; between equal ones, the section the person
 * chose last (`preferred`: Equity Plans sits under Cap Table and under Hire and Retain), then an item of level 2, then
 * the manifest's order.
 */
export function matchNavigation(items: readonly NavItem[], root: string, preferred: string | null = null): NavMatch | null {
  const candidates: (NavMatch & { length: number; order: number })[] = [];
  items.forEach((section, order) => {
    const own = covers(section.path, root);
    if (own >= 0) candidates.push({ section, child: null, length: own, order });
    for (const child of section.children ?? []) {
      const length = covers(child.path, root);
      if (length >= 0) candidates.push({ section, child, length, order });
    }
  });
  if (candidates.length === 0) {
    // A page that only belongs to a section is in it, without being any of its items.
    const owner = BELONGS_TO[`/${root.split("/")[1] ?? ""}`];
    const found = owner ? matchNavigation(items, owner, preferred) : null;
    return found ? { section: found.section, child: null } : null;
  }
  candidates.sort((a, b) =>
    b.length - a.length
    || Number(b.section.key === preferred) - Number(a.section.key === preferred)
    || Number(b.child !== null) - Number(a.child !== null)
    || a.order - b.order);
  const { section, child } = candidates[0]!;
  return { section, child };
}

// ---------------------------------------------------------------------------
// Collapsing, remembered per browser

export type NavState = "collapsed" | "expanded";
export interface NavCollapse {
  l1: NavState;
  l2: NavState;
}
export const NAV_STORAGE_KEY = "insulin-nav";
const EXPANDED: NavCollapse = { l1: "expanded", l2: "expanded" };
const isState = (value: unknown): value is NavState => value === "collapsed" || value === "expanded";

/** Each level's last choice in this browser; both expanded when nothing (or nothing readable) is stored. */
export function readNavCollapse(): NavCollapse {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(NAV_STORAGE_KEY) ?? "null");
    if (!stored || typeof stored !== "object") return EXPANDED;
    const { l1, l2 } = stored as Record<string, unknown>;
    return { l1: isState(l1) ? l1 : "expanded", l2: isState(l2) ? l2 : "expanded" };
  } catch {
    return EXPANDED;
  }
}

export function writeNavCollapse(value: NavCollapse): void {
  try {
    window.localStorage.setItem(NAV_STORAGE_KEY, JSON.stringify({ l1: value.l1, l2: value.l2 }));
  } catch {
    // Storage can be off (a private window, blocked site data): the choice then lasts until the page is reloaded.
  }
}
