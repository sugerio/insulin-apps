import { z } from "zod";
import packageJson from "../../../package.json";
import type { Me } from "#shared";

// The navigation manifest (`insulin.navigation` in package.json, DESIGN.md §3.2 at the repository's root): the app's
// level 1, which the app and the Insulin Apps gateway both render. Its paths are the app's own pages.

/** The Lucide icons the shell draws, by name: a manifest icon is one of these (components/Icon.tsx). */
export const NAV_ICONS = ["file-text", "users", "calendar", "folder", "list", "receipt", "home"] as const;
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
  path: z
    .string()
    .max(200)
    .refine((path) => path.startsWith("/") && !path.startsWith("//") && !RESERVED_PATH.test(path), "must start with / and not be one of the gateway's paths"),
  group: z.string().min(1).max(40).optional(),
  role: z.enum(APP_ROLES).optional(),
};
const navItemSchema = z.strictObject(linkFields);
export const navigationSchema = z.array(navItemSchema).max(12);
export type NavItem = z.infer<typeof navItemSchema>;

export const NAVIGATION: readonly NavItem[] = navigationSchema.parse(packageJson.insulin.navigation);

const rank = (role: AppRole) => APP_ROLES.indexOf(role);

/** The person's role for the manifest, lowered by what their permissions leave them (a custom role that only views). */
export function navigationRole(me: Pick<Me, "role" | "permissions">): AppRole {
  const byRole: AppRole = me.role === "OWNER" || me.role === "ADMIN" ? "ADMIN" : me.role === "EDITOR" ? "EDITOR" : "VIEWER";
  return me.permissions.includes("taxi.prepare") ? byRole : "VIEWER";
}

export function navigationFor(items: readonly NavItem[], role: AppRole): NavItem[] {
  return items.filter((item) => rank(item.role ?? "VIEWER") <= rank(role));
}

/** Items in order, under headings: consecutive items with the same `group` share one. */
export function groupNavigation<T extends NavItem>(items: readonly T[]): { heading: string | null; items: T[] }[] {
  const groups: { heading: string | null; items: T[] }[] = [];
  for (const item of items) {
    const heading = item.group ?? null;
    const last = groups.at(-1);
    if (last && last.heading === heading) last.items.push(item);
    else groups.push({ heading, items: [item] });
  }
  return groups;
}

/**
 * The item a page belongs to: the longest manifest path it starts with. A year's household step is under Household;
 * every other page of a year under Returns.
 */
export function matchNavigation(items: readonly NavItem[], pathname: string): NavItem | null {
  const root = /^\/returns\/\d{4}\/household$/.test(pathname) ? "/household" : pathname;
  let best: NavItem | null = null;
  for (const item of items) {
    if ((root === item.path || root.startsWith(`${item.path}/`)) && item.path.length > (best?.path.length ?? -1)) best = item;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Collapsing, remembered per browser

export type NavState = "collapsed" | "expanded";
export const NAV_STORAGE_KEY = "insulin-nav";

/** Level 1's last choice in this browser; expanded when nothing (or nothing readable) is stored. */
export function readNavCollapse(): NavState {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(NAV_STORAGE_KEY) ?? "null");
    const l1 = stored && typeof stored === "object" ? (stored as Record<string, unknown>).l1 : undefined;
    return l1 === "collapsed" ? "collapsed" : "expanded";
  } catch {
    return "expanded";
  }
}

export function writeNavCollapse(value: NavState): void {
  try {
    window.localStorage.setItem(NAV_STORAGE_KEY, JSON.stringify({ l1: value, l2: "expanded" }));
  } catch {
    // Storage can be off (a private window, blocked site data): the choice then lasts until the page is reloaded.
  }
}
